import { LOGOS, SIMPLE_ICONS } from "./icon-set";
import styles from "./brand-logo.module.css";

type Entry = {
  logo?: keyof typeof LOGOS;
  icon?: keyof typeof SIMPLE_ICONS;
  src?: string;
  color?: string;
  initials?: string;
};

// Brand colors are part of each logo, not of the product palette. Full-color logos sit on a light tile, as the brands
// draw them; the rest take one color.
const BRANDS: Record<string, Entry> = {
  mercadopago: { src: "/brands/mercadopago.svg" },
  woovi: { src: "/brands/woovi.svg" },
  abacatepay: { src: "/brands/abacatepay.svg" },
  depix: { src: "/brands/depix.svg" },
  noxpay: { src: "/brands/noxpay.svg" },
  asaas: { color: "#0030b9", initials: "A" },
  pix: { icon: "pix", color: "#32bcad" },
  gmail: { logo: "google-gmail" },
  brevo: { icon: "brevo", color: "#0b996e" },
  mailjet: { logo: "mailjet-icon" },
  email: { color: "#6b6e66", initials: "@" },
  whatsapp: { logo: "whatsapp-icon" },
  meta: { logo: "meta-icon" },
  webhook: { color: "#6b6e66", initials: "{ }" },
  cloudflare: { logo: "cloudflare-icon" },
  nfse: { color: "#6b6e66", initials: "NF" },
  tiktok: { logo: "tiktok-icon" },
  googleads: { logo: "google-ads" },
  analytics: { logo: "google-analytics" },
  searchconsole: { logo: "google-search-console" },
};

export type Brand = keyof typeof BRANDS;

export function BrandLogo({ brand, size = "md" }: { brand: Brand; size?: "md" | "lg" }) {
  const entry = BRANDS[brand];
  const logo = entry?.logo ? LOGOS[entry.logo] : undefined;
  const body = entry?.icon ? SIMPLE_ICONS[entry.icon] : undefined;

  return (
    <span
      className={styles.logo}
      data-size={size}
      data-tile={logo ? "light" : undefined}
      style={{ color: entry?.color }}
      aria-hidden
    >
      {logo ? (
        <svg viewBox={`0 0 ${logo.width} ${logo.height}`} dangerouslySetInnerHTML={{ __html: logo.body }} />
      ) : entry?.src ? (
        <img src={entry.src} alt="" width={28} height={28} />
      ) : body ? (
        <svg viewBox="0 0 24 24" fill="currentColor" dangerouslySetInnerHTML={{ __html: body }} />
      ) : (
        <span className={styles.initials}>{entry?.initials ?? brand.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
