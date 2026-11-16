import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSystemTime, vi } from "bun:test";
import * as navigation from "next/navigation";
import * as server from "next/server";
import * as fakes from "./fakes";

// Next swaps server-only for an empty module on the server; the tests are server code too. It is mocked before the
// store's modules load, so they are imported below, after the mocks.
vi.mock("server-only", () => ({}));
process.env.TZ = "America/Sao_Paulo";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "librefunnel-test-"));
process.env.BASE_URL = "https://shop.example";
process.env.SECRET = "s".repeat(40);
process.env.ADMIN_PASSWORD = "long-admin-password";
process.env.TRUST_PROXY = "1";

setSystemTime(new Date("2026-11-14T12:00:00-03:00"));

vi.mock("next/headers", () => ({ cookies: async () => fakes.jar, headers: async () => fakes.requestHeaders }));

vi.mock("next/navigation", () => ({
  ...navigation,
  redirect: (to: string) => {
    throw new fakes.RedirectSignal(to);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("next/server", () => ({ ...server, after: () => undefined, connection: async () => undefined }));

vi.mock("nodemailer", () => {
  return {
    default: {
      createTransport: (options: (typeof fakes.mailTransports)[number]) => {
        fakes.mailTransports.push(options);
        return {
          verify: async () => {
            const failure = fakes.mailFailures.shift();
            if (failure) throw failure;
            return true;
          },
          sendMail: async (message: { to: string; subject: string; text: string }) => {
            const failure = fakes.mailFailures.shift();
            if (failure) throw failure;
            fakes.sentMail.push({ to: message.to, subject: message.subject, text: message.text });
            return { messageId: `<${fakes.sentMail.length}@test>` };
          },
        };
      },
    },
  };
});

const { saveCredentials } = await import("@/lib/settings");
const { db, migrate, seedDemo } = await import("@/lib/db");

await migrate();
// The demo catalog is the fixture every suite buys from; the app itself loads it only in demo mode.
await seedDemo(db(), "store.sql");
await saveCredentials("webhook", {}, { secret: fakes.WEBHOOK_SECRET });
