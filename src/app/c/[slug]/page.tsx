import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { tryCoupon } from "@/lib/coupons";
import { clientIp } from "@/lib/guard";
import { Icon } from "@/components/media/icon";
import { getProduct, orderBump } from "@/lib/catalog/products";
import { settings } from "@/lib/settings";
import type { Product } from "@/lib/catalog/products";
import type { Settings } from "@/lib/settings";
import { documentField } from "@/lib/orders/charges";
import { standing } from "@/lib/members";
import { getPixOrder, offerOpen } from "@/lib/orders/checkout";
import { Footer, StoreHeader, Testimonials } from "@/app/buyer";
import { DateTime, Money } from "@/app/format";
import { StandingNotice } from "@/app/standing";
import { Tags } from "@/app/tags";
import { OrderTracker, Tracker } from "@/app/track";
import { Countdown } from "./countdown";
import styles from "./page.module.css";
import { PixPage } from "./pix";
import { Purchase } from "./purchase";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SURFACE: Record<Settings["checkoutTheme"], string> = {
  light: `surface-buyer ${styles.page}`,
  dark: `surface-experience ${styles.page}`,
  auto: `${styles.page}`,
};

// Contact data prefilled from the link never goes into the attribution query.
const UNTRACKED = ["bump", "name", "email", "phone", "document", "coupon"];

export async function generateMetadata({ params, searchParams }: Props) {
  const product = await getProduct((await params).slug);

  if (!product) return {};

  const paying = typeof (await searchParams).order === "string";

  return {
    title: paying ? `Pague com Pix | ${product.name}` : `Finalizar compra | ${product.name}`,
    description: `Pagamento por Pix de ${product.name}, com acesso liberado assim que o Pix cai.`,
    robots: { index: false },
  };
}

function Topbar() {
  return (
    <StoreHeader>
      <span className={styles.secure}>
        <Icon name="lock" size={16} />
        Pagamento seguro
      </span>
    </StoreHeader>
  );
}

function Guarantee({ days }: { days: number }) {
  return (
    <section className={styles.guarantee} aria-label="Garantia">
      <Icon name="shield-check" />
      <div>
        <strong>Garantia de {days} dias</strong>
        <p>Não gostou? Devolvemos 100% do valor.</p>
      </div>
    </section>
  );
}

function lessonCount(product: Product) {
  return product.modules.reduce((sum, module) => sum + module.lessons.length, 0);
}

function prefill(value: string | string[] | undefined, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default async function Checkout({ params, searchParams }: Props) {
  const { slug } = await params;
  const product = await getProduct(slug);

  if (!product) notFound();

  const store = await settings();
  const query = await searchParams;

  if (query.order !== undefined) {
    const order = typeof query.order === "string" ? await getPixOrder(query.order, slug) : undefined;

    if (!order) notFound();

    return (
      <div className={SURFACE[store.checkoutTheme]}>
        <Tags product={slug} />
        <Tracker product={slug} event="pix_view" />
        {order.status === "pending" || order.status === "paid" ? (
          <OrderTracker
            step={order.status === "paid" ? "paid" : "created"}
            order={order.id}
            items={order.bump ? [slug, order.bump] : [slug]}
            value={order.amount}
          />
        ) : null}
        <Topbar />
        <PixPage
          product={product}
          order={order}
          thanks={store.thanksUrl ? { url: store.thanksUrl, label: store.thanksLabel } : undefined}
        />
        <Footer />
      </div>
    );
  }

  if (product.archived) notFound();

  const touch = new URLSearchParams(
    Object.entries(query)
      .filter(([key]) => !UNTRACKED.includes(key))
      .flatMap(([key, value]) =>
        (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((item) => [key, item]),
      ),
  ).toString();

  const typed = prefill(query.coupon, 30);

  const [bump, documentMode, state, applied] = await Promise.all([
    orderBump(product),
    documentField(),
    standing(slug),
    typed ? tryCoupon(typed, product, null, clientIp(await headers())) : undefined,
  ]);

  const open = offerOpen(product);
  const lessons = lessonCount(product);
  const deadline = product.offerEndsAt;
  const testimonials = store.checkoutTestimonials ? product.testimonials : [];

  return (
    <div className={SURFACE[store.checkoutTheme]}>
      <Tags product={slug} />
      <Tracker product={slug} value={product.price} />
      <Tracker product={slug} event="checkout_view" value={product.price} />
      {open && deadline && store.checkoutCountdown ? (
        <div className={styles.countdown} role="timer">
          <Icon name="clock" size={16} />
          Esta oferta termina em <Countdown until={deadline.getTime()} />
        </div>
      ) : null}
      <Topbar />
      <main className={styles.main}>
        {product.banner ? (
          <img
            className={styles.banner}
            src={product.banner}
            alt={product.name}
            width={1040}
            height={325}
            fetchPriority="high"
          />
        ) : null}
        <div className={styles.layout}>
          <section className={styles.product} aria-label="Produto">
            {product.cover ? <img className={styles.cover} src={product.cover} alt="" width={72} height={72} /> : null}
            <div className={styles.productText}>
              <h1>{product.name}</h1>
              {lessons ? <span>{`${lessons} ${lessons === 1 ? "aula" : "aulas"}`}</span> : null}
              <strong className={styles.productPrice}>
                <Money cents={product.price} />
              </strong>
            </div>
          </section>
          <div className={styles.form}>
            {state ? <StandingNotice standing={state} /> : null}
            {open ? (
              <>
                {store.checkoutNotice ? (
                  <p className={styles.notice} role="note">
                    <Icon name="info" size={16} />
                    {store.checkoutNotice}
                  </p>
                ) : null}
                <Purchase
                  slug={slug}
                  touch={touch ? `?${touch}` : ""}
                  price={product.price}
                  bump={bump}
                  bumpDefault={query.bump === "1"}
                  termsUrl={store.termsUrl}
                  guaranteeDays={product.guaranteeDays}
                  phone={store.checkoutPhone}
                  document={documentMode}
                  confirmEmail={store.confirmEmail}
                  button={store.checkoutButton}
                  trust={store.checkoutTrust}
                  seal={store.checkoutGuarantee}
                  prefill={{
                    name: prefill(query.name, 120),
                    email: prefill(query.email, 200),
                    phone: prefill(query.phone, 20),
                    document: prefill(query.document, 18),
                  }}
                  coupon={{
                    code: typed,
                    discount: applied && "discount" in applied ? applied.discount : 0,
                    refused: applied && "code" in applied ? applied.code : null,
                  }}
                />
              </>
            ) : (
              <div className={styles.panel} role="status">
                <h2 className={styles.step}>Inscrições encerradas</h2>
                <p>
                  {deadline ? (
                    <>
                      A oferta de {product.name} terminou em <DateTime at={deadline} />.
                    </>
                  ) : (
                    `A oferta de ${product.name} foi encerrada.`
                  )}{" "}
                  Fale com o vendedor para saber da próxima turma.
                </p>
                <p>
                  Já comprou? <a href="/m">Entrar na área de membros</a>
                </p>
              </div>
            )}
          </div>
          {(open && store.checkoutGuarantee) || testimonials.length ? (
            <aside className={styles.extras}>
              {open && store.checkoutGuarantee ? <Guarantee days={product.guaranteeDays} /> : null}
              <Testimonials items={testimonials} />
            </aside>
          ) : null}
        </div>
      </main>
      <Footer />
    </div>
  );
}
