import { createElement } from "react";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, test, setSystemTime } from "bun:test";
import { enterFromOrder } from "@/lib/actions/members";
import { refundOrder } from "@/lib/actions/orders";
import { saveLesson } from "@/lib/actions/products";
import { POST as upload } from "@/app/admin/media/route";
import { GET as attachment } from "@/app/m/[product]/[lesson]/anexo/route";
import Members from "@/app/m/[[...path]]/page";
import { ErrorText } from "@/app/ui";
import { cookieStore, form, freshBrowser, redirected } from "./fakes";
import { buy, pay, signInAsAdmin } from "./flows";

const MB = 1024 * 1024;
const PDF_NAME = "Manual-do-Sono-do-Bebe.pdf";
const NOON = new Date("2026-11-14T12:00:00-03:00");

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
});
