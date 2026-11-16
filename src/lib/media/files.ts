import "server-only";
import { join } from "node:path";
import { dataDir } from "../db";

const VIDEO_MAX = 1024 ** 3;
const IMAGE_MAX = 10 * 1024 ** 2;
const CAPTIONS_MAX = 1024 ** 2;
const PDF_MAX = 50 * 1024 ** 2;

export const CHUNK = 256 * 1024;

// The id is the first 32 hex characters of every file a media upload creates: the original, its stream folder, temp files.
export const MEDIA_ID = /^([a-f0-9]{32})(?:[./]|$)/;

export const ID_TEXT = "([a-f0-9]{32})";

export const FILE = /^[a-f0-9]{32}\.(mp4|webm|jpg|png|webp|vtt|pdf)$/;

export const FOLDER = /^[a-f0-9]{32}$/;

export const ORIGINAL = /^([a-f0-9]{32})\.(?:mp4|webm)$/;

export const STREAM = /^([a-f0-9]{32})\/(?:master\.m3u8|\d{2,4}\/(?:index\.m3u8|init(?:_\d)?\.mp4|\d{1,5}\.m4s))$/;

export const PREFIX = "media/";

const STREAM_TYPES = [
  { ext: "m3u8", mime: "application/vnd.apple.mpegurl" },
  { ext: "m4s", mime: "video/iso.segment" },
  { ext: "mp4", mime: "video/mp4" },
];

// SVG is left out on purpose: served from our origin it could run script.
const TYPES = [
  { ext: "mp4", mime: "video/mp4", max: VIDEO_MAX, sniff: (head: Buffer) => head.toString("latin1", 4, 8) === "ftyp" },
  { ext: "webm", mime: "video/webm", max: VIDEO_MAX, sniff: (head: Buffer) => head.readUInt32BE(0) === 0x1a45dfa3 },
  { ext: "jpg", mime: "image/jpeg", max: IMAGE_MAX, sniff: (head: Buffer) => head.toString("hex", 0, 3) === "ffd8ff" },
  {
    ext: "png",
    mime: "image/png",
    max: IMAGE_MAX,
    sniff: (head: Buffer) => head.toString("hex", 0, 8) === "89504e470d0a1a0a",
  },
  {
    ext: "webp",
    mime: "image/webp",
    max: IMAGE_MAX,
    sniff: (head: Buffer) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
  },
  {
    ext: "vtt",
    mime: "text/vtt",
    max: CAPTIONS_MAX,
    sniff: (head: Buffer) => /^(\xef\xbb\xbf)?WEBVTT/.test(head.toString("latin1")),
  },
  {
    ext: "pdf",
    mime: "application/pdf",
    max: PDF_MAX,
    sniff: (head: Buffer) => head.toString("latin1", 0, 5) === "%PDF-",
  },
];

export function mediaDir(): string {
  return join(dataDir(), "media");
}

export function typeOf(name: string) {
  return TYPES.find((entry) => entry.ext === name.toLowerCase().split(".").pop()?.replace("jpeg", "jpg"));
}

export function mimeOf(file: string): string | undefined {
  return STREAM.test(file)
    ? STREAM_TYPES.find((entry) => file.endsWith(`.${entry.ext}`))?.mime
    : TYPES.find((entry) => entry.ext === FILE.exec(file)?.[1])?.mime;
}
