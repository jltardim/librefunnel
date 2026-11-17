import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { createOrder } from "@/lib/actions/checkout";
import { savePix } from "@/lib/actions/connections";
import { integrations } from "@/lib/dashboard";
import { db, one } from "@/lib/db";
import { attachCharges, checkCharges, testPsp } from "@/lib/orders/charges";
import { removeCredentials, saveCredentials } from "@/lib/settings";
import { order, payment } from "@/lib/schema";
import { POST as paymentWebhook } from "@/app/api/webhooks/payment/route";
import { PIX_HELP } from "@/app/admin/connections/pix-help";
import { fakeFetch, fakeServer, form, freshBrowser, redirectFetch } from "./fakes";
import { buy, signInAsAdmin } from "./flows";

const KEY = "$aact_prod_teste";
const TOKEN = "asaas-webhook-token-with-32-chars!!";
const CPF = "52998224725";

async function stored(id: string) {
  return one(
    await db()
      .select({
        status: order.status,
        txid: order.txid,
        pixCode: order.pixCode,
        psp: order.psp,
        pspCheckAt: order.pspCheckAt,
        document: order.document,
        expiresAt: order.expiresAt,
      })
      .from(order)
      .where(eq(order.id, id)),
  );
}

function payments(id: string) {
  return db().$count(payment, eq(payment.orderId, id));
}

function notice(paymentId: string, token: string | null = TOKEN) {
  return paymentWebhook(
    new Request("https://shop.example/api/webhooks/payment?psp=asaas", {
      method: "POST",
      body: JSON.stringify({ id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: paymentId, status: "RECEIVED" } }),
      headers: token === null ? {} : { "asaas-access-token": token },
    }),
  );
}

describe("Asaas", () => {
  let server: Awaited<ReturnType<typeof fakeServer>>;

  beforeEach(async () => {
    freshBrowser(`203.0.113.${Math.floor(Math.random() * 250)}`);
    // Orders left open by other tests would get Asaas charges too.
    await db()
      .update(order)
      .set({ status: "canceled" })
      .where(and(eq(order.status, "pending"), isNull(order.psp)));
    server = await fakeServer({});
    redirectFetch(/^https:\/\/api(-sandbox)?\.asaas\.com/, server.url);
    await saveCredentials("asaas", {}, { apiKey: KEY, webhookSecret: TOKEN });
    await saveCredentials("pix", { provider: "asaas" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeCredentials("asaas");
    await saveCredentials("pix", { provider: "static" });
    await server.close();
  });

  function charge(id: string, orderId: string, status: string, extra: object = {}) {
    server.routes[`GET /v3/payments/${id}`] = {
      status: 200,
      body: { id, status, value: 97, netValue: 95.01, billingType: "PIX", externalReference: orderId, ...extra },
    };
  }

  async function asAsaas(email: string, txid: string) {
    const id = await buy({ email, document: CPF });
    await db().update(order).set({ psp: "asaas", txid }).where(eq(order.id, id));
    return id;
  }

  function creating(pay: string, customers: object[] = [{ id: "cus_antigo" }]) {
    server.routes["GET /v3/customers"] = { status: 200, body: { data: customers } };
    server.routes["POST /v3/customers"] = { status: 200, body: { id: "cus_novo" } };
    server.routes["GET /v3/payments"] = { status: 200, body: { data: [] } };
    server.routes["POST /v3/payments"] = { status: 200, body: { id: pay, status: "PENDING" } };
    server.routes[`GET /v3/payments/${pay}/pixQrCode`] = {
      status: 200,
      body: { encodedImage: "x", payload: "00020126ASAAS", expirationDate: "2027-11-14 23:59:59" },
    };
  }

  test("cobrança: cria o pix com valor em reais, referência do pedido e o copia e cola do asaas", async () => {
    creating("pay_1");
    const id = await buy({ email: "asaas-c1@example.com", document: "529.982.247-25" });
    await attachCharges();
    const created = server.to("POST", "/v3/payments")[0];
    expect(created?.headers["access_token"]).toBe(KEY);
    const due = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format((await stored(id)).expiresAt);
    expect(JSON.parse(created?.body ?? "{}")).toMatchObject({
      customer: "cus_antigo",
      billingType: "PIX",
      value: 97,
      dueDate: due,
      externalReference: id,
    });
    expect(await stored(id)).toMatchObject({ psp: "asaas", txid: "pay_1", pixCode: "00020126ASAAS" });
  });

  test("cliente: usa o existente pelo cpf e cria só quando não há", async () => {
    creating("pay_c2a");
    await buy({ email: "asaas-c2a@example.com", document: CPF });
    await attachCharges();
    expect(server.to("GET", "/v3/customers")[0]?.path).toContain(`cpfCnpj=${CPF}`);
    expect(server.to("POST", "/v3/customers")).toHaveLength(0);

    creating("pay_c2b", []);
    const before = server.to("POST", "/v3/payments").length;
    await buy({ email: "asaas-c2b@example.com", document: CPF });
    await attachCharges();
    const made = server.to("POST", "/v3/customers");
    expect(made).toHaveLength(1);
    expect(JSON.parse(made[0]?.body ?? "{}")).toEqual({
      name: "Ana Souza",
      cpfCnpj: CPF,
      email: "asaas-c2b@example.com",
      notificationDisabled: true,
    });
    expect(JSON.parse(server.to("POST", "/v3/payments")[before]?.body ?? "{}").customer).toBe("cus_novo");
  });

  test("falha: asaas fora do ar mantém o pix estático e a nova tentativa não duplica a cobrança", async () => {
    creating("pay_c3");
    server.routes["POST /v3/payments"] = { status: 500, body: { errors: [] } };
    const id = await buy({ email: "asaas-c3@example.com", document: CPF });
    const pix = (await stored(id)).pixCode;
    await attachCharges();
    expect(await stored(id)).toMatchObject({ psp: null, pixCode: pix });

    const posts = server.to("POST", "/v3/payments").length;
    server.routes["GET /v3/payments"] = {
      status: 200,
      body: { data: [{ id: "pay_c3", status: "PENDING", value: 97, externalReference: id }] },
    };
    await attachCharges();
    expect(server.to("GET", "/v3/payments").at(-1)?.path).toContain(`externalReference=${id}`);
    expect(server.to("POST", "/v3/payments")).toHaveLength(posts);
    expect(await stored(id)).toMatchObject({ psp: "asaas", txid: "pay_c3", pixCode: "00020126ASAAS" });
  });

  test("sem cpf: pedido antigo sem documento fica no pix estático", async () => {
    creating("pay_c4");
    const id = await buy({ email: "asaas-c4@example.com", document: CPF });
    await db().update(order).set({ document: null }).where(eq(order.id, id));
    await attachCharges();
    expect(server.to("POST", "/v3/payments")).toHaveLength(0);
    expect((await stored(id)).psp).toBeNull();
  });

  test("conexão: testar aceita a chave e recusa 401; chave de sandbox usa o host de sandbox", async () => {
    server.routes["GET /v3/customers"] = { status: 200, body: { data: [] } };
    expect(await testPsp("asaas")).toBeNull();
    expect(server.to("GET", "/v3/customers")[0]?.headers["access_token"]).toBe(KEY);
    server.routes["GET /v3/customers"] = { status: 401, body: { errors: [] } };
    expect(await testPsp("asaas")).toBe("PSP_REJECTED");

    vi.restoreAllMocks();
    const hosts: string[] = [];
    const real = globalThis.fetch;
    fakeFetch(async (url, init) => {
      hosts.push(new URL(url).host);
      return real(url.replace(/^https:\/\/api(-sandbox)?\.asaas\.com/, server.url), init);
    });
    await saveCredentials("asaas", {}, { apiKey: "$aact_hmlg_teste", webhookSecret: TOKEN });
    server.routes["GET /v3/customers"] = { status: 200, body: { data: [] } };
    expect(await testPsp("asaas")).toBeNull();
    expect(hosts).toEqual(["api-sandbox.asaas.com"]);
  });

  test("webhook: token errado 401, certo antecipa a releitura, cobrança desconhecida não acha pedido", async () => {
    const id = await asAsaas("asaas-c6@example.com", "pay_c6");
    const later = new Date(Date.now() + 3600_000);
    await db().update(order).set({ pspCheckAt: later }).where(eq(order.id, id));
    expect((await notice("pay_c6", "wrong-token-wrong-token-wrong-token")).status).toBe(401);
    expect((await notice("pay_c6", null)).status).toBe(401);
    expect((await stored(id)).pspCheckAt?.getTime()).toBe(later.getTime());
    expect(await (await notice("pay_c6")).json()).toEqual({ ok: true });
    expect((await stored(id)).pspCheckAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await (await notice("pay_desconhecido")).json()).toEqual({ code: "ORDER_NOT_FOUND" });

    await removeCredentials("asaas");
    expect((await notice("pay_c6")).status).toBe(404);
  });

  test("pago: received e confirmed liberam uma vez só", async () => {
    const received = await asAsaas("asaas-c7a@example.com", "pay_c7a");
    const confirmed = await asAsaas("asaas-c7b@example.com", "pay_c7b");
    charge("pay_c7a", received, "RECEIVED");
    charge("pay_c7b", confirmed, "CONFIRMED");
    await Promise.all([notice("pay_c7a"), notice("pay_c7a"), notice("pay_c7a"), notice("pay_c7b")]);
    await Promise.all([checkCharges(), checkCharges()]);
    await notice("pay_c7a");
    await checkCharges();
    expect((await stored(received)).status).toBe("paid");
    expect((await stored(confirmed)).status).toBe("paid");
    expect(await payments(received)).toBe(1);
    const [row] = await db().select({ amount: payment.amount }).from(payment).where(eq(payment.orderId, received));
    expect(row?.amount).toBe(9700);
  });

  test("estorno: refunded e estorno done revogam, estorno pendente não", async () => {
    const full = await asAsaas("asaas-c8a@example.com", "pay_c8a");
    const partial = await asAsaas("asaas-c8b@example.com", "pay_c8b");
    const pending = await asAsaas("asaas-c8c@example.com", "pay_c8c");
    for (const [txid, id] of [["pay_c8a", full], ["pay_c8b", partial], ["pay_c8c", pending]] as const) {
      charge(txid, id, "RECEIVED");
      await notice(txid);
    }
    await checkCharges();
    expect((await stored(full)).status).toBe("paid");

    charge("pay_c8a", full, "REFUNDED");
    charge("pay_c8b", partial, "RECEIVED", { refunds: [{ status: "DONE", value: 97, endToEndIdentifier: "E1" }] });
    charge("pay_c8c", pending, "RECEIVED", { refunds: [{ status: "PENDING", value: 97 }] });
    for (const txid of ["pay_c8a", "pay_c8b", "pay_c8c"]) await notice(txid);
    await checkCharges();
    expect((await stored(full)).status).toBe("refunded");
    expect((await stored(partial)).status).toBe("refunded");
    expect((await stored(pending)).status).toBe("paid");
  });

  test("chargeback: chargeback pedido revoga o acesso", async () => {
    const id = await asAsaas("asaas-c9@example.com", "pay_c9");
    charge("pay_c9", id, "RECEIVED");
    await notice("pay_c9");
    await checkCharges();
    expect((await stored(id)).status).toBe("paid");
    charge("pay_c9", id, "CHARGEBACK_REQUESTED");
    await notice("pay_c9");
    await checkCharges();
    expect((await stored(id)).status).toBe("refunded");
  });

  test("desencontro: cobrança de outro pedido ou valor menor não libera", async () => {
    const other = await asAsaas("asaas-c10a@example.com", "pay_c10a");
    const short = await asAsaas("asaas-c10b@example.com", "pay_c10b");
    charge("pay_c10a", "outro-pedido", "RECEIVED");
    charge("pay_c10b", short, "RECEIVED", { value: 50 });
    await notice("pay_c10a");
    await notice("pay_c10b");
    await checkCharges();
    expect((await stored(other)).status).toBe("pending");
    expect((await stored(short)).status).toBe("pending");
  });

  test("checkout: com o asaas o cpf é obrigatório, sem ele continua opcional", async () => {
    const base = { slug: "bolo-no-pote", name: "Ana Souza", email: "asaas-c11@example.com", touch: "" };
    const count = () => db().$count(order);
    const before = await count();
    expect((await createOrder({ code: null }, form(base))).code).toBe("INVALID_DOCUMENT");
    expect((await createOrder({ code: null }, form({ ...base, document: "123.456.789-00" }))).code).toBe(
      "INVALID_DOCUMENT",
    );
    expect(await count()).toBe(before);
    const id = await buy({ email: "asaas-c11b@example.com", document: "529.982.247-25" });
    expect((await stored(id)).document).toBe(CPF);

    await saveCredentials("pix", { provider: "static" });
    const free = await buy({ email: "asaas-c11c@example.com" });
    expect((await stored(free)).document).toBeNull();
  });

  test("painel: o asaas aparece com os eventos e recusa token curto", async () => {
    const asaas = (await integrations()).pix.providers.find((provider) => provider.id === "asaas");
    expect(asaas).toMatchObject({ name: "Asaas", active: true, configured: true });
    expect(asaas?.webhookUrl).toEndWith("/api/webhooks/payment?psp=asaas");
    expect(asaas?.events).toEqual([
      "PAYMENT_RECEIVED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]);
    expect(PIX_HELP.asaas.apiKey).toBe("Chave da API");
    expect(PIX_HELP.asaas.webhookSecret).toStartWith("Token do webhook");

    await signInAsAdmin();
    const short = await savePix({ code: null }, form({ provider: "asaas", apiKey: KEY, webhookSecret: "x".repeat(31) }));
    expect(short.code).toBe("INVALID_WEBHOOK_SECRET");
  });
});
