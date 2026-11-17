"use server";

import { revalidatePath } from "next/cache";
import * as catalog from "../catalog/products";
import { demoMode, limited } from "../guard";
import { isAdmin } from "../sessions";
import { BUCKET, CREDENTIAL, HOST, parseCredential, parseEmail, parseInteger, parseRate } from "../input";
import * as invoices from "../invoices";
import { connectStorage, setUpR2, testStorage } from "../media/storage";
import * as messages from "../messages";
import * as charges from "../orders/charges";
import * as crypto from "../orders/crypto";
import * as providers from "../orders/psp";
import * as webhooks from "../orders/webhooks";
import { company } from "../registry";
import * as config from "../settings";
import { testConversions } from "../tracking/conversions";
import { done, field, pixFields } from "./form";
import type { ActionState, FormArgs } from "./form";

export type WhatsAppState = ActionState & { qr?: string; pairingCode?: string };

const REMOVABLE = [
  "smtp",
  "meta",
  "tiktok",
  "analytics",
  "googleads",
  "mercadopago",
  "woovi",
  "abacatepay",
  "depix",
  "noxpay",
  "webhook",
  "evolution",
  "whatsapp",
  "storage",
  "nfse",
] as const;

const CERTIFICATE_LIMIT = 64 * 1024;

// AWS and Backblaze put the region in the host (s3.us-east-2.amazonaws.com); R2 and most others take "auto".
const REGION = /^s3[.-]([a-z]{2}-[a-z]+-\d{1,3})\.(?:amazonaws\.com|backblazeb2\.com)$/;

export async function connectWhatsApp(): Promise<WhatsAppState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const result = await messages.connectWhatsApp();
  revalidatePath("/admin");
  return result;
}

export async function disconnectWhatsApp(): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  return done(await messages.disconnectWhatsApp());
}

// The form field "kind" is smtp, an ad platform, evolution, whatsapp, storage, nfse or a Pix provider id.
export async function testConnection(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const kind = field(form, "kind");
  const psp = providers.pixProvider(kind);
  const ads = (["meta", "tiktok", "analytics", "googleads"] as const).find((platform) => platform === kind);
  const known = ads !== undefined || ["smtp", "evolution", "whatsapp", "storage", "nfse"].includes(kind);
  if (!known && (!psp || psp === "static")) return { code: "INVALID_PAYLOAD" };
  if (limited("test", kind, 10, 600)) return { code: "RATE_LIMITED" };
  if (kind === "storage") return done(await testStorage());
  if (kind === "smtp") return done(await messages.testEmail());
  if (kind === "evolution") return done(await messages.testWhatsApp());
  if (kind === "whatsapp") return done(await messages.testCloud());
  if (ads) return done(await testConversions(ads));
  if (kind === "nfse") return done(await invoices.testNfse());
  return done(psp && psp !== "static" ? await charges.testPsp(psp) : "INVALID_PAYLOAD");
}

export async function saveSmtp(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const preset = messages.SMTP_PRESETS.find((entry) => entry.id === field(form, "preset"));
  const typedHost = field(form, "host").trim().toLowerCase();
  const known = preset || typedHost ? undefined : messages.smtpServer(field(form, "user").trim().toLowerCase());
  const host = preset?.host ?? known?.host ?? typedHost;
  if (!HOST.test(host)) return { code: "INVALID_HOST" };
  const port = preset?.port ?? known?.port ?? parseInteger(field(form, "port") || "587", 1, 65_535);
  if (port === undefined) return { code: "INVALID_PORT" };
  const user = field(form, "user").trim();
  const password = parseCredential(field(form, "password"));
  if (password === undefined || (user && !CREDENTIAL.test(user))) return { code: "INVALID_CREDENTIAL" };
  const rawFrom = field(form, "from").trim();
  const from = rawFrom ? parseEmail(rawFrom) : "";
  if (from === undefined || (!from && !parseEmail(user))) return { code: "INVALID_EMAIL" };
  await config.saveCredentials("smtp", { host, port: String(port), user, from }, { password });
  const address = from || parseEmail(user);
  await config.fillSettings({ support_email: address, owner_email: address });
  return done(null);
}

export async function connectR2(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const token = field(form, "token").trim();
  if (!/^[\w-]{20,200}$/.test(token)) return { code: "CLOUDFLARE_TOKEN_INVALID" };
  if (limited("test", "storage", 10, 600)) return { code: "RATE_LIMITED" };
  const code = await setUpR2(token);
  return code ? { code } : done(null);
}

export async function saveStorage(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  // R2 shows the S3 address with the bucket at the end, so that form is accepted as pasted.
  const endpoint = URL.parse(field(form, "endpoint").trim());
  const path = endpoint?.pathname.replace(/^\/|\/$/g, "") ?? "";
  if (!endpoint || endpoint.protocol !== "https:" || endpoint.search || path.includes("/"))
    return { code: "INVALID_ENDPOINT" };
  const bucket = (field(form, "bucket").trim() || path).toLowerCase();
  if (!BUCKET.test(bucket)) return { code: "INVALID_BUCKET" };

  const region =
    REGION.exec(endpoint.hostname)?.[1] ?? (endpoint.hostname === "s3.amazonaws.com" ? "us-east-1" : "auto");

  const accessKey = field(form, "accessKey").trim();
  const secret = parseCredential(field(form, "secret"));
  if (!CREDENTIAL.test(accessKey) || secret === undefined) return { code: "INVALID_CREDENTIAL" };
  const kept = secret || (await config.credentials("storage"))("storage")("secret");
  if (!kept) return { code: "INVALID_CREDENTIAL" };
  if (limited("test", "storage", 10, 600)) return { code: "RATE_LIMITED" };

  const code = await connectStorage({
    endpoint: endpoint.origin,
    name: bucket,
    region,
    accessKey,
    secret: kept,
  });

  if (code) return { code };
  await config.saveCredentials("storage", { endpoint: endpoint.origin, bucket, region, accessKey }, { secret });
  return done(null);
}

// Saves the provider's keys and makes it the one new orders use; orders already issued keep their provider.
export async function savePix(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const provider = providers.pixProvider(field(form, "provider"));
  if (!provider) return { code: "INVALID_PAYLOAD" };
  if (provider !== "static") {
    const apiKey = parseCredential(field(form, "apiKey"));
    const webhookSecret = parseCredential(field(form, "webhookSecret"));
    const clientId = field(form, "clientId").trim();
    if (apiKey === undefined || webhookSecret === undefined || (clientId && !CREDENTIAL.test(clientId)))
      return { code: "INVALID_CREDENTIAL" };
    if ((provider === "abacatepay" || provider === "depix") && webhookSecret && webhookSecret.length < 32)
      return { code: "INVALID_WEBHOOK_SECRET" };
    // Asaas takes a webhook token of 32 to 255 characters.
    if (provider === "asaas" && webhookSecret && (webhookSecret.length < 32 || webhookSecret.length > 255))
      return { code: "INVALID_WEBHOOK_SECRET" };

    const fields =
      provider === "depix" ? { clientId } : provider === "noxpay" ? { currency: field(form, "currency") } : {};

    const stored = providers.pspKeys((await config.credentials(provider))(provider));

    const ready = providers.pspConfigured(provider, {
      ...stored,
      ...fields,
      apiKey: apiKey || stored.apiKey,
      webhookSecret: webhookSecret || stored.webhookSecret,
    });

    if (!ready) return { code: "PIX_PROVIDER_NOT_CONFIGURED" };
    await config.saveCredentials(provider, fields, { apiKey, webhookSecret });
  }
  await config.saveCredentials("pix", { provider });
  return done(null);
}

// The store's key: where the money of "Pix na sua chave" lands, and the fallback code if a provider is down.
export async function savePixKey(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const pix = await pixFields(form);
  if ("code" in pix) return pix;
  await catalog.saveStorePix(pix);
  // A first key in a store that never chose how to receive means receiving on it.
  if (!(await config.credentials("pix"))("pix")("provider"))
    await config.saveCredentials("pix", { provider: "static" });
  return done(null);
}

// Turning conversion on checks the AppID against Woovi's quote, which needs the same permission as the conversion.
export async function saveWooviCrypto(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const mode = field(form, "mode");
  if (mode !== "off" && mode !== "balance" && mode !== "sale") return { code: "INVALID_PAYLOAD" };
  if (mode === "off") {
    await config.saveCredentials("woovi", { convertMode: "off", convertError: "" });
    return done(null);
  }
  const asset = crypto.wooviAsset(field(form, "asset"));
  if (!asset) return { code: "INVALID_PAYLOAD" };
  const wallet = crypto.cryptoWallet(asset, field(form, "wallet"));
  if (!wallet) return { code: "INVALID_WALLET" };
  if (limited("test", "woovi-crypto", 10, 600)) return { code: "RATE_LIMITED" };
  const code = await crypto.testConversion(asset);
  if (code) return { code };
  const previous = (await config.credentials("woovi"))("woovi")("convertMode");

  await config.saveCredentials("woovi", {
    convertMode: mode,
    convertAsset: asset,
    convertWallet: wallet,
    convertNextAt: "",
    convertError: "",
    // Sales made before conversion per sale was turned on stay in reais.
    ...(mode === "sale" && previous !== "sale" ? { convertSince: String(Date.now()) } : {}),
  });

  return done(null);
}

// A blank address goes back to the Evolution bundled with the server.
export async function saveEvolution(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const url = field(form, "url").trim().replace(/\/+$/, "");
  if (!url) {
    await config.removeCredentials("evolution");
    return done(null);
  }
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url) || url.length > 300) return { code: "INVALID_EVOLUTION_URL" };
  const key = parseCredential(field(form, "key"));
  const stored = (await config.credentials("evolution"))("evolution");
  // The kept key goes only to the address it was typed for, never to a new one.
  if (key === undefined || (!key && (!stored("key") || stored("url") !== url))) return { code: "INVALID_CREDENTIAL" };
  await config.saveCredentials("evolution", { url }, { key });
  return done(null);
}

export async function saveCloud(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const stored = (await config.credentials("whatsapp"))("whatsapp");
  const token = parseCredential(field(form, "token")) || stored("token");
  if (!token) return { code: "INVALID_CREDENTIAL" };
  const appSecret = field(form, "appSecret").trim().toLowerCase() || stored("appSecret");
  if (!/^[0-9a-f]{32}$/.test(appSecret)) return { code: "CLOUD_APP_SECRET_INVALID" };
  const phoneId = field(form, "phoneId");
  const pin = field(form, "pin").trim();
  if (phoneId && !/^\d{1,30}$/.test(phoneId)) return { code: "INVALID_PAYLOAD" };
  if (pin && !/^\d{6}$/.test(pin)) return { code: "CLOUD_PIN_INVALID" };
  if (limited("cloud", "connect", 10, 600)) return { code: "RATE_LIMITED" };
  return done(await messages.connectCloud({ token, appSecret, phoneId, pin }));
}

// The certificate is read once here: only its key and chain are kept, sealed; the file and its password are not.
// Blank fiscal fields come from the CNPJ registry, so a first connection needs only the certificate.
export async function saveNfse(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const file = form.get("certificate");
  const fresh = file instanceof File && file.size > 0;
  if (fresh && file.size > CERTIFICATE_LIMIT) return { code: "CERTIFICATE_UNREADABLE" };
  const stored = (await config.credentials("nfse"))("nfse");
  if (!fresh && !stored("chain")) return { code: "CERTIFICATE_UNREADABLE" };
  if (limited("test", "nfse", 10, 600)) return { code: "RATE_LIMITED" };

  const certificate = fresh
    ? await invoices.readCertificate(Buffer.from(await file.arrayBuffer()), field(form, "password"))
    : undefined;

  if (typeof certificate === "string") return { code: certificate };
  // A certificate of another company drops the fields typed for the previous one; a first connection keeps them.
  const same = !certificate || !stored("cnpj") || certificate.cnpj === stored("cnpj");
  const typedCity = same ? field(form, "city").trim() : "";
  const typedRegime = same ? invoices.regime(field(form, "regime")) : undefined;
  const cnpj = certificate?.cnpj ?? stored("cnpj");
  const found = typedCity && typedRegime ? undefined : await company(cnpj);
  const city = typedCity || found?.city;
  const regime = typedRegime ?? (found && invoices.regimeOf(found));
  if (!city || !regime) return { code: "CNPJ_LOOKUP_FAILED" };
  if (!/^\d{7}$/.test(city)) return { code: "INVALID_CITY" };
  const service = (same ? field(form, "service") : "").replace(/\D/g, "") || "080201";
  if (!/^\d{6}$/.test(service)) return { code: "INVALID_SERVICE" };
  const registration = same ? field(form, "registration").trim() : "";
  if (registration && !/^[A-Za-z0-9.\-/]{1,15}$/.test(registration)) return { code: "INVALID_PAYLOAD" };
  const immunity = invoices.immunity(same ? field(form, "immunity") : "");
  if (immunity === undefined) return { code: "INVALID_PAYLOAD" };
  const defaults = invoices.DEFAULT_RATES[regime];
  const taxRate = regime === "mei" ? "" : parseRate((same && field(form, "taxRate")) || defaults.taxRate);
  const issRate = regime === "normal" ? parseRate((same && field(form, "issRate")) || defaults.issRate) : "";
  if (taxRate === undefined || issRate === undefined) return { code: "INVALID_RATE" };

  await config.saveCredentials(
    "nfse",
    {
      city,
      place: found ? `${found.town}/${found.uf}` : city === stored("city") ? stored("place") : "",
      regime,
      service,
      registration,
      taxRate,
      issRate,
      immunity,
      ...(certificate
        ? { cnpj: certificate.cnpj, holder: certificate.holder, expiresAt: certificate.expiresAt.toISOString() }
        : {}),
    },
    certificate ? { key: certificate.key, chain: certificate.chain } : {},
  );
  await config.fillSettings({ legal_name: found?.name ?? certificate?.holder, document: cnpj });
  return done(await invoices.testNfse());
}

export async function rotateWebhookSecret(): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const secret = await webhooks.rotateWebhookSecret();
  revalidatePath("/", "layout");
  return { code: null, ok: true, secret };
}

// The form field "kind" names the connection; removing the active Pix provider goes back to the static Pix.
export async function removeConnection(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  if (demoMode()) return { code: "DEMO_BLOCKED" };
  const kind = REMOVABLE.find((entry) => entry === field(form, "kind"));
  if (!kind) return { code: "INVALID_PAYLOAD" };
  await config.removeCredentials(kind);
  if ((await config.credentials("pix"))("pix")("provider") === kind)
    await config.saveCredentials("pix", { provider: "static" });
  return done(null);
}
