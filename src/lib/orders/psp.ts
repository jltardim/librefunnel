import "server-only";
import type { SQL } from "drizzle-orm";
import type { Credentials } from "../settings";
import { isObject, jsonObject } from "../guard";
import type { GuardCode, Json, JsonObject } from "../guard";
import type { OrderCode } from "./checkout";

export const PSPS = ["mercadopago", "woovi", "abacatepay", "depix", "noxpay", "asaas"] as const;

// Each code is one currency on one network, as NoxPay lists them.
export const NOXPAY_CURRENCIES = [
  { code: "TRX_USDT_S2UZ", label: "USDT na rede Tron" },
  { code: "SOL_USDT_EWAY", label: "USDT na rede Solana" },
  { code: "USDT_ERC20", label: "USDT na rede Ethereum" },
  { code: "SOL_USDC_PTHX", label: "USDC na rede Solana" },
  { code: "USDC", label: "USDC na rede Ethereum" },
  { code: "BTC", label: "Bitcoin" },
] as const;

export type Psp = (typeof PSPS)[number];

export type PixProvider = "static" | Psp;

export type PspKeys = {
  apiKey: string;
  webhookSecret: string;
  publicKeys: string[];
  clientId: string;
  currency: string;
};

export type PspResponse = { status: number; body: JsonObject | undefined; raw: string; retryIn: number };

type ChargeRow = {
  id: string;
  product: string;
  amount: number;
  name: string;
  email: string;
  phone: string | null;
  document: string | null;
};

type Movement = { amount: number; externalId: string };

type Fetched = { retryIn: number; limited?: boolean } | { movements: Movement[]; raw: string };

export type Notice = { code: GuardCode | "PSP_UNREACHABLE"; status: number } | { match: SQL | undefined };

// One shape per provider: a refund or MED in the re-fetched state yields only debits, so it is never released.
export type Adapter = {
  create: (
    row: ChargeRow,
    keys: PspKeys,
    seconds: number,
  ) => Promise<{ txid: string; pixCode: string } | { status: number }>;
  fetch: (row: { id: string; txid: string }, keys: PspKeys) => Promise<Fetched>;
  notice: (raw: string, keys: PspKeys, headers: Headers, url: URL) => Notice;
  test: (keys: PspKeys) => Promise<OrderCode | null>;
};

export const PSP_HOSTS: Record<Psp, string> = {
  mercadopago: "https://api.mercadopago.com",
  woovi: "https://api.woovi.com",
  abacatepay: "https://api.abacatepay.com",
  depix: "https://depix.eulen.app",
  noxpay: "https://checkout.noxpay.io",
  asaas: "https://api.asaas.com",
};

// An Asaas sandbox key only works on the sandbox host, so the key alone decides where the store calls.
const ASAAS_SANDBOX = "https://api-sandbox.asaas.com";

function pspHost(psp: Psp, apiKey: string): string {
  return psp === "asaas" && apiKey.startsWith("$aact_hmlg_") ? ASAAS_SANDBOX : PSP_HOSTS[psp];
}

// Neither Woovi nor AbacatePay documents a maximum expiry; 72 hours is the longest value their docs show working.
export const PSP_MAX_SECONDS = 72 * 3600;

export const PIX_PROVIDERS: { id: PixProvider; name: string; needsCnpj: boolean; fee: string; events: string[] }[] = [
  {
    id: "static",
    name: "Pix direto na sua chave",
    needsCnpj: false,
    fee: "Sem taxa. O Pix cai na chave da loja e você libera o pedido ao ver o valor no extrato.",
    events: [],
  },
  {
    id: "mercadopago",
    name: "Mercado Pago",
    needsCnpj: false,
    fee: "0,99% por venda. Libera o acesso sozinho.",
    events: ["Order (Mercado Pago)", "Chargebacks"],
  },
  {
    id: "woovi",
    name: "Woovi",
    needsCnpj: true,
    fee: "0,80% por Pix (de R$ 0,50 a R$ 5,00) ou R$ 0,85 fixo, conforme o plano. Libera o acesso sozinho.",
    events: [
      "OPENPIX:CHARGE_COMPLETED",
      "OPENPIX:CHARGE_COMPLETED_NOT_SAME_CUSTOMER_PAYER",
      "PIX_TRANSACTION_REFUND_SENT_CONFIRMED",
      "OPENPIX:DISPUTE_ACCEPTED",
    ],
  },
  {
    id: "abacatepay",
    name: "AbacatePay",
    needsCnpj: true,
    fee: "R$ 0,80 por Pix. Libera o acesso sozinho.",
    events: ["transparent.completed", "transparent.refunded", "transparent.disputed", "transparent.lost"],
  },
  {
    id: "depix",
    name: "DePix (cripto)",
    needsCnpj: false,
    fee: "Você recebe DePix (real tokenizado na rede Liquid) direto na sua carteira. Taxa da Eulen. Libera o acesso sozinho.",
    events: ["deposit", "med"],
  },
  {
    id: "noxpay",
    name: "NoxPay (cripto)",
    needsCnpj: false,
    fee: "Você recebe USDT, USDC ou Bitcoin no saldo NoxPay. O comprador paga numa página da NoxPay, com CPF. Libera o acesso sozinho.",
    events: [],
  },
  {
    id: "asaas",
    name: "Asaas",
    needsCnpj: false,
    fee: "Taxa do seu plano Asaas por Pix recebido. Pede o CPF do comprador no checkout. Libera o acesso sozinho.",
    events: [
      "PAYMENT_RECEIVED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ],
  },
];

export function pixProvider(value: string): PixProvider | undefined {
  return PIX_PROVIDERS.find((provider) => provider.id === value)?.id;
}

export function pspOf(value: string | null): Psp | undefined {
  return PSPS.find((psp) => psp === value);
}

export function pspKeys(read: Credentials<Psp>): PspKeys {
  return {
    apiKey: read("apiKey"),
    webhookSecret: read("webhookSecret"),
    publicKeys: read("publicKeys").split(",").filter(Boolean),
    clientId: read("clientId"),
    currency: read("currency"),
  };
}

// Woovi signs with keys only, so its optional webhook authorization is not required.
export function pspConfigured(psp: Psp, keys: PspKeys): boolean {
  return (
    keys.apiKey !== "" &&
    (psp === "woovi" || keys.webhookSecret !== "") &&
    (psp !== "depix" || keys.clientId !== "") &&
    (psp !== "noxpay" || NOXPAY_CURRENCIES.some((currency) => currency.code === keys.currency))
  );
}

export async function callPsp(
  psp: Psp,
  apiKey: string,
  path: string,
  body?: Json,
  idempotencyKey?: string,
): Promise<PspResponse> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const header = psp === "noxpay" ? "api-key" : psp === "asaas" ? "access_token" : "Authorization";
  const plain = psp === "woovi" || psp === "noxpay" || psp === "asaas";
  if (apiKey) headers.set(header, plain ? apiKey : `Bearer ${apiKey}`);
  // Asaas refuses calls from newer accounts that carry no User-Agent.
  if (psp === "asaas") headers.set("User-Agent", "librefunnel");
  if (idempotencyKey) headers.set("X-Idempotency-Key", idempotencyKey);

  const response = await fetch(`${pspHost(psp, apiKey)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const raw = await response.text();
  const wait = Number(response.headers.get("retry-after") ?? response.headers.get("ratelimit-reset") ?? "");
  return {
    status: response.status,
    body: jsonObject(raw),
    raw,
    retryIn: Number.isFinite(wait) && wait >= 1 ? Math.min(Math.ceil(wait), 3600) : 60,
  };
}

export function busy(response: PspResponse): boolean {
  return response.status === 429 || response.status >= 500;
}

export function limited(response: PspResponse): Fetched {
  return { retryIn: response.retryIn, limited: true };
}

export function mismatch(psp: Psp, orderId: string, status: number): Fetched {
  console.warn(`[librefunnel] ${psp} charge for ${orderId} did not match (HTTP ${status})`);
  return { movements: [], raw: "" };
}

export function credentialsReply(response: PspResponse): OrderCode | null {
  if (response.status < 300) return null;
  return response.status === 401 || response.status === 403 ? "PSP_REJECTED" : "PSP_UNREACHABLE";
}

export function objects(value: Json | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function cents(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
