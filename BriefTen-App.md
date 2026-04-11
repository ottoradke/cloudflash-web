# BriefTen — Multi-Tenant Newsletter Platform

A platform that lets anyone set up and run their own AI-generated email newsletter, modeled on The Daily Fintech Briefing. Users bring their own API keys; the platform provides the infrastructure, admin UI, and pipeline.

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

---

# Reference Implementation — The Daily Fintech Briefing

The following documents exactly what was built for the single-tenant Fintech Briefing. Use this as the implementation spec for each tenant's feature set.

---

## Infrastructure

- **Runtime**: Cloudflare Worker (TypeScript), deployed via Wrangler
- **Database**: Cloudflare D1 (SQLite), single database named `briefing-db`
- **Static assets**: Served via a separate `cloudflash-web` Cloudflare Worker with the `app/` directory as its asset root
- **Email delivery**: Resend API
- **Cron**: Cloudflare Worker scheduled trigger — `30 14 * * 2-6` (7:30am PDT, Monday–Friday)
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
6. **Generate stories** — send all articles + topics + vendors + prompt template to Claude (`claude-sonnet-4-6`, `max_tokens: 4096`). Claude returns a JSON array of 10 story objects. Parse and retry up to 3 times on JSON parse failure.
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
