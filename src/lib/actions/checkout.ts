"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import * as catalog from "../catalog/products";
import * as coupons from "../coupons";
import { clientIp, limited } from "../guard";
import { ID, parseCpfCnpj, parseEmail, parseName, parsePhone } from "../input";
import * as members from "../members";
import * as charges from "../orders/charges";
import * as checkout from "../orders/checkout";
import * as payments from "../orders/payments";
import * as config from "../settings";
import { browserIds, fbcFor, recordTouch, visitor } from "../tracking/visitors";
import { done, field } from "./form";
import type { ActionState, FormArgs } from "./form";

export async function createOrder(...[, form]: FormArgs): Promise<ActionState> {
  const product = await catalog.getProduct(field(form, "slug"));
  if (!product) return { code: "PRODUCT_NOT_FOUND" };
  const name = parseName(field(form, "name"));
  if (!name) return { code: "INVALID_NAME" };
  const email = parseEmail(field(form, "email"));
  if (!email) return { code: "INVALID_EMAIL" };
  const { checkoutPhone } = await config.settings();
  const rawPhone = checkoutPhone === "hidden" ? "" : field(form, "phone").trim();
  if (!rawPhone && checkoutPhone === "required") return { code: "INVALID_PHONE" };
  const phone = rawPhone ? parsePhone(rawPhone) : null;
  if (phone === undefined) return { code: "INVALID_PHONE" };
  const asked = await charges.documentField();
  const document = asked === "hidden" ? null : parseCpfCnpj(field(form, "document"));
  if (document === undefined || (document === null && asked === "required")) return { code: "INVALID_DOCUMENT" };
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  if (limited("order", ip, 20, 600)) return { code: "RATE_LIMITED" };
  const typed = field(form, "coupon").trim();
  const coupon = typed ? await coupons.tryCoupon(typed, product, email, ip) : undefined;
  if (coupon && "code" in coupon) return { code: coupon.code };
  const visitorId = await visitor();
  await recordTouch(visitorId, field(form, "touch"), "", `/c/${product.slug}`);
  const browser = await browserIds();

  const result = await checkout.placeOrder({
    product,
    name,
    email,
    phone,
    document,
    coupon,
    bump: field(form, "bump") === "1",
    ownOrder: await members.orderFromCookie(),
    visitorId,
    ip,
    userAgent: (requestHeaders.get("user-agent") ?? "").slice(0, 500),
    browser: { ...browser, fbc: browser.fbc ?? (await fbcFor(visitorId)) },
  });

  if ("code" in result) return { code: result.code };
  await members.rememberOrder(result.id);
  after(charges.attachCharges);
  redirect(`/c/${product.slug}?order=${result.id}`);
}

export async function simulatePayment(...[, form]: FormArgs): Promise<ActionState> {
  const orderId = field(form, "orderId");
  if (!ID.test(orderId)) return { code: "ORDER_NOT_FOUND" };
  return done(await payments.simulatePayment(orderId));
}
