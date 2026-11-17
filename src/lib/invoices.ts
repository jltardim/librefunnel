import "server-only";
import { createHash, createPrivateKey, createSign, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { gzipSync } from "node:zlib";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { credentials } from "./settings";
import { productNames } from "./catalog/products";
import { addSeconds, db } from "./db";
import type { Database } from "./db";
import { demoMode, isObject, jsonObject } from "./guard";
import type { Json, JsonObject } from "./guard";
import { customer, integration, invoice, message, order } from "./schema";
import { formatDecimal, formatFirstName } from "@/format";
import type { Company } from "./registry";

export type InvoiceCode = (typeof INVOICE_CODES)[number];
export type Regime = (typeof REGIMES)[number];
export type Immunity = "" | "livros";
export type InvoiceStatus = (typeof invoice.$inferSelect)["status"];

type Nfse = {
  cnpj: string;
  city: string;
  regime: Regime;
  service: string;
  registration: string;
  taxRate: string;
  issRate: string;
  immunity: Immunity;
  key: string;
  chain: string;
  expiresAt: Date;
};
type Certificate = { key: string; chain: string; cnpj: string; holder: string; expiresAt: Date };
type Reply = { status: number; body: JsonObject | undefined };
type Outcome = { issued: string } | { canceled: true } | { code: InvoiceCode; rejection?: string; retry?: boolean };
type Due = {
  orderId: string;
  status: InvoiceStatus;
  number: string | null;
  key: string | null;
  attempts: number;
  createdAt: Date;
  orderStatus: (typeof order.$inferSelect)["status"];
  amount: number;
  name: string;
  document: string | null;
  product: string;
  bump: string | null;
  customerId: string;
  email: string;
};

const REGIMES = ["mei", "simples", "normal"] as const;

const INVOICE_CODES = [
  "NFSE_NOT_CONFIGURED",
  "NFSE_UNREACHABLE",
  "NFSE_REJECTED",
  "NFSE_CITY_NOT_NATIONAL",
  "NFSE_CITY_MISMATCH",
  "NFSE_MUNICIPAL_REGISTRATION",
  "NFSE_SERVICE_INVALID",
  "NFSE_REGIME_MISMATCH",
  "NFSE_TAX_RATE",
  "NFSE_CANCEL_DEADLINE",
  "NFSE_CANCEL_FORBIDDEN",
  "CERTIFICATE_UNREADABLE",
  "CERTIFICATE_NOT_CNPJ",
  "CERTIFICATE_EXPIRED",
  "CERTIFICATE_REFUSED",
  "INVALID_CITY",
  "INVALID_SERVICE",
  "INVALID_RATE",
  "CNPJ_LOOKUP_FAILED",
] as const;

const SEFIN = "https://sefin.nfse.gov.br/SefinNacional";
const ADN = "https://adn.nfse.gov.br";
const NFSE_NS = "http://www.sped.fazenda.gov.br/nfse";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const APP = "LibreFunnel";
// Applications use series 1 to 49999. One no other emitter of the seller is likely to share, so a retry
// that finds an existing note for this number knows the note is the store's own.
const SERIES = "47101";

const BAG = {
  shroudedKey: "1.2.840.113549.1.12.10.1.2",
  key: "1.2.840.113549.1.12.10.1.1",
  cert: "1.2.840.113549.1.12.10.1.3",
};

const CNPJ_OID = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);
const REPLY_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 8;
const BATCH = 20;
const PUBLIC_QUERY = "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=";

const REJECTIONS: [InvoiceCode, string[]][] = [
  ["CERTIFICATE_EXPIRED", ["E1203", "E0715"]],
  ["CERTIFICATE_REFUSED", ["E1200", "E1205", "E1206", "E1207", "E1208", "E1209", "E0714", "E0716", "E0718"]],
  ["NFSE_CITY_NOT_NATIONAL", ["E0037", "E0038", "E0039"]],
  ["NFSE_CITY_MISMATCH", ["E0041", "E0084"]],
  ["NFSE_MUNICIPAL_REGISTRATION", ["E0116", "E0120", "E0124", "E0023", "E0025"]],
  ["NFSE_SERVICE_INVALID", ["E0310", "E0312"]],
  ["NFSE_REGIME_MISMATCH", ["E0160"]],
  ["NFSE_TAX_RATE", ["E0617", "E0625", "E0710", "E0712", "E0713"]],
  ["NFSE_CANCEL_DEADLINE", ["E0822", "E0823"]],
  ["NFSE_CANCEL_FORBIDDEN", ["E0824"]],
];

// The "aproximado" taxes of Lei 12.741 when the seller sets none: Simples Anexo III's first bracket, and Lucro
// Presumido on services (PIS, COFINS, IRPJ and CSLL) with the highest ISS.
export const DEFAULT_RATES: Record<Regime, { taxRate: string; issRate: string }> = {
  mei: { taxRate: "", issRate: "" },
  simples: { taxRate: "6.00", issRate: "" },
  normal: { taxRate: "11.33", issRate: "5.00" },
};

export function regimeOf(company: Company): Regime {
  return company.mei ? "mei" : company.simples ? "simples" : "normal";
}

// The only ISS immunity a store has: books, e-books included (CF art. 150, VI, d; STF Súmula Vinculante 57).
export function immunity(value: string): Immunity | undefined {
  return value === "" || value === "livros" ? value : undefined;
}

export function regime(value: string): Regime | undefined {
  return REGIMES.find((entry) => entry === value);
}

export function invoiceCode(value: string | null): InvoiceCode | null {
  return INVOICE_CODES.find((code) => code === value) ?? null;
}

export function publicLink(key: string): string {
  return `${PUBLIC_QUERY}${key}`;
}

// e-CNPJ certificates carry the CNPJ under OID 2.16.76.1.3.3 in the subject alternative name.
function cnpjOf(raw: Buffer): string | undefined {
  const at = raw.indexOf(CNPJ_OID);
  if (at < 0) return undefined;
  const digits = /\d{14}/.exec(raw.subarray(at + CNPJ_OID.length, at + CNPJ_OID.length + 24).toString("latin1"));
  return digits?.[0];
}

// node:crypto opens PEM keys but not PKCS#12, and many A1 files still use the legacy ciphers OpenSSL 3 refuses.
// node-forge loads only here, when the seller sends a certificate, so it stays out of the server's memory otherwise.
export async function readCertificate(pfx: Buffer, password: string): Promise<Certificate | InvoiceCode> {
  const { default: forge } = await import("node-forge");
  let key: string;
  let pems: string[];
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(pfx.toString("binary"))),
      password,
    );

    const shrouded = p12.getBags({ bagType: BAG.shroudedKey })[BAG.shroudedKey];
    const plain = p12.getBags({ bagType: BAG.key })[BAG.key];
    const bagKey = [...(shrouded ?? []), ...(plain ?? [])].find((bag) => bag.key)?.key;
    if (!bagKey) return "CERTIFICATE_UNREADABLE";
    key = forge.pki.privateKeyToPem(bagKey);
    pems = (p12.getBags({ bagType: BAG.cert })[BAG.cert] ?? []).flatMap((bag) =>
      bag.cert ? [forge.pki.certificateToPem(bag.cert)] : [],
    );
  } catch {
    return "CERTIFICATE_UNREADABLE";
  }
  const privateKey = createPrivateKey(key);
  const certificates = pems.map((pem) => new X509Certificate(pem));
  const leaf = certificates.find((certificate) => certificate.checkPrivateKey(privateKey));
  if (!leaf) return "CERTIFICATE_UNREADABLE";
  const cnpj = cnpjOf(leaf.raw);
  if (!cnpj) return "CERTIFICATE_NOT_CNPJ";
  const expiresAt = new Date(leaf.validTo);
  if (expiresAt <= new Date()) return "CERTIFICATE_EXPIRED";
  const holder = (/^CN=([^:\n]+)/m.exec(leaf.subject)?.[1] ?? "").trim();

  const others = certificates
    .filter((certificate) => certificate !== leaf)
    .map((certificate) => certificate.toString());

  return { key, chain: [leaf.toString(), ...others].join("\n"), cnpj, holder, expiresAt };
}

async function config(): Promise<Nfse | undefined> {
  const read = (await credentials("nfse"))("nfse");
  const chosen = regime(read("regime"));
  if (!read("key") || !read("chain") || !chosen) return undefined;
  return {
    cnpj: read("cnpj"),
    city: read("city"),
    regime: chosen,
    service: read("service"),
    registration: read("registration"),
    taxRate: read("taxRate"),
    issRate: read("issRate"),
    immunity: immunity(read("immunity")) ?? "",
    key: read("key"),
    chain: read("chain"),
    expiresAt: new Date(read("expiresAt")),
  };
}

export async function invoicesOn(executor: Database = db()): Promise<boolean> {
  return (await executor.$count(integration, eq(integration.kind, "nfse"))) > 0;
}

function call(nfse: Nfse, url: string, method: "GET" | "HEAD" | "POST", payload?: Json): Promise<Reply | undefined> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve) => {
    const outgoing = request(
      url,
      {
        method,
        key: nfse.key,
        cert: nfse.chain,
        timeout: TIMEOUT_MS,
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      },
      (incoming) => {
        let size = 0;
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= REPLY_LIMIT) chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: jsonObject(Buffer.concat(chunks).toString("utf8")) }),
        );
        incoming.on("error", () => resolve(undefined));
      },
    );

    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => resolve(undefined));
    outgoing.end(body);
  });
}

// Sefin answers erros, Erros or erro, with codigo or Codigo: only the official code is kept, never the text.
function rejectionOf(body: JsonObject | undefined): string | undefined {
  if (!body) return undefined;

  const list = (["erros", "Erros", "erro", "Erro"] as const).flatMap((name): Json[] => {
    const value = body[name];
    return Array.isArray(value) ? value : value === undefined ? [] : [value];
  });

  for (const entry of list) {
    const code = isObject(entry) ? (entry.codigo ?? entry.Codigo) : undefined;
    if (typeof code === "string" && /^[A-Z]\d{3,4}$/.test(code)) return code;
  }
  return undefined;
}

function rejected(reply: Reply): Outcome {
  const rejection = rejectionOf(reply.body);
  const code = REJECTIONS.find(([, codes]) => rejection && codes.includes(rejection))?.[0] ?? "NFSE_REJECTED";
  // The text names the field Sefin refused; it goes only to the server log, so the stored row keeps just the code.
  if (code === "NFSE_REJECTED")
    console.warn(`[librefunnel] nfse ${rejection ?? "rejected"} (HTTP ${reply.status})`, JSON.stringify(reply.body ?? {}).slice(0, 2000));
  return { code, rejection };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function element(name: string, content: string | undefined): string {
  return content === undefined || content === "" ? "" : `<${name}>${content}</${name}>`;
}

// Brazil has kept UTC-3 all year since 2019; the layout takes local time with the offset.
function brasilia(date: Date): string {
  return new Date(date.getTime() - 3 * 3600_000).toISOString().slice(0, 19);
}

// Inclusive C14N of an element written with no whitespace, explicit end tags and its namespace inherited:
// the canonical form is the same text with the namespace declared on it.
function signed(root: string, version: string, inner: string, id: string, nfse: Nfse): string {
  const tag = /^<(\w+)/.exec(inner)?.[1] ?? "";
  const canonical = inner.replace(`<${tag} `, `<${tag} xmlns="${NFSE_NS}" `);
  const digest = createHash("sha1").update(canonical, "utf8").digest("base64");
  const info = `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod><SignatureMethod Algorithm="${DSIG_NS}rsa-sha1"></SignatureMethod><Reference URI="#${id}"><Transforms><Transform Algorithm="${DSIG_NS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${DSIG_NS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference>`;

  const value = createSign("RSA-SHA1")
    .update(`<SignedInfo xmlns="${DSIG_NS}">${info}</SignedInfo>`, "utf8")
    .sign(nfse.key, "base64");

  const leaf = new X509Certificate(nfse.chain).raw.toString("base64");
  return `<${root} xmlns="${NFSE_NS}" versao="${version}">${inner}<Signature xmlns="${DSIG_NS}"><SignedInfo>${info}</SignedInfo><SignatureValue>${value}</SignatureValue><KeyInfo><X509Data><X509Certificate>${leaf}</X509Certificate></X509Data></KeyInfo></Signature></${root}>`;
}

// Sefin refuses a document without the declaration with E1229 ("Xml não está utilizando codificação UTF-8").
function packed(xml: string): string {
  return gzipSync(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, "utf8")).toString("base64");
}

function dpsId(nfse: Nfse, number: string): string {
  return `DPS${nfse.city}2${nfse.cnpj}${SERIES.padStart(5, "0")}${number.padStart(15, "0")}`;
}

function totals(nfse: Nfse): string {
  if (nfse.regime === "mei") return "<indTotTrib>0</indTotTrib>";
  if (nfse.regime === "simples") return element("pTotTribSN", nfse.taxRate);
  return `<pTotTrib><pTotTribFed>${nfse.taxRate}</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>${nfse.immunity ? "0.00" : nfse.issRate}</pTotTribMun></pTotTrib>`;
}

// TCTribMunicipal: tribISSQN 1 is taxable, 2 immune; tpImunidade 4 is books, and it comes before tpRetISSQN.
function issqn(nfse: Nfse): string {
  return nfse.immunity === "livros"
    ? "<tribISSQN>2</tribISSQN><tpImunidade>4</tpImunidade>"
    : "<tribISSQN>1</tribISSQN>";
}

function dps(nfse: Nfse, row: Due, number: string, description: string, at: Date): { id: string; xml: string } {
  const id = dpsId(nfse, number);

  const regimeTags = {
    mei: "<opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib>",
    simples: "<opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib>",
    normal: "<opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib>",
  }[nfse.regime];

  const buyer = row.document
    ? `<toma>${element(row.document.length === 11 ? "CPF" : "CNPJ", row.document)}${element("xNome", escape(row.name.slice(0, 300)))}</toma>`
    : "";

  const extra = row.document ? `Pedido ${row.orderId}` : `Pedido ${row.orderId}. Comprador: ${row.name}`;

  const inner =
    `<infDPS Id="${id}"><tpAmb>1</tpAmb><dhEmi>${brasilia(at)}-03:00</dhEmi><verAplic>${APP}</verAplic>` +
    `<serie>${SERIES}</serie><nDPS>${number}</nDPS><dCompet>${brasilia(row.createdAt).slice(0, 10)}</dCompet>` +
    `<tpEmit>1</tpEmit><cLocEmi>${nfse.city}</cLocEmi>` +
    `<prest><CNPJ>${nfse.cnpj}</CNPJ>${element("IM", escape(nfse.registration))}<regTrib>${regimeTags}</regTrib></prest>` +
    buyer +
    `<serv><locPrest><cLocPrestacao>${nfse.city}</cLocPrestacao></locPrest>` +
    `<cServ><cTribNac>${nfse.service}</cTribNac><xDescServ>${escape(description.slice(0, 2000))}</xDescServ></cServ>` +
    `<infoCompl><xInfComp>${escape(extra.slice(0, 2000))}</xInfComp></infoCompl></serv>` +
    `<valores><vServPrest><vServ>${formatDecimal(row.amount)}</vServ></vServPrest>` +
    `<trib><tribMun>${issqn(nfse)}<tpRetISSQN>1</tpRetISSQN></tribMun><totTrib>${totals(nfse)}</totTrib></trib></valores>` +
    `</infDPS>`;

  return { id, xml: signed("DPS", "1.01", inner, id, nfse) };
}

function cancelEvent(nfse: Nfse, key: string, at: Date): string {
  const id = `PRE${key}101101`;

  const inner =
    `<infPedReg Id="${id}"><tpAmb>1</tpAmb><verAplic>${APP}</verAplic><dhEvento>${brasilia(at)}-03:00</dhEvento>` +
    `<CNPJAutor>${nfse.cnpj}</CNPJAutor><chNFSe>${key}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc>` +
    `<cMotivo>2</cMotivo><xMotivo>Compra reembolsada ao comprador</xMotivo></e101101></infPedReg>`;

  return signed("pedRegEvento", "1.01", inner, id, nfse);
}

function keyOf(reply: Reply | undefined): string | undefined {
  const key = reply?.body?.chaveAcesso;
  return typeof key === "string" && /^\d{50}$/.test(key) ? key : undefined;
}

// A lost answer leaves the note's fate unknown: the DPS number tells whether Sefin made it.
async function lookUp(nfse: Nfse, id: string): Promise<Outcome | "missing"> {
  const reply = await call(nfse, `${SEFIN}/dps/${id}`, "GET");
  if (!reply || reply.status >= 500) return { code: "NFSE_UNREACHABLE", retry: true };
  const key = keyOf(reply);
  if (key) return { issued: key };
  return reply.status === 404 ? "missing" : rejected(reply);
}

async function issue(nfse: Nfse, row: Due, number: string, description: string): Promise<Outcome> {
  const { id, xml } = dps(nfse, row, number, description, addSeconds(new Date(), -10));
  if (row.attempts > 0) {
    const found = await lookUp(nfse, id);
    if (found !== "missing") return found;
    // A refund before the note existed leaves nothing to issue or cancel.
    if (row.orderStatus !== "paid") return { canceled: true };
  } else if (row.orderStatus !== "paid") return { canceled: true };

  const reply = await call(nfse, `${SEFIN}/nfse`, "POST", { dpsXmlGZipB64: packed(xml) });
  if (!reply || reply.status >= 500) return { code: "NFSE_UNREACHABLE", retry: true };
  const key = keyOf(reply);
  if (key) return { issued: key };
  const outcome = rejected(reply);
  if ("rejection" in outcome && outcome.rejection === "E0014") {
    const found = await lookUp(nfse, id);
    return found === "missing" ? outcome : found;
  }
  return outcome;
}

async function cancel(nfse: Nfse, key: string): Promise<Outcome> {
  const reply = await call(nfse, `${SEFIN}/nfse/${key}/eventos`, "POST", {
    pedidoRegistroEventoXmlGZipB64: packed(cancelEvent(nfse, key, addSeconds(new Date(), -10))),
  });

  if (!reply || reply.status >= 500) return { code: "NFSE_UNREACHABLE", retry: true };
  if (reply.status === 200 || reply.status === 201) return { canceled: true };
  const outcome = rejected(reply);
  // E0840: already canceled, by an earlier attempt or in the government portal.
  return "rejection" in outcome && outcome.rejection === "E0840" ? { canceled: true } : outcome;
}

// Runs inside the payment transaction: a store with invoices on queues one for the order.
export async function queueInvoice(tx: Database, orderId: string) {
  if (!(await invoicesOn(tx))) return;
  const t = new Date();
  await tx.insert(invoice).values({ orderId, nextAt: t, createdAt: t }).onConflictDoNothing();
}

// Runs inside the refund transaction: an issued note is canceled by the background loop.
export async function cancelInvoice(tx: Database, orderId: string) {
  await tx
    .update(invoice)
    .set({ nextAt: new Date(), attempts: 0 })
    .where(and(eq(invoice.orderId, orderId), eq(invoice.status, "issued")));
}

// The panel's retry: issues a note for a paid order that has none, or tries again a failed issue or cancel.
export async function retryInvoice(orderId: string): Promise<InvoiceCode | "INVALID_TRANSITION" | null> {
  if (!(await invoicesOn())) return "NFSE_NOT_CONFIGURED";
  const t = new Date();
  return db().transaction(async (tx) => {
    const [found] = await tx
      .select({ orderStatus: order.status, status: invoice.status })
      .from(order)
      .leftJoin(invoice, eq(invoice.orderId, order.id))
      .where(eq(order.id, orderId))
      .for("update", { of: order });

    if (!found) return "INVALID_TRANSITION";
    if (!found.status) {
      if (found.orderStatus !== "paid") return "INVALID_TRANSITION";
      await tx.insert(invoice).values({ orderId, nextAt: t, createdAt: t });
      return null;
    }
    const next = { failed: "queued", cancel_failed: "issued" } as const;
    if (found.status !== "failed" && found.status !== "cancel_failed") return "INVALID_TRANSITION";
    await tx
      .update(invoice)
      // At least one earlier attempt keeps the number lookup before a new send; past ones no longer count to the cap.
      .set({
        status: next[found.status],
        nextAt: t,
        error: null,
        rejection: null,
        attempts: sql`LEAST(${invoice.attempts}, 1)`,
      })
      .where(and(eq(invoice.orderId, orderId), eq(invoice.status, found.status)));
    return null;
  });
}

// One number per note, never reused: milliseconds keep a reinstalled store from repeating an old one.
async function nextNumber(): Promise<string> {
  const [row] = await db()
    .select({ last: sql<number | null>`MAX(${invoice.number}::bigint)`.mapWith(Number) })
    .from(invoice);

  return String(Math.max(Date.now(), (row?.last ?? 0) + 1));
}

// What the order sold, by name: the service the note describes and the subject of the buyer's e-mail.
function soldNames(row: Due, names: Map<string, string>): string {
  return [row.product, row.bump].flatMap((slug) => (slug ? [names.get(slug) ?? slug] : [])).join(" + ");
}

async function settle(row: Due, outcome: Outcome, t: Date, names: Map<string, string>) {
  const byOrder = eq(invoice.orderId, row.orderId);
  if ("issued" in outcome) {
    await db().transaction(async (tx) => {
      await tx
        .update(invoice)
        .set({
          status: "issued",
          key: outcome.issued,
          issuedAt: t,
          error: null,
          rejection: null,
          attempts: 0,
          // A refund that came while the note was being issued cancels it on the next pass.
          nextAt: row.orderStatus === "paid" ? null : t,
        })
        .where(byOrder);

      const title = soldNames(row, names);
      await tx
        .insert(message)
        .values({
          channel: "email",
          address: row.email,
          kind: "invoice",
          orderId: row.orderId,
          customerId: row.customerId,
          body: `Nota fiscal do ${title}\n\nOi ${formatFirstName(row.name)}, a nota fiscal da sua compra foi emitida. Veja e baixe em:\n${publicLink(outcome.issued)}`,
          status: "queued",
          nextAt: t,
          createdAt: t,
        })
        .onConflictDoNothing();
    });
    return;
  }
  const failed = row.status === "issued" ? "cancel_failed" : "failed";
  if ("canceled" in outcome) {
    await db().update(invoice).set({ status: "canceled", nextAt: null, error: null, rejection: null }).where(byOrder);
  } else if (outcome.retry && row.attempts < MAX_ATTEMPTS) {
    await db()
      .update(invoice)
      .set({ error: outcome.code, nextAt: addSeconds(t, 60 * 2 ** row.attempts) })
      .where(byOrder);
  } else {
    await db()
      .update(invoice)
      .set({ status: failed, nextAt: null, error: outcome.code, rejection: outcome.rejection ?? null })
      .where(byOrder);
  }
}

export async function issueInvoices() {
  if (demoMode()) return;
  const t = new Date();

  const due = await db()
    .select({
      orderId: invoice.orderId,
      status: invoice.status,
      number: invoice.number,
      key: invoice.key,
      attempts: invoice.attempts,
      createdAt: invoice.createdAt,
      orderStatus: order.status,
      amount: order.amount,
      name: order.name,
      document: order.document,
      product: order.product,
      bump: order.bump,
      customerId: order.customerId,
      email: customer.email,
    })
    .from(invoice)
    .innerJoin(order, eq(order.id, invoice.orderId))
    .innerJoin(customer, eq(customer.id, order.customerId))
    .where(and(isNotNull(invoice.nextAt), lte(invoice.nextAt, t)))
    .orderBy(asc(invoice.nextAt))
    .limit(BATCH);

  if (due.length === 0) return;
  const [nfse, names] = await Promise.all([config(), productNames()]);

  for (const row of due) {
    let outcome: Outcome;
    if (!nfse) outcome = { code: "NFSE_NOT_CONFIGURED" };
    else if (nfse.expiresAt <= t) outcome = { code: "CERTIFICATE_EXPIRED" };
    else if (row.status === "issued" && row.key) {
      await db()
        .update(invoice)
        .set({ attempts: sql`${invoice.attempts} + 1` })
        .where(eq(invoice.orderId, row.orderId));
      outcome = await cancel(nfse, row.key);
    } else {
      // The number and the attempt are stored before the call, so a crash in the middle still looks the note up.
      const number = row.number ?? (await nextNumber());
      await db()
        .update(invoice)
        .set({ number, attempts: sql`${invoice.attempts} + 1` })
        .where(eq(invoice.orderId, row.orderId));

      outcome = await issue(nfse, row, number, soldNames(row, names));
    }
    await settle(row, outcome, t, names);
  }
}

// Checks what can be checked without issuing a note: the city takes DPS from applications and Sefin accepts the certificate.
export async function testNfse(): Promise<InvoiceCode | null> {
  const nfse = await config();
  if (!nfse) return "NFSE_NOT_CONFIGURED";
  if (nfse.expiresAt <= new Date()) return "CERTIFICATE_EXPIRED";
  const agreement = await call(nfse, `${ADN}/parametrizacao/${nfse.city}/convenio`, "GET");
  if (!agreement || agreement.status >= 500) return "NFSE_UNREACHABLE";
  if (agreement.status === 401 || agreement.status === 403) return "CERTIFICATE_REFUSED";
  const terms = agreement.body?.parametrosConvenio;
  if (agreement.status === 404 || !isObject(terms)) return "NFSE_CITY_NOT_NATIONAL";
  // MEI and Simples ME/EPP issue through the national emitter even where the city keeps its own system.
  if (nfse.regime === "normal" && terms.aderenteEmissorNacional !== 1) return "NFSE_CITY_NOT_NATIONAL";
  const probe = await call(nfse, `${SEFIN}/dps/${dpsId(nfse, "1")}`, "HEAD");
  if (!probe || probe.status >= 500) return "NFSE_UNREACHABLE";
  return probe.status === 401 || probe.status === 403 ? "CERTIFICATE_REFUSED" : null;
}
