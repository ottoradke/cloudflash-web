import { buildEmailHtml, Story, TickerData } from "./email-template";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  TAVILY_API_KEY: string;
  FINNHUB_API_KEY: string;
  VERCEL_DEPLOY_HOOK: string;
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
- End with: <cite>↗ Source Name</cite>

Format your response as a JSON array of 10 objects:
[
  { "headline": "...", "body": "...", "cite": "Source Name" },
  ...
]

Here are today's articles:

{ARTICLES}`;

// --- News fetching ---

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  source?: string;
}

async function fetchNewsFromSource(
  source: (typeof NEWS_SOURCES)[0],
  tavilyKey: string
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

  if (!res.ok) {
    console.error(`Tavily fetch failed for ${source.name}:`, res.status);
    return [];
  }

  const data = await res.json() as { results: TavilyResult[] };
  return (data.results || []).map((r) => ({ ...r, source: source.name }));
}

async function fetchAllNews(tavilyKey: string): Promise<TavilyResult[]> {
  const results = await Promise.all(
    NEWS_SOURCES.map((s) => fetchNewsFromSource(s, tavilyKey))
  );
  return results.flat();
}

// --- Ticker fetching ---


async function fetchTickers(finnhubKey: string): Promise<TickerData[] | null> {
  try {
    const results = await Promise.all(
      TICKERS.map(async (symbol) => {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`
        );
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
  anthropicKey: string
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${err}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content[0]?.text || "[]";

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse stories JSON from Claude");
  return JSON.parse(jsonMatch[0]) as Story[];
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
  unsubscribeToken: string
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

  const confirmUrl = `https://cloudflash-briefing.ottoradke.workers.dev/confirm?token=${token}`;
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

async function handleConfirm(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

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

async function runPipeline(env: Env): Promise<void> {
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
  const articles = await fetchAllNews(env.TAVILY_API_KEY);
  console.log(`Fetched ${articles.length} articles`);

  console.log("Fetching tickers...");
  const tickers = await fetchTickers(env.FINNHUB_API_KEY);
  console.log(tickers ? `Fetched ${tickers.length} tickers` : "Ticker fetch failed — omitting");

  console.log("Generating stories with Claude...");
  const stories = await generateStories(articles, env.ANTHROPIC_API_KEY);
  console.log(`Generated ${stories.length} stories`);

  const subject = `The Daily Fintech Briefing · ${date}`;
  const html = buildEmailHtml(stories, tickers, date);

  console.log("Saving issue to D1...");
  await saveIssue(env.DB, dateISO, subject, html);

  console.log("Fetching confirmed subscribers...");
  const subscribers = await env.DB
    .prepare("SELECT email, unsubscribe_token FROM subscribers WHERE confirmed = 1")
    .all<{ email: string; unsubscribe_token: string }>();

  console.log(`Sending to ${subscribers.results.length} subscribers...`);
  await Promise.all(
    subscribers.results.map((sub) =>
      sendBriefing(env.RESEND_API_KEY, [sub.email], subject, html, sub.unsubscribe_token)
    )
  );

  if (env.VERCEL_DEPLOY_HOOK) {
    await fetch(env.VERCEL_DEPLOY_HOOK, { method: "POST" });
    console.log("Vercel deploy hook triggered");
  }

  console.log("Pipeline complete");
}

// --- Worker export ---

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("Daily Fintech Briefing cron triggered:", new Date().toISOString());
    await runPipeline(env);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    if (url.pathname === "/confirm" && request.method === "GET") {
      return handleConfirm(url, env);
    }

    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      return handleUnsubscribe(url, env);
    }

    if (url.pathname === "/test-tickers") {
      const result = await fetchTickers(env.FINNHUB_API_KEY);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
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

    return new Response("Not Found", { status: 404 });
  },
};
