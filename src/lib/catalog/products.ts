import "server-only";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { cache } from "react";
import { db } from "../db";
import type { Database } from "../db";
import { lesson, module, product } from "../schema";
import { credentials, saveCredentials } from "../settings";

export type CatalogCode =
  | "INVALID_COLOR"
  | "INVALID_DOCUMENT"
  | "INVALID_SLUG"
  | "SLUG_TAKEN"
  | "INVALID_TITLE"
  | "INVALID_PRICE"
  | "INVALID_PIX_KEY"
  | "INVALID_PIX_HOLDER"
  | "INVALID_DATE"
  | "INVALID_CTA_SECONDS"
  | "INVALID_TRIGGER"
  | "INVALID_GUARANTEE"
  | "INVALID_BUMP"
  | "INVALID_TEXT"
  | "INVALID_MEDIA"
  | "INVALID_FAQ"
  | "INVALID_TESTIMONIAL"
  | "INVALID_ORDER_HOURS"
  | "INVALID_URL"
  | "INVALID_TRANSITION"
  | "INVALID_HOST"
  | "INVALID_PORT"
  | "INVALID_CREDENTIAL"
  | "INVALID_PIXEL_ID"
  | "INVALID_TEST_EVENT_CODE"
  | "INVALID_EVOLUTION_URL"
  | "INVALID_WEBHOOK_SECRET"
  | "PIX_PROVIDER_NOT_CONFIGURED"
  | "INVALID_DOMAIN"
  | "DOMAIN_TAKEN";

type Lesson = {
  id: string;
  title: string;
  video: string;
  text: string;
  attachment: string | null;
  attachmentName: string | null;
  archived: boolean;
};

export type Module = { id: number; title: string; cover?: string; lessons: Lesson[]; archived: boolean };

export type Testimonial = { name: string; text: string; stars: number };

export type Faq = { q: string; a: string };

export type Player = {
  autoplay: boolean;
  resume: boolean;
  fastBar: boolean;
  floating: boolean;
  button: boolean;
  speed: boolean;
};

export const DEFAULT_BAR = "#c62828";

export type Trigger = { at: number; until: number; text: string; button: boolean };

export type Product = {
  slug: string;
  name: string;
  price: number;
  tagline?: string;
  vsl?: { video: string; ctaSeconds: number; ctaText?: string; captions?: string };
  player: Player;
  triggers: Trigger[];
  bar?: { text: string; color?: string };
  pix: { key: string; name: string; city: string };
  banner?: string;
  cover?: string;
  offerEndsAt?: Date;
  guaranteeDays: number;
  orderBump?: { product: string; price?: number; headline?: string };
  modules: Module[];
  testimonials: Testimonial[];
  faq: Faq[];
  domain?: string;
  archived: boolean;
};

export type OrderBump = Product & { bumpPrice: number; headline?: string };

export type ProductFields = {
  name: string;
  price: number;
  tagline: string | null;
  offerEndsAt: Date | null;
  guaranteeDays: number;
  bumpProduct: string | null;
  bumpPrice: number | null;
  bumpHeadline: string | null;
  vslVideo: string | null;
  ctaSeconds: number;
  ctaText: string | null;
  captions: string | null;
  player: Player;
  triggers: Trigger[];
  barText: string | null;
  barColor: string | null;
  banner: string | null;
  cover: string | null;
  faq: Faq[];
  testimonials: Testimonial[];
  domain: string | null;
};

const PRODUCT_COLUMNS = {
  slug: product.slug,
  name: product.name,
  price: product.priceCents,
  tagline: product.tagline,
  pixKey: product.pixKey,
  pixName: product.pixName,
  pixCity: product.pixCity,
  offerEndsAt: product.offerEndsAt,
  guaranteeDays: product.guaranteeDays,
  bumpProduct: product.bumpProduct,
  bumpPrice: product.bumpPriceCents,
  bumpHeadline: product.bumpHeadline,
  vslVideo: product.vslVideo,
  ctaSeconds: product.ctaSeconds,
  ctaText: product.ctaText,
  playerAutoplay: product.playerAutoplay,
  playerResume: product.playerResume,
  playerFastBar: product.playerFastBar,
  playerFloating: product.playerFloating,
  playerButton: product.playerButton,
  playerSpeed: product.playerSpeed,
  captions: product.captions,
  triggers: product.triggers,
  barText: product.barText,
  barColor: product.barColor,
  banner: product.banner,
  cover: product.cover,
  faq: product.faq,
  testimonials: product.testimonials,
  domain: product.domain,
  archivedAt: product.archivedAt,
};

// Two queries whatever the number of products: the products, then every module joined to its lessons.
async function load(filter: SQL | undefined, admin: boolean): Promise<Product[]> {
  const rows = await db().select(PRODUCT_COLUMNS).from(product).where(filter).orderBy(product.position, product.slug);

  const products = rows.map((row): Product => ({
    slug: row.slug,
    name: row.name,
    price: row.price,
    tagline: row.tagline ?? undefined,
    vsl: row.vslVideo
      ? {
          video: row.vslVideo,
          ctaSeconds: row.ctaSeconds,
          ctaText: row.ctaText ?? undefined,
          captions: row.captions ?? undefined,
        }
      : undefined,
    player: {
      autoplay: row.playerAutoplay,
      resume: row.playerResume,
      fastBar: row.playerFastBar,
      floating: row.playerFloating,
      button: row.playerButton,
      speed: row.playerSpeed,
    },
    triggers: row.triggers,
    bar: row.barText ? { text: row.barText, color: row.barColor ?? undefined } : undefined,
    pix: { key: row.pixKey, name: row.pixName, city: row.pixCity },
    banner: row.banner ?? undefined,
    cover: row.cover ?? undefined,
    offerEndsAt: row.offerEndsAt ?? undefined,
    guaranteeDays: row.guaranteeDays,
    orderBump: row.bumpProduct
      ? { product: row.bumpProduct, price: row.bumpPrice ?? undefined, headline: row.bumpHeadline ?? undefined }
      : undefined,
    modules: [],
    faq: row.faq,
    testimonials: row.testimonials,
    domain: row.domain ?? undefined,
    archived: row.archivedAt !== null,
  }));

  if (products.length === 0) return products;
  const bySlug = new Map(products.map((entry) => [entry.slug, entry]));

  const lessons = await db()
    .select({
      product: module.product,
      id: module.id,
      title: module.title,
      cover: module.cover,
      archivedAt: module.archivedAt,
      lesson: {
        id: lesson.slug,
        title: lesson.title,
        video: lesson.video,
        text: lesson.text,
        attachment: lesson.attachment,
        attachmentName: lesson.attachmentName,
        archivedAt: lesson.archivedAt,
      },
    })
    .from(module)
    .leftJoin(lesson, and(eq(lesson.moduleId, module.id), admin ? undefined : isNull(lesson.archivedAt)))
    .where(and(inArray(module.product, [...bySlug.keys()]), admin ? undefined : isNull(module.archivedAt)))
    .orderBy(module.position, module.id, lesson.position, lesson.id);

  for (const row of lessons) {
    const modules = bySlug.get(row.product)?.modules;
    if (!modules) continue;
    let current = modules.at(-1);
    if (current?.id !== row.id) {
      current = {
        id: row.id,
        title: row.title,
        cover: row.cover ?? undefined,
        lessons: [],
        archived: row.archivedAt !== null,
      };
      modules.push(current);
    }
    if (row.lesson) {
      const { archivedAt, ...entry } = row.lesson;
      current.lessons.push({ ...entry, archived: archivedAt !== null });
    }
  }
  return products;
}

// The admin sees archived products, modules and lessons; buyers see active products and only active lessons.
export function products(admin = false): Promise<Product[]> {
  return load(admin ? undefined : isNull(product.archivedAt), admin);
}

// Archived products still resolve here so old orders, Pix pages and member access keep working.
export const getProduct = cache(
  async (slug: string, admin = false): Promise<Product | undefined> => (await load(eq(product.slug, slug), admin))[0],
);

// The HTTPS server asks this before it requests a certificate, so only domains saved on a selling product get one.
export async function sellsAt(domain: string): Promise<boolean> {
  const [found] = await db()
    .select({ slug: product.slug })
    .from(product)
    .where(and(eq(product.domain, domain), isNull(product.archivedAt)));

  return found !== undefined;
}

export function ownedProducts(slugs: string[]): Promise<Product[]> {
  return load(inArray(product.slug, slugs), false);
}

export async function productNames(executor: Database = db()): Promise<Map<string, string>> {
  const rows = await executor.select({ slug: product.slug, name: product.name }).from(product);
  return new Map(rows.map((row): [string, string] => [row.slug, row.name]));
}

export async function productStates() {
  const rows = await db()
    .select({ slug: product.slug, name: product.name, archivedAt: product.archivedAt })
    .from(product);

  return rows.map((row) => ({ slug: row.slug, name: row.name, archived: row.archivedAt !== null }));
}

export async function orderBump(offer: Product): Promise<OrderBump | undefined> {
  const bump = offer.orderBump;
  const extra = bump ? await getProduct(bump.product) : undefined;
  if (!bump || !extra || extra.archived) return undefined;
  return { ...extra, bumpPrice: bump.price ?? extra.price, headline: bump.headline };
}

// The store's own Pix key, set once in Conexões. Stores from before it existed have it only on their products.
export async function storePix(): Promise<Product["pix"] | undefined> {
  const stored = (await credentials("pix"))("pix");
  if (stored("key")) return { key: stored("key"), name: stored("name"), city: stored("city") };

  const [newest] = await db()
    .select({ key: product.pixKey, name: product.pixName, city: product.pixCity })
    .from(product)
    .orderBy(desc(product.position))
    .limit(1);

  return newest;
}

// Every product keeps a copy of the key, so the static BR Code and a previous version running alongside still work.
export async function saveStorePix(pix: Product["pix"]) {
  await db().transaction(async (tx) => {
    await tx.update(product).set({ pixKey: pix.key, pixName: pix.name, pixCity: pix.city });
    await saveCredentials("pix", { key: pix.key, name: pix.name, city: pix.city }, {}, tx);
  });
}

export async function createProduct(
  slug: string,
  fields: Pick<ProductFields, "name" | "price">,
  pix: Product["pix"],
): Promise<CatalogCode | null> {
  const inserted = await db()
    .insert(product)
    .values({
      slug,
      name: fields.name,
      priceCents: fields.price,
      pixKey: pix.key,
      pixName: pix.name,
      pixCity: pix.city,
      position: sql`(SELECT COALESCE(MAX(${product.position}), 0) + 1 FROM ${product})`,
    })
    .onConflictDoNothing({ target: product.slug })
    .returning({ slug: product.slug });

  return inserted.length === 1 ? null : "SLUG_TAKEN";
}

export function updateProduct(slug: string, fields: ProductFields): Promise<CatalogCode | null> {
  return db().transaction(async (tx) => {
    if (fields.bumpProduct !== null) {
      const [target] = await tx
        .select({ archivedAt: product.archivedAt })
        .from(product)
        .where(eq(product.slug, fields.bumpProduct))
        .for("share");

      if (fields.bumpProduct === slug || !target || target.archivedAt !== null) return "INVALID_BUMP";
    }

    if (fields.domain !== null) {
      const [owner] = await tx
        .select({ slug: product.slug })
        .from(product)
        .where(and(eq(product.domain, fields.domain), ne(product.slug, slug)));

      if (owner) return "DOMAIN_TAKEN";
    }

    const changed = await tx
      .update(product)
      .set({
        name: fields.name,
        priceCents: fields.price,
        tagline: fields.tagline,
        offerEndsAt: fields.offerEndsAt,
        guaranteeDays: fields.guaranteeDays,
        bumpProduct: fields.bumpProduct,
        bumpPriceCents: fields.bumpPrice,
        bumpHeadline: fields.bumpHeadline,
        vslVideo: fields.vslVideo,
        ctaSeconds: fields.ctaSeconds,
        ctaText: fields.ctaText,
        playerAutoplay: fields.player.autoplay,
        playerResume: fields.player.resume,
        playerFastBar: fields.player.fastBar,
        playerFloating: fields.player.floating,
        playerButton: fields.player.button,
        playerSpeed: fields.player.speed,
        captions: fields.captions,
        triggers: fields.triggers,
        barText: fields.barText,
        barColor: fields.barColor,
        banner: fields.banner,
        cover: fields.cover,
        faq: fields.faq,
        testimonials: fields.testimonials,
        domain: fields.domain,
      })
      .where(eq(product.slug, slug))
      .returning({ slug: product.slug });

    return changed.length === 1 ? null : "INVALID_TRANSITION";
  });
}
