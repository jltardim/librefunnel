import "server-only";
import { baseUrl, safeEqual } from "./guard";
import { createAdminLink, signInWithLink } from "./sessions";

// The Publicador asks for the link with ADMIN_LINK_TOKEN, its own secret: the sales report token cannot sign anyone in.
export async function adminLinkRequest(request: Request): Promise<Response> {
  const secret = process.env.ADMIN_LINK_TOKEN ?? "";
  if (!secret) return new Response(null, { status: 404 });
  const sent = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  // safeEqual hashes both sides, so the time does not depend on the length that was sent.
  if (!safeEqual(sent, secret)) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const token = await createAdminLink();
  return Response.json({ url: `${baseUrl()}/admin/entrar?t=${token}` }, { headers: { "Cache-Control": "no-store" } });
}

function page(status: number, title: string, body: string, refresh = ""): Response {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:light-dark(#f5f4f0,#141513);color:light-dark(#181917,#f0f0eb);color-scheme:light dark;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:1rem}a{color:light-dark(#254ccb,#8ca5ff)}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

// The session cookie is SameSite=Strict, so a redirect chain started on the Publicador would arrive without it:
// this page continues to /admin from the store's own origin instead.
export async function enterWithLink(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  if (!(await signInWithLink(token)))
    return page(410, "Link vencido", "Este link de entrada já foi usado ou venceu. Volte ao Publicador e toque em Entrar no painel de novo.");
  return page(200, "Entrando no painel", 'Se nada acontecer, <a href="/admin">abra o painel</a>.', '<meta http-equiv="refresh" content="0;url=/admin">');
}
