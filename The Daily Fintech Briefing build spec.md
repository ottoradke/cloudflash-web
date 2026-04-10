# The Daily Fintech Briefing — Build Specification

**Cloudflash, Inc. · April 2026**

`Vercel` · `Cloudflare Workers + D1` · `Resend` · `Anthropic API`

---

## 1. Overview

The Daily Fintech Briefing is a weekday AI-generated email newsletter and companion website. Each morning at 7:30am PT (10:30am ET), a backend job searches multiple fintech news sources, prioritizes stories by subject matter, fetches live market prices for 11 tracked tickers, writes 10 stories in the voice of a senior fintech analyst, and sends the result to all confirmed subscribers via Resend.

The website at `cloudflash.com/fintech` serves as the subscriber acquisition page, archive, and home for the product. It matches the existing Cloudflash brand aesthetic: dark background, editorial serif typography, minimal layout.

---

## 2. Architecture

The website is hosted on Vercel (existing setup). The backend pipeline — scheduled job, database, and API endpoints — runs on Cloudflare Workers and D1. DNS remains on Cloudflare. Both live in the same Git repository and deploy independently via separate CI pipelines.

### 2.1 Vercel (Frontend Hosting)

Hosts `cloudflash.com` including the `/fintech` landing page, issue archive, and individual issue pages. Deployed from the existing Git repository via Vercel's GitHub integration — Vercel is pointed at the `app/` directory and auto-deploys on every push to main.

### 2.2 Cloudflare Workers (Cron Trigger)

A scheduled Worker runs the daily briefing pipeline at 7:30am PT (cron: `30 14 * * 1-5` in UTC). The pipeline can also be triggered manually via `GET /run?key=PREVIEW_KEY`. Both the cron and manual trigger are protected by a duplicate send guard — if an issue already exists in D1 for today's date, the pipeline aborts immediately and logs the skip.

The Worker orchestrates the following steps in sequence:

- Fetches news from PYMNTS, Finextra, American Banker, Reuters, and Bloomberg via Tavily web search (6 queries)
- Fetches live ticker prices for 11 fintech stocks via Finnhub, batched at 25/batch to stay under the 30 req/sec rate limit
- Calls the Anthropic API (`claude-sonnet-4-6`) with the collected articles to write 10 prioritized stories
- Saves a `pipeline_runs` record with the raw articles JSON and stories JSON (enables regeneration and live preview)
- Assembles the HTML email using the briefing template
- Saves the issue to the `issues` table in Cloudflare D1
- Retrieves the confirmed subscriber list from D1
- Sends the email to all subscribers via Resend, batched at 4/batch with a 1.1s pause to stay under the 5 req/sec rate limit
- Triggers a Vercel Deploy Hook to rebuild the archive with the new issue
- Logs every API call (Tavily, Finnhub, Anthropic, Resend) to the `api_logs` table with timing, token usage, and error details

**DST note:** The cron is set to `30 14 * * 1-5` (UTC), which equals 7:30am PDT (UTC-7). On the first Sunday in November, Cloudflare cron does not automatically adjust — the cron must be manually updated to `30 15 * * 1-5` (UTC) to maintain 7:30am PST (UTC-8) delivery. Switch back in March.

### 2.3 Cloudflare D1 (Database)

SQLite database with five tables:

**issues**
- `id` (integer, primary key)
- `date` (text, YYYY-MM-DD)
- `subject` (text — email subject line)
- `html_body` (text — full rendered HTML)
- `created_at` (timestamp)

**subscribers**
- `id` (integer, primary key)
- `email` (text, unique)
- `confirmed` (integer, 0 or 1)
- `subscribed_at` (timestamp)
- `unsubscribe_token` (text, unique UUID)

**previews**
- `id` (integer, primary key)
- `date` (text, YYYY-MM-DD)
- `html` (text — full rendered HTML of the preview)
- `created_at` (timestamp)

Previews are generated from the admin page and are not considered issues. They are saved to enable sending to an email address after generation.

**pipeline_runs**
- `id` (integer, primary key)
- `date` (text, YYYY-MM-DD)
- `articles_json` (text — raw Tavily results as JSON, saved before Claude call)
- `stories_json` (text — Claude story output as JSON, saved after Claude call)
- `created_at` (timestamp)

Saved during each pipeline run and used by the admin live preview to re-run Claude against cached articles without hitting Tavily or Finnhub again.

**api_logs**
- `id` (integer, primary key)
- `service` (text — tavily, anthropic, finnhub, resend)
- `success` (integer, 0 or 1)
- `duration_ms` (integer — request duration in milliseconds)
- `tokens_used` (integer — Anthropic only: input + output tokens)
- `error_message` (text — HTTP status + response body on failure)
- `created_at` (timestamp)

One row per API call. Queried by the admin page to show per-service usage counts across rolling time windows (1d, 7d, 14d, 21d, 28d).

### 2.4 Resend

Handles all outbound email. Three types of sends:

- **Confirmation** — sent on signup, links to `cloudflash.com/confirm?token=...`
- **Broadcast** — the daily briefing, sent to all confirmed subscribers each morning
- **Ad hoc** — one-off resends via `/resend-to?email=...` and preview sends via `/preview/send`

From address: `Fintech Briefing <briefing@cloudflash.com>`. Domain verified in Resend with SPF, DKIM, and DMARC records in Cloudflare DNS.

Rate limit: 5 emails/sec. Managed with a batch size of 4 and a 1.1s pause between batches.

### 2.5 Anthropic API

`claude-sonnet-4-6` is called once per daily run with a structured prompt that includes the collected news articles and story-writing instructions. On JSON parse failure the call retries up to 3 times before throwing. The API key is stored as a Cloudflare Worker secret.

### 2.6 Finnhub Ticker API

Live prices are fetched from Finnhub using the authenticated quote endpoint, called once per ticker:

```
GET https://finnhub.io/api/v1/quote?symbol=ALKT&token=<FINNHUB_API_KEY>
```

All 11 tickers are fetched in parallel within batches of 25 (rate limit: 30 req/sec, no monthly cap). The API key is stored as a Cloudflare Worker secret. If the fetch fails, the ticker table is omitted from that day's issue. Prices reflect the moment the pipeline runs (10:30am ET) and are labeled "Prices as of 10:30am ET · Data via Finnhub" in the email.

### 2.7 Tavily Search API

News is fetched from Tavily using domain-scoped queries, one per news source (6 total). Each query returns up to 5 results. Rate limit: 1,000 credits/month on the free Researcher plan. 6 searches/run × 20 weekdays ≈ 120/month — well within the limit.

### 2.8 Repository Structure

```
cloudflash/
├── app/                        ← Vercel deploys this
│   ├── index.html              ← Main landing page
│   ├── fintech/
│   │   ├── index.html          ← /fintech landing page
│   │   ├── archive/index.html  ← Issue archive
│   │   ├── issue/index.html    ← Individual issue viewer
│   │   └── admin/index.html    ← Admin preview page
│   ├── robots.txt
│   ├── favicon.svg
│   ├── logo.png
│   ├── og-image.png
│   ├── og-fintech.png
│   └── vercel.json             ← Rewrites for /confirm and /unsubscribe
├── worker/
│   ├── wrangler.toml           ← Worker config, D1 bindings, cron schedule
│   ├── src/
│   │   ├── index.ts            ← Worker logic and all HTTP endpoints
│   │   └── email-template.ts  ← HTML email builder
│   └── schema.sql              ← D1 table definitions
└── .github/
    └── workflows/
        └── deploy-worker.yml
```

### 2.9 GitHub Actions: Worker Deployment

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]
    paths: ['worker/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### 2.10 D1 Migrations

Schema changes are applied manually via Wrangler CLI:

```
wrangler d1 execute briefing-db --remote --command "ALTER TABLE ..."
```

`schema.sql` is the source of truth and is updated with every schema change. New environments can be initialized with:

```
wrangler d1 execute briefing-db --file=worker/schema.sql
```

### 2.11 Vercel Rewrites

`app/vercel.json` proxies two subscriber-facing routes to the Worker so the `api.cloudflash.com` subdomain is never exposed in emails:

```json
{
  "rewrites": [
    { "source": "/confirm", "destination": "https://api.cloudflash.com/confirm?:query" },
    { "source": "/unsubscribe", "destination": "https://api.cloudflash.com/unsubscribe?:query" }
  ]
}
```

The `?:query` suffix is required to forward the token query parameter. `vercel.json` must live in `app/` (not the repo root) because the Vercel project root is set to `app/`.

---

## 3. Landing Page

Located at `cloudflash.com/fintech`. Matches the Cloudflash brand aesthetic: dark background (`#0a0a0a`), Georgia serif for display, Arial for UI, `#222` borders, muted palette.

### 3.1 Navigation

Cloudflash wordmark + "The Daily Fintech Briefing" on the left. "← cloudflash.com" back link on the right. Bottom border: `0.5px solid #222`.

### 3.2 Hero Section

- Eyebrow: "A product by Cloudflash"
- Headline: "Fintech news, without the noise."
- Rotating tagline (see section 3.6)
- Email signup form → POSTs to `api.cloudflash.com/subscribe`
- Two cards to the right of the form: Latest Issue (links to archive) and Subscriber Count (blurred, "In Beta · Not Counting Yet" label)

### 3.3 What It Is Section

Two-column grid. Left: section label. Right: 2×2 feature grid:
- 01 — AI-prioritized stories
- 02 — Vendor watchlist
- 03 — Market open prices
- 04 — Analyst voice

### 3.4 Meta Strip

Four stats: Cadence (Every weekday), Delivery (7:30am PT), Stories (10 per issue), Price (Free).

### 3.5 Issue Archive Link

Links to `cloudflash.com/fintech/archive`.

### 3.6 Rotating Taglines

The hero subhead cycles through the following lines (randomized):
- "written by AI, edited by nobody — which is either a feature or a disclaimer depending on your risk tolerance."
- "written by AI, edited by nobody — verify before forwarding to your board."

> **TODO:** Add more tagline variations over time. The rotating copy is a brand voice opportunity — dry, self-aware, and fintech-specific.

### 3.7 Footer

© 2026 Cloudflash, Inc. on the left. `cloudflash.com` on the right. Top border: `0.5px solid #1a1a1a`.

---

## 4. Subscriber Flow

### 4.1 Signup

- User enters email on landing page and clicks Subscribe
- Worker validates email format
- Checks for duplicate; if already confirmed, returns 409
- Inserts unconfirmed record with a unique UUID `unsubscribe_token`
- Sends a confirmation email via Resend

### 4.2 Confirmation

Two-step to prevent security scanners from auto-confirming:

- Confirmation email links to `cloudflash.com/confirm?token=...`
- Vercel proxies to `api.cloudflash.com/confirm?token=...`
- **GET** — Worker renders a confirmation page with a button
- **POST** — Worker sets `confirmed = 1`, redirects to `cloudflash.com/fintech?status=confirmed`

### 4.3 Unsubscribe

- Footer link in every email: `cloudflash.com/unsubscribe?token=...`
- Vercel proxies to `api.cloudflash.com/unsubscribe?token=...`
- Worker deletes the subscriber record, redirects to `cloudflash.com/fintech?status=unsubscribed`

---

## 5. Email Template

Fully inline styles for Gmail and Outlook compatibility. Georgia serif for editorial content, Arial for UI. Max-width 600px, white background.

### 5.1 Structure

- **Header:** Cloudflash logo + "The Daily Fintech Briefing" + full date + subscribe nudge
- **10 numbered stories:** headline + 3–5 sentence paragraph + inline source citation with ↗ link
- **Ticker snapshot table:** 11 stocks across 4 groups
- **Footer:** "Prices as of 10:30am ET · [DATE] · Data via Finnhub" · sources · unsubscribe link

### 5.2 Ticker Groups

**Digital Banking:** Alkami Technology (ALKT), NCR Voyix (VYX), Q2 Holdings (QTWO)

**Core Banking:** FIS (FIS), Fiserv (FI), Jack Henry (JKHY)

**Payments & Rails:** ACI Worldwide (ACIW), Green Dot (GDOT), Marqeta (MQ)

**AI & Lending:** nCino (NCNO), Upstart (UPST)

> Candidates for future ticker groups: Fraud & Compliance (EFX, NDAQ), Wealth & Capital Markets (BR, ENV, SEIC, TEMN).

### 5.3 Price Formatting

- Positive change: `#1a6e1a` (dark green)
- Negative change: `#b91c1c` (dark red)
- Footer note: "Prices as of 10:30am ET · [DATE] · Data via Finnhub"

---

## 6. Story Pipeline

### 6.1 Sources

- PYMNTS.com
- Finextra.com
- American Banker
- Reuters (fintech/banking query)
- Bloomberg (fintech banking technology query)
- Bloomberg Money Stuff by Matt Levine

### 6.2 Priority Order

1. AI in banking and financial services
2. Bank technology and digital banking
3. M&A for banks and credit unions
4. Credit union consolidation
5. Core banking modernization
6. Bank middleware and infrastructure
7. Payments modernization (ISO 20022, FedNow, real-time rails)
8. Fraud technology in fintech
9. Core banking vendors (FIS, Fiserv, Jack Henry, Temenos, nCino, etc.)
10. Banking regulation
11. Embedded finance
12. Banking-as-a-Service (BaaS) and regulatory developments
13. Vendor risk and third-party oversight

### 6.3 Vendor Watchlist

Stories involving any of the following vendors are bumped ahead of generic stories on the same topic.

**Digital Banking / Front-End:** Q2, Alkami, Apiture, Backbase, Bottomline Technologies, ebankIT, Finalytics.ai, Lumen Digital, Moxian, NCR Voyix, Personetics, Tyfone

**Core Banking:** FIS, Fiserv, Jack Henry & Associates, Temenos, Thought Machine, Mambu, Finacle (Infosys), Oracle FLEXCUBE, SAP Banking, Nymbus, Corelation, CSI, Silverlake Systems

**Middleware / BaaS:** Unit, Treasury Prime, Synctera, Bond, Marqeta, Galileo, Solid, Column, Green Dot, Cross River Bank, PortX, Trabian, Core10, MuleSoft

**Payments & Rails:** ACI Worldwide, Volante Technologies, Form3, Icon Solutions, Temenos Payments, Finastra, BPC Banking Technologies

**AI & Analytics:** Zest AI, Upstart, Scienaptic, Canoe Intelligence, DataRobot, Gro Intelligence, Featurespace, Pindrop

**Fraud Technology:** Alloy, Unit21, Sardine, Hawk AI, ComplyAdvantage, Hummingbird, Themis, Featurespace, BioCatch, Simility (FIS), Feedzai, ThreatMetrix (LexisNexis), Kount (Equifax), Socure, Sift, Forter, Onfido, Jumio, Fraud.net, Quantexa, Verafin (Nasdaq)

**Lending & Credit:** nCino, Blend, Numerated, Teslar Software, Baker Hill

**Wealth / Investment:** Envestnet, Orion, SEI, FNZ, Broadridge

### 6.4 Writing Style

Stories are written in the voice of a senior fintech analyst writing to a trusted colleague. Conversational and personal in voice — with a point of view, not just a summary. Each story includes thoughtful analysis of what the news means for banks, vendors, or the industry, and where relevant a strategic observation about what it signals or what comes next. Dry wit is welcome but secondary to genuine insight.

Headline: punchy, no clickbait, no "This Is Why" constructions.
Body: 3–5 sentences with key facts, honest read on what it means, and a strategic observation where warranted.

### 6.5 JSON Parse Retry

If Claude returns malformed JSON, the pipeline retries the Anthropic call up to 3 times before throwing. This handles transient formatting failures without manual intervention.

---

## 7. Issue Archive

Each daily issue is saved to D1 and rendered as a public webpage. Archive pages are client-side rendered — JavaScript fetches from the Worker API and builds the page dynamically.

- `cloudflash.com/fintech/archive` — lists all issues by date, links to individual pages
- `cloudflash.com/fintech/issue?date=YYYY-MM-DD` — renders the full issue HTML in a sandboxed iframe

A Vercel Deploy Hook is triggered after each daily run to rebuild the static site with updated content.

---

## 8. Admin Page

Located at `cloudflash.com/fintech/admin`. Internal tool — requires a preview key stored in `localStorage`.

### 8.1 Preview Key

The key is set via `wrangler secret put PREVIEW_KEY`. Entered once in the admin UI and persisted in `localStorage` across sessions.

### 8.2 Buttons

- **Mock preview** — instantly renders a mock email using hardcoded stories and tickers. No API calls.
- **Fetch articles** — calls `/pipeline/fetch`, runs Tavily and saves a new `pipeline_runs` record. Takes 15–20 seconds. Use this to get fresh articles before a live preview.
- **Live preview** — calls `/preview/live`, re-runs Claude against the latest saved articles, fetches fresh tickers via Finnhub, saves the result to the `previews` table, and renders the email in an iframe. Takes 20–30 seconds. Costs 1 Anthropic call + 11 Finnhub calls per click.

After a live preview loads, a **Send preview to…** input and Send button appear. Entering an email and clicking Send calls `/preview/send`, which delivers the saved preview via Resend.

All buttons are visually disabled (40% opacity) while a request is in flight.

### 8.3 API Usage Cards

Four cards showing per-service call counts across selectable time windows: 1 day, 7 days, 14 days, 21 days, 28 days. Each window is cumulative (not a single day's count).

| Service | Monthly limit | Rate limit |
|---------|--------------|------------|
| Tavily | 1,000 / month | — |
| Anthropic | Pay-as-you-go · No cap | — |
| Finnhub | No monthly cap | 30 req/sec |
| Resend | 50,000 / month | 5 req/sec |

Failures shown in red. Counts sourced from the `api_logs` D1 table.

---

## 9. Worker HTTP Endpoints

All endpoints are on `api.cloudflash.com` (Cloudflare Worker).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/subscribe` | — | Subscribe an email address |
| GET | `/confirm?token=` | — | Show confirmation page |
| POST | `/confirm?token=` | — | Confirm subscription |
| GET | `/unsubscribe?token=` | — | Delete subscriber, redirect |
| GET | `/resend-to?email=` | — | Resend latest issue to a subscriber |
| GET | `/run?key=` | PREVIEW_KEY | Trigger a full pipeline run |
| GET | `/test-run?email=&key=` | PREVIEW_KEY | Run pipeline, send only to one email |
| GET | `/test-tickers` | — | Fetch and return live ticker data |
| GET | `/preview?key=` | PREVIEW_KEY | Return mock email HTML |
| GET | `/preview/live?key=` | PREVIEW_KEY | Re-run Claude on cached articles, save to previews |
| GET | `/preview/send?key=&id=&to=` | PREVIEW_KEY | Send a saved preview to an email address |
| GET | `/pipeline/fetch?key=` | PREVIEW_KEY | Fetch fresh articles from Tavily, save to pipeline_runs |
| GET | `/api/issues` | — | List all issues (id, date, subject) |
| GET | `/api/issues/:date` | — | Get a single issue by date |
| GET | `/api/subscribers/count` | — | Return confirmed subscriber count |
| GET | `/api/logs` | — | Return per-service API usage counts by time window |
| GET | `/health` | — | Health check |
| GET | `/robots.txt` | — | Disallow all crawlers |

---

## 10. Secrets & Environment Variables

All secrets stored as Cloudflare Worker secrets (`wrangler secret put`). Never committed to version control.

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `RESEND_API_KEY` | Resend API key |
| `VERCEL_DEPLOY_HOOK` | Vercel Deploy Hook URL to trigger archive rebuilds |
| `FINNHUB_API_KEY` | Finnhub API key for live ticker prices |
| `TAVILY_API_KEY` | Tavily API key for news search |
| `PREVIEW_KEY` | Shared secret for the admin preview page and pipeline fetch |
| `ALERT_EMAIL` | Email address for pipeline failure alerts (ottoradke@gmail.com) |
| `CLOUDFLARE_API_TOKEN` | Stored in GitHub repository secrets for CI deployment |

## 10.1 Third-Party Services & Plans

| Service | What it does | Plan | Limit |
|---------|-------------|------|-------|
| **Anthropic** | Generates 10 stories per issue using Claude Sonnet 4.6 | Pay-as-you-go | ~$3/M input tokens, ~$15/M output tokens. Each run costs pennies. No monthly cap. |
| **Tavily** | Web search for fintech news across 6 sources | Free (Researcher) | 1,000 credits/month. Each search = 1 credit. 6 searches/run × 20 weekdays = ~120/month. |
| **Finnhub** | Live stock prices for 11 fintech tickers at market open | Free | No monthly cap. 30 req/sec rate limit. Batched at 25/batch in the pipeline. |
| **Resend** | Sends daily briefing, confirmation, ad hoc, and preview emails | Pro ($20/month) | 50,000 emails/month. 5 emails/sec rate limit. Batched at 4/batch with 1.1s pause. |
| **Cloudflare Workers** | Runs the pipeline, subscriber API, and all endpoints | Free (Workers) | 100,000 requests/day, 10ms CPU/request. Cron trigger not counted toward request limit. |
| **Cloudflare D1** | Stores issues, subscribers, pipeline runs, previews, and API logs | Free | 5M reads/day, 100K writes/day. |
| **Vercel** | Hosts cloudflash.com including the /fintech landing page and archive | Pro | Unlimited bandwidth on Pro plan. |

---

## 11. Error Alerting

If the scheduled pipeline throws an unhandled error, `sendAlert()` sends an email to `ALERT_EMAIL` (ottoradke@gmail.com) via Resend with the error message and stack trace. The error is re-thrown after alerting so it appears in Cloudflare Worker logs.

---

## 12. Open Items & Future Considerations

### 12.1 Near-term

- Add more rotating taglines to the landing page hero (see section 3.6)
- Add ticker groups: Fraud & Compliance (EFX, NDAQ) and Wealth & Capital Markets (BR, ENV, SEIC, TEMN)
- Add physical mailing address to HTML and plaintext email footers (CAN-SPAM compliance) — use a PO Box, virtual mailbox, or registered agent address; do not use a personal address

### 12.2 Later

- Manual story editing / override before the daily send
- Analytics: open rate, click rate per story (available via Resend dashboard)
- Potential paid tier with deeper analysis or custom vendor watchlists
- Anthropic credit balance monitoring (console.anthropic.com API requires browser session auth — not accessible from the Worker)

---

## Appendix: Related Files

- `worker/src/index.ts` — Worker logic, all pipeline steps and HTTP endpoints
- `worker/src/email-template.ts` — HTML email builder, ticker table, story layout
- `worker/schema.sql` — D1 table definitions (source of truth)
- `app/fintech/admin/index.html` — Admin preview page
- `app/vercel.json` — Vercel rewrites for /confirm and /unsubscribe
