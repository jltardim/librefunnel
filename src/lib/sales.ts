import "server-only";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "./db";
import { baseUrl, safeEqual } from "./guard";
import { parseInstant } from "./input";
import { order, payment, touch } from "./schema";

type SalesCode = "INVALID_TOKEN" | "INVALID_DATE";

const TOKEN_MIN = 32;

function reply(code: SalesCode, status: number): Response {
  return Response.json({ code }, { status });
}

function utm(column: AnyPgColumn, name: string) {
  return sql<string | null>`NULLIF(${column}, '')`.as(name);
}

// For an outside dashboard: paid and refunded orders by payment time, with the last touch before the order, and
// nothing that identifies the buyer. Without a long token in VENDAS_TOKEN the route does not exist.
export async function salesReport(request: Request): Promise<Response> {
  const token = process.env.VENDAS_TOKEN ?? "";
  if (token.length < TOKEN_MIN) return new Response(null, { status: 404 });
  const sent = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!safeEqual(sent, token)) return reply("INVALID_TOKEN", 401);
  const query = new URL(request.url).searchParams;
  const from = parseInstant(query.get("desde") ?? "");
  const to = parseInstant(query.get("ate") ?? "");
  if (!from || !to || from > to) return reply("INVALID_DATE", 400);
  const paidAt = sql`MIN(${payment.createdAt}) FILTER (WHERE ${payment.amount} > 0)`;

  const sold = db()
    .$with("sold")
    .as(
      db()
        .select({
          id: order.id,
          visitorId: order.visitorId,
          createdAt: order.createdAt,
          amount: order.amount,
          status: order.status,
          paidAt: sql<Date>`${paidAt}`.as("paid_at"),
        })
        .from(order)
        .innerJoin(payment, eq(payment.orderId, order.id))
        .where(and(inArray(order.status, ["paid", "refunded"]), lt(order.createdAt, to)))
        .groupBy(order.id)
        .having(sql`${paidAt} >= ${from.toISOString()} AND ${paidAt} < ${to.toISOString()}`),
    );

  const ranked = db()
    .$with("ranked")
    .as(
      db()
        .select({
          id: sold.id,
          source: utm(touch.source, "utm_source"),
          medium: utm(touch.medium, "utm_medium"),
          campaign: utm(touch.campaign, "utm_campaign"),
          content: utm(touch.content, "utm_content"),
          position: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${sold.id} ORDER BY ${touch.firstSeenAt} DESC)`.as(
            "position",
          ),
        })
        .from(sold)
        .leftJoin(touch, and(eq(touch.visitorId, sold.visitorId), lte(touch.firstSeenAt, sold.createdAt))),
    );

  const rows = await db()
    .with(sold, ranked)
    .select({
      id: sold.id,
      paidAt: sql<string>`to_char(${sold.paidAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      amount: sold.amount,
      status: sold.status,
      source: ranked.source,
      medium: ranked.medium,
      campaign: ranked.campaign,
      content: ranked.content,
    })
    .from(ranked)
    .innerJoin(sold, eq(sold.id, ranked.id))
    .where(eq(ranked.position, 1))
    .orderBy(sold.paidAt, sold.id);

  const sales = rows.map((row) => ({
    id: row.id,
    pago_em: row.paidAt,
    valor_centavos: row.amount,
    status: row.status === "paid" ? "pago" : "reembolsado",
    utm_source: row.source,
    utm_medium: row.medium,
    utm_campaign: row.campaign,
    utm_content: row.content,
  }));

  return Response.json(
    { loja: URL.parse(baseUrl())?.hostname ?? "", moeda: "brl", vendas: sales },
    { headers: { "Cache-Control": "no-store" } },
  );
}
