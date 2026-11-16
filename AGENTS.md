# AGENTS.md

Guidance for anyone changing this repo, human or agent. `CLAUDE.md` is not used: this is the single source.

## What this is

LibreFunnel: a self-hosted, fee-free sales funnel for Brazilian infoproduct sellers. VSL page, Pix checkout (static BR
Code or a payment provider), order bump, members area with magic-link login, WhatsApp and e-mail cart recovery,
attribution with Meta Conversions API, and an admin dashboard where the seller manages products, course content,
automations and settings.

Stack: Next.js 16 (App Router, standalone output), React 19 Server Components and Server Actions, TypeScript 7, Docker
Compose with Caddy. Bun is the only runtime and tool: install, scripts, tests, build and production (`bunfig.toml` runs
package binaries with Bun; never npm, npx or Node). Database: PostgreSQL with Drizzle ORM, through `Bun.SQL` when
`DATABASE_URL` is set and PGlite otherwise (local dev under `DATA_DIR/pglite`, tests in memory).

Next.js 16 differs from older versions: read `node_modules/next/dist/docs/` before using an API you are not sure about.

## One click to revenue

The seller is not a developer. The path from install to the first sale is as short as it can be: the installer and the
store set up and detect everything they can, and once installed, nothing asks for a terminal, `.env`, a file or the
installer again. Updates from the admin bring everything a release changes (images, the updater itself, `compose.yaml`,
`Caddyfile`), so a new feature never needs a step on the server. Visible text never names an environment variable, a
file or a command; when the store needs something from the seller, it asks in the admin, in plain words, with the fix
one click away.

## Commands

```sh
bun install
bun run dev            # http://localhost:3000, needs .env (see .env.example; locally DATA_DIR=data, BASE_URL=http://localhost:3000)
bun run start          # the full server with Docker: store, database, WhatsApp, HTTPS and updater
bun run check          # typecheck, lint, unused code (knip), formatting and tests: what CI runs
bun run fix            # fixes lint (blank lines around multi-line consts) and formatting
bun run test           # tests only (bun test, one process per file)
bun run migration      # after editing src/lib/schema.ts: writes the next migration
bun run release        # patch, minor, major or 1.2.3: checks, dates CHANGELOG.md, bumps, tags and pushes; GitHub publishes it
bun run brand          # after changing the logo or the colors: rewrites every logo, icon and banner file
bun run icons          # after adding a Lucide or brand icon to docs/icons.ts: rewrites src/components/media/icon-set.ts
bun run demo-art       # after editing demo/art.ts: rewrites the demo images and sales video (needs rsvg-convert, ffmpeg, fonts in demo/media/CREDITS.md)
```

A change is done only when `bun run check` passes. CI runs the same on every push; the Docker build runs only when
something the image ships changes. The site goes out by itself on every push that changes `site/`, so a site fix needs
no release; a release is for the store. Every change a seller notices goes under `## Próxima versão` in `CHANGELOG.md`
(pt-BR, one line per change): the release turns it into the version's notes, which the admin shows with the update.

## Layout

- `src/app/`: pages, route handlers, `ui.tsx` (form client components and `ERROR_TEXT`), `track.tsx` (visit tracking),
  `format.tsx` (money and dates, no client JS); the admin is one route per section under `src/app/admin/` with a sidebar
  in `layout.tsx`
- `src/components/`: the component library, one component per file in folders by responsibility (see
  `docs/design-system.md`)
- `src/lib/`: business rules, one file or folder per domain: `actions/` (the only server action edge: one `"use server"`
  file per screen area, with `form` holding the shared `Code`, `ActionState` and form readers), `orders/` (`checkout`
  places orders, `payments` releases and refunds them, `webhooks` is the payment entry, `charges` creates and re-checks
  provider charges, `psp` holds what every provider shares, one file per provider, `pix` the static BR Code, `crypto`
  the Woovi conversion), `catalog/` (`products`, `course` for modules and lessons), `settings` (store settings and
  integration credentials), `media/` (`files`, `bucket` the S3 client, `uploads`, `serving`, `storage` connects the
  bucket, `video` transcodes, `sweep`, `backup`), `tracking/` (`funnel`, `visitors`, `retention`, `meta`), `coupons`,
  `invoices` (NFS-e Nacional), `sales` (the `/api/v1/vendas` report, on only with `VENDAS_TOKEN`), `members`, `sessions`
  (admin, member and checkout sessions), `messages`, `dashboard`, `guard`, `db`; `input` parses and validates every
  value that comes from outside (`parse*` returns the normalized value or `undefined`), and `registry` is the only
  caller of public registries (CNPJ through BrasilAPI)
- `src/format.ts`: every text the store formats for people, server and browser alike (`format*`: money, CPF and CNPJ,
  phones, names); a new formatter or validator goes there or in `input`, never inline in a screen or action
- `src/lib/schema.ts`, `src/lib/migrations/`: Drizzle schema and the SQL migrations generated from it
  (`bun run migration`), applied at startup; a fresh install starts empty (`0001_demo.sql` is an empty placeholder kept
  for the journal)
- `demo/`: the public demo (`DEMO_MODE=1`), only in the image's `demo` target: `store.sql` (the catalog, also the tests'
  fixture), `showcase.sql` (settings and 30 days of activity), `media/` served at `/demo/<file>` and drawn by `art.ts`
- `src/proxy.ts`: Content-Security-Policy with a fresh script nonce per page request
- `src/instrumentation.ts`, `src/jobs.ts`: instrumentation loads `jobs.ts` only in the Node runtime; `jobs.ts` runs
  migrations, then the background loop: order expiry, outbox, Meta events
- `tests/`: `bun test` suites (setup in `bunfig.toml`) with fake HTTP servers for providers
- `deploy/`: Dockerfile, Caddyfile, `evolution.sql` (Evolution's database on the shared PostgreSQL), `updater.ts` and
  `Dockerfile.updater` (restarts and updates the store from the admin, bringing the release's `compose.yaml`,
  `Caddyfile` and `evolution.sql` along with the image), `demo-deploy.sh` (run through Oracle Cloud Run Command by the
  Release workflow to put each release on the public demo), `install.sh` (the one-command installer served at
  librefunnel.com/install: POSIX sh, pt-BR output, downloads only `compose.yaml`, `Caddyfile` and `evolution.sql` of the
  latest release, plus its `images.txt` (image digests and the files' SHA-256); check with `shellcheck -s sh` and
  `--plan`)
- `docs/`: `deploy.md` (layperson guide), `design-system.md`, `roadmap.md` (what to build next, in order), `brand.ts`
  and the brand SVGs it writes
- `site/`: librefunnel.com: a separate Fumadocs app (own `package.json` and `bun.lock`, outside the store's tooling and
  image), landing page in `app/(home)`, docs in `content/docs/*.mdx`, static export to `site/out` with
  `deploy/install.sh` copied in as `/install`; `llms.txt`, `llms-full.txt` and `/md/<page>.md` are built from the docs
  by `lib/llms.ts`; `bun run shots` (in `site/`, needs Chrome and `cwebp`) rewrites the landing screenshots in
  `public/shots/` and `og.png` from the public demo, admin first since the buyer flow adds an order

## Code rules

- Simplest thing that solves the current problem. No abstraction, layer or option "for later". No duplicated logic: find
  and reuse first.
- Split by responsibility, which means by reason to change: code that changes together lives together, code that changes
  for different reasons (one payment provider's API, the payment rules, the webhook entry, a screen) lives apart. In
  `src/lib` a small domain is one file named after it in one lowercase word (`coupons.ts`); a domain that holds more
  than one responsibility is a folder of one-word files (`orders/checkout.ts`, `orders/payments.ts`, `orders/woovi.ts`).
  Importers point at the file that owns the name: no `index.ts` barrels that only re-export.
- Size is the signal, not the rule: a source file past about 400 lines (a test file past about 600) is checked for a
  second responsibility, and a feature is never added to such a file before that split. Do not split for its own sake:
  no file per function, no folder with one file, no layers (repositories, services, controllers, DTOs) and no shared
  module that only forwards calls. A long file with one responsibility stays whole.
- In `src/components` and screens, one component per file. Move or split existing code with a script, never by retyping
  it.
- Identifiers and comments in English. Visible text (UI, e-mails, WhatsApp) in pt-BR.
- Comments: default is none. One line, only for a "why" the code cannot express. Never narrate the code, never leave
  TODOs or commented-out code.
- Types: no `any`, `unknown`, `as` casts or `!`. Do not annotate what TypeScript infers. Unused variables and parameters
  are removed, never prefixed with `_`.
- Errors that cross a boundary (server actions, route handlers, webhooks) are closed `THIS_CASING` code unions, never
  prose. The UI translates codes in `ERROR_TEXT`, with the concrete cause and the fix.
- Never use the em dash character anywhere (code, copy, docs). Use colons, commas, parentheses or periods.
- Do not run formatters on files you did not change beyond `bun run fix` on the whole repo.

## Data and money rules

- Money is integer cents. Prices always come from the stored product on the server, never from the request. Orders
  snapshot their prices.
- An order becomes paid only after the received amount is checked, inside a transaction with a conditional update so
  concurrent webhooks release once. Refunds revoke access.
- Buyer requests and webhooks only write to the database. Every third-party call (e-mail, WhatsApp, Meta, payment
  provider) runs in the background loop through the outbox, with retries. A provider failure never blocks the buyer.
- Updates and restarts never take the store offline: the updater starts a new app container next to the old one and
  stops the old one once `/api/health` answers. So two versions run at once against the same database. Migrations must
  keep the previous version working (add columns nullable or with a default, drop or rename only in a later release),
  and per-process state must tolerate a second process. The background loop runs only in the process that holds the jobs
  lock (`leadJobs` in `db.ts`).
- The smallest target is a 1 vCPU, 1 GB server. Heavy background work (ffmpeg) runs at the lowest CPU priority and one
  at a time; nothing grows without a bound on disk or in memory.
- Queries: name every column (no `SELECT *`), aggregate and filter in the database, no N+1, no duplicate reads in one
  flow, no fetching what the flow does not use. Caching is never the fix for any of these.
- Validate every external input at the edge (`src/lib/actions/`, route handlers). Server secrets (`SECRET`,
  `ADMIN_PASSWORD`, database) only through environment variables; integration credentials set in `/admin` > Conexões
  live in the `integration` table, sealed with `guard.seal` (AES-256-GCM, key derived from `SECRET`), read per use and
  never sent to the browser. Provider errors never echo response bodies.
- Every module in `src/lib` except the `"use server"` files in `actions/` (the edge client components import) starts
  with `import "server-only"`. Every export of a `"use server"` file is a public endpoint, so helpers live in
  `actions/form.ts` or stay unexported.
- Tracking lives in `src/lib/tracking/`. `STEPS` in `src/funnel.ts` (shared with the browser) lists every browser funnel
  step (the first-party event the panel counts and its ad platform events) and `ORDER_STEPS` the server ones and the
  platforms each goes to, which orders record with `orderStep` inside their transaction. The browser sends steps only
  through `track`/`Tracker`/`OrderTracker`/`TrackClick` in `src/app/track.tsx`, which also fire the browser tags
  (`src/app/tags.tsx`) with the same event id, so each platform counts a step once. `sendConversions` in
  `conversions.ts` is the one sender; each platform (`meta`, `tiktok`, `analytics`, `googleads`) is a `Destination` in
  its own file, and `accounts.ts` picks the connection for each product (its own from `product_tracking`, or the
  store's). A new step or ad platform is a change there, never a call scattered in a page. Browser tags load only on
  buyer pages, only when the seller turns them on, never in the demo.
- Sessions go only through `src/lib/sessions.ts`: a random 256-bit id in an `HttpOnly`, `Secure`, `__Host-` cookie
  (`SameSite=Strict` for the admin), stored in `session` as its SHA-256, ended by deleting the row. No session id, token
  or credential in `localStorage`, `sessionStorage`, a URL that lasts, or anything else JavaScript can read, and no
  stateless session tokens (JWT or signed cookies): `guard.sign` is only for links such as unsubscribe.
- Personal data: Meta receives e-mail, phone, name and customer id only as hashes; IP, user agent, `fbp` and `fbc` go
  raw because the Conversions API requires them that way. Access credentials go only by e-mail, never by WhatsApp or in
  a permanent URL.
- `DEMO_MODE=1` (`demoMode()` in `src/lib/guard.ts`) is the public demo: a new third-party call or connection action
  returns early or `DEMO_BLOCKED` under it, and nothing demo-only (like `simulatePayment`) works without it.
- Anything that releases money or access must be attacked as a fraudster before it ships: concurrent requests, replays,
  underpayment, refund then reuse, reused provider ids.

## UI rules

- The admin is rendered on demand only (`src/app/admin/page.tsx` checks the session before rendering anything, and every
  admin action and route handler checks it again) and nothing from it ships to buyers: a `"use client"` module is
  bundled whole, so admin-only client components live under `src/app/admin/` and buyer pages never import them.
  Components that need no browser JS stay server components. Every module in `src/lib` starts with
  `import "server-only"`.

- Follow `docs/design-system.md`: tokens, components and patterns live there. Do not invent one-off colors, spacing or
  components.
- One-step UX: if an action needs a prerequisite, the action leads to it and comes back. No disabled control without
  saying why and offering the fix.
- Every async button shows loading and is disabled while pending. Success messages only after the server confirms.
  Queued work says it is queued.
- Check every buyer screen at 390 px wide.
- Buyer pages ship only the client code they use. A `"use client"` module is bundled whole, so sales-page code stays out
  of `ui.tsx`, and links between buyer pages are plain `<a>`, not `next/link`.

## No AI slop

This repo should read like it was written by one careful engineer. Before you finish, delete anything below.

**Code**

- Wrappers that only forward to another function, `utils`/`helpers` grab bags, factories or generics with one caller,
  options nobody sets.
- `try/catch` that only logs and rethrows, swallows, or guards something that cannot throw. Fallbacks for states the
  types already rule out.
- Defensive checks repeated at every layer: validate once at the edge, trust the types after.
- Comments that restate the code, section banners, JSDoc that repeats the signature, `console.log` left behind.
- Vague names (`data`, `info`, `item`, `handleClick`, `processData`, `result2`). Name what it is.
- Tests that assert implementation details or only that a function "was called". Test behavior.

**Interface**

- Purple/indigo gradients, gradient text, glassmorphism, glow, emoji as icons, sparkle icons.
- Every element in its own shadowed card, everything `rounded-2xl`, decorative badges and pills, three-column "icon +
  title + description" feature grids.
- Grids of equal-weight KPI cards, walls of stacked alerts, placeholder or lorem copy, fake testimonials and fake
  numbers.
- Animation that does not explain a state change.

**Writing (UI copy, docs, commit messages)**

- Hype words: seamless, robust, powerful, effortless, leverage, unlock, elevate, supercharge, cutting-edge,
  game-changing, best-in-class, delve, streamline.
- Filler openers and closers ("In today's world", "It's important to note", "Whether you're X or Y", "In conclusion").
- Reflex lists of three, "not just X but Y", a bold lead-in on every bullet, emoji bullets, headings for two-line
  sections.
- Write the fact, the number or the command. If a sentence can be deleted without losing information, delete it.

## Working here

- Do not commit, push or rewrite history unless asked.
- Do not add a dependency without a clear need; pin exact versions.
- When a doc or this file stops matching the code, update it in the same change.
