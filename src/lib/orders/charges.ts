import "server-only";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import { credentials } from "../settings";
import { addSeconds, db } from "../db";
import { demoMode } from "../guard";
import { invoicesOn } from "../invoices";
import { customer, order } from "../schema";
import { abacatepay } from "./abacatepay";
import { asaas } from "./asaas";
import type { OrderCode, OrderStatus } from "./checkout";
import { depix } from "./depix";
import { mercadopago } from "./mercadopago";
import { noxpay } from "./noxpay";
import { recordPayment } from "./payments";
import { PSPS, pspConfigured, pspKeys, pspOf } from "./psp";
import type { Adapter, Psp } from "./psp";
import { refreshWebhookKeys, woovi } from "./woovi";

export const ADAPTERS: Record<Psp, Adapter> = { mercadopago, woovi, abacatepay, depix, noxpay, asaas };

export type DocumentField = "hidden" | "optional" | "required";

// Asaas creates no charge without the buyer's CPF or CNPJ, so with it the field stops being optional.
export async function documentField(): Promise<DocumentField> {
  if ((await credentials("pix"))("pix")("provider") === "asaas") return "required";
  return (await invoicesOn()) ? "optional" : "hidden";
}

export async function testPsp(psp: Psp): Promise<OrderCode | null> {
  const keys = pspKeys((await credentials(psp))(psp));
  if (!pspConfigured(psp, keys)) return "PSP_NOT_CONFIGURED";
  try {
    const code = await ADAPTERS[psp].test(keys);
    if (psp === "woovi" && !code) await refreshWebhookKeys();
    return code;
  } catch {
    return "PSP_UNREACHABLE";
  }
}

// Static Pix is issued at checkout; the PSP charge replaces it in the background so a PSP outage never blocks the sale.
export async function attachCharges() {
  const stored = await credentials("pix", ...PSPS);
  const psp = pspOf(stored("pix")("provider"));
  const keys = psp && pspKeys(stored(psp));
  // Every PSP charge starts here; checks and webhooks only follow orders that have one.
  if (!psp || !keys || !pspConfigured(psp, keys) || demoMode()) return;
  const t = new Date();

  const rows = await db()
    .select({
      id: order.id,
      product: order.product,
      amount: order.amount,
      name: order.name,
      phone: order.phone,
      document: order.document,
      expiresAt: order.expiresAt,
      email: customer.email,
    })
    .from(order)
    .innerJoin(customer, eq(customer.id, order.customerId))
    .where(and(eq(order.status, "pending"), isNull(order.psp), gt(order.createdAt, addSeconds(t, -600))))
    // Newest first: orders the provider keeps refusing never hold back a buyer who is waiting on the page right now.
    .orderBy(desc(order.createdAt))
    .limit(20);

  for (const row of rows) {
    try {
      const charge = await ADAPTERS[psp].create(row, keys, Math.floor((row.expiresAt.getTime() - t.getTime()) / 1000));

      if ("status" in charge) {
        console.warn(`[librefunnel] ${psp} charge for ${row.id} refused with HTTP ${charge.status}`);
        continue;
      }
      await db()
        .update(order)
        // DePix is the one provider whose webhooks are never retried, so it is polled every minute from the start.
        .set({
          psp,
          txid: charge.txid,
          pixCode: charge.pixCode,
          pspCheckAt: psp === "depix" ? addSeconds(t, 60) : reconcileAt("pending", t, row.expiresAt, t),
        })
        .where(and(eq(order.id, row.id), isNull(order.psp), eq(order.status, "pending")));
    } catch (error) {
      console.warn(`[librefunnel] ${psp} unreachable for ${row.id}`, error);
    }
  }
}

// Webhooks get lost, so every order is also re-checked on its own: while it can still be paid, then through the MED
// window (a payer can claim a Pix back for up to 80 days). Points are minutes after creation, then days.
const OPEN_CHECKS_MIN = [5, 30, 120];
const PAID_CHECKS_DAYS = [1, 7, 30, 85];
const LATE_PAYMENT_MIN = 10;

function reconcileAt(status: OrderStatus, createdAt: Date, expiresAt: Date, now: Date): Date | null {
  if (status === "refunded") return null;
  const lastChance = addSeconds(expiresAt, LATE_PAYMENT_MIN * 60);

  const points =
    status === "paid"
      ? PAID_CHECKS_DAYS.map((days) => addSeconds(createdAt, days * 86_400))
      : [
          ...OPEN_CHECKS_MIN.map((minutes) => addSeconds(createdAt, minutes * 60)).filter((at) => at < lastChance),
          lastChance,
        ];

  return points.find((at) => at > now) ?? null;
}

// Each order is checked with the provider that issued it, even after the store switched providers.
export async function checkCharges() {
  const rows = await db()
    .select({
      id: order.id,
      txid: order.txid,
      psp: order.psp,
      status: order.status,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
    })
    .from(order)
    .where(and(lte(order.pspCheckAt, new Date()), isNotNull(order.psp)))
    .orderBy(asc(order.pspCheckAt))
    .limit(20);

  if (rows.length === 0) return;
  const stored = await credentials(...PSPS);
  const paused = new Set<string>();

  for (const row of rows) {
    const checkAt = (at: Date | null) => db().update(order).set({ pspCheckAt: at }).where(eq(order.id, row.id));
    const psp = pspOf(row.psp);
    const keys = psp && pspKeys(stored(psp));
    if (!psp || !keys?.apiKey) {
      await checkAt(null);
      console.warn(`[librefunnel] no credentials to check ${row.id} with ${row.psp}`);
      continue;
    }
    if (paused.has(psp)) continue;
    try {
      const fetched = await ADAPTERS[psp].fetch(row, keys);
      if ("retryIn" in fetched) {
        const at = addSeconds(new Date(), fetched.retryIn);
        if (!fetched.limited) {
          await checkAt(at);
          continue;
        }
        // The provider asked to slow down: every due order of that provider waits, not only this one.
        paused.add(psp);
        await db()
          .update(order)
          .set({ pspCheckAt: at })
          .where(and(eq(order.psp, psp), lte(order.pspCheckAt, at)));
        continue;
      }
      for (const movement of fetched.movements)
        await recordPayment(row.id, movement.amount, movement.externalId, fetched.raw);

      const [after] = fetched.movements.length
        ? await db().select({ status: order.status }).from(order).where(eq(order.id, row.id))
        : [row];

      await checkAt(reconcileAt(after?.status ?? row.status, row.createdAt, row.expiresAt, new Date()));
    } catch (error) {
      await checkAt(addSeconds(new Date(), 60));
      console.warn(`[librefunnel] ${psp} unreachable while checking ${row.id}`, error);
    }
  }
}
