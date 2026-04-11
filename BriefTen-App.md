# BriefTen — Multi-Tenant Newsletter Platform

A platform that lets anyone set up and run their own AI-generated email newsletter, modeled on The Daily Fintech Briefing. Users bring their own API keys; the platform provides the infrastructure, admin UI, and pipeline.

---

## Step 1 — Project Setup

**Single repo.** Frontend and backend live together — the same structure as the Fintech Briefing. One repo makes it easy to keep API contracts in sync across both sides, and there's no reason to split until you have separate teams or a build pipeline complex enough to warrant it.

Suggested structure:
```
brieften/
  worker/        — Cloudflare Worker (API, pipeline, all backend logic)
  app/           — Frontend (Cloudflare Pages)
  wrangler.toml  — root config
```

Create the local folder first, then the GitHub repo. Do not create the repo on GitHub first — you'll end up cloning an empty repo and moving files in, which is unnecessary.

### Git and Gitflow Setup

BriefTen uses **Gitflow** — a branching model with two permanent branches (`main` and `develop`) and short-lived branches for features, releases, and hotfixes. Nothing goes directly to `main`. Production deploys come from release or hotfix merges only.

**Install git-flow (one-time, macOS):**
```bash
brew install git-flow-avh
```

**Initialize the repo:**
```bash
mkdir brieften
cd brieften
git init
git commit --allow-empty -m "Initial commit"
git flow init -d            # -d accepts all defaults
```

`git flow init -d` configures:
- `main` — production-ready code only, tagged at each release
- `develop` — integration branch, where all feature work lands
- `feature/` — individual feature branches, cut from and merged back to `develop`
- `release/` — release preparation branches, cut from `develop`, merged to `main` + `develop`
- `hotfix/` — emergency fixes, cut from `main`, merged to `main` + `develop`

**Create the GitHub repo and push both branches:**
```bash
gh repo create brieften --private --source=. --remote=origin --push
git push origin develop
```

`gh repo create` pushes `main`. Pushing `develop` separately ensures both permanent branches exist on the remote from the start.

### Daily Workflow

```bash
# Start a feature (branches from develop)
git flow feature start my-feature

# Finish a feature (merges to develop, deletes branch)
git flow feature finish my-feature

# Cut a release (branches from develop)
git flow release start 1.0.0

# Finish a release (merges to main + develop, creates tag v1.0.0)
git flow release finish 1.0.0
git push origin main develop --tags

# Emergency fix against production (branches from main)
git flow hotfix start fix-name

# Finish a hotfix (merges to main + develop)
git flow hotfix finish fix-name
git push origin main develop --tags
```

**Branch naming convention:**
- `feature/onboarding-flow`
- `feature/stripe-integration`
- `release/1.0.0`
- `hotfix/pipeline-crash`

**Cloudflare Pages deployment**: Connect Pages to the `main` branch only. The `develop` branch should have its own Pages project (`brieften-web-dev`) for staging previews. This way, merging a release to `main` triggers a production deploy automatically, and `develop` stays as a preview environment.

---

## Business Model

Flat monthly subscription — users pay for the platform, not for API consumption. Since they bring their own keys, you're not absorbing Anthropic or Tavily costs. Easy to reason about pricing.

---

## Bring Your Own Keys

Users supply API keys for all four services the pipeline depends on:

- **Anthropic** — story generation (Claude)
- **Tavily** — news article search
- **Finnhub** — market data / tickers
- **Resend** — email delivery

This keeps your infrastructure costs near zero and removes the need to meter or rate-limit per-account API usage. The tradeoff is onboarding friction — users must get keys from four services before they can do a first send. Good onboarding UX is critical here.

---

## Key Storage

Worker secrets are deploy-time only and can't be stored per-tenant at runtime. The right approach is **D1 + AES-256-GCM encryption**:

1. User enters API keys in a settings UI
2. Worker encrypts each key using a master secret stored as a Worker secret
3. Encrypted values stored in a `tenant_keys` D1 table
4. At pipeline run time, Worker fetches and decrypts the keys for that tenant
5. Keys are never returned to the browser — write-only from the UI, same as Cloudflare secrets behave today

The master encryption key is the single point of trust. If compromised, all tenant keys are exposed. Mitigate by rotating it periodically and re-encrypting stored values.

---

## Privacy Policies

Two layers are required:

**Platform policy** — covers the relationship between BriefTen and its tenants (account data, billing, infrastructure). One policy, maintained by you, at `app.yourplatform.com/privacy`.

**Per-tenant policy** — covers each tenant's relationship with their subscribers. Tenants are the data controller for their subscriber lists; BriefTen is the data processor. Each tenant must provide a URL to their own privacy policy as part of onboarding. That URL is stored on their account record and linked dynamically in every email footer.

Required account field: `privacy_policy_url TEXT NOT NULL`. The email template's hardcoded `cloudflash.com/privacy` link becomes a dynamic value pulled from tenant config at render time, same pattern as source names.

For GDPR compliance, a Data Processing Agreement (DPA) should be available for tenants who need it. Make it a downloadable PDF linked from the platform's privacy policy.

The Fintech Briefing privacy policy (see below) is a good starting template for tenants to adapt — keep it short, cover only what's actually collected, name the third-party services involved.

---

## Feature List

### Auth & Accounts
- User signup / login (email + password or OAuth)
- Per-account isolation of all data
- Billing / subscription management (Stripe)
- Key entry UI with per-key validation on save (test each key immediately so users know if something is wrong)

### Per-Account Config
Everything already built for the Fintech Briefing, scoped per tenant:
- Story topics (priority-ordered for Claude)
- Vendor watchlist
- News sources (with per-source Tavily query, days lookback, max results)
- Tickers (with groups for market snapshot)
- Prompt template (`{TOPICS}`, `{VENDORS}`, `{ARTICLES}` placeholders)
- Newsletter name, branding (logo, accent color)
- From name and reply-to address

### Email Infrastructure
- Per-account verified sending domain via Resend's domain verification flow
- Unsubscribe tokens scoped per tenant
- CAN-SPAM compliance fields (physical mailing address) stored per account
- Double opt-in confirmation flow

### Pipeline
- Per-account cron schedules (or a shared scheduler that fans out across tenants)
- Pipeline runs as a queue processing each account's scheduled job
- Per-account run logs (articles fetched, stories generated, send results)
- Failure isolation — one account's pipeline failure doesn't affect others

### Subscriber Management
- Double opt-in flow with confirmation email
- Hosted subscribe page per account (see Subscribe Page Options below)
- Subscriber list with status filters (active, pending, unsubscribed)
- Confirm and delete actions
- Exportable subscriber list (CSV)

### Admin UI
Everything already built, scoped per account:
- Preview tab (mock and live preview, send to test address)
- Pipeline tab (trigger run, view run history)
- Config tab (topics, vendors, sources, tickers, prompt)
- Subscribers tab (list, search, manage)
- Stats tab (API usage per service)

Plus account-level settings:
- Newsletter branding
- API key management
- Sending domain setup
- CAN-SPAM address

### Deliverability
- Bounce and complaint handling via Resend webhooks
- Automatic unsubscribe on complaint
- Sending reputation monitoring
- Per-account unsubscribe list sync

---

## Subscribe Page Options

Ship in this order:

**1. Hosted slug page (launch with this)**
Every account gets `app.yourplatform.com/newsletter/[slug]`. Platform controls the page; tenant configures the content (name, description, branding). No custom domain required. Low friction to go live. Also the natural target for "Forwarded this? Subscribe here" links in email footers.

**2. Embeddable widget**
A `<script>` tag tenants drop into their own site. Renders a subscribe form that posts to the platform API. Lets them keep their own domain and design. Best for users who already have a blog or website.

**3. Custom domain**
Tenant points a subdomain (e.g. `subscribe.theirdomain.com`) via CNAME. Cloudflare Workers handles this natively with custom domains per route. Most professional, highest onboarding friction — ship last.

---

## Architecture

**Single Cloudflare Worker** with a shared D1 database. Every table gets a `tenant_id` column. The pipeline becomes a queue (Cloudflare Queues or Durable Objects) that processes each account's scheduled run rather than a single cron job.

This is essentially what the Fintech Briefing already is, unwrapped from its single-tenant assumptions and re-wrapped with a multi-tenant data model. Most of the hard product work is already done.

---

## Hosting — Drop Vercel

The Fintech Briefing uses Vercel to serve static files and proxy two routes (`/confirm`, `/unsubscribe`) to the Cloudflare worker via `vercel.json` rewrites. This works for a single static site but doesn't scale to BriefTen.

BriefTen needs dynamic per-tenant pages, an auth-gated dashboard, onboarding flows, and billing pages — none of which is a static site. Rather than add a framework on top of Vercel, go fully Cloudflare:

- **Cloudflare Pages** serves the frontend (static or SSR). No commercial use restrictions, generous free tier.
- **Cloudflare Workers** handles all API and pipeline logic (already the case).
- Everything on one platform — one billing account, no proxy rewrites, no cross-service dependencies.

The Vercel rewrite workaround for `/confirm` and `/unsubscribe` disappears entirely — those routes are served directly by the Worker since you control full domain routing through Cloudflare.

---

## Cloudflare Account Separation

Cloudflare does not have a native "projects" concept. Within a single account, all Workers, D1 databases, KV namespaces, and Pages sites are flat named resources with no grouping. **BriefTen will share the existing Cloudflare account with other projects.**

Naming convention is the only organizational tool. Prefix every BriefTen resource consistently:
- Worker: `brieften-api`
- D1 database: `brieften-db`
- KV namespace: `brieften-kv`
- Pages project: `brieften-web`

This keeps BriefTen resources visually grouped in the Cloudflare dashboard and makes it unambiguous which resources belong to which project. Worker secrets are scoped per Worker, so there's no risk of BriefTen secrets leaking to other Workers in the same account.

---

## Onboarding Flow

The BYOK model creates a specific first-run problem: the user signed up and paid, but nothing works until all four keys are entered and validated. Good onboarding design is the difference between "this is powerful" and "I couldn't figure it out."

**Step 1 — Account created**
After Stripe checkout completes, redirect to `app.yourplatform.com/onboarding`. Show a checklist of what needs to be done before the first send:
- [ ] API keys (Anthropic, Tavily, Finnhub, Resend)
- [ ] Sending domain verified
- [ ] Configure at least one news source
- [ ] Add story topics
- [ ] Physical mailing address (CAN-SPAM)

**Step 2 — API key entry**
One key per field. On blur (not on save), fire a lightweight validation request per key: a minimal API call that confirms the key is valid and has sufficient permissions. Show a green checkmark or red error inline. Never show the key value after it's been saved — treat it like a password field.

**Step 3 — Sending domain**
Walk the user through Resend's domain verification: add DNS records, poll until verified. This is the highest-friction step — most users won't have done this before. Consider linking directly to Resend's DNS setup docs.

**Step 4 — First config**
Redirect to the Config tab pre-populated with sensible defaults. The reference fintech config (topics, vendors, sources, tickers, prompt) is a good starting point for any business-focused newsletter; offer it as a "use fintech template" option alongside a blank slate.

**Step 5 — First preview**
Once keys and config are set, prompt the user to run a live preview. This confirms everything works before they add a single subscriber. Show the preview inline in the onboarding checklist.

**Step 6 — Subscribe page**
Show the tenant their hosted subscribe slug URL. Prompt them to test it — subscribe themselves, click the confirmation link, confirm they receive the confirmation email from their own domain.

**State management**: The tenant account record should track `onboarding_completed BOOLEAN DEFAULT FALSE`. The onboarding checklist is re-entrant — the user can leave and come back. The admin dashboard should surface incomplete items until all steps are done.

**Empty state**: Every tab in the admin UI should have a non-empty empty state. If there are no subscribers, don't show a blank table — show "No subscribers yet. Share your subscribe page: [URL]." If no pipeline runs, show "Run a live preview to test your setup."

---

## Stripe Integration

Stripe is the only billing system worth using here. Use Stripe Checkout for the initial payment flow and Stripe Customer Portal for self-serve plan management.

**Integration points:**

- **Checkout**: On signup, create a Stripe customer and redirect to Stripe Checkout for the monthly subscription. On `checkout.session.completed` webhook, create the tenant account record with `status = 'active'` and `trial_ends_at = null` (or set a trial period).
- **Trial period**: A 14-day free trial (no credit card required) is the standard SaaS approach. Set `trial_ends_at = now + 14 days` on account creation; grant full access until that date.
- **Payment failure**: Stripe sends `invoice.payment_failed` after a failed charge. On first failure, send the tenant an email and set `status = 'past_due'`. The pipeline should still run during the grace period (Stripe retries for ~7 days by default). On final failure (`customer.subscription.deleted`), set `status = 'canceled'` and disable pipeline runs and sends.
- **Cancellation**: On `customer.subscription.deleted`, set `status = 'canceled'`. Stop the pipeline. Keep the tenant's data per the retention policy (see Tenant Lifecycle below). Do not immediately delete anything.
- **Reactivation**: If a canceled tenant resubscribes, restore their account. Their config, subscriber list, and issues history should all still be there.

**Tenant account fields:**
```sql
CREATE TABLE tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'trialing',  -- trialing | active | past_due | canceled
  trial_ends_at TIMESTAMP,
  plan TEXT NOT NULL DEFAULT 'standard',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**What `status` gates:**
- `trialing` / `active` — full access
- `past_due` — read-only admin UI, pipeline runs suspended, warning banner shown
- `canceled` — login allowed (so they can export subscribers), all pipeline and send functionality disabled

**Never put Stripe logic in the Worker cron path.** Webhook events are the source of truth. The Worker should check `tenant.status` from D1 at pipeline run time and skip canceled/past_due tenants, not call the Stripe API.

---

## Tenant Account Lifecycle

**Active → Canceled**
When a tenant cancels, they have 30 days to export their subscriber list before data is deleted. Send an automated email on cancellation with the export link and the deletion date. After 30 days, run a hard delete of all tenant data: subscriber rows, issues, pipeline runs, config, API logs, encrypted keys. This is non-reversible — document it clearly in the platform privacy policy and DPA.

**Data export**
Every tenant should be able to export their subscriber list as CSV at any time, not just at cancellation. This is both good UX and a GDPR requirement.

**Account deletion (tenant-initiated)**
Provide a "Delete my account" button in account settings. Require typed confirmation ("delete my account"). Trigger immediate subscriber list export email, then schedule deletion in 7 days to allow reversal. Cancel the Stripe subscription on the same request.

**Subscriber data after tenant cancels**
Tenants' subscribers are *their* subscribers — the tenants are the data controllers. When a tenant cancels and their account is deleted, all their subscriber records must be deleted too. This includes unsubscribed records still in the 90-day retention window. There is no BriefTen interest in retaining those records after the tenant relationship ends.

---

## Pipeline Scheduling Per Tenant

The Fintech Briefing uses a single Cloudflare Worker cron (`30 14 * * 2-6`). Multi-tenant means potentially dozens of pipelines running on different schedules.

**Option A — Cloudflare Queues (recommended)**
One cron fires every minute. It queries D1 for tenants whose `next_run_at <= now` and whose `status` is active, then enqueues a message per tenant to a Cloudflare Queue. Queue consumers process each message independently. If one tenant's pipeline fails, the error is isolated to that message — other tenants are unaffected.

Tradeoffs: Queue consumer has a separate execution context (not the cron worker). Messages can be retried independently. Good failure isolation. Cloudflare Queues has a generous free tier (5M messages/month).

**Option B — Durable Objects**
One Durable Object per tenant, each managing its own alarm-based schedule. More flexible (per-tenant schedule changes take effect immediately without a cron firing), but significantly more complex to implement and debug.

**Recommendation**: Start with Queues. It's simpler to reason about, easier to debug (Cloudflare Logs shows queue consumer invocations), and the per-minute polling approach is well within D1 query performance limits even at hundreds of tenants.

**Per-tenant schedule config:**
```sql
ALTER TABLE tenants ADD COLUMN cron TEXT NOT NULL DEFAULT '30 14 * * 2-6';
ALTER TABLE tenants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE tenants ADD COLUMN next_run_at TIMESTAMP;
```

`next_run_at` is computed and stored after each successful run, based on the tenant's cron expression and timezone. The per-minute cron just queries `WHERE next_run_at <= CURRENT_TIMESTAMP AND status = 'active'`.

**Admin UI for schedule config**: Tenants should set their send time as a human-readable local time (e.g. "7:30am, Monday–Friday") and timezone (a dropdown of IANA timezone names like `America/New_York`). The platform converts this to a cron expression and computes `next_run_at` using `Intl.DateTimeFormat` for DST-aware calculation. Tenants should never see or edit a raw cron expression.

**DST handling**: Cloudflare cron runs in UTC with no timezone support — it cannot handle DST automatically. The reference implementation (single-tenant Fintech Briefing) requires manually updating the cron expression twice a year: `30 14 * * 2-6` during PDT (UTC-7, April–October) and `30 15 * * 2-6` during PST (UTC-8, November–March). BriefTen avoids this entirely by using the per-minute polling approach — `next_run_at` is computed in the correct local time using the tenant's IANA timezone, so DST transitions are handled automatically without any cron changes. Also note: Cloudflare's day-of-week numbering uses `1=Sunday` (not the standard `1=Monday`), so `2-6` = Monday–Friday.

---

## Database Migration Strategy

D1 is SQLite and doesn't have a built-in migration system. Use versioned `.sql` files with a `schema_version` table.

**Pattern:**
```
worker/migrations/
  001_initial_schema.sql
  002_add_tenant_id_columns.sql
  003_add_stripe_fields.sql
  ...
```

Each file is run exactly once. Track applied migrations:
```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Run migrations with:
```bash
npx wrangler d1 execute brieften-db --file=worker/migrations/002_add_tenant_id_columns.sql
```

**Rules:**
- Migrations are append-only. Never edit an already-applied migration file.
- Every schema change is a new numbered file, even simple `ALTER TABLE ADD COLUMN` statements.
- Test migrations against a local D1 (`--local` flag) before running against production.
- `schema.sql` in the repo root remains the canonical create-from-scratch schema (union of all migrations), updated after each migration to reflect current state. This is for new environment setup only — never run it against a database with data.

---

## Rate Limiting and Abuse Prevention

The `/subscribe` endpoint is public and unauthenticated. Without rate limiting, it's trivially abused — bad actors can flood a tenant's subscriber list with fake addresses, which will eventually damage their sending reputation via bounces.

**At minimum, implement:**

**IP-based rate limiting** via Cloudflare's built-in rate limiting rules. Set at the Cloudflare dashboard level, not in Worker code: max 5 subscribe requests per IP per 10 minutes. This requires no code changes — it's a firewall rule. Free on all Cloudflare plans.

**Email domain validation** in the Worker: reject addresses with obviously disposable domains (a static blocklist is fine to start). Also reject addresses that fail basic regex — don't rely on HTML `type="email"` alone.

**Duplicate suppression**: The current schema enforces `email UNIQUE`, so duplicate subscribes for the same address just update the token. This is correct behavior. But the confirmation email can be used as a spam vector if someone subscribes an address they don't own repeatedly. After 3 confirmation resends to the same address within 24 hours, stop sending and return a generic success response.

**Honeypot field**: Add a hidden `<input type="text" name="website" tabindex="-1" autocomplete="off">` to the subscribe form. If it's filled on submit, silently drop the request without returning an error. Bots fill all fields; humans never see this field.

---

## Email Template Customization Per Tenant

The reference implementation uses a fixed layout and color scheme tied to The Daily Fintech Briefing brand. BriefTen tenants will have their own newsletters with different names, colors, and branding.

**What to parameterize per tenant:**
- Newsletter name (replaces "The Daily Fintech Briefing" in the header)
- Accent color (used for story numbers and links — currently `#2179c8`)
- Logo URL (currently `https://cloudflash.com/logo.png`)
- "Forwarded this? Subscribe here" URL (the tenant's hosted subscribe slug)
- "Subscribe here" link text and destination
- Copyright line (tenant name, not "Cloudflash, Inc.")
- Privacy policy URL (already planned — per-tenant `privacy_policy_url`)
- Physical mailing address (CAN-SPAM requirement, stored per tenant)

**What should NOT be parameterized:**
The underlying table-based HTML structure, fonts (Arial/Georgia for email client compatibility), and layout (600px centered table) should be fixed. These are not design choices — they're email client compatibility decisions. Allowing tenants to inject arbitrary CSS or change the font stack is a deliverability and rendering risk.

**Implementation**: `buildEmailHtml` and `buildEmailText` in `email-template.ts` accept a `branding` parameter:
```typescript
interface TenantBranding {
  newsletterName: string;
  accentColor: string;      // hex, e.g. '#2179c8'
  logoUrl: string;
  subscribeUrl: string;
  copyrightName: string;
  privacyPolicyUrl: string;
  mailingAddress: string;
}
```

All current hardcoded values become defaults that map to the Fintech Briefing configuration.

---

## Platform-Level Monitoring

The Fintech Briefing has `ALERT_EMAIL` for pipeline failures. For a multi-tenant platform, you need visibility at two levels:

**Per-tenant (already built)**
- `api_logs` table tracks every API call with success/failure and duration
- Pipeline failure sends alert to tenant's configured email
- Admin Stats tab shows per-service call counts and failures per period

**Platform-wide (new)**
A separate internal admin endpoint (key-gated, not exposed to tenants):

`GET /platform/health?key=...` — returns:
- Total tenants by status (active, trialing, past_due, canceled)
- Pipelines run in last 24h / 7d
- Pipeline failure rate across all tenants
- Any tenants whose pipeline has failed 3+ consecutive times (may indicate bad API keys)
- Resend bounce/complaint rates if accessible via API

Cloudflare Workers Analytics (available in the dashboard) will surface global error rates, CPU time, and invocation counts without any code changes. Check this after deploying a new Worker version.

**Alerting on repeated failures**: If a tenant's pipeline fails 3 consecutive times, send an alert to the platform `ALERT_EMAIL` (not the tenant's email — this is a platform-level signal, not a tenant error). Common causes: expired API key, Tavily quota exhausted, bad config that triggers Claude parsing errors.

---

## Local Development

**Requirements**: Node.js, Wrangler CLI, `gh` CLI.

**Setup:**
```bash
# Install dependencies
npm install

# Create local D1 database
npx wrangler d1 create brieften-db --local

# Run migrations
npx wrangler d1 execute brieften-db --local --file=worker/migrations/001_initial_schema.sql

# Seed prompt
npx wrangler d1 execute brieften-db --local --file=worker/seed-prompt.sql

# Start worker dev server
npx wrangler dev --config worker/wrangler.toml

# In a second terminal, serve the frontend
npx serve app/
```

**Environment**: Wrangler dev mode uses a local SQLite file for D1 (`.wrangler/state/`). Worker secrets (API keys) must be set in a `.dev.vars` file (not committed to git):
```
ANTHROPIC_API_KEY=sk-ant-...
TAVILY_API_KEY=tvly-...
FINNHUB_API_KEY=...
RESEND_API_KEY=re_...
PREVIEW_KEY=local-dev-key
ALERT_EMAIL=you@example.com
```

**Testing against production D1**: Use `npx wrangler d1 execute brieften-db --file=...` (without `--local`) to run queries against the live database. Always test with `--local` first.

**Important**: The encryption master key for tenant API keys must also be in `.dev.vars` as `ENCRYPTION_KEY`. Generate a random 32-byte base64 value locally; it doesn't need to match production (local tenant key data is separate from prod).

---

## Testing Strategy

**What to test:**

**Subscribe / confirm / unsubscribe flow** — the most critical path. An automated end-to-end test that:
1. POSTs to `/subscribe` with a test email
2. Queries D1 directly for the confirmation token
3. GETs `/confirm?token=...` and verifies the confirmation page renders
4. POSTs to `/confirm?token=...` and verifies the subscriber row is updated
5. GETs `/unsubscribe?token=...` and verifies the subscriber is soft-deleted

This can be a simple TypeScript test file using `fetch` against a local Wrangler dev instance.

**Tenant isolation** — verify that a request with tenant A's key cannot read or modify tenant B's data. Run the same config endpoint twice with different tenant keys and confirm the responses are isolated.

**Pipeline steps in isolation** — each pipeline step (fetch articles, generate stories, build email, send) should be individually testable via the existing `/pipeline/fetch`, `/preview/live`, etc. endpoints. These are manual integration tests, not unit tests — the real value is catching regressions against live APIs.

**Schema migrations** — before applying any migration to production, run it against a copy of the production schema with `--local`. Verify the migration completes without error and a sample query still returns expected results.

**What not to test with mocks**: Don't mock D1 queries in unit tests. The reference implementation learned this the hard way — the SQL dialect and constraint behavior in SQLite matters, and mocks don't catch it. Use the local D1 instance for all data-layer tests.

---

## Bounce and Complaint Thresholds

Resend routes delivery events to the `/webhooks/resend` endpoint. The current implementation handles `email.bounced` and `email.complained` by soft-deleting the subscriber. The thresholds that matter:

**Hard bounce** (permanent delivery failure — address doesn't exist): Remove immediately on first occurrence. This is already implemented.

**Soft bounce** (temporary failure — mailbox full, server timeout): Resend classifies these as `email.bounced` with a `bounce_type` of `soft`. Current implementation treats all bounces the same — for soft bounces, a more defensive approach is to increment a bounce counter and remove after 3 consecutive soft bounces (Resend's webhook payload includes `bounce_type` in the event data).

**Complaint** (subscriber hit "report spam"): Remove immediately. Already implemented. Note: Gmail and Yahoo now require a `List-Unsubscribe-Post` header for one-click unsubscribe compliance. Resend handles this automatically when you use their unsubscribe URL in the email — verify the Resend docs for current configuration.

**Sending reputation thresholds** (industry standards):
- Bounce rate > 2%: ISPs start filtering to spam. Resend will warn you.
- Complaint rate > 0.1%: Google/Yahoo will start rejecting. Resend will suspend sending.

These thresholds apply per sending domain, not per tenant. If one tenant has a dirty list, it affects all tenants on the same Resend account. For this reason, consider requiring domain verification before a tenant can send to more than ~100 subscribers. Resend's per-domain sending also isolates reputation per tenant if each tenant uses their own verified domain.

---

---

# Reference Implementation — The Daily Fintech Briefing

The following documents exactly what was built for the single-tenant Fintech Briefing. Use this as the implementation spec for each tenant's feature set.

---

## Infrastructure

- **Runtime**: Cloudflare Worker (TypeScript), deployed via Wrangler
- **Database**: Cloudflare D1 (SQLite), single database named `briefing-db`
- **Static assets**: Served via a separate `cloudflash-web` Cloudflare Worker with the `app/` directory as its asset root
- **Email delivery**: Resend API
- **Cron**: Cloudflare Worker scheduled trigger — `30 14 * * 2-6` (7:30am PDT, Monday–Friday). Two quirks to be aware of:
  - **No timezone support** — Cloudflare cron runs in UTC only. The expression must be manually updated when daylight saving time changes: `30 14 * * 2-6` during PDT (UTC-7, April–October), `30 15 * * 2-6` during PST (UTC-8, November–March).
  - **Day-of-week is 1=Sunday** — so `2-6` = Monday–Friday. This differs from standard cron where `1=Monday`.
- **Deployment**: `wrangler deploy` from `worker/` directory

### Worker Secrets (set via `wrangler secret put`)
- `ANTHROPIC_API_KEY` — Claude API key
- `RESEND_API_KEY` — Resend API key
- `TAVILY_API_KEY` — Tavily search API key
- `FINNHUB_API_KEY` — Finnhub market data API key
- `PREVIEW_KEY` — shared secret that gates all admin/pipeline endpoints
- `ALERT_EMAIL` — email address to receive pipeline failure alerts
- `VERCEL_DEPLOY_HOOK` — optional Vercel deploy hook URL, triggered after each pipeline run

---

## Database Schema

### `issues`
Stores every sent newsletter issue.
```sql
CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,           -- YYYY-MM-DD (Pacific time)
  subject TEXT NOT NULL,        -- email subject line
  html_body TEXT NOT NULL,      -- full rendered HTML
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `subscribers`
One row per subscriber. Unsubscribe is a soft delete (sets `unsubscribed_at`, `confirmed = 0`). Re-subscribing sets `confirmed = 1` and a new `confirmed_at`. Active status is determined by comparing timestamps: a subscriber is active if `confirmed = 1` AND (`unsubscribed_at IS NULL` OR `confirmed_at > unsubscribed_at`).
```sql
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMP,
  unsubscribed_at TIMESTAMP,
  subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  unsubscribe_token TEXT UNIQUE NOT NULL  -- UUID, used in email footer links
);
```

### `previews`
Stores rendered HTML from preview runs (both live and mock). Used by the admin page's "Send preview to..." feature.
```sql
CREATE TABLE previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `pipeline_runs`
One row per pipeline execution. Articles are saved before the Claude call so they're available even if generation fails. Stories are updated after Claude returns.
```sql
CREATE TABLE pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  articles_json TEXT,   -- JSON array of TavilyResult objects
  stories_json TEXT,    -- JSON array of Story objects (added after Claude call)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `api_logs`
Every call to Anthropic, Tavily, Finnhub, and Resend is logged here. Used by the Stats tab.
```sql
CREATE TABLE api_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,         -- 'anthropic' | 'tavily' | 'finnhub' | 'resend'
  success INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  tokens_used INTEGER,           -- Anthropic only
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `config_topics`
Story topics passed to Claude in priority order. Claude is instructed to select and rank stories matching these topics first.
```sql
CREATE TABLE config_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_pos INTEGER NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''  -- admin-only, never sent to Claude
);
```

### `config_vendors`
Vendor names passed to Claude. Claude bumps stories mentioning these vendors above generic stories on the same topic.
```sql
CREATE TABLE config_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_pos INTEGER NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
```

### `config_sources`
News sources fetched via Tavily. Each source generates one Tavily API call per pipeline run.
```sql
CREATE TABLE config_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_pos INTEGER NOT NULL,
  name TEXT NOT NULL,            -- display name (used in email footer)
  domain TEXT NOT NULL,          -- e.g. 'pymnts.com'
  query TEXT NOT NULL,           -- Tavily search query
  days INTEGER NOT NULL DEFAULT 7,          -- lookback window
  max_results INTEGER NOT NULL DEFAULT 5,   -- articles fetched per source
  note TEXT NOT NULL DEFAULT ''
);
```

### `config_tickers`
Stock tickers fetched from Finnhub and displayed in the email market snapshot. `ticker_group` controls how they're grouped in the email (e.g. "Digital Banking", "Core Banking").
```sql
CREATE TABLE config_tickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_pos INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  ticker_group TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
```

### `config_prompt`
Single-row table storing the Claude prompt template. Uses `{TOPICS}`, `{VENDORS}`, and `{ARTICLES}` as placeholders. Falls back to a hardcoded default in the worker if the row is missing.
```sql
CREATE TABLE config_prompt (
  id INTEGER PRIMARY KEY DEFAULT 1,
  template TEXT NOT NULL
);
```

---

## Pipeline

The pipeline runs on a cron schedule and can also be triggered manually via `/run?key=...`.

### Steps

1. **Duplicate check** — query `issues` for today's date (Pacific time). Abort if a row exists to prevent duplicate sends on manual retriggers.
2. **Load config** — load all five config tables in parallel via `Promise.all`.
3. **Fetch articles** — call Tavily once per `config_sources` row, in parallel. Each call uses the source's `query`, `domain`, `days`, and `max_results`. Results are tagged with the source name.
4. **Fetch tickers** — call Finnhub's `/quote` endpoint for each `config_tickers` symbol, in batches of 25 with 1-second delays between batches (Finnhub rate limit: 30 req/sec).
5. **Save pipeline run** — insert a `pipeline_runs` row with `articles_json` before calling Claude. This ensures articles are preserved even if Claude fails.
6. **Generate stories** — fetch the last 5 pipeline runs' story headlines from `pipeline_runs.stories_json`, then send all articles + topics + vendors + prompt template + recent headlines to Claude (`claude-sonnet-4-6`, `max_tokens: 4096`). Claude returns a JSON array of 10 story objects. Parse and retry up to 3 times on JSON parse failure. The recent headlines are appended to the prompt after the articles with the instruction: "Do not repeat these stories or any substantially similar stories."
7. **Update pipeline run** — write `stories_json` back to the `pipeline_runs` row.
8. **Build email** — render HTML and plain-text versions using `buildEmailHtml` / `buildEmailText`, passing ticker groups/names and source names dynamically from config.
9. **Save issue** — insert into `issues` table.
10. **Save preview** — insert into `previews` table (makes it accessible to the admin preview/send feature).
11. **Send** — query `subscribers WHERE confirmed = 1 AND (unsubscribed_at IS NULL OR confirmed_at > unsubscribed_at)`. Send in batches of 4 with 1.1-second delays (Resend rate limit: 5 req/sec). Each email has its `{{UNSUBSCRIBE_TOKEN}}` placeholder replaced with the subscriber's token.
12. **Trigger Vercel deploy hook** — optional, redeploys the public-facing site after a new issue is saved.
13. **Purge expired subscribers** — delete rows where `confirmed = 0 AND unsubscribed_at < 90 days ago`.

### Error handling
- Tavily failures per source are logged and silently skipped (other sources continue).
- Finnhub failures per symbol are logged and skipped (ticker section omitted if all fail).
- Claude JSON parse failures retry up to 3 times before throwing.
- Pipeline-level failures send an alert email to `ALERT_EMAIL` via Resend.

---

## API Endpoints

All endpoints on `api.cloudflash.com` (the `cloudflash-briefing` worker). Endpoints requiring `key` validate against the `PREVIEW_KEY` secret.

### Public

| Method | Path | Description |
|--------|------|-------------|
| POST | `/subscribe` | Subscribe an email. Accepts JSON `{email}` or form data. Sends double opt-in confirmation email. Returns `{status: "confirmation_sent"}`. |
| GET | `/confirm?token=...` | Show confirmation page (prevents security scanner auto-confirm). |
| POST | `/confirm?token=...` | Actually confirm subscription. Redirects to `cloudflash.com/fintech?status=confirmed`. |
| GET | `/unsubscribe?token=...` | Unsubscribe. Sets `confirmed=0`, `unsubscribed_at=now`. Redirects to `cloudflash.com/fintech?status=unsubscribed`. |
| GET | `/api/issues` | List all issues (id, date, subject). |
| GET | `/api/issues/:date` | Fetch a single issue by YYYY-MM-DD date. |
| GET | `/api/subscribers/count` | Count of active confirmed subscribers (no key required). |
| GET | `/api/logs` | API usage stats for all services across 1/7/14/21/28-day windows. |
| GET | `/sitemap.xml` | Sitemap of all issue URLs. |
| GET | `/health` | Returns `{status: "ok"}`. |

### Key-gated (require `?key=PREVIEW_KEY`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/run` | Trigger a full pipeline run and send to all subscribers. |
| GET | `/test-run?email=...` | Run full pipeline but send only to the specified email. |
| GET | `/pipeline/fetch` | Fetch articles from Tavily and save to `pipeline_runs`. Does not call Claude or send email. |
| GET | `/preview` | Render mock email using hardcoded sample stories and tickers. Returns HTML. |
| GET | `/preview/live` | Re-run Claude + Finnhub against the most recent `pipeline_runs` articles. Saves to `previews`. Returns HTML with `X-Preview-ID` and `X-Pipeline-Date` headers. |
| GET | `/preview/send?id=...&to=...` | Send a saved preview by ID to an email address. |
| GET | `/resend-to?email=...` | Resend the most recent issue to a specific confirmed subscriber. |
| GET | `/api/config` | Return full config object (topics, vendors, sources, tickers, prompt). |
| PUT | `/api/config/topics` | Replace all topics. Body: `Array<{order_pos, name, note}>`. |
| PUT | `/api/config/vendors` | Replace all vendors. Body: `Array<{order_pos, name, note}>`. |
| PUT | `/api/config/sources` | Replace all sources. Body: `Array<{order_pos, name, domain, query, days, max_results, note}>`. |
| PUT | `/api/config/tickers` | Replace all tickers. Body: `Array<{order_pos, symbol, name, group, note}>`. |
| PUT | `/api/config/prompt` | Update prompt template. Body: `{template: string}`. Upserts the single `config_prompt` row. |
| GET | `/api/pipeline/runs` | List last 20 pipeline runs with article/story counts. |
| GET | `/api/subscribers` | List all subscribers with status fields. |
| POST | `/api/subscribers/confirm` | Manually confirm a subscriber by ID. Body: `{id}`. |
| DELETE | `/api/subscribers/remove` | Hard delete a subscriber by ID. Body: `{id}`. |
| POST | `/webhooks/resend` | Resend webhook receiver. On `email.bounced` or `email.complained`, soft-deletes the subscriber. |

---

## Email Template

Two exported functions in `worker/src/email-template.ts`:

**`buildEmailHtml(stories, tickers, date, tickerGroups?, tickerNames?, sourceNames?)`**
Returns a full `<!DOCTYPE html>` email. Layout: logo + title header, date line, story list (numbered, with headline + body + source link), market snapshot table (tickers grouped by `tickerGroups`), footer with source list and unsubscribe link.

**`buildEmailText(stories, tickers, date, tickerGroups?, tickerNames?, sourceNames?)`**
Plain-text version. Same content, formatted as a readable text email with separator lines.

Both functions accept optional `tickerGroups`, `tickerNames`, and `sourceNames` parameters. When omitted, they fall back to hardcoded constants — this only applies to the mock preview. All real pipeline and live preview calls pass config-derived values.

The `{{UNSUBSCRIBE_TOKEN}}` placeholder is left in the rendered HTML/text and replaced per-subscriber at send time.

---

## Claude Prompt

Stored in `config_prompt` (single row, `id = 1`). Loaded at pipeline run time. Three placeholders:

- `{TOPICS}` — replaced with a numbered list of topic names from `config_topics` in order
- `{VENDORS}` — replaced with a comma-separated list of vendor names from `config_vendors`
- `{ARTICLES}` — replaced with all fetched articles, formatted as `[N] Title\nSource: name\nURL: url\nContent`

The prompt instructs Claude to return a JSON array of exactly 10 story objects, each with `headline`, `body`, `cite`, and `url` fields. The worker strips markdown code fences if Claude wraps the response, then extracts the JSON array with a regex before parsing.

If the D1 row is missing, the worker falls back to `DEFAULT_PROMPT`, a constant in `index.ts` identical to the seeded value.

---

## Subscribe / Confirm / Unsubscribe Flow

1. **Subscribe**: Form on `cloudflash.com/fintech` POSTs to `api.cloudflash.com/subscribe`. Worker validates email, inserts unconfirmed row (or updates token if already exists), sends confirmation email via Resend.
2. **Confirm (GET)**: Confirmation email links to `cloudflash.com/confirm?token=...`. Vercel proxies to `api.cloudflash.com/confirm?token=...`. Worker renders a confirmation page with a submit button — this prevents email security scanners from auto-confirming by pre-fetching the link.
3. **Confirm (POST)**: Button submits the form. Worker sets `confirmed = 1`, `confirmed_at = CURRENT_TIMESTAMP`. Redirects to `cloudflash.com/fintech?status=confirmed`.
4. **Unsubscribe**: Footer link in every email goes to `cloudflash.com/unsubscribe?token=...`. Vercel proxies to worker. Worker sets `confirmed = 0`, `unsubscribed_at = CURRENT_TIMESTAMP`. Redirects to `cloudflash.com/fintech?status=unsubscribed`.
5. **Re-subscribe**: User submits form again. Worker updates their token. Confirm flow repeats. If `confirmed_at > unsubscribed_at`, subscriber is treated as active.

Vercel rewrites in `app/vercel.json`:
```json
{
  "rewrites": [
    { "source": "/confirm", "destination": "https://api.cloudflash.com/confirm?:query" },
    { "source": "/unsubscribe", "destination": "https://api.cloudflash.com/unsubscribe?:query" }
  ]
}
```

---

## Admin UI

Single-page HTML at `app/fintech/admin/index.html`. No framework, no build step. Served statically by Vercel.

### Auth
Key is entered in a form in the header. On submit, the page calls `GET /api/config?key=...`. If 200, the key is stored in `localStorage` and the page unlocks. On reload, the stored key is silently re-validated. A lock button clears the key and re-locks the page.

Protected tabs (`preview`, `pipeline`, `config`, `subscribers`) show a "Enter your key to unlock" message until authenticated.

### Tabs

**Stats** (default, always visible)
- API usage cards for Tavily, Anthropic, Finnhub, Resend
- Each card shows: service name + description, call count for the selected period, failure count, plan limit
- Period selector: 1 / 7 / 14 / 21 / 28 days
- Data from `GET /api/logs`

**Preview**
- Mock preview button — calls `GET /preview`, renders instantly with hardcoded sample data
- Live preview button — calls `GET /preview/live`, re-runs Claude + Finnhub against most recent pipeline articles (~20–30 seconds, costs an Anthropic API call)
- Note shows date of the most recent pipeline run (populated from `GET /api/pipeline/runs` on unlock)
- After a live preview loads, a "Send preview to..." row appears — sends the preview via `GET /preview/send?id=...&to=...`
- Preview renders in a sandboxed iframe

**Pipeline**
- "Fetch articles" button — calls `GET /pipeline/fetch`, fetches from Tavily only, saves to `pipeline_runs`
- "Run pipeline" button — calls `GET /run`, full pipeline run including Claude, Finnhub, and send to all subscribers
- Run history table showing date, article count, story count, and timestamp for the last 20 runs
- Data from `GET /api/pipeline/runs`

**Config** (sub-tabs)
- *Story topics* — ordered list of topics. Move up/down, add, delete, save. Hint: order determines Claude's story priority.
- *Vendor watchlist* — list of vendor names. Move, add, delete, save.
- *News sources* — table with name, domain, query, days, max_results, note. Days and max_results are number inputs (min: 1). Defaults: days=7, max_results=5.
- *Tickers* — table with symbol, name, group, note. Group controls market snapshot grouping in email.
- *Prompt* — full textarea with the Claude prompt template. "Default prompt" button restores the original with a confirmation dialog. Changes mark the Save button dirty.
- *All* — read-only view of all config sections including the current prompt text. Regenerated each time the tab is visited.

All config sections use a DELETE + INSERT pattern on save (replaces entire table contents). After save, config is reloaded from the API to sync fresh IDs.

**Subscribers**
- Status filter tabs: All, Active, Pending, Unsubscribed (with live counts)
- Email search (client-side filter)
- Table with email, status badge, subscribed date, and actions
- Confirm button (on pending subscribers) — calls `POST /api/subscribers/confirm`
- Delete button — shows confirmation dialog, calls `DELETE /api/subscribers/remove`
- Status logic: `unsubscribed` if `unsubscribed_at` is set and later than `confirmed_at`; `active` if `confirmed = 1`; otherwise `pending`
- Data from `GET /api/subscribers`

### Next Run card
Always visible above the tab bar. Shows: next scheduled run date/time, Tavily source count, Finnhub ticker count, confirmed subscriber count. Populated on unlock.

---

## Privacy Policy — Reference Implementation

The following is the privacy policy written for The Daily Fintech Briefing. It covers what is actually collected (email address, confirmation timestamp, subscription status — nothing else), names the four third-party services involved, and describes the 90-day post-unsubscribe retention period that matches the `purgeExpiredSubscribers` function. Use this as the starting template for the BriefTen platform policy and as a reference for the tenant policy template.

Key design decisions reflected in the policy:
- **Minimal collection** — only what is needed to send the email. No names, no tracking, no advertising.
- **Single stated purpose** — the email address is used only to send the newsletter.
- **Named third parties** — Resend (delivery), Cloudflare (infrastructure/database), Anthropic (content generation — note that subscriber data is explicitly not involved), Vercel (website hosting + anonymous analytics).
- **90-day retention** matches the code: `DELETE FROM subscribers WHERE confirmed = 0 AND unsubscribed_at < datetime('now', '-90 days')`.
- **No cookies** — accurate, since the admin page uses `localStorage` (not cookies) for the auth key, and Vercel Analytics is cookieless.
- **Email obfuscation** — contact email links are base64-encoded and injected at runtime via JavaScript to prevent scraper harvesting. The policy page uses the same pattern as the main site.

---

### Policy text (as of April 10, 2026)

**Privacy Policy**
*Last updated April 10, 2026*

This policy covers Cloudflash, Inc. and The Daily Fintech Briefing newsletter. We keep it short because we don't do much with your data.

**What we collect**
- Your email address when you subscribe
- The date and time you confirmed your subscription
- Your subscription status (subscribed or unsubscribed)

We don't collect names, payment information, browsing behavior, or anything else.

**How we use it**
Your email address is used for one purpose: to send you The Daily Fintech Briefing each weekday morning. We don't use it for advertising, we don't sell it, and we don't share it with anyone except the services listed below that are necessary to deliver the email.

**Third-party services**
- **Resend** — handles email delivery. Your address is passed to Resend to send each issue.
- **Cloudflare** — hosts our backend infrastructure and database.
- **Anthropic** — generates newsletter content using the Claude API. Article text is sent to Anthropic to write stories; no subscriber data is involved.
- **Vercel** — hosts the website. Vercel Analytics collects anonymous page view data with no cookies.

**Unsubscribing**
Every email includes an unsubscribe link in the footer. Clicking it removes you immediately. You can also email hello@cloudflash.com and we'll remove you manually.

**Data retention**
When you unsubscribe, your record is marked inactive and retained for 90 days before being purged. This allows us to maintain an accurate picture of subscription history. After 90 days the record is deleted permanently.

**Your rights**
You can request a copy of the data we hold about you, or ask us to delete it at any time by emailing hello@cloudflash.com. We'll respond within 30 days.

**Cookies**
We don't use cookies for tracking or advertising.

**Changes**
If we make material changes to this policy we'll update the date at the top. We won't notify subscribers by email unless the changes are significant.

**Contact**
hello@cloudflash.com

---

---

# Design Reference — Cloudflash Visual Language

The following documents the design system used across the Cloudflash site, the Fintech Briefing signup page, and the email template. BriefTen's hosted subscribe pages and admin UI should stay consistent with this language.

---

## Color Palette

Defined as CSS custom properties in `:root`:

```css
:root {
  --bg:        #2179c8;   /* primary blue background */
  --border:    rgba(255,255,255,0.18);  /* subtle white border */
  --text:      #ffffff;   /* primary text */
  --muted:     rgba(255,255,255,0.62);  /* secondary/label text */
  --canvas-bg: #1a6bbf;   /* mesh animation background, slightly darker blue */
}
```

The blue gradient (`#2179c8` → `#1a6bbf`) is the core brand color. It appears as the page background and as the canvas behind the mesh animation strip.

Accent green (`#a8f0c6`) is used only for the status dot pulse — it signals "live" or "active" in a subtle way. Don't use it for general UI.

In email, the accent blue appears as `#2179c8` for story numbers. Red `#b91c1c` and green `#1a6e1a` are used exclusively for negative and positive ticker changes respectively.

---

## Typography

**Web**: Inter from Google Fonts, weights 300 / 400 / 500 / 600. Load via:
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
```

Usage conventions:
- `font-weight: 300` — large headlines (h1)
- `font-weight: 400` — body text, labels
- `font-weight: 500` — info values, nav items
- `font-weight: 600` — logo, strong emphasis within headlines, buttons
- `letter-spacing: -0.03em` — on large headlines
- `letter-spacing: 0.1em` — on uppercase eyebrow labels (paired with `text-transform: uppercase; font-size: 0.7–0.72rem`)

**Email**: Arial for headlines, UI text, and labels. Georgia (serif) for story body paragraphs. This is intentional — email clients don't reliably render web fonts, and the Arial/Georgia pairing gives the email a readable, editorial feel without custom fonts.

---

## Layout

**Page container**: `max-width: 900px`, centered with `margin: 0 auto`, horizontal padding `40px` (desktop) / `24px` (mobile ≤600px).

**Header**: `padding: 36px 0`, `border-bottom: 1px solid var(--border)`. Logo left, status indicator right.

**Hero**: `padding: 64px 0 48px` (main page) / `padding: 64px 0 20px` (fintech page).

**Info row**: Used in both the main page and fintech page below the mesh animation. `display: flex; gap: 28px`, each item has an uppercase label (`0.7rem`, `letter-spacing: 0.1em`, `--muted`) and a value (`0.95rem`, `font-weight: 500`).

**Section grid**: Two-column `grid-template-columns: 1fr 2fr` with a label column on the left and content on the right. Used for "What it is" sections.

**Feature grid**: `grid-template-columns: 1fr 1fr; gap: 20px`. Each card: `background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 6px; padding: 16px 18px`. Numbered with `0.7rem` muted label, `0.88rem` bold title, `0.78rem` muted description.

**Footer**: `display: flex; justify-content: space-between`, `padding: 28px 40px 36px`, `font-size: 0.75rem`, `color: var(--muted)`. Collapses to column with `text-align: center` on mobile.

**Responsive breakpoint**: `@media (max-width: 600px)` — reduce padding, collapse feature grid to 1 column, wrap info rows.

---

## Animation System

Four keyframes used across the site:

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes expandW {
  from { opacity: 0; transform: scaleX(0); }
  to   { opacity: 1; transform: scaleX(1); }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
```

Page sections fade up on load with staggered delays:
- Header: `0.1s`
- Hero / h1: `0.35–0.55s`
- Divider: `0.5s` (uses `expandW`, `transform-origin: left`)
- Footer: `0.8–1.0s`

The cursor blink (`.cursor-blink` rect in the SVG logo): `blink 1.8s step-end infinite`.

The status dot: `pulse 2.5s ease infinite`.

---

## Logo

Inline SVG, `32×32px` (main page) / `28×28px` (fintech page). Two elements:
1. A lightning bolt polygon: `points="6,0 0,10 4,10 1,17 10,6 5,6"` translated by `(7,8)`, `fill: rgba(255,255,255,0.95)`
2. A blinking cursor rectangle: `x=11 y=14 width=8 height=2.5 rx=1.25`, same fill, animated with `.cursor-blink`

The cursor blink is the distinctive identity element — it signals "text interface" and ties the logo to the product's nature as a written, AI-generated product.

---

## Mesh Animation

A `<canvas>` element that spans the full viewport width, absolutely positioned behind the `.lower` content in the `.mesh-zone` strip. Parameters:

```js
NODE_COUNT       = 40     // number of nodes
MAX_DIST         = 120    // px — max distance for drawing a connection line
SPEED            = 0.25   // velocity per frame
NODE_RADIUS      = 2.5    // px
LINE_OPACITY_MAX = 0.3    // max opacity of connection lines
NODE_OPACITY     = 0.50   // node fill opacity
BG_COLOR         = '#1a6bbf'
```

Nodes bounce off canvas edges. Line opacity is proportional to `1 - dist / MAX_DIST`. Canvas is resized to `window.innerWidth × meshZone.offsetHeight` on load and on resize, which reinitializes all nodes.

The animation runs via `requestAnimationFrame`. No dependencies — pure canvas 2D API.

---

## Subscribe Page Patterns

**Signup form** (`app/fintech/index.html`):
- `max-width: 440px`, `display: flex; gap: 10px`
- Email input: `background: rgba(255,255,255,0.12); border: 1px solid var(--border); border-radius: 4px; padding: 10px 14px`
- Button: `background: rgba(255,255,255,0.95); color: #1a5fa8; font-weight: 600`
- Fine print below form: `0.72rem`, `--muted` color
- Error messages: `color: #ffaaaa` / success: `color: #a8f0c6`

**Status message handling**: After form submit, the form and fine print are hidden, replaced by the success message. On reload with `?status=confirmed`, `?status=unsubscribed`, etc., the appropriate message shows immediately (redirect from the worker's confirm/unsubscribe endpoints).

**Rotating tagline**: The fintech page tagline has a rotating ending. One span fades out over `0.5s`, replaced with the next string. Cycle: `6000ms`. Pattern is reusable for any subscribe page that needs a punchy rotating sub-headline.

**Email obfuscation**: The contact email is never in the HTML source. It is base64-encoded and injected via JavaScript at runtime to prevent scraper harvesting:
```js
const e = atob('aGVsbG9AY2xvdWRmbGFzaC5jb20=');
document.getElementById('contact-link').href = 'mailto:' + e;
document.getElementById('footer-email').textContent = e;
```
Apply this pattern to any admin contact email on BriefTen pages.

---

## Email Template Design

File: `worker/src/email-template.ts`

**Overall layout**: Table-based (required for email client compatibility). Single centered `<table width="600">` with `max-width:600px; padding:40px 24px`. White background (`#fff`).

**Header**: Logo image (52×52px) left-aligned next to `<h1>` newsletter title (`font-size:36px; font-weight:bold; color:#111`). Below that, a two-column row: date left (`14px; color:#666`), "Forwarded this?" subscribe link right (`12px; color:#999`).

**Separator**: `<td style="border-bottom:3px solid #111">` — a bold black rule separates the header from stories.

**Story layout**: Each story is a two-column table row. Left column: story number (`32px; font-weight:bold; color:#2179c8; width:70px`). Right column: headline (`19px; font-weight:bold; color:#1a1a1a`) and body text in Georgia (`15px; color:#333; line-height:1.7`). Source citation is inline at the end of the body text: `Arial; 12px; color:#999` with an `↗` arrow.

**Market snapshot table**: `border-top:1px solid #eee; margin-top:32px`. Group headers: `11px; color:#999; text-transform:uppercase; letter-spacing:0.05em`. Data rows: company name left, price right, change right. Positive change: `color:#1a6e1a`, negative: `color:#b91c1c`. Footer line: `11px; color:#bbb` — "Prices as of 10:30am ET · [date] · Data via Finnhub".

**Email footer**: `border-top:1px solid #eee; padding:32px 0 0`. Two lines: sources list (`12px; color:#bbb`), then copyright + Privacy Policy + Unsubscribe links (same style). The `{{UNSUBSCRIBE_TOKEN}}` placeholder is a literal string replaced per-subscriber at send time via `.replace('{{UNSUBSCRIBE_TOKEN}}', subscriber.token)`.

**Plain-text version**: `─`.repeat(60) used as section dividers. Stories numbered `1.` through `10.`. Citations as `— Source: URL`. Market snapshot with group headers in uppercase, data as `  Company (SYM)  $price  +change (%)`. Footer: sources line, copyright line, privacy URL, unsubscribe URL.

**Accessibility**: The ticker table includes `role="region" aria-label="Market Snapshot"` and invisible `<th scope="col">` headers. Change values include `aria-label` with a spoken description (e.g. `aria-label="up 0.42 (1.23%)"`). Story source links include `aria-label="Source: [cite]"`.

**What is hardcoded** (intentionally, for email client compatibility):
- Font families: Arial and Georgia only
- Table layout: fixed 600px width
- Inline styles throughout — no `<style>` blocks (Gmail strips them)
- No web fonts
- No CSS variables
- No flexbox or grid (poor email client support)
