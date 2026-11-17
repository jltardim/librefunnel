import "server-only";
import { eq } from "drizzle-orm";
import { isObject, jsonObject, safeEqual } from "../guard";
import type { Json } from "../guard";
import { order } from "../schema";
import { busy, callPsp, cents, credentialsReply, limited, mismatch, objects } from "./psp";
import type { Adapter, Notice, PspKeys } from "./psp";

const PAID = ["RECEIVED", "CONFIRMED"];
const CHARGEBACK = ["CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"];

// Asaas speaks reais with cents as decimals; the store keeps integer cents.
function asCents(value: Json | undefined): number | undefined {
  return typeof value === "number" ? cents(Math.round(value * 100)) : undefined;
}

// The Pix stays payable until the end of this day in São Paulo, the order's own deadline day.
function dueDate(seconds: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(Date.now() + seconds * 1000);
}

// The token is the one the owner typed when creating the webhook in the Asaas panel.
function asaasNotice(raw: string, keys: PspKeys, headers: Headers): Notice {
  if (!safeEqual(headers.get("asaas-access-token") ?? "", keys.webhookSecret))
    return { code: "INVALID_SIGNATURE", status: 401 };
  const charge = jsonObject(raw)?.payment;
  return { match: isObject(charge) && typeof charge.id === "string" ? eq(order.txid, charge.id) : undefined };
}

// One Asaas customer per CPF or CNPJ, so the owner's panel does not fill with copies of the same buyer.
async function customerId(
  row: { name: string; email: string; document: string },
  keys: PspKeys,
): Promise<string | { status: number }> {
  const found = await callPsp("asaas", keys.apiKey, `/v3/customers?cpfCnpj=${row.document}`);
  if (found.status >= 300) return { status: found.status };
  const existing = objects(found.body?.data)[0]?.id;
  if (typeof existing === "string") return existing;

  const made = await callPsp("asaas", keys.apiKey, "/v3/customers", {
    name: row.name,
    cpfCnpj: row.document,
    email: row.email,
    notificationDisabled: true,
  });
  return made.status < 300 && typeof made.body?.id === "string" ? made.body.id : { status: made.status };
}

// Asaas takes no idempotency key, so a retry first looks for the charge an earlier attempt already made.
async function chargeId(
  row: { id: string; amount: number; name: string; email: string; document: string },
  keys: PspKeys,
  seconds: number,
): Promise<string | { status: number }> {
  const earlier = await callPsp("asaas", keys.apiKey, `/v3/payments?externalReference=${row.id}`);
  if (earlier.status >= 300) return { status: earlier.status };
  const open = objects(earlier.body?.data).find(
    (entry) => entry.externalReference === row.id && entry.status === "PENDING" && typeof entry.id === "string",
  );
  if (typeof open?.id === "string") return open.id;

  const customer = await customerId(row, keys);
  if (typeof customer !== "string") return customer;
  const made = await callPsp("asaas", keys.apiKey, "/v3/payments", {
    customer,
    billingType: "PIX",
    value: row.amount / 100,
    dueDate: dueDate(seconds),
    externalReference: row.id,
    description: `Pedido ${row.id}`,
  });
  return made.status < 300 && typeof made.body?.id === "string" ? made.body.id : { status: made.status };
}

export const asaas: Adapter = {
  async create(row, keys, seconds) {
    // Asaas requires a CPF or CNPJ for every customer; an order without one keeps its static Pix.
    if (!row.document) return { status: 422 };
    const id = await chargeId({ ...row, document: row.document }, keys, seconds);
    if (typeof id !== "string") return id;
    const qr = await callPsp("asaas", keys.apiKey, `/v3/payments/${encodeURIComponent(id)}/pixQrCode`);
    const payload = qr.body?.payload;
    return qr.status < 300 && typeof payload === "string" ? { txid: id, pixCode: payload } : { status: qr.status };
  },
  async fetch(row, keys) {
    const response = await callPsp("asaas", keys.apiKey, `/v3/payments/${encodeURIComponent(row.txid)}`);
    if (busy(response)) return limited(response);
    const charge = response.body;
    const amount = asCents(charge?.value);
    if (response.status >= 300 || !charge || charge.id !== row.txid || charge.externalReference !== row.id || !amount)
      return mismatch("asaas", row.id, response.status);

    // Each finished refund is debited by its own Pix id; a refund still pending moves nothing yet.
    const debits = objects(charge.refunds).flatMap((entry, index) => {
      const value = asCents(entry.value);
      const key = typeof entry.endToEndIdentifier === "string" ? entry.endToEndIdentifier : String(index);
      return entry.status === "DONE" && value ? [{ amount: -value, externalId: `asaas:refund:${row.txid}:${key}` }] : [];
    });

    const status = typeof charge.status === "string" ? charge.status : "";
    if (debits.length) return { movements: debits, raw: response.raw };
    if (status === "REFUNDED" || CHARGEBACK.includes(status))
      return { movements: [{ amount: -amount, externalId: `asaas:${row.txid}:revoked` }], raw: response.raw };
    return {
      movements: PAID.includes(status) ? [{ amount, externalId: `asaas:${row.txid}` }] : [],
      raw: response.raw,
    };
  },
  notice: asaasNotice,
  async test(keys) {
    return credentialsReply(await callPsp("asaas", keys.apiKey, "/v3/customers?limit=1"));
  },
};
