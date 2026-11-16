import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import forge from "node-forge";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, test, vi, setSystemTime } from "bun:test";
import { enterFromOrder } from "@/lib/actions/members";
import { refundOrder } from "@/lib/actions/orders";
import { createProduct, saveLesson } from "@/lib/actions/products";
import { saveNfse } from "@/lib/actions/connections";
import { issueInvoices } from "@/lib/invoices";
import { removeCredentials, saveCredentials } from "@/lib/settings";
import { db, one } from "@/lib/db";
import { currentMember } from "@/lib/members";
import { checkCharges } from "@/lib/orders/charges";
import { invoice, order, payment } from "@/lib/schema";
import { recordTouch, visitor } from "@/lib/tracking/visitors";
import { POST as upload } from "@/app/admin/media/route";
import { GET as attachment } from "@/app/m/[product]/[lesson]/anexo/route";
import Members from "@/app/m/[[...path]]/page";
import { GET as sales } from "@/app/api/v1/vendas/route";
import { POST as paymentWebhook } from "@/app/api/webhooks/payment/route";
import { ErrorText } from "@/app/ui";
import { cookieStore, fakeServer, form, freshBrowser, redirected, redirectFetch } from "./fakes";
import { buy, pay, signInAsAdmin } from "./flows";

const MB = 1024 * 1024;
const PDF_NAME = "Manual-do-Sono-do-Bebe.pdf";
const NOON = new Date("2026-11-14T12:00:00-03:00");

// The NFS-e goes to Sefin over mutual TLS; here the same requests reach a plain local server.
let sefin = "";

vi.mock("node:https", () => ({
  request: (url: string, options: RequestOptions, callback: Parameters<typeof httpRequest>[2]) =>
    httpRequest(url.replace(/^https:\/\/(sefin|adn)\.nfse\.gov\.br/, sefin), options, callback),
}));

let ip = 0;

beforeEach(() => {
  ip += 1;
  freshBrowser(`203.0.113.${ip}`);
  setSystemTime(NOON);
});

function pdf(size: number): Buffer<ArrayBuffer> {
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(size - 9, 0x20)]);
}

function sendFile(name: string, body: Buffer<ArrayBuffer>) {
  return upload(new Request(`https://shop.example/admin/media?name=${name}`, { method: "POST", body }));
}

function download(product: string, lesson: string) {
  return attachment(new Request(`https://shop.example/m/${product}/${lesson}/anexo`), {
    params: Promise.resolve({ product, lesson }),
  });
}

async function lessonHtml(product: string, lesson: string) {
  const page = createElement(Members, {
    params: Promise.resolve({ path: [product, lesson] }),
    searchParams: Promise.resolve({}),
  });

  return (await new Response((await prerender(page)).prelude).text()).replaceAll("<!-- -->", "");
}

// The seller uploads the ebook on the lesson through the admin; the buyer pages run in a browser of their own.
async function attachEbook(lesson: string): Promise<Buffer> {
  const bytes = pdf(Math.round(3.9 * MB));
  await signInAsAdmin();
  const { path } = await (await sendFile(PDF_NAME, bytes)).json();
  const fields = { lesson, title: "O manual", video: "", text: "Baixe o manual.", attachment: path };
  expect(await saveLesson({ code: null }, form({ ...fields, attachmentName: PDF_NAME }))).toEqual({
    code: null,
    ok: true,
  });
  return bytes;
}

const CNPJ = "64076031000109";
const NOTE_KEY = `3550308264076031000109${"0".repeat(28)}`;
const ABACATE_SECRET = "abacate-webhook-secret-with-32-chars!";

// Published on AbacatePay's webhook security page.
const ABACATEPAY_SIGNING_KEY =
  "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9";

// One fake for everything the store calls outside here: the CNPJ registry, Sefin and AbacatePay. NFS-e is turned on.
async function outside() {
  const server = await fakeServer({
    "GET /parametrizacao/3550308/convenio": {
      status: 200,
      body: { parametrosConvenio: { aderenteEmissorNacional: 1 } },
    },
    [`GET /api/cnpj/v1/${CNPJ}`]: {
      status: 200,
      body: {
        razao_social: "ACT TECH LTDA",
        codigo_municipio_ibge: 3550308,
        municipio: "SAO PAULO",
        uf: "SP",
        opcao_pelo_simples: true,
        opcao_pelo_mei: false,
      },
    },
    "HEAD *": { status: 404, body: "" },
    "GET *": { status: 404, body: { erro: { codigo: "E0000" } } },
    "POST /SefinNacional/nfse": { status: 201, body: { chaveAcesso: NOTE_KEY, idDps: "x" } },
  });

  sefin = server.url;
  redirectFetch(/^https:\/\/(brasilapi\.com\.br|api\.abacatepay\.com)/, server.url);
  await signInAsAdmin();
  expect(await saveNfse({ code: null }, nfseForm(certificate(CNPJ)))).toEqual({ code: null, ok: true });
  return server;
}

// The notice only names the charge; the store then reads its status from AbacatePay, as it does for every event.
function abacateNotice(event: string, chargeId: string) {
  const raw = JSON.stringify({
    id: `log_${event}`,
    event,
    apiVersion: 2,
    devMode: false,
    data: { transparent: { id: chargeId } },
  });

  const signature = createHmac("sha256", ABACATEPAY_SIGNING_KEY).update(raw).digest("base64");
  return paymentWebhook(
    new Request("https://shop.example/api/webhooks/payment?psp=abacatepay", {
      method: "POST",
      body: raw,
      headers: { "x-webhook-secret": ABACATE_SECRET, "x-webhook-signature": signature },
    }),
  );
}

async function buyer(email: string, slug = "bolo-no-pote", amount = 9700): Promise<string> {
  ip += 1;
  freshBrowser(`192.0.2.${ip}`);
  const id = await buy({ email, slug });
  await pay(id, amount, `acttech-${id}`);
  await redirected(enterFromOrder());
  return id;
}

describe("acttech", () => {
  test("anexo: aceita PDF de 3,9 MB, recusa PDF de 51 MB e .docx", async () => {
    await signInAsAdmin();
    const accepted = await sendFile(PDF_NAME, pdf(Math.round(3.9 * MB)));
    expect(accepted.status).toBe(200);
    const { path } = await accepted.json();
    expect(path).toMatch(/^\/media\/[a-f0-9]{32}\.pdf$/);
    const lesson = { lesson: "m2a1", title: "Brigadeiro de colher", video: "", text: "Receita." };
    expect(await saveLesson({ code: null }, form({ ...lesson, attachment: path, attachmentName: PDF_NAME }))).toEqual({
      code: null,
      ok: true,
    });

    const tooBig = await sendFile("Manual-grande.pdf", pdf(51 * MB));
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ code: "MEDIA_TOO_LARGE" });

    const docx = Buffer.concat([Buffer.from("504b030414000600", "hex"), Buffer.alloc(200)]);
    const word = await sendFile("Manual.docx", docx);
    expect(word.status).toBe(415);
    expect(await word.json()).toEqual({ code: "MEDIA_TYPE" });
    expect((await (await sendFile("Manual.pdf", docx)).json()).code).toBe("MEDIA_TYPE");

    expect(ErrorText({ code: "MEDIA_TOO_LARGE" })).toContain("PDF até 50 MB");
    expect(ErrorText({ code: "MEDIA_TYPE" })).toContain("PDF");

    const video = Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), Buffer.alloc(88, 7)]);
    const { path: videoPath } = await (await sendFile("aula.mp4", video)).json();
    expect(
      (await saveLesson({ code: null }, form({ ...lesson, attachment: videoPath, attachmentName: "aula.mp4" }))).code,
    ).toBe("INVALID_MEDIA");
  });

  test("anexo: comprador com acesso baixa o PDF como attachment", async () => {
    const bytes = await attachEbook("m1a1");
    await buyer("baixa@example.com");
    const response = await download("bolo-no-pote", "m1a1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toStartWith(`attachment; filename="${PDF_NAME}"`);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("anexo: sem sessão vai ao login, outro produto e reembolsado dão 404", async () => {
    await attachEbook("m1a1");
    freshBrowser("192.0.2.150");
    const anonymous = await download("bolo-no-pote", "m1a1");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/m");

    await buyer("planilha@example.com", "planilha-preco", 4700);
    expect((await download("bolo-no-pote", "m1a1")).status).toBe(404);
    expect((await download("planilha-preco", "m1a1")).status).toBe(404);

    const refunded = await buyer("reembolso@example.com");
    expect((await download("bolo-no-pote", "m1a1")).status).toBe(200);
    const memberCookies = new Map(cookieStore);
    await signInAsAdmin();
    expect(await refundOrder({ code: null }, form({ orderId: refunded }))).toEqual({ code: null, ok: true });
    freshBrowser("192.0.2.151");
    for (const [name, value] of memberCookies) cookieStore.set(name, value);
    const afterRefund = await download("bolo-no-pote", "m1a1");
    expect(afterRefund.status).toBe(404);
    expect(await afterRefund.text()).toBe("");
  });

  test("anexo: a aula com anexo mostra Baixar o PDF", async () => {
    await attachEbook("m1a1");
    await buyer("aula@example.com");
    const withPdf = await lessonHtml("bolo-no-pote", "m1a1");
    expect(withPdf).toContain("Baixar o PDF");
    expect(withPdf).toContain('href="/m/bolo-no-pote/m1a1/anexo"');
    const withoutPdf = await lessonHtml("bolo-no-pote", "m1a2");
    expect(withoutPdf).toContain("Montagem sem vazar");
    expect(withoutPdf).not.toContain("Baixar o PDF");
    expect(withoutPdf).not.toContain("/anexo");
  });

  test("nfse: descrição com o nome do produto", async () => {
    const server = await outside();

    try {
      await redirected(
        createProduct({ code: null }, form({ name: "Manual do Sono do Bebê", slug: "manual-do-sono", price: "47,00" })),
      );

      freshBrowser("192.0.2.160");
      const id = await buy({ email: "nota@example.com", slug: "manual-do-sono", document: "529.982.247-25" });
      await pay(id, 4700, `nota-${id}`);
      await issueInvoices();

      const [issued] = server.to("POST", "/SefinNacional/nfse");
      const xml = gunzipSync(Buffer.from(JSON.parse(issued?.body ?? "{}").dpsXmlGZipB64, "base64")).toString("utf8");
      expect(xml).toContain("<xDescServ>Manual do Sono do Bebê</xDescServ>");
      expect(xml).toContain("<vServ>47.00</vServ>");
      expect(xml).not.toContain("Acesso ao curso online");
    } finally {
      vi.restoreAllMocks();
      await removeCredentials("nfse");
      await server.close();
    }
  });

  test("vendas: 401 sem token, lista vazia e pedidos com UTM do último toque", async () => {
    const token = "t".repeat(40);

    const ask = (query: string, authorization?: string) =>
      sales(
        new Request(`https://shop.example/api/v1/vendas?${query}`, {
          headers: authorization ? { authorization } : {},
        }),
      );

    const october = "desde=2026-10-01T00:00:00-03:00&ate=2026-10-04T00:00:00-03:00";

    delete process.env.VENDAS_TOKEN;
    expect((await ask(october, `Bearer ${token}`)).status).toBe(404);
    process.env.VENDAS_TOKEN = "curto";
    expect((await ask(october, "Bearer curto")).status).toBe(404);
    process.env.VENDAS_TOKEN = token;

    try {
      expect((await ask(october)).status).toBe(401);
      expect((await ask(october, `Bearer ${"x".repeat(40)}`)).status).toBe(401);
      expect((await ask(october, token)).status).toBe(401);

      const empty = await ask("desde=2026-09-01T00:00:00-03:00&ate=2026-09-02T00:00:00-03:00", `Bearer ${token}`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ loja: "shop.example", moeda: "brl", vendas: [] });

      // An earlier visit, the visit that placed the order, then a visit after it: the middle one brought the sale.
      freshBrowser("192.0.2.170");
      setSystemTime(new Date("2026-10-01T09:00:00-03:00"));
      await recordTouch(await visitor(), "?utm_source=tiktok&utm_content=antes", "", "/v/bolo-no-pote");
      setSystemTime(new Date("2026-10-01T10:00:00-03:00"));
      const touch = "?utm_source=instagram&utm_medium=dm&utm_campaign=r-com&utm_content=1789";
      const paid = await buy({ email: "utm@example.com", phone: "(48) 98888-7777", touch });
      setSystemTime(new Date("2026-10-01T10:05:00-03:00"));
      await pay(paid, 9700, `utm-${paid}`);
      setSystemTime(new Date("2026-10-01T11:00:00-03:00"));
      await recordTouch(await visitor(), "?utm_source=email&utm_content=depois", "", "/v/bolo-no-pote");

      freshBrowser("192.0.2.171");
      setSystemTime(new Date("2026-10-02T10:00:00-03:00"));
      const refunded = await buy({ email: "volta@example.com", slug: "planilha-preco" });
      await pay(refunded, 4700, `utm-${refunded}`);
      freshBrowser("192.0.2.172");
      await buy({ email: "pendente@example.com" });
      setSystemTime(new Date("2026-10-03T10:00:00-03:00"));
      await signInAsAdmin();
      expect(await refundOrder({ code: null }, form({ orderId: refunded }))).toEqual({ code: null, ok: true });

      freshBrowser("192.0.2.173");
      setSystemTime(new Date("2026-10-05T10:00:00-03:00"));
      const later = await buy({ email: "depois@example.com" });
      await pay(later, 9700, `utm-${later}`);

      const report = await ask(october, `Bearer ${token}`);
      expect(report.status).toBe(200);
      const text = await report.text();
      expect(JSON.parse(text)).toEqual({
        loja: "shop.example",
        moeda: "brl",
        vendas: [
          {
            id: paid,
            pago_em: "2026-10-01T13:05:00.000Z",
            valor_centavos: 9700,
            status: "pago",
            utm_source: "instagram",
            utm_medium: "dm",
            utm_campaign: "r-com",
            utm_content: "1789",
          },
          {
            id: refunded,
            pago_em: "2026-10-02T13:00:00.000Z",
            valor_centavos: 4700,
            status: "reembolsado",
            utm_source: null,
            utm_medium: null,
            utm_campaign: null,
            utm_content: null,
          },
        ],
      });

      for (const personal of ["@example.com", "Ana Souza", "98888", "192.0.2."]) expect(text).not.toContain(personal);
    } finally {
      delete process.env.VENDAS_TOKEN;
    }
  });

  // docs.abacatepay.com/pages/webhooks/events/transparent: an open dispute (MED on Pix) is UNDER_DISPUTE, a lost one
  // goes back to REFUNDED, announced by transparent.disputed and transparent.lost.
  test("abacatepay: MED perdido revoga o acesso e disputa aberta não", async () => {
    const server = await outside();
    const key = `${NOTE_KEY.slice(0, -1)}1`;
    server.routes["POST /SefinNacional/nfse"] = { status: 201, body: { chaveAcesso: key, idDps: "x" } };
    server.routes[`POST /SefinNacional/nfse/${key}/eventos`] = { status: 201, body: { eventoXmlGZipB64: "" } };

    const charge = (status: string, reason?: string) => {
      const entry = { id: "pix_med", amount: 9700, status, devMode: false, brCode: "x", ...(reason ? { reason } : {}) };
      server.routes["GET /v2/transparents/list"] = { status: 200, body: { data: [entry], success: true, error: null } };
    };

    const state = async (id: string) => ({
      status: one(await db().select({ status: order.status }).from(order).where(eq(order.id, id))).status,
      payments: (
        await db().select({ amount: payment.amount }).from(payment).where(eq(payment.orderId, id)).orderBy(payment.id)
      ).map((row) => row.amount),
      note: one(await db().select({ status: invoice.status }).from(invoice).where(eq(invoice.orderId, id))).status,
      access: (await currentMember())?.owned ?? [],
    });

    try {
      await saveCredentials("abacatepay", {}, { apiKey: "abc_prod_key", webhookSecret: ABACATE_SECRET });
      await saveCredentials("pix", { provider: "abacatepay" });
      freshBrowser("192.0.2.180");
      const id = await buy({ email: "med@example.com", document: "529.982.247-25" });
      await db().update(order).set({ psp: "abacatepay", txid: "pix_med" }).where(eq(order.id, id));

      charge("PAID");
      await abacateNotice("transparent.completed", "pix_med");
      await checkCharges();
      await redirected(enterFromOrder());
      await issueInvoices();
      expect(await state(id)).toEqual({ status: "paid", payments: [9700], note: "issued", access: ["bolo-no-pote"] });

      charge("UNDER_DISPUTE", "Dispute created");
      await abacateNotice("transparent.disputed", "pix_med");
      await checkCharges();
      await issueInvoices();
      expect(await state(id)).toEqual({ status: "paid", payments: [9700], note: "issued", access: ["bolo-no-pote"] });
      expect(server.to("POST", `/SefinNacional/nfse/${key}/eventos`)).toHaveLength(0);

      charge("REFUNDED", "Dispute created");
      await abacateNotice("transparent.lost", "pix_med");
      await checkCharges();
      await abacateNotice("transparent.disputed", "pix_med");
      await checkCharges();
      await issueInvoices();
      expect(await state(id)).toEqual({ status: "refunded", payments: [9700, -9700], note: "canceled", access: [] });
      expect(server.to("POST", `/SefinNacional/nfse/${key}/eventos`)).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await removeCredentials("nfse");
      await removeCredentials("abacatepay");
      await saveCredentials("pix", { provider: "static" });
      await server.close();
    }
  });
});

// An e-CNPJ like the ones ICP-Brasil issues: the CNPJ under OID 2.16.76.1.3.3 in the alternative name.
function certificate(cnpj: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2027-01-01T00:00:00Z");
  const subject = [{ name: "commonName", value: `ACT TECH LTDA:${cnpj}` }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  const { asn1 } = forge;

  const otherName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("2.16.76.1.3.3").getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, cnpj),
    ]),
  ]);

  const names = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [otherName]);
  cert.setExtensions([{ id: "2.5.29.17", value: asn1.toDer(names).getBytes() }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "senha-do-a1", { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

function nfseForm(pfx: Buffer): FormData {
  const data = form({
    regime: "",
    city: "",
    service: "",
    registration: "",
    taxRate: "",
    issRate: "",
    password: "senha-do-a1",
  });

  data.set("certificate", new File([new Uint8Array(pfx)], "act-tech.pfx", { type: "application/x-pkcs12" }));
  return data;
}
