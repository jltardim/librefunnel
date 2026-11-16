import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, newId } from "../db";
import { lesson, module, product } from "../schema";

type Kind = "product" | "module" | "lesson";

type Item = {
  table: PgTable;
  key: AnyPgColumn;
  position: AnyPgColumn;
  parent: AnyPgColumn | null;
  archivedAt: AnyPgColumn;
};

const ITEMS: Record<Kind, Item> = {
  product: {
    table: product,
    key: product.slug,
    position: product.position,
    parent: null,
    archivedAt: product.archivedAt,
  },
  module: {
    table: module,
    key: module.id,
    position: module.position,
    parent: module.product,
    archivedAt: module.archivedAt,
  },
  lesson: {
    table: lesson,
    key: lesson.slug,
    position: lesson.position,
    parent: lesson.moduleId,
    archivedAt: lesson.archivedAt,
  },
};

export async function saveModule(
  target: { id: number } | { product: string },
  title: string,
  cover: string | null,
): Promise<boolean> {
  if ("id" in target) {
    const changed = await db()
      .update(module)
      .set({ title, cover })
      .where(eq(module.id, target.id))
      .returning({ id: module.id });

    return changed.length === 1;
  }

  const [owner] = await db().select({ slug: product.slug }).from(product).where(eq(product.slug, target.product));
  if (!owner) return false;
  await db()
    .insert(module)
    .values({
      product: owner.slug,
      title,
      cover,
      position: sql`(SELECT COALESCE(MAX(${module.position}), 0) + 1 FROM ${module} WHERE ${module.product} = ${owner.slug})`,
    });
  return true;
}

// Lesson slugs are random and never change, so progress rows survive renames and reordering.
export async function saveLesson(
  target: { slug: string } | { module: number },
  values: { title: string; video: string; text: string; attachment: string | null; attachmentName: string | null },
): Promise<boolean> {
  if ("slug" in target) {
    const changed = await db()
      .update(lesson)
      .set(values)
      .where(eq(lesson.slug, target.slug))
      .returning({ id: lesson.id });

    return changed.length === 1;
  }

  const [parent] = await db().select({ id: module.id }).from(module).where(eq(module.id, target.module));
  if (!parent) return false;
  await db()
    .insert(lesson)
    .values({
      moduleId: parent.id,
      slug: newId().slice(0, 10),
      ...values,
      position: sql`(SELECT COALESCE(MAX(${lesson.position}), 0) + 1 FROM ${lesson} WHERE ${lesson.moduleId} = ${parent.id})`,
    });
  return true;
}

export function move(kind: Kind, key: string | number, up: boolean): Promise<boolean> {
  const item = ITEMS[kind];
  const mine = sql`(SELECT ${item.position} FROM ${item.table} WHERE ${item.key} = ${key})`;
  return db().transaction(async (tx) => {
    const [neighbor] = await tx
      .select({
        key: sql<string | number>`${item.key}`,
        position: sql<number>`${item.position}`,
        mine: sql<number>`${mine}`,
      })
      .from(item.table)
      .where(
        and(
          item.parent
            ? sql`${item.parent} = (SELECT ${item.parent} FROM ${item.table} WHERE ${item.key} = ${key})`
            : undefined,
          up ? sql`${item.position} < ${mine}` : sql`${item.position} > ${mine}`,
        ),
      )
      .orderBy(up ? desc(item.position) : asc(item.position))
      .limit(1);

    if (!neighbor) return false;
    await tx
      .update(item.table)
      .set({
        position: sql`CASE WHEN ${item.key} = ${key} THEN ${neighbor.position}::integer ELSE ${neighbor.mine}::integer END`,
      })
      .where(inArray(item.key, [key, neighbor.key]));
    return true;
  });
}

export async function archive(kind: Kind, key: string | number, archived: boolean): Promise<boolean> {
  const item = ITEMS[kind];

  const changed = await db()
    .update(item.table)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(item.key, key), archived ? isNull(item.archivedAt) : isNotNull(item.archivedAt)))
    .returning({ key: item.key });

  return changed.length === 1;
}
