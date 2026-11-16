import "server-only";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { isAdmin, readSession } from "../sessions";
import { currentMember } from "../members";
import { lesson, module, product } from "../schema";
import { LINKS, bucket, call, presign } from "./bucket";
import type { Visibility } from "./bucket";
import { CHUNK, ORIGINAL, PREFIX, STREAM, mediaDir, mimeOf } from "./files";

// Pull-based so a slow phone downloading a long video never makes the server read ahead into memory.
async function fileStream(path: string, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
  const handle = await open(path);
  let position = start;
  return new ReadableStream({
    async pull(controller) {
      const length = Math.max(0, Math.min(CHUNK, end + 1 - position));
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, position);
      if (bytesRead === 0) {
        await handle.close();
        controller.close();
        return;
      }
      position += bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
    cancel: () => handle.close(),
  });
}

// A lesson file is paid content: only the admin and current buyers of its product get it, so a refund or a shared link opens nothing.
// A VSL plays as dozens of segment requests per viewer; remembering the public verdict for a minute keeps them off the database.
// Only "public" is remembered, since the private answer depends on who asks. Capped so random names cannot grow it.
const publicUntil = new Map<string, number>();

const REMEMBERED = 2000;

async function access(urls: string[]): Promise<Visibility | "denied"> {
  const key = urls.join(" ");
  if ((publicUntil.get(key) ?? 0) > Date.now()) return "public";
  const visibility = await checkAccess(urls);

  if (visibility === "public") {
    if (publicUntil.size >= REMEMBERED) publicUntil.clear();
    publicUntil.set(key, Date.now() + 60_000);
  }

  return visibility;
}

async function checkAccess(urls: string[]): Promise<Visibility | "denied"> {
  const [owners, shown] = await Promise.all([
    db()
      .selectDistinct({ product: module.product })
      .from(lesson)
      .innerJoin(module, eq(module.id, lesson.moduleId))
      .where(or(inArray(lesson.video, urls), inArray(lesson.attachment, urls))),
    db().$count(
      product,
      or(
        inArray(product.vslVideo, urls),
        inArray(product.captions, urls),
        inArray(product.banner, urls),
        inArray(product.cover, urls),
      ),
    ),
  ]);

  if (owners.length === 0 || shown > 0) return "public";
  if (await isAdmin()) return "private";
  const owned = (await currentMember())?.owned ?? [];
  return owners.some((row) => owned.includes(row.product)) ? "private" : "denied";
}

export const streams = new Set<string>();

const missing = new Map<string, number>();

export async function streamFor(url: string): Promise<string | undefined> {
  const id = ORIGINAL.exec(url.replace(/^\/media\//, ""))?.[1];
  if (!id) return;
  const master = `/media/${id}/master.m3u8`;
  if (streams.has(id) || (await stat(join(mediaDir(), id, "master.m3u8")).catch(() => undefined))) return master;
  if ((missing.get(id) ?? 0) > Date.now()) return;
  const target = await bucket();
  if (!target) return;
  const head = await call(target, "HEAD", `${PREFIX}${id}/master.m3u8`).catch(() => undefined);
  if (head?.ok) streams.add(id);
  else missing.set(id, Date.now() + 60_000);
  return head?.ok ? master : undefined;
}

// A finished stream never changes (random names, master playlist uploaded last), so its playlists are kept in memory.
const playlists = new Map<string, string>();

// Playlists pass through here so their relative links come back to this route; every other file is a redirect to a signed link.
async function serveRemote(file: string, mime: string, visibility: Visibility): Promise<Response> {
  const target = await bucket();
  if (!target) return new Response(null, { status: 404 });
  const key = `${PREFIX}${file}`;

  if (file.endsWith(".m3u8")) {
    let text = playlists.get(file);

    if (text === undefined) {
      const response = await fetch(presign(target, "GET", key, visibility), { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return new Response(null, { status: 404 });
      text = await response.text();
      if (playlists.size >= REMEMBERED) playlists.clear();
      playlists.set(file, text);
    }

    return new Response(text, { headers: { "Content-Type": mime, "Cache-Control": LINKS[visibility].cache } });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: presign(target, "GET", key, visibility), "Cache-Control": LINKS[visibility].cache },
  });
}

// Names are random, so the files never change. A stream file (`<id>/...`) inherits the access rules of its original video.
export async function serveMedia(request: Request, file: string): Promise<Response> {
  const mime = mimeOf(file);
  if (!mime) return new Response(null, { status: 404 });
  const id = STREAM.exec(file)?.[1];
  const visibility = await access(id ? [`/media/${id}.mp4`, `/media/${id}.webm`] : [`/media/${file}`]);
  if (visibility === "denied") return new Response(null, { status: 404 });
  const path = join(mediaDir(), file);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return serveRemote(file, mime, visibility);
  const cache = visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store";
  return sendFile(request, path, info.size, mime, cache);
}

// The ASCII name is for old browsers; filename* keeps the accents of the name the seller uploaded.
function disposition(name: string): string {
  const plain = name.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

// A lesson PDF is paid content like its video: the same check, and a visitor without a session goes to the login.
export async function serveAttachment(request: Request, productSlug: string, lessonSlug: string): Promise<Response> {
  if (!(await readSession("member")) && !(await isAdmin()))
    return new Response(null, { status: 302, headers: { Location: "/m" } });

  const [found] = await db()
    .select({ url: lesson.attachment, name: lesson.attachmentName })
    .from(lesson)
    .innerJoin(module, eq(module.id, lesson.moduleId))
    .where(and(eq(lesson.slug, lessonSlug), eq(module.product, productSlug)));

  if (!found?.url || !found.name || (await access([found.url])) === "denied")
    return new Response(null, { status: 404 });
  const file = found.url.replace(/^\/media\//, "");
  const saveAs = disposition(found.name);
  const path = join(mediaDir(), file);
  const info = await stat(path).catch(() => undefined);

  if (info?.isFile()) {
    const response = await sendFile(request, path, info.size, "application/pdf", "private, no-store");
    response.headers.set("Content-Disposition", saveAs);
    return response;
  }

  const target = await bucket();
  if (!target) return new Response(null, { status: 404 });
  const query = { "response-content-disposition": saveAs, "response-content-type": "application/pdf" };

  return new Response(null, {
    status: 302,
    headers: {
      Location: presign(target, "GET", `${PREFIX}${file}`, "private", query),
      "Cache-Control": LINKS.private.cache,
    },
  });
}

// Safari only plays video that answers byte ranges with 206.
export async function sendFile(request: Request, path: string, size: number, mime: string, cache: string) {
  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": cache };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) {
    return new Response(await fileStream(path, 0, size - 1), {
      headers: { ...headers, "Content-Length": String(size) },
    });
  }
  const [, from = "", to = ""] = range;
  const start = from === "" ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if ((from === "" && !(Number(to) > 0)) || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  return new Response(await fileStream(path, start, end), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}
