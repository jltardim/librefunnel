import "server-only";

// Everything that comes from outside (forms, links, webhooks) is parsed here: what passes is normalized, the rest is
// undefined, and the caller answers with its error code.
const CONTROL = /[\u0000-\u001f\u007f]/;

const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const NAME = /^[\p{L}\p{M}'’. -]+$/u;
// Order and visitor ids.
export const ID = /^[a-z0-9]{20}$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MEDIA = /^\/(media|demo)\/[\w.-]{1,100}$/;
const PDF = /^\/media\/[a-f0-9]{32}\.pdf$/;
const ROW_ID = /^\d{1,12}$/;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export const CREDENTIAL = /^[\x21-\x7e]{1,4000}$/;
export const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
export const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export const LINK = /^https?:\/\/[^\s/]+\.[^\s]{2,500}$/;

export function parseEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  return email.length <= 200 && EMAIL.test(email) ? email : undefined;
}

export function parseName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  const letters = name.replace(/[^\p{L}]/gu, "").length;
  return name.length <= 120 && letters >= 2 && NAME.test(name) ? name : undefined;
}

export function parsePhone(raw: string): string | undefined {
  if (CONTROL.test(raw) || /[^\d\s().+-]/.test(raw)) return undefined;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 10 && digits.length <= 11) return `55${digits}`;
  return /^55\d{10,11}$/.test(digits) ? digits : undefined;
}

// Ad platform ids, typed alone or found in whatever the seller copied: the whole tag code, a link or the id itself.
export function parseMetaPixel(raw: string): string | undefined {
  const text = raw.trim();
  const found = /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{5,20})/.exec(text) ?? /[?&]id=(\d{5,20})\b/.exec(text);
  return found?.[1] ?? (/^\d{5,20}$/.test(text) ? text : undefined);
}

export function parseTikTokPixel(raw: string): string | undefined {
  const text = raw.trim();

  const found =
    /ttq\.load\(\s*['"]([A-Za-z0-9]{10,30})['"]/.exec(text) ?? /[?&]sdkid=([A-Za-z0-9]{10,30})\b/.exec(text);

  const code = found?.[1] ?? (/^[A-Za-z0-9]{10,30}$/.test(text) ? text : undefined);
  return code?.toUpperCase();
}

// The Google tag code carries the Analytics id (G-) and the Google Ads one (AW-); either may be pasted alone.
export function parseGoogleTags(raw: string): { analytics?: string; ads?: string } {
  return {
    analytics: /\bG-[A-Z0-9]{4,20}\b/i.exec(raw)?.[0].toUpperCase(),
    ads: /\bAW-\d{5,20}\b/i.exec(raw)?.[0].toUpperCase(),
  };
}

// The id alone, or the address of the conversion action's page in Google Ads (ctId=).
export function parseConversionAction(raw: string): string | undefined {
  const text = raw.trim();
  return /[?&]ctId=(\d{1,20})\b/.exec(text)?.[1] ?? (/^\d{1,20}$/.test(text) ? text : undefined);
}

// Google shows account ids as 123-456-7890.
export function parseGoogleAccount(raw: string): string | undefined {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : undefined;
}

// Site verification codes, typed alone or pasted inside the whole <meta> tag the platform shows.
export function parseVerifications(raw: string, max: number): string[] | undefined {
  const codes = raw.split(/\r?\n/).flatMap((line) => {
    const tagged = [...line.matchAll(/content=["']([^"']*)["']/g)].map((match) => match[1] ?? "");
    return tagged.length ? tagged : line.split(/[\s,]+/).filter(Boolean);
  });

  return codes.length <= max && codes.every((code) => /^[\w-]{10,100}$/.test(code)) ? [...new Set(codes)] : undefined;
}

export function parsePrintable(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max && !CONTROL.test(trimmed) ? trimmed : "";
}

function isCpf(digits: string): boolean {
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    return ((sum * 10) % 11) % 10 === Number(digits[length]);
  };

  return !/^(\d)\1{10}$/.test(digits) && check(9) && check(10);
}

// DICT key formats (BCB API-DICT): e-mail, EVP, +E.164 phone, CPF with check digits, alphanumeric CNPJ.
export function parsePixKey(raw: string): string | undefined {
  const value = raw.trim();
  if (value.includes("@")) {
    const email = parseEmail(value);
    return email && email.length <= 77 ? email : undefined;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  if (value.startsWith("+")) {
    const phone = `+${value.replace(/\D/g, "")}`;
    return /^\+[1-9]\d{1,14}$/.test(phone) ? phone : undefined;
  }
  const document = value.replace(/[.\-/\s]/g, "").toUpperCase();
  if (/^\d{11}$/.test(document)) return isCpf(document) ? document : undefined;
  return /^[A-Z0-9]{12}\d{2}$/.test(document) ? document : undefined;
}

// The BR Code only carries ASCII, 25 characters for the holder and 15 for the city.
export function parsePixText(value: string, max: number): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max)
    .trim();
}

function isCnpj(digits: string): boolean {
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[length - 1 - index]) * ((index % 8) + 2);
    const rest = sum % 11;
    return (rest < 2 ? 0 : 11 - rest) === Number(digits[length]);
  };

  return !/^(\d)\1{13}$/.test(digits) && check(12) && check(13);
}

// A CPF or CNPJ with valid check digits, digits only: null when left blank, undefined when it cannot be one.
export function parseCpfCnpj(raw: string): string | null | undefined {
  const digits = raw.replace(/[.\-/\s]/g, "");
  if (!digits) return null;
  if (/^\d{11}$/.test(digits)) return isCpf(digits) ? digits : undefined;
  return /^\d{14}$/.test(digits) && isCnpj(digits) ? digits : undefined;
}

// A percentage typed as 6, 6,5 or 6.50, kept as the two-decimal text the layout takes.
export function parseRate(raw: string): string | undefined {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  return match ? `${Number(match[1])}.${(match[2] ?? "").padEnd(2, "0")}` : undefined;
}

export function parseCents(raw: string): number | undefined {
  const compact = raw.trim().replace(/^R\$\s*/i, "");
  const decimal = compact.includes(",") ? compact.replace(/\./g, "").replace(",", ".") : compact;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function parseTitle(raw: string): string | undefined {
  const value = parsePrintable(raw.replace(/\s+/g, " "), 120);
  return value.length >= 2 ? value : undefined;
}

// Optional one-line text: null when left blank, undefined when it cannot be accepted.
export function parseLine(raw: string, max = 300): string | null | undefined {
  if (!raw.trim()) return null;
  return parsePrintable(raw, max) || undefined;
}

export function parseText(raw: string, max: number): string | undefined {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  return value.length <= max && !MULTILINE_CONTROL.test(value) ? value : undefined;
}

export function parseMedia(raw: string): string | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  return MEDIA.test(value) ? value : undefined;
}

// The name of the seller's file is the name the buyer's download is saved under.
export function parseAttachment(path: string, name: string): { url: string; name: string } | null | undefined {
  const url = path.trim();
  if (!url) return null;
  const file = name.trim();
  const valid = PDF.test(url) && file.length <= 200 && /\.pdf$/i.test(file) && !/[\u0000-\u001f\u007f"\\/]/.test(file);
  return valid ? { url, name: file } : undefined;
}

// A moment in ISO 8601 with its offset, like 2026-11-16T00:00:00-03:00, or a calendar day read as UTC midnight.
export function parseInstant(raw: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(raw)) return undefined;
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

export function parseInteger(raw: string, min: number, max: number): number | undefined {
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export function parsePrice(raw: string): number | undefined {
  const cents = parseCents(raw);
  return cents !== undefined && cents >= 100 && cents <= 10_000_000 ? cents : undefined;
}

// Blank keeps the stored secret; undefined when it cannot be a key (spaces, accents, control characters).
export function parseCredential(raw: string): string | undefined {
  const value = raw.trim();
  return !value || CREDENTIAL.test(value) ? value : undefined;
}

// Coupon codes are compared in upper case, so "promo10" typed by a buyer matches PROMO10.
export function parseCouponCode(raw: string): string | undefined {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9_-]{3,30}$/.test(code) ? code : undefined;
}

// Accepts what sellers paste (https://MeuCurso.com.br/), keeps the bare name; at least one dot and a letter in the last
// label, so an IP address or a name without a public suffix is refused.
export function parseDomain(raw: string): string | undefined {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/.]+$/, "");

  return HOST.test(domain) && /\.[a-z][a-z0-9-]*$/.test(domain) ? domain : undefined;
}

export function parseRowId(raw: string): number | undefined {
  return ROW_ID.test(raw) ? Number(raw) : undefined;
}
