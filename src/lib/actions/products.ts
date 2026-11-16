"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as course from "../catalog/course";
import * as catalog from "../catalog/products";
import { baseUrl, demoMode } from "../guard";
import { isAdmin } from "../sessions";
import {
  SLUG,
  parseAttachment,
  parseDomain,
  parseInteger,
  parseLine,
  parseMedia,
  parsePrice,
  parseRowId,
  parseText,
  parseTitle,
} from "../input";
import { column, done, field, pixFields } from "./form";
import type { ActionState, Code, FormArgs } from "./form";
import { formatSlug } from "@/format";

function productFields(form: FormData): catalog.ProductFields | { code: Code } {
  const name = parseTitle(field(form, "name"));
  if (!name) return { code: "INVALID_TITLE" };
  const cents = parsePrice(field(form, "price"));
  if (!cents) return { code: "INVALID_PRICE" };
  const tagline = parseLine(field(form, "tagline"));
  const ctaText = parseLine(field(form, "ctaText"), 80);
  const bumpHeadline = parseLine(field(form, "bumpHeadline"));
  if (tagline === undefined || ctaText === undefined || bumpHeadline === undefined) return { code: "INVALID_TEXT" };
  const offer = field(form, "offerEndsAt").trim();
  const offerEndsAt = offer ? new Date(offer) : null;
  if (offerEndsAt && Number.isNaN(offerEndsAt.getTime())) return { code: "INVALID_DATE" };
  const guaranteeDays = parseInteger(field(form, "guaranteeDays"), 7, 365);
  if (guaranteeDays === undefined) return { code: "INVALID_GUARANTEE" };
  const ctaSeconds = parseInteger(field(form, "ctaSeconds") || "0", 0, 7200);
  if (ctaSeconds === undefined) return { code: "INVALID_CTA_SECONDS" };
  const bumpProduct = field(form, "bumpProduct") || null;
  const bumpPrice = field(form, "bumpPrice").trim() ? parsePrice(field(form, "bumpPrice")) : null;
  if (bumpPrice === undefined || (bumpProduct !== null && !SLUG.test(bumpProduct))) return { code: "INVALID_BUMP" };
  const vslVideo = parseMedia(field(form, "vslVideo"));
  const banner = parseMedia(field(form, "banner"));
  const cover = parseMedia(field(form, "cover"));
  if (vslVideo === undefined || banner === undefined || cover === undefined) return { code: "INVALID_MEDIA" };
  const answers = column(form, "faq_a");
  const faq: catalog.Faq[] = [];
  for (const [index, raw] of column(form, "faq_q").entries()) {
    const q = parseLine(raw);
    const a = parseText(answers[index] ?? "", 2000);
    if (q === null && !a) continue;
    if (!q || !a) return { code: "INVALID_FAQ" };
    faq.push({ q, a });
  }
  const quotes = column(form, "testimonial_text");
  const stars = column(form, "testimonial_stars");
  const testimonials: catalog.Testimonial[] = [];
  for (const [index, raw] of column(form, "testimonial_name").entries()) {
    const author = parseTitle(raw);
    const quote = parseText(quotes[index] ?? "", 1000);
    const rating = parseInteger(stars[index] ?? "", 1, 5);
    if (!raw.trim() && !quote) continue;
    if (!author || !quote || rating === undefined) return { code: "INVALID_TESTIMONIAL" };
    testimonials.push({ name: author, text: quote, stars: rating });
  }
  const starts = column(form, "trigger_at");
  const ends = column(form, "trigger_until");
  const kinds = column(form, "trigger_kind");
  const triggers: catalog.Trigger[] = [];
  for (const [index, raw] of column(form, "trigger_text").entries()) {
    const label = parseLine(raw, 80);
    const at = parseInteger(starts[index] ?? "", 0, 7200);
    const until = parseInteger(ends[index] ?? "", 1, 7200);
    if (label === null && !starts[index]?.trim() && !ends[index]?.trim()) continue;
    if (!label || at === undefined || until === undefined || until <= at) return { code: "INVALID_TRIGGER" };
    triggers.push({ at, until, text: label, button: kinds[index] === "button" });
  }
  const barText = parseLine(field(form, "barText"), 120);
  if (barText === undefined) return { code: "INVALID_TEXT" };
  const barColor = field(form, "barColor").trim().toLowerCase() || null;
  if (barColor !== null && !/^#[0-9a-f]{6}$/.test(barColor)) return { code: "INVALID_COLOR" };
  const captions = parseMedia(field(form, "captions"));
  if (captions === undefined) return { code: "INVALID_MEDIA" };
  const typed = field(form, "domain").trim();
  const domain = typed ? parseDomain(typed) : null;
  if (domain === undefined || domain === URL.parse(baseUrl())?.hostname) return { code: "INVALID_DOMAIN" };
  // The public demo would otherwise request certificates for any name a visitor points at it.
  if (domain !== null && demoMode()) return { code: "DEMO_BLOCKED" };
  return {
    name,
    price: cents,
    tagline,
    offerEndsAt,
    guaranteeDays,
    bumpProduct,
    bumpPrice,
    bumpHeadline,
    vslVideo,
    ctaSeconds,
    ctaText,
    player: {
      autoplay: field(form, "playerAutoplay") === "1",
      resume: field(form, "playerResume") === "1",
      fastBar: field(form, "playerFastBar") === "1",
      floating: field(form, "playerFloating") === "1",
      button: field(form, "playerButton") === "1",
      speed: field(form, "playerSpeed") === "1",
    },
    captions,
    triggers: triggers.sort((a, b) => a.at - b.at),
    barText,
    barColor,
    banner,
    cover,
    faq,
    testimonials,
    domain,
  };
}

function item(form: FormData): { kind: "product" | "module" | "lesson"; key: string | number } | undefined {
  const kind = field(form, "kind");
  const raw = field(form, "key");
  if (kind === "product" || kind === "lesson") return SLUG.test(raw) ? { kind, key: raw } : undefined;
  const key = parseRowId(raw);
  return kind === "module" && key !== undefined ? { kind, key } : undefined;
}

export async function createProduct(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const name = parseTitle(field(form, "name"));
  if (!name) return { code: "INVALID_TITLE" };
  const slug = field(form, "slug").trim() || formatSlug(name);
  if (!SLUG.test(slug)) return { code: "INVALID_SLUG" };
  const cents = parsePrice(field(form, "price"));
  if (!cents) return { code: "INVALID_PRICE" };
  // The second step asks for the store's key only when the store has none yet, and saves it for every product.
  let pix = await catalog.storePix();
  if (!pix) {
    const typed = await pixFields(form);
    if ("code" in typed) return typed;
    await catalog.saveStorePix(typed);
    pix = typed;
  }
  const code = await catalog.createProduct(slug, { name, price: cents }, pix);
  if (code) return { code };
  revalidatePath("/", "layout");
  redirect(`/admin?tab=products&product=${slug}`);
}

export async function saveProduct(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const fields = productFields(form);
  return "code" in fields ? fields : done(await catalog.updateProduct(field(form, "slug"), fields));
}

export async function moveItem(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const target = item(form);
  const moved = target && (await course.move(target.kind, target.key, field(form, "direction") === "up"));
  return done(moved ? null : "INVALID_TRANSITION");
}

export async function archiveItem(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const target = item(form);
  const changed = target && (await course.archive(target.kind, target.key, field(form, "archived") === "1"));
  return done(changed ? null : "INVALID_TRANSITION");
}

export async function saveModule(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const name = parseTitle(field(form, "title"));
  if (!name) return { code: "INVALID_TITLE" };
  const cover = parseMedia(field(form, "cover"));
  if (cover === undefined) return { code: "INVALID_MEDIA" };
  const id = parseRowId(field(form, "id"));
  const target = id === undefined ? { product: field(form, "product") } : { id };
  return done((await course.saveModule(target, name, cover)) ? null : "INVALID_TRANSITION");
}

export async function saveLesson(...[, form]: FormArgs): Promise<ActionState> {
  if (!(await isAdmin())) return { code: "NOT_SIGNED_IN" };
  const name = parseTitle(field(form, "title"));
  if (!name) return { code: "INVALID_TITLE" };
  const video = parseMedia(field(form, "video"));
  if (video === undefined) return { code: "INVALID_MEDIA" };
  const attachment = parseAttachment(field(form, "attachment"), field(form, "attachmentName"));
  if (attachment === undefined) return { code: "INVALID_MEDIA" };
  const body = parseText(field(form, "text"), 20_000);
  if (body === undefined) return { code: "INVALID_TEXT" };
  const slug = field(form, "lesson");
  const target = SLUG.test(slug) ? { slug } : { module: parseRowId(field(form, "module")) ?? 0 };

  const values = {
    title: name,
    video: video ?? "",
    text: body,
    attachment: attachment?.url ?? null,
    attachmentName: attachment?.name ?? null,
  };

  return done((await course.saveLesson(target, values)) ? null : "INVALID_TRANSITION");
}
