import { createHash, createVerify, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import forge from "node-forge";
import { afterEach, beforeEach, describe, expect, test, vi, setSystemTime } from "bun:test";
import { refundOrder, retryInvoice } from "@/lib/actions/orders";
import { saveNfse, testConnection } from "@/lib/actions/connections";
import { removeCredentials } from "@/lib/settings";
import { integrations } from "@/lib/dashboard";
import { db, one } from "@/lib/db";
import { issueInvoices } from "@/lib/invoices";
import { invoice, message, order } from "@/lib/schema";
import { fakeServer, form, redirectFetch } from "./fakes";
import { buy, pay, signInAsAdmin } from "./flows";

const CNPJ = "11222333000181";
const CITY = "3550308";
const PASSWORD = "senha-do-a1";

const sent: { url: string; options: RequestOptions }[] = [];
let target = "";

// The store calls Sefin and ADN over mutual TLS; the tests send the same requests to a plain local server.
vi.mock("node:https", () => ({
  request: (url: string, options: RequestOptions, callback: Parameters<typeof httpRequest>[2]) => {
    sent.push({ url, options });
    return httpRequest(url.replace(/^https:\/\/(sefin|adn)\.nfse\.gov\.br/, target), options, callback);
  },
}));

// An e-CNPJ like the ones ICP-Brasil issues: the CNPJ under OID 2.16.76.1.3.3 in the alternative name.
function certificate(cnpj: string | null, password = PASSWORD): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2027-01-01T00:00:00Z");
  const subject = [{ name: "commonName", value: `LOJA TESTE LTDA:${cnpj ?? "00000000000"}` }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  if (cnpj) {
    const { asn1 } = forge;

    const otherName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("2.16.76.1.3.3").getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, cnpj),
      ]),
    ]);

    const names = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [otherName]);
    cert.setExtensions([{ id: "2.5.29.17", value: asn1.toDer(names).getBytes() }]);
  }
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

function nfseForm(fields: Record<string, string>, file?: Buffer): FormData {
  const data = form({
    regime: "",
    city: "",
    service: "",
    registration: "",
    taxRate: "",
    issRate: "",
    immunity: "",
    password: PASSWORD,
    ...fields,
  });

  if (file) data.set("certificate", new File([new Uint8Array(file)], "empresa.pfx", { type: "application/x-pkcs12" }));
  return data;
}

function unpacked(body: string, field: string): string {
  const packedXml = JSON.parse(body)[field];
  return gunzipSync(Buffer.from(packedXml, "base64")).toString("utf8");
}

// Checks the XML the way Sefin does: digest of the canonical signed element, then the RSA-SHA1 signature of SignedInfo.
function verifySignature(xml: string, element: string) {
  const signedPart = new RegExp(`<${element} Id="[^"]+">.*</${element}>`).exec(xml)?.[0] ?? "";
  const canonical = signedPart.replace(`<${element} `, `<${element} xmlns="http://www.sped.fazenda.gov.br/nfse" `);
  const digest = createHash("sha1").update(canonical).digest("base64");
  expect(xml).toContain(`<DigestValue>${digest}</DigestValue>`);
  const info = /<SignedInfo>(.*)<\/SignedInfo>/.exec(xml)?.[1] ?? "";
  const value = /<SignatureValue>(.*)<\/SignatureValue>/.exec(xml)?.[1] ?? "";
  const leaf = /<X509Certificate>(.*)<\/X509Certificate>/.exec(xml)?.[1] ?? "";
  const publicKey = new X509Certificate(Buffer.from(leaf, "base64")).publicKey;

  const verifier = createVerify("RSA-SHA1").update(
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">${info}</SignedInfo>`,
  );

  expect(verifier.verify(publicKey, value, "base64")).toBe(true);
}

async function stored(orderId: string) {
  return one(
    await db()
      .select({
        status: invoice.status,
        key: invoice.key,
        error: invoice.error,
        rejection: invoice.rejection,
        nextAt: invoice.nextAt,
      })
      .from(invoice)
      .where(eq(invoice.orderId, orderId)),
  );
}

describe("NFS-e", () => {
  let server: Awaited<ReturnType<typeof fakeServer>>;
  const pfx = certificate(CNPJ);
  let buyers = 0;
  let notes = 0;
  let KEY = "";

  async function paidOrder(document = "") {
    buyers += 1;
    const id = await buy({ email: `nota${buyers}@example.com`, document });
    await pay(id);
    return id;
  }

  // Each test runs 20 minutes after the previous one, so the panel's limit on connection tests starts over.
  let now = new Date();

  beforeEach(async () => {
    notes += 1;
    now = new Date(Date.parse("2026-11-14T12:00:00-03:00") + notes * 20 * 60_000);
    setSystemTime(now);
    KEY = `${CITY}2${String(notes).padStart(42, "0")}`;
    server = await fakeServer({
      [`GET /parametrizacao/${CITY}/convenio`]: {
        status: 200,
        body: { parametrosConvenio: { aderenteEmissorNacional: 1 } },
      },
      [`GET /api/cnpj/v1/${CNPJ}`]: {
        status: 200,
        body: {
          razao_social: "LOJA TESTE LTDA",
          codigo_municipio_ibge: 3550308,
          municipio: "SAO PAULO",
          uf: "SP",
          opcao_pelo_simples: true,
          opcao_pelo_mei: false,
        },
      },
      "HEAD *": { status: 404, body: "" },
      "GET *": { status: 404, body: { erro: { codigo: "E0000" } } },
      "POST /SefinNacional/nfse": { status: 201, body: { chaveAcesso: KEY, idDps: "x" } },
      [`POST /SefinNacional/nfse/${KEY}/eventos`]: { status: 201, body: { eventoXmlGZipB64: "" } },
    });
    target = server.url;
    redirectFetch("https://brasilapi.com.br", server.url);
    sent.length = 0;
    await signInAsAdmin();
    expect(await saveNfse({ code: null }, nfseForm({}, pfx))).toEqual({ code: null, ok: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeCredentials("nfse");
    await server.close();
  });

  test("the certificate alone fills the city, the regime and the taxes from the CNPJ registry", async () => {
    expect(await integrations()).toMatchObject({
      nfse: {
        cnpj: CNPJ,
        city: CITY,
        place: "Sao Paulo/SP",
        regime: "simples",
        taxRate: "6.00",
        issRate: "",
        service: "080201",
      },
    });

    server.routes[`GET /api/cnpj/v1/${CNPJ}`] = {
      status: 200,
      body: {
        razao_social: "LOJA TESTE LTDA",
        codigo_municipio_ibge: 3550308,
        municipio: "SAO PAULO",
        uf: "SP",
        opcao_pelo_simples: false,
        opcao_pelo_mei: false,
      },
    };
    expect(await saveNfse({ code: null }, nfseForm({}, pfx))).toEqual({ code: null, ok: true });
    expect((await integrations()).nfse).toMatchObject({ regime: "normal", taxRate: "11.33", issRate: "5.00" });

    server.routes["GET /parametrizacao/4205407/convenio"] = {
      status: 200,
      body: { parametrosConvenio: { aderenteEmissorNacional: 1 } },
    };
    expect(await saveNfse({ code: null }, nfseForm({ regime: "mei", city: "4205407" }))).toEqual({
      code: null,
      ok: true,
    });
    expect((await integrations()).nfse).toMatchObject({ regime: "mei", city: "4205407", place: "", taxRate: "" });

    server.routes[`GET /api/cnpj/v1/${CNPJ}`] = { status: 503, body: "" };
    expect(await saveNfse({ code: null }, nfseForm({}, pfx))).toEqual({ code: "CNPJ_LOOKUP_FAILED" });
  });

  test("a first connection with the registry down uses the regime and city typed beside the certificate", async () => {
    await removeCredentials("nfse");
    server.routes[`GET /api/cnpj/v1/${CNPJ}`] = { status: 503, body: "" };
    const typed = { regime: "simples", city: CITY, service: "010902", immunity: "livros" };
    expect(await saveNfse({ code: null }, nfseForm(typed, pfx))).toEqual({ code: null, ok: true });
    expect((await integrations()).nfse).toMatchObject({ cnpj: CNPJ, ...typed, place: "", taxRate: "6.00" });
  });

  test("the certificate is checked, its key goes only to Sefin over mutual TLS, and the city is confirmed", async () => {
    expect(await saveNfse({ code: null }, nfseForm({ password: "errada" }, pfx))).toEqual({
      code: "CERTIFICATE_UNREADABLE",
    });
    expect(await saveNfse({ code: null }, nfseForm({}, certificate(null)))).toEqual({ code: "CERTIFICATE_NOT_CNPJ" });
    expect(await saveNfse({ code: null }, nfseForm({ city: "355030", regime: "simples" }))).toEqual({
      code: "INVALID_CITY",
    });
    expect(await saveNfse({ code: null }, nfseForm({ taxRate: "seis" }))).toEqual({ code: "INVALID_RATE" });
    expect(sent.every((call) => call.options.key && call.options.cert)).toBe(true);

    server.routes[`GET /parametrizacao/${CITY}/convenio`] = { status: 404, body: { parametrosConvenio: null } };
    expect(await testConnection({ code: null }, form({ kind: "nfse" }))).toEqual({ code: "NFSE_CITY_NOT_NATIONAL" });
  });

  test("a paid order gets one signed NFS-e, the buyer gets the link, and a refund cancels it", async () => {
    const id = await paidOrder("529.982.247-25");
    expect((await stored(id)).status).toBe("queued");

    await issueInvoices();
    const [issued] = server.to("POST", "/SefinNacional/nfse");
    const xml = unpacked(issued?.body ?? "{}", "dpsXmlGZipB64");
    expect(xml).toMatch(
      /^<\?xml version="1\.0" encoding="UTF-8"\?><DPS xmlns="http:\/\/www\.sped\.fazenda\.gov\.br\/nfse" versao="1\.01"><infDPS Id="DPS3550308211222333000181471010\d{14}">/,
    );
    const issuedAt = new Date(now.getTime() - 3 * 3600_000 - 10_000).toISOString().slice(0, 19);
    expect(xml).toContain(`<dhEmi>${issuedAt}-03:00</dhEmi>`);
    expect(xml).toContain("<dCompet>2026-11-14</dCompet>");
    expect(xml).toContain("<toma><CPF>52998224725</CPF><xNome>Ana Souza</xNome></toma>");
    expect(xml).toContain("<cTribNac>080201</cTribNac>");
    expect(xml).toContain("<vServ>97.00</vServ>");
    expect(xml).toContain("<totTrib><pTotTribSN>6.00</pTotTribSN></totTrib>");
    verifySignature(xml, "infDPS");

    expect(await stored(id)).toMatchObject({ status: "issued", key: KEY, nextAt: null });

    const [mail] = await db()
      .select({ address: message.address, body: message.body })
      .from(message)
      .where(eq(message.orderId, id))
      .then((rows) => rows.filter((row) => row.body.includes("nota fiscal")));

    expect(mail?.body).toContain(`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${KEY}`);

    await issueInvoices();
    expect(server.to("POST", "/SefinNacional/nfse")).toHaveLength(1);

    expect(await refundOrder({ code: null }, form({ orderId: id }))).toEqual({ code: null, ok: true });
    await issueInvoices();
    const [event] = server.to("POST", `/SefinNacional/nfse/${KEY}/eventos`);
    const cancel = unpacked(event?.body ?? "{}", "pedidoRegistroEventoXmlGZipB64");
    expect(cancel.startsWith('<?xml version="1.0" encoding="UTF-8"?><pedRegEvento ')).toBe(true);
    expect(cancel).toContain(`<infPedReg Id="PRE${KEY}101101">`);
    expect(cancel).toContain(`<CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${KEY}</chNFSe>`);
    verifySignature(cancel, "infPedReg");
    expect((await stored(id)).status).toBe("canceled");
  });

  test("a book's note is immune to ISS: tribISSQN 2 with tpImunidade 4, and turning it off taxes again", async () => {
    expect((await integrations()).nfse).toMatchObject({ immunity: "" });

    const book = { regime: "normal", city: CITY, service: "010902", immunity: "livros" };
    expect(await saveNfse({ code: null }, nfseForm({ ...book, immunity: "talvez" }))).toEqual({
      code: "INVALID_PAYLOAD",
    });
    expect(await saveNfse({ code: null }, nfseForm(book))).toEqual({ code: null, ok: true });
    expect((await integrations()).nfse).toMatchObject({ service: "010902", immunity: "livros" });

    await paidOrder("529.982.247-25");
    await issueInvoices();
    const [immune] = server.to("POST", "/SefinNacional/nfse");
    const xml = unpacked(immune?.body ?? "{}", "dpsXmlGZipB64");
    expect(xml).toContain("<cTribNac>010902</cTribNac>");
    expect(xml).toContain(
      "<tribMun><tribISSQN>2</tribISSQN><tpImunidade>4</tpImunidade><tpRetISSQN>1</tpRetISSQN></tribMun>",
    );
    expect(xml).toContain("<pTotTribMun>0.00</pTotTribMun>");
    verifySignature(xml, "infDPS");

    expect(await saveNfse({ code: null }, nfseForm({ ...book, immunity: "" }))).toEqual({ code: null, ok: true });
    // Sefin gives every note its own access key.
    server.routes["POST /SefinNacional/nfse"] = {
      status: 201,
      body: { chaveAcesso: `${CITY}2${"1".repeat(42)}`, idDps: "y" },
    };
    await paidOrder("529.982.247-25");
    await issueInvoices();
    const [, taxed] = server.to("POST", "/SefinNacional/nfse");
    const again = unpacked(taxed?.body ?? "{}", "dpsXmlGZipB64");
    expect(again).toContain("<tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>");
    expect(again).not.toContain("tpImunidade");
    expect(again).toContain("<pTotTribMun>5.00</pTotTribMun>");
  });

  test("without a CPF the note has no tomador, and a lost answer is looked up instead of issuing twice", async () => {
    const id = await paidOrder();
    server.routes["POST /SefinNacional/nfse"] = { status: 503, body: "" };
    await issueInvoices();
    expect(await stored(id)).toMatchObject({ status: "queued", error: "NFSE_UNREACHABLE" });
    const xml = unpacked(server.to("POST", "/SefinNacional/nfse")[0]?.body ?? "{}", "dpsXmlGZipB64");
    expect(xml).not.toContain("<toma>");
    expect(xml).toContain("Comprador: Ana Souza");
    const dpsId = /Id="(DPS\d{42})"/.exec(xml)?.[1] ?? "";

    server.routes[`GET /SefinNacional/dps/${dpsId}`] = { status: 200, body: { chaveAcesso: KEY } };
    setSystemTime(new Date(now.getTime() + 5 * 60_000));
    await issueInvoices();
    setSystemTime(now);
    expect(await stored(id)).toMatchObject({ status: "issued", key: KEY });
    expect(server.to("POST", "/SefinNacional/nfse")).toHaveLength(1);
  });

  test("a rejection keeps only the official code, and the panel sends it again after the fix", async () => {
    const id = await paidOrder();
    server.routes["POST /SefinNacional/nfse"] = {
      status: 400,
      body: { erros: [{ codigo: "E0310", descricao: "Código de tributação inexistente <script>" }] },
    };
    await issueInvoices();
    expect(await stored(id)).toMatchObject({ status: "failed", error: "NFSE_SERVICE_INVALID", rejection: "E0310" });

    server.routes["POST /SefinNacional/nfse"] = { status: 201, body: { chaveAcesso: KEY } };
    expect(await retryInvoice({ code: null }, form({ orderId: id }))).toEqual({ code: null, ok: true });
    await issueInvoices();
    expect(await stored(id)).toMatchObject({ status: "issued", error: null, rejection: null });
  });

  test("a refund before the note is issued sends nothing", async () => {
    const id = await paidOrder();
    expect(await refundOrder({ code: null }, form({ orderId: id }))).toEqual({ code: null, ok: true });
    await issueInvoices();
    expect((await stored(id)).status).toBe("canceled");
    expect(server.to("POST", "/SefinNacional/nfse")).toHaveLength(0);
  });

  test("the checkout asks for CPF or CNPJ only while invoices are on, and checks its digits", async () => {
    await expect(buy({ email: "cpf-errado@example.com", document: "529.982.247-26" })).rejects.toThrow();
    const id = await buy({ email: "cnpj@example.com", document: "11.222.333/0001-81" });
    expect(one(await db().select({ document: order.document }).from(order).where(eq(order.id, id)))).toEqual({
      document: CNPJ,
    });

    await removeCredentials("nfse");
    const ignored = await buy({ email: "sem-nota@example.com", document: "123" });
    expect(one(await db().select({ document: order.document }).from(order).where(eq(order.id, ignored)))).toEqual({
      document: null,
    });
  });
});
