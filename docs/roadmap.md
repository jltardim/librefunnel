# Roadmap

What to build next, in order. Every item follows the rules in `AGENTS.md` and fits a 1 vCPU, 1 GB server.

## Next

### 1. Coupons (done)

Built in `src/lib/coupons.ts` and `/admin/coupons`. A payment that arrives after the coupon ran out (use limit, or the
same e-mail already paid with it) is recorded and leaves the order pending, marked "Cupom esgotado", for the seller to
release or refund. Coupons are the base for items 2 and 11.

### 2. Upsell and downsell after payment

Pix cannot charge again in one click, so the upsell is a second order: the thank-you page offers another product at a
discount for a few minutes, with name, e-mail and phone already filled in and a fresh QR code. Declining shows the
downsell, if set. The discount is a coupon that only the buyer's e-mail can use, once, within 15 to 1440 minutes, unique
per source order. One table (`offer`: source product, upsell product, downsell product, discount, minutes) and the
existing checkout cover it. The panel shows offered and accepted per offer.

Attack cases: the coupon reused by another e-mail, used after it expires, or used twice from two tabs; an old, abandoned
upsell order paid after a newer one (flag it as paid twice).

### 3. Outgoing webhooks and the new sale alert

Events `order.paid`, `order.refunded` and `lead.created` POSTed to URLs the seller sets in Conexões, signed with
HMAC-SHA256. Delivery runs through the outbox (retries at 1 min, 5 min, 30 min, 2 h, 12 h, then failed with a resend
button). URLs that resolve to private IPs are refused. Responses are logged by status only, never by body. This connects
LibreFunnel to n8n, Zapier and Make without one integration per tool.

A WhatsApp or e-mail to the seller on each sale goes through the same outbox.

### 4. Ad platforms and analytics (done)

Built in `src/lib/tracking/`: `conversion` and `signal` are keyed by platform, and Meta, TikTok (Events API), Google Ads
(Data Manager API, OAuth from Conexões) and Google Analytics (Measurement Protocol, sale and refund) each are a
`Destination`. The Meta Pixel, the TikTok Pixel and the Google tag are on by default, share the server's event ids and
load only on buyer pages. Each field takes whatever the seller pastes (the id, the tag code, the conversion action's
link) and saving tests the connection. A product can have its own pixel, property and conversion action
(`product_tracking`, the "Anúncios" tab), falling back to the store's. Every click id of a link is kept. Search Console
and Meta domain verification codes go on every domain.

Not covered: a refund in Google Ads. The Data Manager API only restates a conversion's value, and its documentation does
not say a zero value retracts it.

### 4a. Connect the ad platforms with one click

"Conectar com Meta", "Conectar com Google" and "Conectar com TikTok": the seller signs in and picks the pixel, account
or conversion action from a list, with no token to copy and no Google Cloud project. The pasted connection stays for
those who prefer it.

The platforms only send a login back to addresses registered in an app, and each store has its own domain, so this needs
LibreFunnel's own apps and a small login service on librefunnel.com that hands the access back to the store that asked
(signed state, one use, the token sealed for that store only). Before any code:

1. Meta: a business-verified app with Facebook Login for Business, `ads_management` and `business_management` approved
   in App Review.
2. Google: a Cloud project with the Data Manager API and a verified OAuth consent screen for the `datamanager` scope.
3. TikTok: a TikTok for Business developer app with the Events Manager and Ads Management scopes approved.

Built only once the three are approved, since none of it can be tested before.

### 5. Drip content

A module opens a number of days after payment or on a fixed date, with an optional e-mail when it opens. Two nullable
columns on `module` (`release_days`, `release_at`), and access is computed when the lesson is read from the order's
payment date, with no stored state. The opening e-mail goes through the outbox.

### 6. Certificates

Issued when progress reaches 100%: name, course, hours, date and a code. A public page `/certificado/<code>`, rendered
on the server and printable (no PDF library), doubles as verification. One table (`certificate`) and one setting per
product (hours, signature image).

### 7. Bundles and access duration

A product that grants other products (`bundle_item`: bundle, component). Refunds and chargebacks revoke every component.
Access that ends after N days (`access_days` on the product), shown in the members area.

### 8. Price batches and sales windows

A promotional price that ends at a date or after N sales (the Brazilian "lote 1, lote 2"), checked when the order is
created and counted when it is paid. Sales that open and close at set dates. Columns on `product` only.

## Later

### 9. Refund requests from the members area

A "Pedir reembolso" button while the guarantee is open (`guarantee_days` already exists), with an optional reason. The
admin gets a queue to approve, which runs the refund that exists today, or to reject with a reply. This covers the 7-day
right of withdrawal (CDC art. 49) without the buyer having to find the seller's e-mail.

### 10. Free product with double opt-in, and waitlist

A product with price zero skips Pix: the e-mail gets a confirmation link, and access is granted only after the click.
The exact consent text and its version are stored with the lead, as LGPD evidence. A product that is not on sale shows a
waitlist form instead of a 404. Both feed item 11.

### 11. E-mail sequences, broadcasts and tags

A sequence starts on an event (paid, lead, refunded, tag added) and sends e-mails or WhatsApp messages at set delays
through the outbox. A broadcast sends once to a segment (buyers of a product, leads, a tag). Tags are a column on
`contact`. Steps are versioned, so running sequences keep the version they started with. Recovery reuses the same steps,
and its last step can carry a coupon. Opens and clicks only if they come with no new dependency, through a signed pixel
and redirect.

### 12. VSL retention curve

The player reports how far each visit watched, in buckets, with one row per visit. The panel shows where viewers drop
off against the second the buy button appears.

### 13. Ad spend and ROAS

Daily spend per campaign read from the Meta Marketing API in the background loop (last 3 days re-read, 30 days on
connect), matched to sales by UTM. The panel shows spent, sold and return per campaign.

### 14. A/B split of the sales page

Two variants of a product page (video, headline, price) with weights. A visitor is assigned once by hash and the
assignment is stored, so changing weights does not move people already counted. The result shows visits, sales, rate and
whether the difference is significant (two-proportion test), so noise is not declared the winner.

### 15. Lesson materials, comments and quizzes

PDF attachments per lesson (done): one PDF of up to 50 MB in `lesson.attachment`, with the uploaded file name in
`lesson.attachment_name`, downloaded at `/m/<product>/<lesson>/anexo` under the same access check as the lesson video
(`media/serving.ts`), as `Content-Disposition: attachment` with that name; a connected bucket answers through a signed
link. Without a session the link goes to the members login; a buyer of another product or a refunded one gets 404. Still
to do: other file types (no zip on request). Comments per lesson with admin moderation. Quizzes with a passing grade,
scored on the server with wrong answers penalized.

### Small items

- Block disposable e-mail domains at checkout, as a static list.
- Restore access when a chargeback or MED dispute is won. Check what happens today after `OPENPIX:DISPUTE_ACCEPTED` and
  Mercado Pago chargebacks.

## Not planned

- Page builder: heavy on 1 vCPU and off the VSL model.
- Community with posts and reactions: sellers use WhatsApp groups.
- Affiliates. If it ever comes: commission paid only after the guarantee plus a hold, and zero commission on
  self-referral.
- Subscriptions. Recurring Pix (Pix Automático) depends on the providers and is its own project.
- License keys, multi-currency, multi-tenant, roles, LLM analysis of the funnel.
