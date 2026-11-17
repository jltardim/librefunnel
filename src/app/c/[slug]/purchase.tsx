import { Field } from "@/components/form/field";
import { Input } from "@/components/form/input";
import { Icon } from "@/components/media/icon";
import type { Code } from "@/lib/actions/form";
import type { OrderBump } from "@/lib/catalog/products";
import { Money } from "@/app/format";
import { CheckoutForm, CheckoutTotal, FieldMessage, FormMessage, SubmitLabel } from "@/app/ui";
import { ConfirmEmail } from "./confirm";
import { CouponField } from "./coupon";
import { EmailInput } from "./email-input";
import styles from "./page.module.css";

export function Purchase({
  slug,
  touch,
  price,
  bump,
  bumpDefault,
  termsUrl,
  guaranteeDays,
  phone,
  document,
  confirmEmail,
  button,
  trust,
  seal,
  prefill,
  coupon,
}: {
  slug: string;
  touch: string;
  price: number;
  bump?: OrderBump;
  bumpDefault: boolean;
  termsUrl?: string;
  guaranteeDays: number;
  phone: "optional" | "required" | "hidden";
  document: "optional" | "required" | "hidden";
  confirmEmail: boolean;
  button: string;
  trust: boolean;
  seal: boolean;
  prefill: { name: string; email: string; phone: string; document: string };
  coupon: { code: string; discount: number; refused: Code | null };
}) {
  return (
    <CheckoutForm slug={slug} touch={touch} bumpDefault={bumpDefault} discountDefault={coupon.discount}>
      <div className={styles.panel}>
        <Field label="Nome completo" hint={<FieldMessage code="INVALID_NAME" />}>
          {(control) => (
            <Input
              {...control}
              name="name"
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
              defaultValue={prefill.name}
              placeholder="Digite seu nome completo"
            />
          )}
        </Field>
        <Field label="E-mail" hint={<FieldMessage code="INVALID_EMAIL" />}>
          {(control) => (
            <EmailInput
              {...control}
              name="email"
              required
              maxLength={200}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="email"
              placeholder="seu@email.com"
              defaultValue={prefill.email}
            />
          )}
        </Field>
        {confirmEmail ? (
          <Field label="Confirme seu e-mail">
            {(control) => (
              <ConfirmEmail
                {...control}
                name="emailConfirm"
                required
                maxLength={200}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
                placeholder="Digite o e-mail de novo"
                defaultValue={prefill.email}
              />
            )}
          </Field>
        ) : null}
        {phone === "hidden" ? null : (
          <Field
            label={phone === "required" ? "WhatsApp" : "WhatsApp (opcional)"}
            hint={<FieldMessage code="INVALID_PHONE" />}
          >
            {(control) => (
              <Input
                {...control}
                name="phone"
                type="tel"
                inputMode="tel"
                required={phone === "required"}
                maxLength={20}
                autoComplete="tel"
                placeholder="(11) 98765-4321"
                defaultValue={prefill.phone}
              />
            )}
          </Field>
        )}
        {document !== "hidden" ? (
          <Field
            label={document === "required" ? "CPF ou CNPJ (para o Pix e a nota)" : "CPF ou CNPJ na nota (opcional)"}
            hint={<FieldMessage code="INVALID_DOCUMENT" />}
          >
            {(control) => (
              <Input
                {...control}
                name="document"
                required={document === "required"}
                inputMode="numeric"
                maxLength={18}
                autoComplete="off"
                placeholder="000.000.000-00"
                defaultValue={prefill.document}
              />
            )}
          </Field>
        ) : null}

        {bump ? (
          <label className={styles.bump}>
            <span className={styles.bumpBody}>
              <input type="checkbox" name="bump" value="1" defaultChecked={bumpDefault} className={styles.bumpCheck} />
              {bump.cover ? (
                <img className={styles.bumpCover} src={bump.cover} alt="" width={64} height={64} loading="lazy" />
              ) : null}
              <span className={styles.bumpText}>
                <strong>{bump.headline ?? `Adicionar ${bump.name}`}</strong>
                {bump.tagline ? <span>{bump.tagline}</span> : null}
              </span>
              <span className={styles.bumpPrice}>
                <strong>
                  + <Money cents={bump.bumpPrice} />
                </strong>
                {bump.price > bump.bumpPrice ? (
                  <s>
                    <Money cents={bump.price} />
                  </s>
                ) : null}
              </span>
            </span>
          </label>
        ) : null}

        <CouponField slug={slug} initial={coupon.code} refusedDefault={coupon.refused} />
        <div className={styles.total}>
          <span>Total</span>
          <CheckoutTotal price={price} bump={bump?.bumpPrice} />
        </div>
        <FormMessage />
        <button type="submit" className={styles.buy}>
          <Icon name="lock" />
          <SubmitLabel idle={button} pending="Gerando seu Pix" />
        </button>
        {trust ? (
          <ul className={styles.trust}>
            <li>
              <Icon name="shield-check" size={16} />
              Compra 100% segura
            </li>
            {seal ? null : (
              <li>
                <Icon name="badge-check" size={16} />
                Garantia de {guaranteeDays} dias
              </li>
            )}
            <li>
              <Icon name="zap" size={16} />
              Acesso imediato
            </li>
          </ul>
        ) : null}
        <p className={styles.legal}>
          Ao pagar, você aceita os{" "}
          {termsUrl ? (
            <a href={termsUrl} target="_blank" rel="noopener noreferrer">
              termos de compra
            </a>
          ) : (
            "termos de compra"
          )}
          .
        </p>
      </div>
    </CheckoutForm>
  );
}
