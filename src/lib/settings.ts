import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "./db";
import type { Database } from "./db";
import { seal, unseal } from "./guard";
import { integration, setting } from "./schema";

export type Settings = {
  brand: string;
  ownerEmail?: string;
  ownerWhatsapp?: string;
  termsUrl?: string;
  termsVersion: string;
  orderHours: number;
  logo?: string;
  icon?: string;
  accent?: string;
  supportEmail?: string;
  supportWhatsapp?: string;
  legalName?: string;
  document?: string;
  privacyUrl?: string;
  poweredBy: boolean;
  description?: string;
  shareImage?: string;
  home?: string;
  checkoutPhone: "optional" | "required" | "hidden";
  confirmEmail: boolean;
  checkoutTheme: "light" | "dark" | "auto";
  checkoutButton: string;
  checkoutNotice?: string;
  checkoutCountdown: boolean;
  checkoutTrust: boolean;
  checkoutGuarantee: boolean;
  checkoutTestimonials: boolean;
  thanksUrl?: string;
  thanksLabel: string;
  googleVerification: string[];
  metaVerification?: string;
};

export const CHECKOUT_PHONE = ["optional", "required", "hidden"] as const;

export const CHECKOUT_THEME = ["light", "dark", "auto"] as const;

export const CHECKOUT_LABELS = { button: "Pagar com Pix", thanks: "Próximo passo" };

// The home setting holds a product slug, nothing for the showcase, or this path, which no slug can be.
export const MEMBERS_HOME = "/m";

const SETTING_KEYS = setting.key.enumValues;

export type SettingValues = Partial<Record<(typeof setting.$inferSelect)["key"], string>>;

export type IntegrationKind = (typeof integration.$inferSelect)["kind"];

type FieldName<K extends IntegrationKind> = (typeof INTEGRATIONS)[K]["fields"][number];

type SecretName<K extends IntegrationKind> = (typeof INTEGRATIONS)[K]["secrets"][number];

export type Credentials<K extends IntegrationKind> = (name: FieldName<K> | SecretName<K>) => string;

// The Pix providers share field names; the panel labels them Access Token, AppID, API key or Client Secret.
const INTEGRATIONS = {
  smtp: { fields: ["host", "port", "user", "from"], secrets: ["password"] },
  meta: { fields: ["pixelId", "testEventCode", "pixel"], secrets: ["token"] },
  tiktok: { fields: ["pixelCode", "testEventCode", "pixel"], secrets: ["token"] },
  analytics: { fields: ["measurementId", "tag"], secrets: ["apiSecret"] },
  // state and stateAt hold the pending "Conectar com Google" login, checked once by the callback.
  googleads: {
    fields: ["clientId", "customerId", "loginCustomerId", "actionId", "tagId", "state", "stateAt"],
    secrets: ["clientSecret", "refreshToken"],
  },
  pix: { fields: ["provider", "key", "name", "city"], secrets: [] },
  mercadopago: { fields: [], secrets: ["apiKey", "webhookSecret"] },
  woovi: {
    fields: [
      "publicKeys",
      "keysAt",
      "convertMode",
      "convertAsset",
      "convertWallet",
      "convertSince",
      "convertNextAt",
      "convertError",
    ],
    secrets: ["apiKey", "webhookSecret"],
  },
  abacatepay: { fields: [], secrets: ["apiKey", "webhookSecret"] },
  depix: { fields: ["clientId"], secrets: ["apiKey", "webhookSecret"] },
  noxpay: { fields: ["currency"], secrets: ["apiKey", "webhookSecret"] },
  webhook: { fields: [], secrets: ["secret"] },
  storage: { fields: ["endpoint", "bucket", "region", "accessKey"], secrets: ["secret"] },
  evolution: { fields: ["url"], secrets: ["key"] },
  whatsapp: { fields: ["phoneId", "wabaId", "number"], secrets: ["token", "appSecret"] },
  nfse: {
    fields: [
      "cnpj",
      "holder",
      "expiresAt",
      "city",
      "place",
      "regime",
      "service",
      "registration",
      "taxRate",
      "issRate",
      "immunity",
    ],
    secrets: ["key", "chain"],
  },
} as const satisfies Record<IntegrationKind, { fields: readonly string[]; secrets: readonly string[] }>;

// cache() lasts one request: the layout, the metadata and the page of one view share a single read.
export const settings = cache(async (executor: Database = db()): Promise<Settings> => {
  const rows = await executor.select({ key: setting.key, value: setting.value }).from(setting);
  const values = new Map(rows.map((row): [string, string] => [row.key, row.value]));
  return {
    brand: values.get("brand") || "LibreFunnel",
    ownerEmail: values.get("owner_email") || undefined,
    ownerWhatsapp: values.get("owner_whatsapp") || undefined,
    termsUrl: values.get("terms_url") || undefined,
    termsVersion: values.get("terms_version") ?? "",
    orderHours: Number(values.get("order_hours")) || 72,
    logo: values.get("logo") || undefined,
    icon: values.get("icon") || undefined,
    accent: values.get("accent") || undefined,
    supportEmail: values.get("support_email") || undefined,
    supportWhatsapp: values.get("support_whatsapp") || undefined,
    legalName: values.get("legal_name") || undefined,
    document: values.get("document") || undefined,
    privacyUrl: values.get("privacy_url") || undefined,
    poweredBy: values.get("powered_by") !== "0",
    description: values.get("description") || undefined,
    shareImage: values.get("share_image") || undefined,
    home: values.get("home") || undefined,
    checkoutPhone: CHECKOUT_PHONE.find((mode) => mode === values.get("checkout_phone")) ?? "optional",
    confirmEmail: values.get("confirm_email") === "1",
    checkoutTheme: CHECKOUT_THEME.find((theme) => theme === values.get("checkout_theme")) ?? "light",
    checkoutButton: values.get("checkout_button") || CHECKOUT_LABELS.button,
    checkoutNotice: values.get("checkout_notice") || undefined,
    checkoutCountdown: values.get("checkout_countdown") !== "0",
    checkoutTrust: values.get("checkout_trust") !== "0",
    checkoutGuarantee: values.get("checkout_guarantee") !== "0",
    checkoutTestimonials: values.get("checkout_testimonials") !== "0",
    thanksUrl: values.get("thanks_url") || undefined,
    thanksLabel: values.get("thanks_label") || CHECKOUT_LABELS.thanks,
    // One per Search Console property: each product domain is its own property with its own code.
    googleVerification: (values.get("google_verification") ?? "").split(" ").filter(Boolean),
    metaVerification: values.get("meta_verification") || undefined,
  };
});

// Fills keys the seller never saved, with what the store learned elsewhere; a value cleared on purpose stays cleared.
export async function fillSettings(values: SettingValues) {
  const rows = Object.entries(values).flatMap(([key, value]) =>
    SETTING_KEYS.flatMap((known) => (known === key && value ? [{ key: known, value }] : [])),
  );

  if (rows.length) await db().insert(setting).values(rows).onConflictDoNothing();
}

// Only the keys given are written, so each settings screen saves its own fields without touching the rest.
export async function saveSettings(values: SettingValues) {
  const rows = Object.entries(values).flatMap(([key, value]) =>
    SETTING_KEYS.flatMap((known) => (known === key && value !== undefined ? [{ key: known, value }] : [])),
  );

  if (!rows.length) return;
  await db()
    .insert(setting)
    .values(rows)
    .onConflictDoUpdate({ target: setting.key, set: { value: sql`excluded.value` } });
}

// Read on every use, so a change saved in the panel applies to the next send without a restart.
export async function credentials<K extends IntegrationKind>(
  ...kinds: K[]
): Promise<<P extends K>(kind: P) => Credentials<P>> {
  const rows = await db()
    .select({ kind: integration.kind, fields: integration.fields, secrets: integration.secrets })
    .from(integration)
    .where(inArray(integration.kind, kinds));

  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return (kind) => (name) => {
    const row = byKind.get(kind);
    const sealed = row?.secrets[name];
    return sealed === undefined ? (row?.fields[name] ?? "") : (unseal(sealed, `${kind}.${name}`) ?? "");
  };
}

// Fields are replaced; a blank secret keeps the stored one, so the panel never needs to send a secret back.
export async function saveCredentials<K extends IntegrationKind>(
  kind: K,
  fields: Partial<Record<FieldName<K>, string>>,
  secrets: Partial<Record<SecretName<K>, string>> = {},
  executor: Database = db(),
) {
  const plain: Record<string, string> = {};
  for (const [name, value] of Object.entries<string | undefined>(fields)) if (value !== undefined) plain[name] = value;
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries<string | undefined>(secrets))
    if (value) sealed[name] = seal(value, `${kind}.${name}`);

  await executor
    .insert(integration)
    .values({ kind, fields: plain, secrets: sealed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integration.kind,
      set: {
        fields: sql`${integration.fields} || excluded.fields`,
        secrets: sql`${integration.secrets} || excluded.secrets`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

export async function removeCredentials(kind: IntegrationKind) {
  await db().delete(integration).where(eq(integration.kind, kind));
}
