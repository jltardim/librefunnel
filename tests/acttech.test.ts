import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { gunzipSync } from "node:zlib";
import forge from "node-forge";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, test, vi, setSystemTime } from "bun:test";
import { enterFromOrder } from "@/lib/actions/members";
import { refundOrder } from "@/lib/actions/orders";
import { createProduct, saveLesson } from "@/lib/actions/products";
import { saveNfse } from "@/lib/actions/connections";
import { issueInvoices } from "@/lib/invoices";
import { removeCredentials } from "@/lib/settings";
import { POST as upload } from "@/app/admin/media/route";
import { GET as attachment } from "@/app/m/[product]/[lesson]/anexo/route";
import Members from "@/app/m/[[...path]]/page";
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
    const cnpj = "64076031000109";
    const key = `3550308264076031000109${"0".repeat(28)}`;

    const server = await fakeServer({
      "GET /parametrizacao/3550308/convenio": {
        status: 200,
        body: { parametrosConvenio: { aderenteEmissorNacional: 1 } },
      },
      [`GET /api/cnpj/v1/${cnpj}`]: {
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
      "POST /SefinNacional/nfse": { status: 201, body: { chaveAcesso: key, idDps: "x" } },
    });

    sefin = server.url;
    redirectFetch("https://brasilapi.com.br", server.url);

    try {
      await signInAsAdmin();
      const pfx = nfseForm(certificate(cnpj));
      expect(await saveNfse({ code: null }, pfx)).toEqual({ code: null, ok: true });
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
