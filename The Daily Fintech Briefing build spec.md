# The Daily Fintech Briefing — Build Specification

**Cloudflash, Inc. · April 2026**

`Vercel` · `Cloudflare Workers + D1` · `Resend` · `Anthropic API`

---

## 1. Overview

The Daily Fintech Briefing is a weekday AI-generated email newsletter and companion website. Each morning at 7:30am PT (10:30am ET), a backend job searches multiple fintech news sources, prioritizes stories by subject matter, fetches live market open prices for 11 tracked tickers, writes 10 stories in the style of NextDraft by Dave Pell, and sends the result to all confirmed subscribers via Resend.

The website at `cloudflash.com/fintech` serves as the subscriber acquisition page, archive, and home for the product. It matches the existing Cloudflash brand aesthetic: dark background, editorial serif typography, minimal layout.

---

## 2. Architecture

The website is hosted on Vercel (existing setup). The backend pipeline — scheduled job, database, and API endpoints — runs on Cloudflare Workers and D1. DNS remains on Cloudflare. Both live in the same Git repository and deploy independently via separate CI pipelines. This split leverages Vercel's strengths for frontend delivery while keeping compute and data on Cloudflare.

### 2.1 Vercel (Frontend Hosting)

Hosts `cloudflash.com` including the `/fintech` landing page, issue archive, and individual issue pages. Deployed from the existing Git repository via Vercel's GitHub integration — Vercel is pointed at the `app/` directory and auto-deploys on every push to main. No changes to the existing Vercel project setup are required beyond adding the new `/fintech` route and pages.

### 2.2 Cloudflare Workers (Cron Trigger)

A scheduled Worker runs the daily briefing pipeline at 7:30am PT (cron: `30 7 * * *`). The Worker orchestrates the following steps in sequence:

- Fetches news from PYMNTS, Finextra, American Banker, Reuters, and Bloomberg via web search
- Fetches ticker prices via a single Yahoo Finance batch API call
- Calls the Anthropic API (`claude-sonnet-4-6`) with the collected content to write 10 prioritized stories
- Assembles the HTML email using the briefing template
- Saves the issue to Cloudflare D1
- Retrieves the confirmed subscriber list from D1
- Sends the email to all subscribers via the Resend API
- Triggers a Vercel Deploy Hook to rebuild the archive with the new issue

### 2.3 Cloudflare D1 (Database)

SQLite database with two primary tables:

**issues**
- `id` (integer, primary key)
- `date` (text, YYYY-MM-DD)
- `subject` (text — email subject line)
- `html_body` (text — full rendered HTML)
- `created_at` (timestamp)

**subscribers**
- `id` (integer, primary key)
- `email` (text, unique)
- `confirmed` (boolean, default false)
- `subscribed_at` (timestamp)
- `unsubscribe_token` (text, unique UUID)

### 2.4 Resend

Handles all outbound email. Two types of sends:

- **Transactional** — confirmation emails on signup, sent immediately via the Resend API
- **Broadcast** — the daily briefing, sent to all confirmed subscribers each morning

From address: `Fintech Briefing <otto@cloudflash.com>`. Domain `cloudflash.com` must have SPF, DKIM, and DMARC DNS records added in Cloudflare DNS and verified in the Resend dashboard before the first send.

### 2.5 Anthropic API

Claude Sonnet 4 (`claude-sonnet-4-6`) is called once per daily run with a structured prompt that includes the collected news content and the full story-writing instructions from `SKILL.md`. The API key is stored as a Cloudflare Worker secret.

### 2.6 Yahoo Finance Batch Endpoint

A single unauthenticated GET request retrieves live prices for all 11 tickers simultaneously:

```
GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=ALKT,VYX,QTWO,FIS,FI,JKHY,ACIW,GDOT,MQ,NCNO,UPST
```

Called at 7:30am PT (10:30am ET), one hour after market open, when prices have settled from the opening print. If the request fails, the ticker table is omitted from that day's issue with a "Market data unavailable" note.

### 2.7 Repository Structure

One Git repository hosts both the Vercel frontend and the Cloudflare Worker. Each platform deploys from its own subdirectory and ignores the other:

```
cloudflash/
├── app/                ← Vercel deploys this (Next.js or static site)
├── worker/             ← Cloudflare deploys this
│   ├── wrangler.toml   ← Worker config, D1 bindings, cron schedule
│   ├── src/index.ts    ← Worker logic
│   └── schema.sql      ← D1 migrations
└── .github/
    └── workflows/
        └── deploy-worker.yml
```

Vercel auto-deploys via its own GitHub App integration — no workflow file needed on your side. It watches the `app/` directory. Cloudflare deploys via a GitHub Actions workflow that runs `wrangler deploy` whenever files in `worker/` change. They trigger independently and never step on each other.

### 2.8 GitHub Actions: Worker Deployment

A workflow file at `.github/workflows/deploy-worker.yml` handles Cloudflare Worker deployments automatically on push to main. It only fires when Worker code changes:

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

The `CLOUDFLARE_API_TOKEN` is stored as a GitHub repository secret (Settings > Secrets). Vercel-only commits don't trigger this workflow, and Worker commits don't trigger a Vercel deploy — each platform only reacts to changes in its own directory.

### 2.9 D1 Migrations

D1 schema changes are applied manually via the Wrangler CLI rather than automatically on push, to prevent unintended schema changes in production:

```
wrangler d1 execute briefing-db --file=worker/schema.sql
```

Any schema change is committed to the repo, reviewed, and then applied manually. This is the standard approach for production D1 databases where accidental migrations would be destructive.

---

## 3. Landing Page

Located at `cloudflash.com/fintech`. The primary design directive is to match the look and feel of the existing Cloudflash landing page (`cloudflash.com`) exactly — the `/fintech` page should feel like a natural extension of the main site, not a standalone product.

> **Note:** The existing Cloudflash site uses: near-black background (`#0a0a0a`), Georgia serif for display headings, Arial for UI/body text, 0.5px borders in `#222`, muted palette with `#666` and `#999` for secondary text, and a tight editorial grid. All of these carry through to `/fintech` without modification.

### 3.1 Navigation

Match the existing Cloudflash nav pattern exactly. Additions specific to this page:

- Cloudflash wordmark + product name "The Daily Fintech Briefing" on the left
- "← cloudflash.com" back link on the right, styled as the existing nav link
- Bottom border: `0.5px solid #222` (matches existing site)

### 3.2 Hero Section

Primary layout, consistent with the existing Cloudflash holding page structure:

- Eyebrow: "A product by Cloudflash" — Arial, 11px, `#555`, uppercase, matching existing site label style
- Headline: "Fintech news, without the noise." — matching existing site heading size and weight; accent word in `#6B7FA8`
- Subhead: one rotating tagline (see section 3.6 below)
- Email signup form: text input + "Subscribe →" button, styled to match existing site form elements
- Fine print: "Free · No spam · Unsubscribe anytime" in `#555`

### 3.3 What It Is Section

Two-column grid matching the existing site's Status/Expected/Platforms layout pattern. Left column: section label. Right column: description + 2×2 feature grid. Each feature item has a number, title, and one-line description:

- 01 — AI-prioritized stories
- 02 — Vendor watchlist
- 03 — Market open prices
- 04 — NextDraft tone

### 3.4 Sample Issue Section

A live preview of a real issue rendered inline on the page — showing 3 sample stories and a snippet of the ticker table. Updates to the most recent issue once publishing begins; static placeholder until then. The sample card uses the existing site's border and background treatment (`#0d0d0d` card on `#0a0a0a` background).

### 3.5 Meta Strip

A horizontal row of four stats mirroring the existing site's Status/Platforms metadata row: Cadence (Every weekday), Delivery (7:30am PT), Stories (10 per issue), Price (Free).

### 3.6 Rotating Taglines

The hero subhead cycles through the following lines on page load (randomized or sequential). New taglines can be added to this list over time:

- "written by AI, edited by nobody — which is either a feature or a disclaimer depending on your risk tolerance."
- "written by AI, edited by nobody — verify before forwarding to your board."

> **TODO:** Add more tagline variations over time. The rotating copy is a brand voice opportunity — dry, self-aware, and fintech-specific. Consider adding one new line per month.

### 3.7 Alternative Design

An alternative layout was explored during initial design that gives the `/fintech` page a more independent, newsletter-focused identity. It can be used if the team decides the page warrants a stronger standalone presence. Key differences from the primary design:

- Larger, more prominent navigation bar with explicit product branding
- Hero headline at 52px (larger than main site)
- Explicit full-bleed section dividers between content blocks
- More expansive feature grid with longer descriptions per item

### 3.8 Footer

- © 2026 Cloudflash, Inc. on the left — matching existing site footer exactly
- `cloudflash.com` on the right
- Top border: `0.5px solid #1a1a1a` (matches existing site)

---

## 4. Subscriber Flow

### 4.1 Signup

- User enters email on landing page and clicks Subscribe
- Worker validates email format
- Checks for duplicate in subscribers table
- Inserts unconfirmed record with a unique UUID `unsubscribe_token`
- Sends a confirmation email via Resend with a confirm link

### 4.2 Confirmation

- Confirm link hits a Cloudflare Worker endpoint: `GET https://api.cloudflash.com/confirm?token=UUID`
- Worker looks up the token, sets `confirmed = true`
- Redirects to a "You're subscribed" confirmation page

### 4.3 Unsubscribe

- Every briefing email includes an unsubscribe link in the footer
- Link hits a Cloudflare Worker endpoint: `GET https://api.cloudflash.com/unsubscribe?token=UUID`
- Worker deletes or soft-deletes the subscriber record
- Redirects to a "You've been unsubscribed" page

---

## 5. Email Template

The HTML email uses fully inline styles for maximum Gmail and Outlook compatibility. Georgia serif for editorial content, Arial for UI elements. Max-width 600px, white background.

### 5.1 Structure

- **Header:** Small uppercase "The Daily Fintech Briefing" label + full date. No large masthead — understated, straight into the stories.
- **10 numbered stories:** each with a headline, 3–5 sentence paragraph, and inline source citation using the ↗ arrow
- **Ticker snapshot table:** 11 stocks across 4 groups (Digital Banking, Core Banking, Payments & Rails, AI & Lending), alphabetized within each group
- **Footer:** source credits + NextDraft attribution + unsubscribe link

### 5.2 Ticker Groups

**Digital Banking**
- Alkami Technology (ALKT)
- NCR Voyix (VYX)
- Q2 Holdings (QTWO)

**Core Banking**
- FIS (FIS)
- Fiserv (FI)
- Jack Henry (JKHY)

**Payments & Rails**
- ACI Worldwide (ACIW)
- Green Dot (GDOT)
- Marqeta (MQ)

**AI & Lending**
- nCino (NCNO)
- Upstart (UPST)

> Not shown (candidates for future sections): Fraud & Compliance (EFX, NDAQ), Wealth & Capital Markets (BR, ENV, SEIC, TEMN).

### 5.3 Price Formatting

- Positive change: `#1a6e1a` (dark green)
- Negative change: `#b91c1c` (dark red)
- Price labeled: "Prices at market open · 10:30am ET · [DATE] · Data via Yahoo Finance"

---

## 6. Story Pipeline

### 6.1 Sources

- PYMNTS.com
- Finextra.com
- American Banker
- Reuters (fintech/banking)
- Bloomberg (technology/banking/fintech)
- Bloomberg Money Stuff by Matt Levine

### 6.2 Priority Order

Stories are selected and ranked in this order, with higher-priority topics filling slots first:

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

Stories involving any of the following vendors are bumped ahead of generic stories on the same topic. Full list maintained in `SKILL.md`.

**Digital Banking / Front-End:** Q2, Alkami, Apiture, Backbase, Bottomline Technologies, ebankIT, Finalytics.ai, Lumen Digital, Moxian, NCR Voyix, Personetics, Tyfone

**Core Banking:** FIS, Fiserv, Jack Henry & Associates, Temenos, Thought Machine, Mambu, Finacle (Infosys), Oracle FLEXCUBE, SAP Banking, Nymbus, Corelation, CSI, Silverlake Systems

**Middleware / BaaS:** Unit, Treasury Prime, Synctera, Bond, Marqeta, Galileo, Solid, Column, Green Dot, Cross River Bank, PortX, Trabian, Core10, MuleSoft

**Payments & Rails:** ACI Worldwide, Volante Technologies, Form3, Icon Solutions, Temenos Payments, Finastra, BPC Banking Technologies

**AI & Analytics:** Zest AI, Upstart, Scienaptic, Canoe Intelligence, DataRobot, Gro Intelligence, Featurespace, Pindrop

**Fraud Technology:** Alloy, Unit21, Sardine, Hawk AI, ComplyAdvantage, Hummingbird, Themis, Featurespace, BioCatch, Simility (FIS), Feedzai, ThreatMetrix (LexisNexis), Kount (Equifax), Socure, Sift, Forter, Onfido, Jumio, Fraud.net, Quantexa, Verafin (Nasdaq)

**Lending & Credit:** nCino, Blend, Numerated, Teslar Software, Baker Hill

**Wealth / Investment:** Envestnet, Orion, SEI, FNZ, Broadridge

### 6.4 Writing Style

Dry, witty, editorial — like a smart colleague summarizing the news. Inspired by the format of NextDraft by Dave Pell. Each story: punchy headline + 3–5 sentence paragraph + inline source citation.

---

## 7. Issue Archive

Each daily issue is saved to Cloudflare D1 and rendered as a public webpage at `cloudflash.com/fintech/[YYYY-MM-DD]`. The archive index page at `cloudflash.com/fintech/archive` lists all past issues with date and subject line. Archive pages are statically generated by Vercel after each issue is saved. A Cloudflare Worker triggers a Vercel Deploy Hook after each daily run to rebuild the archive with the new issue.

---

## 8. Secrets & Environment Variables

All secrets are stored as Cloudflare Worker secrets (`wrangler secret put`). Never committed to version control.

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `RESEND_API_KEY` | Resend API key — rotate before use (see note below) |
| `VERCEL_DEPLOY_HOOK` | Vercel Deploy Hook URL to trigger archive rebuilds |
| `CLOUDFLARE_API_TOKEN` | Stored in GitHub repository secrets for CI deployment |

> **⚠️ Important:** The Resend API key was accidentally shared in a chat session on April 7, 2026. It must be rotated before use. Generate a new key in the Resend dashboard and use that one.

---

## 9. Open Items & Future Considerations

### 9.1 Immediate

- Rotate Resend API key (see note in section 8)
- Add Vercel Deploy Hook URL as a Cloudflare Worker secret to trigger archive rebuilds
- Verify `cloudflash.com` domain in Resend (SPF, DKIM, DMARC)
- Confirm Yahoo Finance batch endpoint still active (unofficial — monitor for breakage)

### 9.2 Near-term

- Add ticker groups: Fraud & Compliance (EFX, NDAQ) and Wealth & Capital Markets (BR, ENV, SEIC, TEMN)
- Add more rotating taglines to the landing page hero (see section 3.6)
- Implement issue archive and per-issue web pages
- Add subscriber count display on landing page once audience grows

### 9.3 Later

- Web-based admin view to preview each day's briefing before it sends
- Manual override / story editing before send
- Analytics: open rate, click rate per story (Resend provides this)
- Potential paid tier with deeper analysis or custom vendor watchlists

---

## 10. Suggested Development Order

The following sequence minimizes blocked work and ensures each phase is testable before building on top of it. Each phase has a clear deliverable you can verify before moving on.

### Phase 1 — Foundation *(do this first)*

Set up the infrastructure scaffolding before writing any feature code. Nothing else can proceed without this.

- Create the monorepo structure: `app/` and `worker/` directories in the existing cloudflash repo
- Install Wrangler CLI and authenticate with your Cloudflare account
- Create the Cloudflare D1 database: `wrangler d1 create briefing-db`
- Write and apply the initial `schema.sql` (issues and subscribers tables)
- Create a minimal `wrangler.toml` that binds to the D1 database
- Add `CLOUDFLARE_API_TOKEN` to GitHub repository secrets
- Add the `deploy-worker.yml` GitHub Actions workflow
- Deploy a hello-world Worker to verify the pipeline end to end

> **Deliverable:** a Worker that deploys on push and can read/write to D1. Nothing user-facing yet.

### Phase 2 — Email Pipeline *(the core product)*

Build the Worker that generates and sends the briefing. This is the most important piece — get it working before touching the website.

- Port the `SKILL.md` pipeline logic into the Worker: web search, ticker fetch, Anthropic API call, HTML assembly
- Store `ANTHROPIC_API_KEY` and `RESEND_API_KEY` as Cloudflare Worker secrets via `wrangler secret put`
- Test the Anthropic API call in isolation — verify story generation works
- Test the Yahoo Finance batch fetch — verify ticker data parses correctly
- Assemble the full HTML email and send a test to yourself via Resend
- Save the generated issue to D1
- Set the cron trigger in `wrangler.toml`: `30 7 * * *`
- Verify the cron fires correctly using `wrangler tail` to watch live logs

> **Deliverable:** a Worker that runs on schedule, generates a real briefing, and sends it to one email address. Subscriber management not yet needed.

### Phase 3 — Subscriber Management

Add the API endpoints that handle signups, confirmations, and unsubscribes. These are Worker routes, not Vercel routes.

- `POST /subscribe` — validate email, insert unconfirmed record, send confirmation email via Resend
- `GET /confirm?token=UUID` — set `confirmed = true`, redirect to confirmation page
- `GET /unsubscribe?token=UUID` — delete subscriber record, redirect to unsubscribe page
- Update the daily send to pull confirmed subscribers from D1 and send to all of them
- Add the unsubscribe link to the email footer using each subscriber's unique token
- Verify `cloudflash.com` domain in Resend — add SPF, DKIM, DMARC records in Cloudflare DNS
- Rotate the Resend API key (the original was exposed — generate a new one before this phase)

> **Deliverable:** anyone can subscribe, confirm, and unsubscribe. The daily send reaches all confirmed subscribers.

### Phase 4 — Landing Page

Build the `/fintech` page in the Vercel app. By this point the Worker is already running daily, so you can use a real issue as the sample.

- Add the `/fintech` route to the existing Vercel app
- Build the landing page matching the existing Cloudflash site aesthetic (see section 3)
- Wire up the email signup form to POST to the Worker's `/subscribe` endpoint
- Add the rotating taglines to the hero subhead
- Add the meta strip (cadence, delivery, stories, price)
- Drop in a real issue as the sample — pull the latest from D1 or hardcode the first real one
- Test the full signup flow end to end from the landing page

> **Deliverable:** a live page at `cloudflash.com/fintech` where people can subscribe.

### Phase 5 — Issue Archive

Add the archive so past issues are publicly accessible and discoverable.

- Add the `/fintech/archive` index page listing all past issues by date
- Add individual issue pages at `/fintech/[YYYY-MM-DD]`
- Add `VERCEL_DEPLOY_HOOK` as a Worker secret and trigger it after each daily save to D1
- Verify archive rebuilds correctly after a new issue is saved

> **Deliverable:** every past issue is accessible at a permanent URL. The archive grows automatically each weekday.

### Phase 6 — Polish & Monitoring

Once everything is running, harden it.

- Add error alerting — email or Slack notification if the daily Worker run fails
- Monitor Yahoo Finance endpoint reliability — add a fallback or alert if it stops responding
- Review Resend delivery analytics after the first week — check open rates and bounces
- Add subscriber count to the landing page once you have a meaningful number
- Consider a simple admin page to preview the next day's briefing before it sends

---

## Appendix: Related Files

- `SKILL.md` — Cowork scheduled task definition (source of truth for story pipeline logic)
- `daily-fintech-briefing.md` — Exported copy of the task file with all updates applied
