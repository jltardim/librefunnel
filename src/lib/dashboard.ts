import "server-only";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lte,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { credentials } from "./settings";
import { productNames, storePix } from "./catalog/products";
import { addSeconds, db, one } from "./db";
import { baseUrl } from "./guard";
import { immunity, invoiceCode, publicLink, regime } from "./invoices";
import { cloudOf, cloudStatus, evolutionOf, messageCode, replyOpen, SMTP_PRESETS, whatsappState } from "./messages";
import { conversionError, cryptoMode } from "./orders/crypto";
import { PIX_PROVIDERS, pixProvider, pspConfigured, pspKeys } from "./orders/psp";
import type { OrderStatus } from "./orders/checkout";
import {
  contact,
  customer,
  event,
  integration,
  invoice,
  lesson,
  login,
  module as courseModule,
  message,
  order,
  payment,
  progress,
  touch,
} from "./schema";
import { formatDecimal } from "@/format";

type Days = 7 | 30 | 90;
export type InboxFilter = "all" | "waiting" | "failed";
export type Conversation = { channel: "email" | "whatsapp"; address: string };

const PAGE_SIZE = 50;

// The buyer's name from their latest order, matched by WhatsApp number or e-mail, else their WhatsApp profile name.
const CONTACT_NAME = sql<string | null>`COALESCE(
  (SELECT o.name FROM orders o WHERE o.phone = message.address ORDER BY o.created_at DESC LIMIT 1),
  (SELECT o.name FROM orders o INNER JOIN customer c ON c.id = o.customer_id
    WHERE c.email = message.address ORDER BY o.created_at DESC LIMIT 1),
  (SELECT k.name FROM contact k WHERE k.address = message.address))`;

// When the stored WhatsApp photo was fetched, in seconds: part of the photo link, so a new photo gets a new link.
const PHOTO_VERSION = sql<number | null>`(SELECT EXTRACT(EPOCH FROM k.photo_checked_at)::bigint FROM contact k
  WHERE k.address = message.address AND k.photo IS NOT NULL)`.mapWith(Number);

const ZONE = "America/Sao_Paulo";
const SOURCE = sql<string>`COALESCE(NULLIF(${touch.source}, ''), CASE ${touch.clickKind} WHEN 'fbclid' THEN 'facebook' WHEN 'gclid' THEN 'google' WHEN 'ttclid' THEN 'tiktok' WHEN 'gbraid' THEN 'google' WHEN 'wbraid' THEN 'google' END, NULLIF(${touch.referrerHost}, ''), '(direto)')`;

const RECEIVED = sql<number>`${new QueryBuilder()
  .select({ received: sql`COALESCE(SUM(${payment.amount}), 0)` })
  .from(payment)
  .where(eq(payment.orderId, order.id))}`.mapWith(Number);

function since(days: Days): Date {
  return addSeconds(new Date(), -days * 86400);
}

function total(expression: SQL) {
  return sql<number>`${expression}`.mapWith(Number);
}

export async function summary(days: Days) {
  const t = new Date();
  const start = since(days);

  const paid = db()
    .$with("paid")
    .as(
      db()
        .select({
          id: order.id,
          customerId: order.customerId,
          amount: order.amount,
          bump: order.bump,
          paidAt: sql<Date>`MIN(${payment.createdAt})`.as("paid_at"),
          net: sql<number>`SUM(${payment.amount})`.as("net"),
        })
        .from(order)
        .innerJoin(payment, eq(payment.orderId, order.id))
        .where(eq(order.status, "paid"))
        .groupBy(order.id)
        .having(sql`MIN(${payment.createdAt}) >= ${start.toISOString()}`),
    );

  const recovered = sql`EXISTS (SELECT 1 FROM ${message} WHERE ${message.orderId} = ${paid.id} AND ${message.kind} = 'recovery' AND ${message.sentAt} < ${paid.paidAt})`;

  const row = one(
    await db()
      .with(paid)
      .select({
        revenue: total(
          sql`(SELECT COALESCE(SUM(${payment.amount}), 0) FROM ${payment} WHERE ${payment.createdAt} >= ${start.toISOString()})`,
        ),
        paidOrders: count(),
        buyers: countDistinct(paid.customerId),
        ticketTotal: total(sql`COALESCE(SUM(${paid.amount}), 0)`),
        bumps: total(sql`COUNT(*) FILTER (WHERE ${paid.bump} IS NOT NULL)`),
        pendingNow: total(
          sql`(SELECT COUNT(*) FROM ${order} WHERE ${order.status} = 'pending' AND ${order.expiresAt} > ${t.toISOString()})`,
        ),
        recoveredOrders: total(sql`COUNT(*) FILTER (WHERE ${recovered})`),
        recoveredRevenue: total(sql`COALESCE(SUM(${paid.net}) FILTER (WHERE ${recovered}), 0)`),
      })
      .from(paid),
  );

  return {
    revenue: row.revenue,
    paidOrders: row.paidOrders,
    buyers: row.buyers,
    averageTicket: row.paidOrders ? Math.round(row.ticketTotal / row.paidOrders) : 0,
    bumpRate: row.paidOrders ? row.bumps / row.paidOrders : 0,
    pendingNow: row.pendingNow,
    recoveredOrders: row.recoveredOrders,
    recoveredRevenue: row.recoveredRevenue,
  };
}

// Buckets are Sao Paulo calendar days whatever the server time zone.
export function revenueByDay(days: Days): Promise<{ day: string; amount: number }[]> {
  const t = new Date();
  const day = sql`(${t.toISOString()}::timestamptz AT TIME ZONE ${ZONE})::date - span.back`;
  return db()
    .select({
      day: sql<string>`to_char(${day}, 'YYYY-MM-DD')`,
      amount: total(sql`COALESCE(SUM(${payment.amount}), 0)`),
    })
    .from(sql`generate_series(0, ${days - 1}::integer) AS span (back)`)
    .leftJoin(
      payment,
      and(
        sql`(${payment.createdAt} AT TIME ZONE ${ZONE})::date = ${day}`,
        gte(payment.createdAt, addSeconds(t, -(days + 1) * 86400)),
      ),
    )
    .groupBy(sql`span.back`)
    .orderBy(sql`span.back DESC`);
}

export async function funnel(days: Days) {
  const start = since(days);

  const milestones = db()
    .select({
      product: event.product,
      visitors: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'page_view')`.as("visitors"),
      played: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'video_play')`.as("played"),
      offer: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'cta_view')`.as("offer"),
      clicked: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'cta_click')`.as("clicked"),
      checkout: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'checkout_view')`.as("checkout"),
      filling: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'checkout_start')`.as("filling"),
      copied: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'pix_copy')`.as("copied"),
      accessed: sql<number>`COUNT(*) FILTER (WHERE ${event.name} = 'member_access')`.as("accessed"),
    })
    .from(event)
    .where(and(gte(event.createdAt, start), ne(event.product, "")))
    .groupBy(event.product)
    .as("milestones");

  const buyers = db()
    .select({
      product: order.product,
      started: sql<number>`COUNT(DISTINCT ${order.customerId}) FILTER (WHERE ${order.status} <> 'canceled')`.as(
        "started",
      ),
      paid: sql<number>`COUNT(DISTINCT ${order.customerId}) FILTER (WHERE ${order.status} IN ('paid', 'refunded'))`.as(
        "paid",
      ),
    })
    .from(order)
    .where(gte(order.createdAt, start))
    .groupBy(order.product)
    .as("buyers");

  const visitors = total(sql`COALESCE(${milestones.visitors}, 0)`);
  const started = total(sql`COALESCE(${buyers.started}, 0)`);

  return db()
    .select({
      product: sql<string>`COALESCE(${milestones.product}, ${buyers.product})`,
      visitors,
      played: total(sql`COALESCE(${milestones.played}, 0)`),
      offer: total(sql`COALESCE(${milestones.offer}, 0)`),
      clicked: total(sql`COALESCE(${milestones.clicked}, 0)`),
      checkout: total(sql`COALESCE(${milestones.checkout}, 0)`),
      filling: total(sql`COALESCE(${milestones.filling}, 0)`),
      started,
      copied: total(sql`COALESCE(${milestones.copied}, 0)`),
      paid: total(sql`COALESCE(${buyers.paid}, 0)`),
      accessed: total(sql`COALESCE(${milestones.accessed}, 0)`),
    })
    .from(milestones)
    .fullJoin(buyers, eq(milestones.product, buyers.product))
    .orderBy(desc(visitors), desc(started));
}

export async function sources(days: Days, model: "last" | "first") {
  const sold = db()
    .$with("sold")
    .as(
      db()
        .select({
          id: order.id,
          visitorId: order.visitorId,
          createdAt: order.createdAt,
          status: order.status,
          net: RECEIVED.as("net"),
        })
        .from(order)
        .where(and(gte(order.createdAt, since(days)), inArray(order.status, ["paid", "refunded"]))),
    );

  const ranked = db()
    .$with("ranked")
    .as(
      db()
        .select({
          id: sold.id,
          source: sql<string>`${SOURCE}`.as("source"),
          campaign: sql<string>`COALESCE(${touch.campaign}, '')`.as("campaign"),
          position:
            sql<number>`ROW_NUMBER() OVER (PARTITION BY ${sold.id} ORDER BY ${model === "first" ? touch.firstSeenAt : desc(touch.firstSeenAt)})`.as(
              "position",
            ),
        })
        .from(sold)
        .leftJoin(touch, and(eq(touch.visitorId, sold.visitorId), lte(touch.firstSeenAt, sold.createdAt))),
    );

  const revenue = total(sql`SUM(${sold.net})`);
  return db()
    .with(sold, ranked)
    .select({
      source: ranked.source,
      campaign: ranked.campaign,
      orders: total(sql`COUNT(*) FILTER (WHERE ${sold.status} = 'paid')`),
      revenue,
    })
    .from(ranked)
    .innerJoin(sold, eq(sold.id, ranked.id))
    .where(eq(ranked.position, 1))
    .groupBy(ranked.source, ranked.campaign)
    .orderBy(desc(revenue));
}

export type OrderFilter = { q: string; status: OrderStatus | ""; product: string; days: Days | null; page: number };

export async function orders(filter: OrderFilter) {
  const q = filter.q.trim().toLowerCase().slice(0, 200);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

  // Everything but the status, so each status tab can show how many orders it holds under the other filters.
  const matching = and(
    filter.product ? or(eq(order.product, filter.product), eq(order.bump, filter.product)) : undefined,
    filter.days ? gte(order.createdAt, since(filter.days)) : undefined,
    q
      ? or(
          eq(order.id, q),
          eq(order.phone, q),
          eq(sql`lower(${order.txid})`, q),
          like(customer.email, pattern),
          like(sql`lower(${order.name})`, pattern),
        )
      : undefined,
  );

  const [rows, counts] = await Promise.all([
    db()
      .select({
        total: total(sql`COUNT(*) OVER ()`),
        row: {
          id: order.id,
          createdAt: order.createdAt,
          name: order.name,
          email: customer.email,
          product: order.product,
          bump: order.bump,
          amount: order.amount,
          status: order.status,
          txid: order.txid,
          received: RECEIVED,
        },
      })
      .from(order)
      .innerJoin(customer, eq(customer.id, order.customerId))
      .where(and(matching, filter.status ? eq(order.status, filter.status) : undefined))
      .orderBy(desc(order.createdAt))
      .limit(PAGE_SIZE)
      .offset(Math.max(0, filter.page - 1) * PAGE_SIZE),
    db()
      .select({ status: order.status, orders: count() })
      .from(order)
      .innerJoin(customer, eq(customer.id, order.customerId))
      .where(matching)
      .groupBy(order.status),
  ]);

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((entry) => entry.row),
    counts: new Map(counts.map((row) => [row.status, row.orders])),
  };
}

// One order with everything the seller needs to act on it, and the profile of the person who placed it.
export async function orderDetail(id: string) {
  const [found] = await db()
    .select({
      id: order.id,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
      name: order.name,
      email: customer.email,
      phone: order.phone,
      product: order.product,
      bump: order.bump,
      productAmount: order.productAmount,
      bumpAmount: order.bumpAmount,
      coupon: order.coupon,
      discount: order.discount,
      amount: order.amount,
      status: order.status,
      txid: order.txid,
      received: RECEIVED,
      paidAt: sql<Date | null>`(SELECT MIN(${payment.createdAt}) FROM ${payment}
        WHERE ${payment.orderId} = ${order.id} AND ${payment.amount} > 0)`.mapWith(order.createdAt),
      document: order.document,
      invoice: {
        status: invoice.status,
        key: invoice.key,
        error: invoice.error,
        rejection: invoice.rejection,
        issuedAt: invoice.issuedAt,
        pending: sql<boolean>`${invoice.nextAt} IS NOT NULL`.mapWith(Boolean),
      },
      invoicesOn: sql<boolean>`EXISTS (SELECT 1 FROM ${integration} WHERE ${integration.kind} = 'nfse')`.mapWith(
        Boolean,
      ),
    })
    .from(order)
    .innerJoin(customer, eq(customer.id, order.customerId))
    .leftJoin(invoice, eq(invoice.orderId, order.id))
    .where(eq(order.id, id));

  if (!found) return null;
  return {
    ...found,
    invoice: found.invoice && {
      ...found.invoice,
      error: invoiceCode(found.invoice.error),
      link: found.invoice.key ? publicLink(found.invoice.key) : null,
    },
    profile: await buyer({ channel: "email", address: found.email }),
  };
}

// One conversation per channel and address: everything sent to a buyer and everything they answered.
export async function inbox(filter: InboxFilter, selected: Conversation | null) {
  const threads = db()
    .select({
      channel: message.channel,
      address: message.address,
      lastId: max(message.id).as("last_id"),
      failed: total(sql`COUNT(*) FILTER (WHERE ${message.status} = 'failed')`).as("failed"),
    })
    .from(message)
    .groupBy(message.channel, message.address)
    .as("threads");

  const [conversations, counts] = await Promise.all([
    db()
      .select({
        channel: threads.channel,
        address: threads.address,
        failed: threads.failed,
        name: CONTACT_NAME,
        photo: PHOTO_VERSION,
        kind: message.kind,
        body: message.body,
        createdAt: message.createdAt,
      })
      .from(threads)
      .innerJoin(message, eq(message.id, threads.lastId))
      .where(
        filter === "waiting" ? eq(message.kind, "inbound") : filter === "failed" ? gt(threads.failed, 0) : undefined,
      )
      .orderBy(desc(threads.lastId))
      .limit(100),
    db()
      .select({
        all: count(),
        waiting: total(sql`COUNT(*) FILTER (WHERE ${message.kind} = 'inbound')`),
        failed: total(sql`COUNT(*) FILTER (WHERE ${threads.failed} > 0)`),
      })
      .from(threads)
      .innerJoin(message, eq(message.id, threads.lastId))
      .then(one),
  ]);

  const open = selected ?? conversations[0];
  if (!open) return { conversations, counts, thread: null };
  const where = and(eq(message.channel, open.channel), eq(message.address, open.address));

  const [rows, header, stored, profile] = await Promise.all([
    db()
      .select({
        id: message.id,
        kind: message.kind,
        status: message.status,
        error: message.error,
        body: message.body,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(where)
      .orderBy(desc(message.id))
      .limit(100),
    db().select({ name: CONTACT_NAME, photo: PHOTO_VERSION }).from(message).where(where).limit(1),
    credentials("whatsapp"),
    buyer(open),
  ]);

  if (rows.length === 0) return { conversations, counts, thread: null };
  const lastInbound = rows.find((row) => row.kind === "inbound")?.createdAt ?? null;

  return {
    conversations,
    counts,
    thread: {
      ...open,
      name: header[0]?.name ?? null,
      photo: header[0]?.photo ?? null,
      profile,
      messages: rows.map((row) => ({ ...row, error: messageCode(row.error) })),
      canReply: open.channel === "whatsapp" && replyOpen(cloudOf(stored("whatsapp")) !== undefined, lastInbound),
    },
  };
}

// Everything known about the person behind a conversation: their orders, how they found the store, what they did
// on the sales page and in the members area. Orders are matched by e-mail or WhatsApp, then everything else by
// the customers and browsers of those orders.
async function buyer(open: Conversation) {
  const owners =
    open.channel === "email"
      ? db().select({ id: customer.id }).from(customer).where(eq(customer.email, open.address))
      : db().selectDistinct({ id: order.customerId }).from(order).where(eq(order.phone, open.address));

  const [orders, [known], names] = await Promise.all([
    db()
      .select({
        id: order.id,
        customerId: order.customerId,
        product: order.product,
        bump: order.bump,
        amount: order.amount,
        status: order.status,
        email: customer.email,
        phone: order.phone,
        visitorId: order.visitorId,
        userAgent: order.userAgent,
        createdAt: order.createdAt,
        paidAt: sql<Date | null>`(SELECT MIN(${payment.createdAt}) FROM ${payment}
          WHERE ${payment.orderId} = ${order.id} AND ${payment.amount} > 0)`.mapWith(order.createdAt),
      })
      .from(order)
      .innerJoin(customer, eq(customer.id, order.customerId))
      .where(inArray(order.customerId, owners))
      .orderBy(desc(order.createdAt))
      .limit(20),
    db().select({ optedOutAt: contact.optedOutAt }).from(contact).where(eq(contact.address, open.address)),
    productNames(),
  ]);

  const customers = [...new Set(orders.map((row) => row.customerId))];
  const visitors = [...new Set(orders.flatMap((row) => (row.visitorId ? [row.visitorId] : [])))];

  const bought = [
    ...new Set(orders.filter((row) => row.status === "paid").flatMap((row) => [row.product, row.bump ?? ""])),
  ];

  const [events, touches, logins, lessons] = await Promise.all([
    visitors.length
      ? db()
          .select({ product: event.product, name: event.name, value: event.value, createdAt: event.createdAt })
          .from(event)
          .where(inArray(event.visitorId, visitors))
      : [],
    visitors.length
      ? db()
          .select({
            source: SOURCE,
            campaign: touch.campaign,
            content: touch.content,
            landing: touch.landing,
            firstSeenAt: touch.firstSeenAt,
            lastSeenAt: touch.lastSeenAt,
          })
          .from(touch)
          .where(inArray(touch.visitorId, visitors))
          .orderBy(touch.firstSeenAt)
      : [],
    customers.length
      ? db()
          .select({ lastAt: max(login.usedAt) })
          .from(login)
          .where(inArray(login.customerId, customers))
          .then(one)
      : { lastAt: null },
    bought.length
      ? db()
          .select({
            product: courseModule.product,
            total: count(lesson.id),
            done: total(sql`COUNT(${progress.lesson})`),
          })
          .from(lesson)
          .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
          .leftJoin(
            progress,
            and(
              eq(progress.lesson, lesson.slug),
              eq(progress.product, courseModule.product),
              inArray(progress.customerId, customers),
            ),
          )
          .where(and(inArray(courseModule.product, bought), isNull(lesson.archivedAt), isNull(courseModule.archivedAt)))
          .groupBy(courseModule.product)
      : [],
  ]);

  const products = [...new Set([...orders.map((row) => row.product), ...events.map((row) => row.product)])].filter(
    (slug) => names.has(slug),
  );

  return {
    email: orders.find((row) => row.email)?.email ?? (open.channel === "email" ? open.address : null),
    phone: orders.find((row) => row.phone)?.phone ?? (open.channel === "whatsapp" ? open.address : null),
    optedOutAt: known?.optedOutAt ?? null,
    userAgent: orders[0]?.userAgent ?? null,
    orders: orders.map((row) => ({
      id: row.id,
      title: [row.product, row.bump].flatMap((slug) => (slug ? [names.get(slug) ?? slug] : [])).join(" + "),
      amount: row.amount,
      status: row.status,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
    })),
    journeys: products.map((slug) => {
      const steps = new Map(
        events.filter((row) => row.product === slug).map((row): [string, typeof row] => [row.name, row]),
      );

      const orderOf = orders.filter((row) => row.product === slug);

      return {
        product: names.get(slug) ?? slug,
        firstSeenAt: steps.get("page_view")?.createdAt ?? null,
        playedAt: steps.get("video_play")?.createdAt ?? null,
        watched: steps.get("video_watch")?.value ?? 0,
        reached: ["video_100", "video_75", "video_50", "video_25"].find((name) => steps.has(name))?.slice(6) ?? null,
        offerAt: steps.get("cta_view")?.createdAt ?? null,
        clickedAt: steps.get("cta_click")?.createdAt ?? null,
        orderedAt: orderOf.at(-1)?.createdAt ?? null,
        paidAt: orderOf.find((row) => row.paidAt)?.paidAt ?? null,
      };
    }),
    origin: touches[0] ?? null,
    lastSeenAt: touches.reduce<Date | null>(
      (latest, row) => (!latest || row.lastSeenAt > latest ? row.lastSeenAt : latest),
      null,
    ),
    visits: touches.length,
    lastLoginAt: logins.lastAt,
    lessons: lessons.map((row) => ({ ...row, product: names.get(row.product) ?? row.product })),
  };
}

// Everything the Connections screen shows. Secrets only come out as "is set" flags; their values never leave the server.
export async function integrations() {
  const [stored, failedMessages] = await Promise.all([
    credentials(
      "smtp",
      "pix",
      "mercadopago",
      "woovi",
      "abacatepay",
      "depix",
      "noxpay",
      "asaas",
      "webhook",
      "evolution",
      "whatsapp",
      "storage",
      "nfse",
    ),
    db().$count(message, eq(message.status, "failed")),
  ]);

  const evolution = evolutionOf(stored("evolution"));
  const cloud = stored("whatsapp");
  const cloudLink = cloudOf(cloud);

  const [state, live] = await Promise.all([whatsappState(evolution), cloudLink ? cloudStatus(cloudLink) : null]);

  const smtp = stored("smtp");
  const panelEvolution = stored("evolution");
  const active = pixProvider(stored("pix")("provider")) ?? "static";
  const account = await storePix();
  const webhookUrl = `${baseUrl()}/api/webhooks/payment`;

  return {
    email: {
      configured: smtp("host") !== "",
      host: smtp("host"),
      port: Number(smtp("port")) || 587,
      user: smtp("user"),
      from: smtp("from"),
      passwordSet: smtp("password") !== "",
      presets: SMTP_PRESETS,
    },
    pix: {
      provider: active,
      chosen: stored("pix")("provider") !== "",
      account: account ?? null,
      crypto: {
        mode: cryptoMode(stored("woovi")("convertMode")),
        asset: stored("woovi")("convertAsset"),
        wallet: stored("woovi")("convertWallet"),
        error: conversionError(stored("woovi")("convertError")),
      },
      providers: PIX_PROVIDERS.map((provider) => {
        if (provider.id === "static")
          return {
            ...provider,
            active: active === "static",
            configured: account !== undefined,
            apiKeySet: false,
            webhookSecretSet: false,
            clientId: "",
            currency: "",
            webhookUrl: null,
          };
        const keys = pspKeys(stored(provider.id));

        return {
          ...provider,
          active: active === provider.id,
          configured: pspConfigured(provider.id, keys),
          apiKeySet: keys.apiKey !== "",
          webhookSecretSet: keys.webhookSecret !== "",
          clientId: keys.clientId,
          currency: keys.currency,
          // NoxPay takes the address with each checkout, so there is nothing to register in its panel.
          webhookUrl: provider.id === "noxpay" ? null : `${webhookUrl}?psp=${provider.id}`,
        };
      }),
    },
    webhook: { configured: stored("webhook")("secret") !== "", url: webhookUrl },
    storage: {
      configured: stored("storage")("bucket") !== "" && stored("storage")("secret") !== "",
      endpoint: stored("storage")("endpoint"),
      bucket: stored("storage")("bucket"),
      accessKey: stored("storage")("accessKey"),
      secretSet: stored("storage")("secret") !== "",
      origin: new URL(baseUrl()).origin,
    },
    whatsapp: {
      configured: evolution !== undefined,
      external: panelEvolution("url") !== "",
      url: panelEvolution("url"),
      keySet: panelEvolution("key") !== "",
      state,
    },
    cloud: {
      configured: cloudLink !== undefined,
      https: baseUrl().startsWith("https://"),
      baseUrl: baseUrl(),
      phoneId: cloud("phoneId"),
      number: cloud("number"),
      template: live?.template ?? null,
      numbers: live?.numbers ?? [],
    },
    nfse: {
      configured: stored("nfse")("chain") !== "",
      cnpj: stored("nfse")("cnpj"),
      holder: stored("nfse")("holder"),
      expiresAt: stored("nfse")("expiresAt") ? new Date(stored("nfse")("expiresAt")) : null,
      city: stored("nfse")("city"),
      place: stored("nfse")("place"),
      regime: regime(stored("nfse")("regime")) ?? null,
      service: stored("nfse")("service"),
      registration: stored("nfse")("registration"),
      taxRate: stored("nfse")("taxRate"),
      issRate: stored("nfse")("issRate"),
      immunity: immunity(stored("nfse")("immunity")) ?? "",
    },
    failedMessages,
  };
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function ordersCsv(params: URLSearchParams): Promise<string> {
  const days = Number(params.get("days"));
  const status = order.status.enumValues.find((value) => value === params.get("status"));
  const start = days === 7 || days === 30 || days === 90 ? since(days) : new Date(0);

  const picked = db()
    .select({
      orderId: sql<string>`${order.id}`.as("order_id"),
      source: sql<string>`${SOURCE}`.as("source"),
      campaign: sql<string>`${touch.campaign}`.as("campaign"),
      position: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${order.id} ORDER BY ${touch.firstSeenAt} DESC)`.as(
        "position",
      ),
    })
    .from(order)
    .innerJoin(touch, and(eq(touch.visitorId, order.visitorId), lte(touch.firstSeenAt, order.createdAt)))
    .where(gte(order.createdAt, start))
    .as("picked");

  // The latest ad click before the order, so a gclid can go to Google Ads as an offline conversion.
  const clicked = db()
    .select({
      orderId: sql<string>`${order.id}`.as("click_order_id"),
      kind: sql<string>`${touch.clickKind}`.as("click_kind"),
      id: sql<string>`${touch.clickId}`.as("click_id"),
      position: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${order.id} ORDER BY ${touch.firstSeenAt} DESC)`.as(
        "click_position",
      ),
    })
    .from(order)
    .innerJoin(
      touch,
      and(eq(touch.visitorId, order.visitorId), lte(touch.firstSeenAt, order.createdAt), ne(touch.clickKind, "")),
    )
    .where(gte(order.createdAt, start))
    .as("clicked");

  const rows = await db()
    .select({
      id: order.id,
      created: sql<string>`to_char(${order.createdAt} AT TIME ZONE ${ZONE}, 'YYYY-MM-DD HH24:MI:SS')`,
      name: order.name,
      email: customer.email,
      phone: order.phone,
      product: order.product,
      bump: order.bump,
      amount: order.amount,
      status: order.status,
      txid: order.txid,
      received: RECEIVED,
      source: picked.source,
      campaign: picked.campaign,
      clickKind: clicked.kind,
      clickId: clicked.id,
    })
    .from(order)
    .innerJoin(customer, eq(customer.id, order.customerId))
    .leftJoin(picked, and(eq(picked.orderId, order.id), eq(picked.position, 1)))
    .leftJoin(clicked, and(eq(clicked.orderId, order.id), eq(clicked.position, 1)))
    .where(and(gte(order.createdAt, start), status ? eq(order.status, status) : undefined))
    .orderBy(desc(order.createdAt));

  const lines = [
    [
      "pedido",
      "data",
      "nome",
      "email",
      "telefone",
      "produto",
      "bump",
      "valor",
      "recebido",
      "status",
      "txid",
      "origem",
      "campanha",
      "tipo_clique",
      "id_clique",
    ].join(";"),
  ];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.created,
        row.name,
        row.email,
        row.phone ?? "",
        row.product,
        row.bump ?? "",
        formatDecimal(row.amount, ","),
        formatDecimal(row.received, ","),
        row.status,
        row.txid,
        row.source ?? "(direto)",
        row.campaign ?? "",
        row.clickKind ?? "",
        row.clickId ?? "",
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
