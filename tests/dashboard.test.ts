import { beforeEach, describe, expect, test, setSystemTime, vi } from "bun:test";
import { eq } from "drizzle-orm";
import { saveMeta } from "@/lib/actions/ads";
import { removeConnection, saveEvolution, savePix, saveSmtp } from "@/lib/actions/connections";
import { credentials } from "@/lib/settings";
import { db } from "@/lib/db";
import { funnel, integrations, orders, revenueByDay, summary } from "@/lib/dashboard";
import type { OrderFilter } from "@/lib/dashboard";
import { seal, unseal } from "@/lib/guard";
import { integration, message, order as orderTable } from "@/lib/schema";
import { adConnections } from "@/lib/tracking/accounts";
import { GET as csvRoute } from "@/app/admin/orders.csv/route";
import { POST as trackRoute } from "@/app/t/route";
import { fakeServer, form, freshBrowser, redirectFetch } from "./fakes";
import { buy, pay, signInAsAdmin, webhook } from "./flows";

let ip = 0;

beforeEach(() => {
  ip += 1;
  freshBrowser(`203.0.113.${ip}`);
  setSystemTime(new Date("2026-11-14T12:00:00-03:00"));
});

describe("dashboard", () => {
  test("revenue is net of refunds and bucketed by Sao Paulo day", async () => {
    setSystemTime(new Date("2026-11-13T22:00:00-03:00"));
    const late = await buy({ email: "night@example.com" });
    await pay(late);
    setSystemTime(new Date("2026-11-14T12:00:00-03:00"));
    const refunded = await buy({ email: "refunded@example.com" });
    await pay(refunded);
    await webhook({ order: refunded, status: "refunded", amount: 9700, id: "refund-1" });
    const days = await revenueByDay(7);
    expect(days.length).toBe(7);
    expect(days[0]?.day).toBe("2026-11-08");
    expect(days.find((entry) => entry.day === "2026-11-13")?.amount).toBe(9700);
    expect(days.find((entry) => entry.day === "2026-11-14")?.amount).toBe(0);
    expect(await summary(7)).toMatchObject({
      revenue: 9700,
      paidOrders: 1,
      buyers: 1,
      averageTicket: 9700,
      bumpRate: 0,
    });
  });

  test("recovered sales count only payments after a sent recovery message", async () => {
    const order = await buy({ email: "recovered@example.com", bump: "1" });
    const minuteAgo = new Date(Date.now() - 60_000);
    await db().insert(message).values({
      channel: "whatsapp",
      address: "5548999990000",
      kind: "recovery",
      orderId: order,
      body: "x",
      status: "sent",
      createdAt: minuteAgo,
      sentAt: minuteAgo,
    });
    await pay(order, 9700 + 1990);
    const totals = await summary(7);
    expect(totals).toMatchObject({ recoveredOrders: 1, recoveredRevenue: 11690 });
    expect(totals.bumpRate).toBeGreaterThan(0);
  });

  test("funnel counts visitors from milestones and buyers from orders", async () => {
    await trackRoute(
      new Request("https://shop.example/t", {
        method: "POST",
        body: JSON.stringify({ e: "page_view", p: "planilha-preco", q: "", r: "", l: "/v/planilha-preco" }),
      }),
    );
    await trackRoute(
      new Request("https://shop.example/t", {
        method: "POST",
        body: JSON.stringify({ e: "cta_click", p: "planilha-preco" }),
      }),
    );
    const order = await buy({ email: "funnel@example.com", slug: "planilha-preco" });
    await pay(order, 4700);
    expect((await funnel(7)).find((row) => row.product === "planilha-preco")).toEqual({
      product: "planilha-preco",
      visitors: 1,
      played: 0,
      offer: 0,
      clicked: 1,
      checkout: 0,
      filling: 0,
      started: 1,
      copied: 0,
      paid: 1,
      accessed: 0,
    });
  });

  test("orders search finds by e-mail and txid, with the total from the window", async () => {
    const order = await buy({ email: "search@example.com" });
    const all = { product: "", days: null, page: 1 };
    expect(await orders({ ...all, q: "SEARCH@", status: "" })).toMatchObject({
      total: 1,
      rows: [{ id: order, email: "search@example.com", received: 0, status: "pending" }],
    });
    expect((await orders({ ...all, q: order, status: "pending" })).total).toBe(1);
    expect((await orders({ ...all, q: "%", status: "" })).total).toBe(0);
  });

  test("orders filter by product, bump included, and count each status under the other filters", async () => {
    const all: OrderFilter = { q: "filters@", status: "", product: "", days: null, page: 1 };
    const paid = await buy({ email: "filters@example.com", bump: "1" });
    await pay(paid, 9700 + 1990);
    await buy({ email: "filters@example.com", name: "Outra Pessoa" });
    const result = await orders({ ...all, product: "planilha-preco" });
    expect(result.rows.map((row) => row.id)).toEqual([paid]);
    expect(result.counts).toEqual(new Map([["paid", 1]]));
    expect((await orders({ ...all, status: "pending" })).counts).toEqual(
      new Map([
        ["paid", 1],
        ["pending", 1],
      ]),
    );
  });

  test("CSV export needs the admin and neutralizes spreadsheet formulas", async () => {
    const order = await buy({ email: "spreadsheet@example.com" });
    await db().update(orderTable).set({ name: '=IMPORTXML("http://x";"//a")' }).where(eq(orderTable.id, order));
    const anonymous = await csvRoute(new Request("https://shop.example/admin/orders.csv"));
    expect(anonymous.status).toBe(303);
    await signInAsAdmin();
    const response = await csvRoute(new Request("https://shop.example/admin/orders.csv?days=7"));
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain(`"'=IMPORTXML(""http://x"";""//a"")"`);
    expect(text).toContain("97,00");
  });
});

describe("integration settings", () => {
  const SECRETS = [
    "smtp-pass-1234",
    "meta-token-5678",
    "APP_USR-mp-9012",
    "mp-hook-3456",
    "abc_prod_secret_7890",
    "abacate-webhook-secret-of-32-chars-x",
    "evo-key-1357",
  ];

  test("sealed values round-trip, and tampering, another field or another SECRET is refused", () => {
    const sealed = seal("token-123", "meta.token");
    expect(sealed).not.toContain("token-123");
    expect(unseal(sealed, "meta.token")).toBe("token-123");
    expect(seal("token-123", "meta.token")).not.toBe(sealed);
    expect(unseal(sealed, "smtp.password")).toBeUndefined();
    const [nonce, tag, body = ""] = sealed.split(".");
    expect(unseal(`${nonce}.${tag}.${body.slice(0, -2)}AA`, "meta.token")).toBeUndefined();
    const secret = process.env.SECRET;
    process.env.SECRET = "t".repeat(40);
    expect(unseal(sealed, "meta.token")).toBeUndefined();
    process.env.SECRET = secret;
  });

  test("secrets are stored sealed and never appear in what the panel reads", async () => {
    await signInAsAdmin();
    const [smtpPass, metaToken, mpKey, mpHook, abacateKey, abacateHook, evoKey] = SECRETS;
    expect(
      await saveSmtp(
        { code: null },
        form({ preset: "brevo", user: "login@smtp-brevo.com", password: smtpPass ?? "", from: "loja@example.com" }),
      ),
    ).toEqual({ code: null, ok: true });
    // Saving the Meta connection tests it, so Meta answers from a fake server here.
    const graph = await fakeServer({ "POST /v27.0/1234567/events": { status: 200, body: { events_received: 1 } } });
    redirectFetch("https://graph.facebook.com", graph.url);
    expect(await saveMeta({ code: null }, form({ pixelId: "1234567", token: metaToken ?? "" }))).toEqual({
      code: null,
      ok: true,
    });
    vi.restoreAllMocks();
    await graph.close();
    expect(
      await savePix(
        { code: null },
        form({ provider: "mercadopago", apiKey: mpKey ?? "", webhookSecret: mpHook ?? "" }),
      ),
    ).toEqual({ code: null, ok: true });
    expect(
      (
        await savePix(
          { code: null },
          form({ provider: "abacatepay", apiKey: abacateKey ?? "", webhookSecret: "short" }),
        )
      ).code,
    ).toBe("INVALID_WEBHOOK_SECRET");
    expect((await savePix({ code: null }, form({ provider: "woovi", apiKey: "" }))).code).toBe(
      "PIX_PROVIDER_NOT_CONFIGURED",
    );
    expect(
      await savePix(
        { code: null },
        form({ provider: "abacatepay", apiKey: abacateKey ?? "", webhookSecret: abacateHook ?? "" }),
      ),
    ).toEqual({ code: null, ok: true });
    expect(await saveEvolution({ code: null }, form({ url: "https://evo.example.com", key: evoKey ?? "" }))).toEqual({
      code: null,
      ok: true,
    });

    const rows = JSON.stringify(
      await db().select({ fields: integration.fields, secrets: integration.secrets }).from(integration),
    );

    const read = JSON.stringify([await integrations(), await adConnections()]);
    for (const secret of SECRETS) {
      expect(rows).not.toContain(secret);
      expect(read).not.toContain(secret);
    }

    const links = await integrations();
    expect(links.email).toMatchObject({
      configured: true,
      host: "smtp-relay.brevo.com",
      port: 587,
      user: "login@smtp-brevo.com",
      passwordSet: true,
    });
    expect((await adConnections()).meta).toMatchObject({ configured: true, pixelId: "1234567", tokenSet: true });
    expect(links.whatsapp).toMatchObject({ external: true, url: "https://evo.example.com", keySet: true });
    expect(links.pix.provider).toBe("abacatepay");
    expect(links.pix.providers.map((entry) => [entry.id, entry.needsCnpj, entry.configured])).toEqual([
      ["static", false, true],
      ["mercadopago", false, true],
      ["woovi", true, false],
      ["abacatepay", true, true],
      ["depix", false, false],
      ["noxpay", false, false],
      ["asaas", false, false],
    ]);
    expect(links.pix.providers.find((entry) => entry.id === "woovi")?.webhookUrl).toBe(
      "https://shop.example/api/webhooks/payment?psp=woovi",
    );

    expect(
      await saveSmtp({ code: null }, form({ preset: "brevo", user: "login@smtp-brevo.com", password: "" })),
    ).toEqual({ code: null, ok: true });
    expect((await credentials("smtp"))("smtp")("password")).toBe(smtpPass ?? "");
    expect(await removeConnection({ code: null }, form({ kind: "abacatepay" }))).toEqual({ code: null, ok: true });
    expect((await integrations()).pix.provider).toBe("static");
    for (const kind of ["smtp", "meta", "mercadopago", "evolution"])
      await removeConnection({ code: null }, form({ kind }));
    freshBrowser();
    expect((await saveMeta({ code: null }, form({ pixelId: "1234567", token: "x" }))).code).toBe("NOT_SIGNED_IN");
  });
});
