import { buildEmailHtml, Story, TickerData } from "./email-template";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  TAVILY_API_KEY: string;
  FINNHUB_API_KEY: string;
  VERCEL_DEPLOY_HOOK: string;
  ALERT_EMAIL: string;
  PREVIEW_KEY: string;
}

const TICKERS = ["ALKT", "VYX", "QTWO", "FIS", "FI", "JKHY", "ACIW", "GDOT", "MQ", "NCNO", "UPST"];

const TICKER_GROUPS: Record<string, string[]> = {
  "Digital Banking": ["ALKT", "VYX", "QTWO"],
  "Core Banking": ["FIS", "FI", "JKHY"],
  "Payments & Rails": ["ACIW", "GDOT", "MQ"],
  "AI & Lending": ["NCNO", "UPST"],
};

const NEWS_SOURCES = [
  { name: "PYMNTS", domain: "pymnts.com" },
  { name: "Finextra", domain: "finextra.com" },
  { name: "American Banker", domain: "americanbanker.com" },
  { name: "Reuters", domain: "reuters.com", query: "fintech banking" },
  { name: "Bloomberg", domain: "bloomberg.com", query: "fintech banking technology" },
  { name: "Bloomberg Money Stuff", domain: "bloomberg.com", query: "Matt Levine Money Stuff" },
];

const STORY_PROMPT = `You are writing The Daily Fintech Briefing — a weekday AI-generated email newsletter in the style of NextDraft by Dave Pell. Dry, witty, and editorial. Like a smart colleague summarizing the news.

Below is a collection of fintech news articles gathered this morning. Select and write exactly 10 stories, prioritized in this order:
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

Stories involving these vendors should be bumped ahead of generic stories on the same topic: Q2, Alkami, Apiture, Backbase, FIS, Fiserv, Jack Henry, Temenos, Thought Machine, Mambu, nCino, Blend, Upstart, Marqeta, Galileo, ACI Worldwide, Volante, Alloy, Sardine, Feedzai, Socure, Unit, Treasury Prime, Synctera.

For each story write:
- A punchy, witty headline (no clickbait, no "This Is Why" constructions)
- A 3–5 sentence paragraph with the key facts, context, and a dry observation
Format your response as a JSON array of 10 objects:
[
  { "headline": "...", "body": "...", "cite": "Source Name", "url": "https://..." },
  ...
]

Use the exact URL from the article for the "url" field.

Here are today's articles:

{ARTICLES}`;

// --- API usage logging ---

async function logApi(db: D1Database, service: string, success: boolean): Promise<void> {
  await db.prepare("INSERT INTO api_logs (service, success) VALUES (?, ?)").bind(service, success ? 1 : 0).run();
}

// --- News fetching ---

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  source?: string;
}

async function fetchNewsFromSource(
  source: (typeof NEWS_SOURCES)[0],
  tavilyKey: string,
  db: D1Database
): Promise<TavilyResult[]> {
  const query = source.query
    ? source.query
    : `site:${source.domain} fintech banking`;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: "basic",
      include_domains: [source.domain],
      max_results: 5,
      include_answer: false,
    }),
  });

  await logApi(db, "tavily", res.ok);

  if (!res.ok) {
    console.error(`Tavily fetch failed for ${source.name}:`, res.status);
    return [];
  }

  const data = await res.json() as { results: TavilyResult[] };
  return (data.results || []).map((r) => ({ ...r, source: source.name }));
}

async function fetchAllNews(tavilyKey: string, db: D1Database): Promise<TavilyResult[]> {
  const results = await Promise.all(
    NEWS_SOURCES.map((s) => fetchNewsFromSource(s, tavilyKey, db))
  );
  return results.flat();
}

// --- Ticker fetching ---


async function fetchTickers(finnhubKey: string, db: D1Database): Promise<TickerData[] | null> {
  try {
    const results = await Promise.all(
      TICKERS.map(async (symbol) => {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`
        );
        await logApi(db, "finnhub", res.ok);
        if (!res.ok) return null;
        const data = await res.json() as { c: number; d: number; dp: number };
        if (!data.c) return null;
        return {
          symbol,
          price: data.c,
          change: data.d,
          changePercent: data.dp,
        };
      })
    );
    const tickers = results.filter((t): t is TickerData => t !== null);
    return tickers.length > 0 ? tickers : null;
  } catch (err) {
    console.error("Ticker fetch failed:", err);
    return null;
  }
}

// --- Claude story generation ---


async function generateStories(
  articles: TavilyResult[],
  anthropicKey: string,
  db: D1Database,
  attempt = 1
): Promise<Story[]> {
  const articleText = articles
    .map(
      (a, i) =>
        `[${i + 1}] ${a.title}\nSource: ${a.source}\nURL: ${a.url}\n${a.content}`
    )
    .join("\n\n---\n\n");

  const prompt = STORY_PROMPT.replace("{ARTICLES}", articleText);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  await logApi(db, "anthropic", res.ok);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${err}`);
  }

  const rawText = await res.text();
  const data = JSON.parse(rawText) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content[0]?.text || "[]";

  // Strip markdown code fences if Claude wraps the response
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  const jsonMatch = stripped.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse stories JSON from Claude");
  try {
    return JSON.parse(jsonMatch[0]) as Story[];
  } catch (err) {
    if (attempt < 3) {
      console.warn(`Stories JSON parse failed (attempt ${attempt}), retrying...`);
      return generateStories(articles, anthropicKey, db, attempt + 1);
    }
    throw err;
  }
}

// --- Save to D1 ---

async function saveIssue(db: D1Database, date: string, subject: string, html: string): Promise<number> {
  const result = await db
    .prepare("INSERT INTO issues (date, subject, html_body) VALUES (?, ?, ?) RETURNING id")
    .bind(date, subject, html)
    .first<{ id: number }>();
  return result!.id;
}

// --- Send via Resend ---

async function sendBriefing(
  resendKey: string,
  to: string[],
  subject: string,
  html: string,
  unsubscribeToken: string,
  db: D1Database
): Promise<void> {
  const personalizedHtml = html.replace("{{UNSUBSCRIBE_TOKEN}}", unsubscribeToken);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "Fintech Briefing <briefing@cloudflash.com>",
      to,
      subject,
      html: personalizedHtml,
    }),
  });

  await logApi(db, "resend", res.ok);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${res.status} ${err}`);
  }
}

// --- Subscriber management ---

function generateToken(): string {
  return crypto.randomUUID();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let email: string;
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json() as { email?: string };
    email = (body.email || "").trim().toLowerCase();
  } else {
    const form = await request.formData();
    email = ((form.get("email") as string) || "").trim().toLowerCase();
  }

  if (!isValidEmail(email)) {
    return jsonResponse({ error: "Invalid email address" }, 400);
  }

  const existing = await env.DB
    .prepare("SELECT confirmed FROM subscribers WHERE email = ?")
    .bind(email)
    .first<{ confirmed: number }>();

  if (existing?.confirmed) {
    return jsonResponse({ error: "Already subscribed" }, 409);
  }

  const token = generateToken();

  if (existing) {
    await env.DB
      .prepare("UPDATE subscribers SET unsubscribe_token = ? WHERE email = ?")
      .bind(token, email)
      .run();
  } else {
    await env.DB
      .prepare("INSERT INTO subscribers (email, confirmed, unsubscribe_token) VALUES (?, 0, ?)")
      .bind(email, token)
      .run();
  }

  const confirmUrl = `https://cloudflash.com/confirm?token=${token}`;
  const confirmHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:500px;margin:60px auto;padding:0 24px">
    <p style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.08em">The Daily Fintech Briefing</p>
    <h2 style="font-family:Georgia,serif;color:#111">Confirm your subscription</h2>
    <p style="color:#555;line-height:1.6">Click below to confirm your email and start receiving the briefing each weekday morning at 7:30am PT.</p>
    <a href="${confirmUrl}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#111;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:13px">Confirm subscription →</a>
    <p style="margin-top:32px;font-size:12px;color:#bbb">If you didn't request this, ignore this email.</p>
  </body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Fintech Briefing <briefing@cloudflash.com>",
      to: [email],
      subject: "Confirm your subscription to The Daily Fintech Briefing",
      html: confirmHtml,
    }),
  });

  return jsonResponse({ status: "confirmation_sent" });
}

async function handleConfirm(request: Request, url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  // GET: show confirmation page with a button — prevents security scanners from auto-confirming
  if (request.method === "GET") {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm — The Daily Fintech Briefing</title></head>
<body style="margin:0;padding:0;background:#2179c8;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="max-width:420px;padding:48px 32px;text-align:center">
    <p style="margin:0 0 8px;font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.1em">The Daily Fintech Briefing</p>
    <h1 style="margin:0 0 16px;font-size:26px;font-weight:600;color:#fff;line-height:1.2">Confirm your subscription</h1>
    <p style="margin:0 0 32px;font-size:15px;color:rgba(255,255,255,0.7);line-height:1.6">Click below to start receiving the briefing each weekday morning at 7:30am PT.</p>
    <form method="POST" action="/confirm?token=${token}">
      <button type="submit" style="background:#fff;color:#1a5fa8;border:none;border-radius:4px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer">Confirm subscription →</button>
    </form>
  </div>
</body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }

  // POST: actually confirm
  const result = await env.DB
    .prepare("UPDATE subscribers SET confirmed = 1 WHERE unsubscribe_token = ? AND confirmed = 0 RETURNING email")
    .bind(token)
    .first<{ email: string }>();

  if (!result) {
    return htmlRedirect("https://cloudflash.com/fintech?status=already_confirmed");
  }

  return htmlRedirect("https://cloudflash.com/fintech?status=confirmed");
}

async function handleUnsubscribe(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  await env.DB
    .prepare("DELETE FROM subscribers WHERE unsubscribe_token = ?")
    .bind(token)
    .run();

  return htmlRedirect("https://cloudflash.com/fintech?status=unsubscribed");
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function htmlRedirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

// --- Main pipeline ---

async function runPipeline(env: Env, overrideTo?: string[]): Promise<void> {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
  const dateISO = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD in PT

  console.log("Fetching news...");
  const articles = await fetchAllNews(env.TAVILY_API_KEY, env.DB);
  console.log(`Fetched ${articles.length} articles`);

  console.log("Fetching tickers...");
  const tickers = await fetchTickers(env.FINNHUB_API_KEY, env.DB);
  console.log(tickers ? `Fetched ${tickers.length} tickers` : "Ticker fetch failed — omitting");

  console.log("Generating stories with Claude...");
  const stories = await generateStories(articles, env.ANTHROPIC_API_KEY, env.DB);
  console.log(`Generated ${stories.length} stories`);

  const subject = `The Daily Fintech Briefing · ${date}`;
  const html = buildEmailHtml(stories, tickers, date);

  console.log("Saving issue to D1...");
  await saveIssue(env.DB, dateISO, subject, html);

  if (overrideTo) {
    console.log(`Test run — sending only to: ${overrideTo.join(", ")}`);
    let sent = 0, failed = 0;
    for (const email of overrideTo) {
      try {
        await sendBriefing(env.RESEND_API_KEY, [email], subject, html, "test", env.DB);
        console.log(`Sent: ${email}`);
        sent++;
      } catch (err) {
        console.error(`Failed: ${email} —`, err);
        failed++;
      }
    }
    console.log(`Test run complete — sent: ${sent}, failed: ${failed}`);
  } else {
    console.log("Fetching confirmed subscribers...");
    const subscribers = await env.DB
      .prepare("SELECT email, unsubscribe_token FROM subscribers WHERE confirmed = 1")
      .all<{ email: string; unsubscribe_token: string }>();

    const subs = subscribers.results;
    console.log(`Sending to ${subs.length} subscribers...`);

    let sent = 0, failed = 0;
    const BATCH = 4;
    for (let i = 0; i < subs.length; i += BATCH) {
      const batch = subs.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (sub) => {
          try {
            await sendBriefing(env.RESEND_API_KEY, [sub.email], subject, html, sub.unsubscribe_token, env.DB);
            console.log(`Sent: ${sub.email}`);
            sent++;
          } catch (err) {
            console.error(`Failed: ${sub.email} —`, err);
            failed++;
          }
        })
      );
      if (i + BATCH < subs.length) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    }
    console.log(`Send complete — sent: ${sent}, failed: ${failed}`);
  }

  if (env.VERCEL_DEPLOY_HOOK) {
    await fetch(env.VERCEL_DEPLOY_HOOK, { method: "POST" });
    console.log("Vercel deploy hook triggered");
  }

  console.log("Pipeline complete");
}

// --- Preview mock data ---

const MOCK_STORIES: Story[] = [
  {
    headline: "FIS Bets Big on AI-Powered Core Modernization",
    body: "FIS announced a sweeping initiative to embed generative AI across its core banking platform, targeting mid-size banks that have been slowest to modernize. The move follows a year of margin pressure and a strategic review that concluded 'AI or attrition' was the only viable path. Analysts are cautiously optimistic — cautiously being the operative word.",
    cite: "American Banker",
    url: "https://www.americanbanker.com",
  },
  {
    headline: "Q2 Holdings Acquires Middleware Startup, Promises 'Seamless Integration'",
    body: "Q2 Holdings picked up a Midwest-based middleware firm for an undisclosed sum, expanding its integration layer for community bank clients. The acquisition gives Q2 a foothold in real-time payment routing that it previously lacked. 'Seamless integration' remains the most optimistic phrase in banking technology.",
    cite: "Finextra",
    url: "https://www.finextra.com",
  },
  {
    headline: "Upstart Revises Guidance Upward as AI Loan Models Stabilize",
    body: "Upstart raised its full-year revenue guidance after reporting that its AI underwriting models have finally settled into a more predictable default curve. The company weathered two years of model recalibration that cost it dearly with bank partners. Stability, in fintech lending, is its own kind of headline.",
    cite: "Reuters",
    url: "https://www.reuters.com",
  },
  {
    headline: "Jack Henry Rolls Out FedNow Onboarding for 200 Credit Unions",
    body: "Jack Henry & Associates completed FedNow onboarding for 200 credit union clients in Q1, ahead of its internal timeline. The company cited a streamlined API layer and a surprisingly cooperative core migration process. Credit unions, historically the last to adopt anything, appear to have gotten the memo.",
    cite: "PYMNTS",
    url: "https://www.pymnts.com",
  },
  {
    headline: "Marqeta Expands into BNPL Infrastructure for Regional Banks",
    body: "Marqeta launched a white-label BNPL infrastructure product aimed squarely at regional banks that want to compete with Affirm without building anything themselves. The offering includes underwriting logic, ledger management, and a compliance wrapper. Regional banks remain the most enthusiastic buyers of things other people built.",
    cite: "Bloomberg",
    url: "https://www.bloomberg.com",
  },
  {
    headline: "Temenos Faces Pressure as European Core Banking RFPs Accelerate",
    body: "A wave of European bank RFPs for core modernization is creating both opportunity and anxiety for Temenos, which is competing against Thought Machine and Mambu on several large deals. The company's sales cycle has lengthened, and at least two prospects have paused decisions pending regulatory clarity on cloud residency. Nothing slows a bank like a pending regulatory clarification.",
    cite: "Finextra",
    url: "https://www.finextra.com",
  },
  {
    headline: "Alloy Raises $50M to Expand Identity Decisioning Platform",
    body: "Alloy closed a $50 million Series C to accelerate product development and expand its sales team targeting mid-market fintechs. The identity decisioning platform now processes over 100 million decisions monthly across 500 clients. Fraud, it turns out, is a growth market.",
    cite: "PYMNTS",
    url: "https://www.pymnts.com",
  },
  {
    headline: "nCino Deepens Mortgage Automation Push with New Workflow Engine",
    body: "nCino released an updated mortgage workflow engine that reduces manual touchpoints in the origination process by an estimated 40%. Early adopters report faster closing times and fewer compliance exceptions. The mortgage industry's relationship with automation is long, complicated, and slowly improving.",
    cite: "American Banker",
    url: "https://www.americanbanker.com",
  },
  {
    headline: "ACI Worldwide Lands ISO 20022 Migration Deal with Tier-1 Bank",
    body: "ACI Worldwide signed a multi-year agreement with a Tier-1 bank to manage its ISO 20022 migration across wholesale payment rails. The deal is one of ACI's largest in three years and validates its bet on payments modernization as a sustained revenue driver. ISO 20022 migration: the project that is always happening and never quite done.",
    cite: "Reuters",
    url: "https://www.reuters.com",
  },
  {
    headline: "OCC Signals Tighter Oversight of Bank-Fintech Partnership Agreements",
    body: "The OCC issued guidance signaling closer scrutiny of bank-fintech partnership agreements, particularly those involving deposit-taking and credit origination. The move follows a series of BaaS enforcement actions and puts pressure on sponsor banks to revisit their due diligence frameworks. Regulators remain the fintech industry's most reliable product managers.",
    cite: "American Banker",
    url: "https://www.americanbanker.com",
  },
];

const MOCK_TICKERS: TickerData[] = [
  { symbol: "ALKT", price: 28.42, change: 0.54, changePercent: 1.94 },
  { symbol: "VYX",  price: 11.87, change: -0.23, changePercent: -1.90 },
  { symbol: "QTWO", price: 74.15, change: 1.02, changePercent: 1.39 },
  { symbol: "FIS",  price: 81.33, change: -0.67, changePercent: -0.82 },
  { symbol: "FI",   price: 176.50, change: 2.14, changePercent: 1.23 },
  { symbol: "JKHY", price: 162.88, change: 0.31, changePercent: 0.19 },
  { symbol: "ACIW", price: 34.77, change: -0.44, changePercent: -1.25 },
  { symbol: "GDOT", price: 9.12, change: 0.08, changePercent: 0.89 },
  { symbol: "MQ",   price: 5.63, change: -0.11, changePercent: -1.92 },
  { symbol: "NCNO", price: 24.91, change: 0.37, changePercent: 1.51 },
  { symbol: "UPST", price: 43.28, change: 1.85, changePercent: 4.47 },
];

// --- Error alerting ---

async function sendAlert(env: Env, error: unknown): Promise<void> {
  if (!env.ALERT_EMAIL || !env.RESEND_API_KEY) return;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Fintech Briefing <briefing@cloudflash.com>",
      to: [env.ALERT_EMAIL],
      subject: `[Cloudflash] Pipeline failure — ${new Date().toISOString()}`,
      html: `<pre style="font-family:monospace;font-size:13px">${message}${stack}</pre>`,
    }),
  });
}

// --- Worker export ---

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("Daily Fintech Briefing cron triggered:", new Date().toISOString());
    try {
      await runPipeline(env);
    } catch (err) {
      console.error("Pipeline failed:", err);
      await sendAlert(env, err);
      throw err;
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }

    if (url.pathname === "/confirm" && (request.method === "GET" || request.method === "POST")) {
      return handleConfirm(request, url, env);
    }

    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      return handleUnsubscribe(url, env);
    }

    if (url.pathname === "/resend-to" && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) return new Response("Missing email", { status: 400 });

      const issue = await env.DB
        .prepare("SELECT subject, html_body FROM issues ORDER BY id DESC LIMIT 1")
        .first<{ subject: string; html_body: string }>();
      if (!issue) return new Response("No issues found", { status: 404 });

      const sub = await env.DB
        .prepare("SELECT unsubscribe_token FROM subscribers WHERE email = ? AND confirmed = 1")
        .bind(email)
        .first<{ unsubscribe_token: string }>();
      if (!sub) return new Response("Subscriber not found", { status: 404 });

      const html = issue.html_body.replace("{{UNSUBSCRIBE_TOKEN}}", sub.unsubscribe_token);

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
          body: JSON.stringify({ from: "Fintech Briefing <briefing@cloudflash.com>", to: [email], subject: issue.subject, html }),
        });

        if (!res.ok) {
          const err = await res.text();
          return new Response(JSON.stringify({ error: `Resend error: ${err}` }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({ status: "sent", to: email }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/test-tickers") {
      const result = await fetchTickers(env.FINNHUB_API_KEY);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/test-run") {
      const email = url.searchParams.get("email");
      if (!email) return new Response("Missing email", { status: 400 });
      try {
        await runPipeline(env, [email]);
        return new Response(JSON.stringify({ status: "ok", sent_to: email }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ status: "error", message: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/run") {
      try {
        await runPipeline(env);
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ status: "error", message: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/api/logs" && request.method === "GET") {
      const periods = [1, 7, 14, 21, 28];
      const services = ["tavily", "anthropic", "finnhub", "resend"];
      const result: Record<string, Record<string, { calls: number; failures: number }>> = {};

      for (const service of services) {
        result[service] = {};
        for (const days of periods) {
          const row = await env.DB
            .prepare(`SELECT COUNT(*) as calls, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures FROM api_logs WHERE service = ? AND created_at >= datetime('now', '-${days} days')`)
            .bind(service)
            .first<{ calls: number; failures: number }>();
          result[service][`${days}d`] = { calls: row?.calls ?? 0, failures: row?.failures ?? 0 };
        }
      }
      return jsonResponse(result);
    }

    if (url.pathname === "/api/subscribers/count" && request.method === "GET") {
      const result = await env.DB
        .prepare("SELECT COUNT(*) as count FROM subscribers WHERE confirmed = 1")
        .first<{ count: number }>();
      return jsonResponse({ count: result?.count ?? 0 });
    }

    if (url.pathname === "/api/issues" && request.method === "GET") {
      const issues = await env.DB
        .prepare("SELECT id, date, subject FROM issues ORDER BY date DESC")
        .all<{ id: number; date: string; subject: string }>();
      return jsonResponse(issues.results);
    }

    if (url.pathname.startsWith("/api/issues/") && request.method === "GET") {
      const date = url.pathname.replace("/api/issues/", "");
      const issue = await env.DB
        .prepare("SELECT id, date, subject, html_body FROM issues WHERE date = ?")
        .bind(date)
        .first<{ id: number; date: string; subject: string; html_body: string }>();
      if (!issue) return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
      return jsonResponse(issue);
    }

    if (url.pathname === "/preview" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const now = new Date();
      const date = now.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      });

      const html = buildEmailHtml(MOCK_STORIES, MOCK_TICKERS, date);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
