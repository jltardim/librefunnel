import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { addSeconds, db } from "./db";
import { adminPasswordMatches, adminTag, baseUrl, limited, setCookie, sha256 } from "./guard";
import type { GuardCode } from "./guard";
import { order, session } from "./schema";

type Kind = (typeof session.$inferSelect)["kind"];
export type Session = { customerId: string | null; orderId: string | null };

const ADMIN_TTL = 12 * 3600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// admin_link never becomes a cookie; it is listed only because Kind includes it.
const SAME_SITE: Record<Kind, "lax" | "strict"> = { admin: "strict", member: "lax", order: "lax", admin_link: "strict" };

// __Host- makes the browser keep the cookie only if it is Secure, host-only and on /, so neither a subdomain nor a
// product domain can plant or overwrite it. Plain http (local development) cannot carry the prefix.
function cookieName(kind: Kind): string {
  return `${baseUrl().startsWith("https://") ? "__Host-" : ""}lf_${kind}`;
}

async function cookieToken(kind: Kind): Promise<string | undefined> {
  const token = (await cookies()).get(cookieName(kind))?.value;
  return token && TOKEN.test(token) ? token : undefined;
}

// A fresh random id at every sign-in, and the browser's previous one of the same kind is deleted, so a planted or
// stolen id never outlives the next sign-in.
export async function startSession(
  kind: Kind,
  fields: { customerId?: string; orderId?: string; tag?: string },
  ttl: number,
) {
  const previous = await cookieToken(kind);
  if (previous)
    await db()
      .delete(session)
      .where(eq(session.tokenHash, sha256(previous)));
  const token = randomBytes(32).toString("base64url");
  const t = new Date();
  await db()
    .insert(session)
    .values({ tokenHash: sha256(token), kind, ...fields, createdAt: t, expiresAt: addSeconds(t, ttl) });
  await setCookie(cookieName(kind), token, ttl, SAME_SITE[kind]);
}

export async function readSession(kind: Kind): Promise<(Session & { tag: string | null }) | undefined> {
  const token = await cookieToken(kind);
  if (!token) return undefined;

  const [found] = await db()
    .select({ customerId: session.customerId, orderId: session.orderId, tag: session.tag })
    .from(session)
    .where(and(eq(session.tokenHash, sha256(token)), eq(session.kind, kind), gt(session.expiresAt, new Date())));

  return found;
}

export async function endSession(kind: Kind) {
  const token = await cookieToken(kind);
  if (token)
    await db()
      .delete(session)
      .where(eq(session.tokenHash, sha256(token)));
  // Expired with the same attributes it was set with: a __Host- cookie cleared without Secure stays in the browser.
  await setCookie(cookieName(kind), "", 0, SAME_SITE[kind]);
}

// Every device of this buyer, including the checkout's order cookies that could otherwise reopen a session.
export async function endCustomerSessions(customerId: string) {
  await db()
    .delete(session)
    .where(
      or(
        eq(session.customerId, customerId),
        inArray(session.orderId, db().select({ id: order.id }).from(order).where(eq(order.customerId, customerId))),
      ),
    );
}

export async function pruneSessions() {
  await db().delete(session).where(lte(session.expiresAt, new Date()));
}

export async function isAdmin(): Promise<boolean> {
  const found = await readSession("admin");
  return found !== undefined && found.tag === adminTag();
}

export async function signInAdmin(password: string, ip: string): Promise<GuardCode | null> {
  if (limited("admin", ip, 10, 900)) return "RATE_LIMITED";
  if (!adminPasswordMatches(password)) return "INVALID_PASSWORD";
  await startSession("admin", { tag: adminTag() }, ADMIN_TTL);
  return null;
}

// The Publicador signs the owner in with a one-time link: same session as the password, opened by the owner's
// Executor login instead. The link is deleted in the same statement that checks it, so two clicks open one session.
const LINK_TTL = 60;

export async function createAdminLink(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const t = new Date();
  await db()
    .insert(session)
    .values({ tokenHash: sha256(token), kind: "admin_link", createdAt: t, expiresAt: addSeconds(t, LINK_TTL) });
  return token;
}

export async function signInWithLink(token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  const used = await db()
    .delete(session)
    .where(and(eq(session.tokenHash, sha256(token)), eq(session.kind, "admin_link"), gt(session.expiresAt, new Date())))
    .returning({ tokenHash: session.tokenHash });
  if (used.length === 0) return false;
  await startSession("admin", { tag: adminTag() }, ADMIN_TTL);
  return true;
}

export async function signOutAdmin() {
  await endSession("admin");
}
