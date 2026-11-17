import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { session } from "@/lib/schema";
import { isAdmin } from "@/lib/sessions";
import { POST as adminLink } from "@/app/api/admin/link/route";
import { GET as enter } from "@/app/admin/entrar/route";
import { cookieOptions, cookieStore, freshBrowser } from "./fakes";

const TOKEN = "a".repeat(64);
const NOW = new Date("2026-11-14T12:00:00-03:00");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function ask(authorization?: string) {
  return adminLink(
    new Request("https://shop.example/api/admin/link", {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization },
    }),
  );
}

async function linkToken(): Promise<string> {
  const reply = await ask(`Bearer ${TOKEN}`);
  const { url } = (await reply.json()) as { url: string };
  return new URL(url).searchParams.get("t") ?? "";
}

const links = () => db().$count(session, eq(session.kind, "admin_link"));

describe("portal", () => {
  afterEach(() => {
    delete process.env.ADMIN_LINK_TOKEN;
    setSystemTime(NOW);
  });

  test("link de entrada: bearer certo gera url de uso único, errado 401, sem segredo 404", async () => {
    expect((await ask(`Bearer ${TOKEN}`)).status).toBe(404);

    process.env.ADMIN_LINK_TOKEN = TOKEN;
    const before = await links();
    const reply = await ask(`Bearer ${TOKEN}`);
    expect(reply.status).toBe(200);
    const { url } = (await reply.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/shop\.example\/admin\/entrar\?t=[A-Za-z0-9_-]{43}$/);
    const token = new URL(url).searchParams.get("t") ?? "";
    const [row] = await db()
      .select({ expiresAt: session.expiresAt, createdAt: session.createdAt })
      .from(session)
      .where(and(eq(session.tokenHash, sha(token)), eq(session.kind, "admin_link")));
    expect(row?.expiresAt.getTime()).toBe(NOW.getTime() + 60_000);
    expect(await links()).toBe(before + 1);

    for (const wrong of [undefined, "Bearer " + "b".repeat(64), "Bearer " + TOKEN.slice(1), TOKEN])
      expect((await ask(wrong)).status).toBe(401);
    expect(await links()).toBe(before + 1);
  });

  test("entrar: link vale uma vez em 60 segundos e abre a sessão de admin", async () => {
    process.env.ADMIN_LINK_TOKEN = TOKEN;
    freshBrowser();
    expect(await isAdmin()).toBe(false);

    const token = await linkToken();
    const opened = await enter(new Request(`https://shop.example/admin/entrar?t=${token}`));
    expect(opened.status).toBe(200);
    const html = await opened.text();
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/admin">');
    expect(html).toContain('href="/admin"');
    expect(cookieStore.has("__Host-lf_admin")).toBe(true);
    expect(cookieOptions.get("__Host-lf_admin")).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict" });
    expect(await isAdmin()).toBe(true);
    expect(await db().$count(session, eq(session.tokenHash, sha(token)))).toBe(0);

    freshBrowser();
    expect((await enter(new Request(`https://shop.example/admin/entrar?t=${token}`))).status).toBe(410);
    expect(cookieStore.has("__Host-lf_admin")).toBe(false);

    const late = await linkToken();
    setSystemTime(new Date(NOW.getTime() + 61_000));
    expect((await enter(new Request(`https://shop.example/admin/entrar?t=${late}`))).status).toBe(410);
    expect((await enter(new Request(`https://shop.example/admin/entrar?t=${"c".repeat(43)}`))).status).toBe(410);
    expect((await enter(new Request("https://shop.example/admin/entrar"))).status).toBe(410);
    expect(cookieStore.has("__Host-lf_admin")).toBe(false);
  });
});
