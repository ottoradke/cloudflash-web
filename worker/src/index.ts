import { buildEmailHtml, buildEmailText, Story, TickerData } from "./email-template";

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

// --- Config types ---

interface ConfigTopic {
  id: number;
  order_pos: number;
  name: string;
  note: string;
}

interface ConfigVendor {
  id: number;
  order_pos: number;
  name: string;
  note: string;
}

interface ConfigSource {
  id: number;
  order_pos: number;
  name: string;
  domain: string;
  query: string;
  note: string;
}

interface Config {
  topics: ConfigTopic[];
  vendors: ConfigVendor[];
  sources: ConfigSource[];
}

async function loadConfig(db: D1Database): Promise<Config> {
  const [topics, vendors, sources] = await Promise.all([
    db.prepare("SELECT id, order_pos, name, note FROM config_topics ORDER BY order_pos ASC").all<ConfigTopic>(),
    db.prepare("SELECT id, order_pos, name, note FROM config_vendors ORDER BY order_pos ASC").all<ConfigVendor>(),
    db.prepare("SELECT id, order_pos, name, domain, query, note FROM config_sources ORDER BY order_pos ASC").all<ConfigSource>(),
  ]);
  return {
    topics: topics.results,
    vendors: vendors.results,
    sources: sources.results,
  };
}

function buildPrompt(topics: ConfigTopic[], vendors: ConfigVendor[]): string {
  const topicList = topics.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
  const vendorList = vendors.map((v) => v.name).join(", ");
  return `You are writing The Daily Fintech Briefing — a weekday AI-generated email newsletter in the style of a senior fintech analyst writing to a trusted colleague. Conversational and personal in voice — write as if you have a point of view, not just a summary. Each story should include thoughtful analysis of what the news actually means for banks, vendors, or the industry, and where relevant, a strategic observation about what it signals or what comes next. Dry wit is welcome but secondary to genuine insight.

Below is a collection of fintech news articles gathered this morning. Select and write exactly 10 stories, prioritized in this order:
${topicList}

Stories involving these vendors should be bumped ahead of generic stories on the same topic: ${vendorList}.

For each story write:
- A punchy, witty headline (no clickbait, no "This Is Why" constructions)
- A 3–5 sentence paragraph with the key facts, your honest read on what it means, and — where the story warrants it — a strategic observation about what it signals for the industry. Write with a point of view. Wit is fine but don't reach for a joke at the expense of insight.
Format your response as a JSON array of 10 objects:
[
  { "headline": "...", "body": "...", "cite": "Source Name", "url": "https://..." },
  ...
]

Use the exact URL from the article for the "url" field.

Here are today's articles:

{ARTICLES}`;
}

// --- API usage logging ---

async function logApi(
  db: D1Database,
  service: string,
  success: boolean,
  opts: { duration_ms?: number; tokens_used?: number; error_message?: string } = {}
): Promise<void> {
  await db
    .prepare("INSERT INTO api_logs (service, success, duration_ms, tokens_used, error_message) VALUES (?, ?, ?, ?, ?)")
    .bind(service, success ? 1 : 0, opts.duration_ms ?? null, opts.tokens_used ?? null, opts.error_message ?? null)
    .run();
}

// --- News fetching ---

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  source?: string;
}

async function fetchNewsFromSource(
  source: ConfigSource,
  tavilyKey: string,
  db: D1Database
): Promise<TavilyResult[]> {
  const query = source.query || `site:${source.domain} fintech banking`;

  const tavilyStart = Date.now();
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
      days: 7,
    }),
  });
  const tavilyDuration = Date.now() - tavilyStart;

  if (!res.ok) {
    const errText = await res.text();
    await logApi(db, "tavily", false, { duration_ms: tavilyDuration, error_message: `${res.status} ${errText}` });
    console.error(`Tavily fetch failed for ${source.name}:`, res.status);
    return [];
  }

  await logApi(db, "tavily", true, { duration_ms: tavilyDuration });

  const data = await res.json() as { results: TavilyResult[] };
  return (data.results || []).map((r) => ({ ...r, source: source.name }));
}

async function fetchAllNews(sources: ConfigSource[], tavilyKey: string, db: D1Database): Promise<TavilyResult[]> {
  const results = await Promise.all(
    sources.map((s) => fetchNewsFromSource(s, tavilyKey, db))
  );
  return results.flat();
}

// --- Ticker fetching ---


const FINNHUB_BATCH = 25; // Finnhub limit: 30 calls/sec

async function fetchTickers(finnhubKey: string, db: D1Database): Promise<TickerData[] | null> {
  try {
    const allResults: (TickerData | null)[] = [];
    for (let i = 0; i < TICKERS.length; i += FINNHUB_BATCH) {
      const batch = TICKERS.slice(i, i + FINNHUB_BATCH);
      const batchResults = await Promise.all(
        batch.map(async (symbol) => {
          const start = Date.now();
          const res = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`
          );
          const duration_ms = Date.now() - start;
          if (!res.ok) {
            const errText = await res.text();
            await logApi(db, "finnhub", false, { duration_ms, error_message: `${res.status} ${errText}` });
            return null;
          }
          await logApi(db, "finnhub", true, { duration_ms });
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
      allResults.push(...batchResults);
      if (i + FINNHUB_BATCH < TICKERS.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const tickers = allResults.filter((t): t is TickerData => t !== null);
    return tickers.length > 0 ? tickers : null;
  } catch (err) {
    console.error("Ticker fetch failed:", err);
    return null;
  }
}

// --- Claude story generation ---


async function generateStories(
  articles: TavilyResult[],
  topics: ConfigTopic[],
  vendors: ConfigVendor[],
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

  const prompt = buildPrompt(topics, vendors).replace("{ARTICLES}", articleText);

  const anthropicStart = Date.now();
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
  const anthropicDuration = Date.now() - anthropicStart;

  if (!res.ok) {
    const errText = await res.text();
    await logApi(db, "anthropic", false, { duration_ms: anthropicDuration, error_message: `${res.status} ${errText}` });
    throw new Error(`Anthropic API error: ${res.status} ${errText}`);
  }

  const rawText = await res.text();
  const data = JSON.parse(rawText) as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const tokens_used = data.usage ? data.usage.input_tokens + data.usage.output_tokens : undefined;
  await logApi(db, "anthropic", true, { duration_ms: anthropicDuration, tokens_used });
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
      return generateStories(articles, topics, vendors, anthropicKey, db, attempt + 1);
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

// --- Preview storage ---

async function savePreview(db: D1Database, date: string, html: string): Promise<number> {
  const result = await db
    .prepare("INSERT INTO previews (date, html) VALUES (?, ?) RETURNING id")
    .bind(date, html)
    .first<{ id: number }>();
  return result!.id;
}

// --- Pipeline run caching ---

async function savePipelineRun(db: D1Database, date: string, articles: TavilyResult[]): Promise<number> {
  const result = await db
    .prepare("INSERT INTO pipeline_runs (date, articles_json) VALUES (?, ?) RETURNING id")
    .bind(date, JSON.stringify(articles))
    .first<{ id: number }>();
  return result!.id;
}

async function updatePipelineRunStories(db: D1Database, id: number, stories: Story[]): Promise<void> {
  await db
    .prepare("UPDATE pipeline_runs SET stories_json = ? WHERE id = ?")
    .bind(JSON.stringify(stories), id)
    .run();
}

// --- Send via Resend ---

async function sendBriefing(
  resendKey: string,
  to: string[],
  subject: string,
  html: string,
  text: string,
  unsubscribeToken: string,
  db: D1Database
): Promise<void> {
  const personalizedHtml = html.replace("{{UNSUBSCRIBE_TOKEN}}", unsubscribeToken);
  const personalizedText = text.replace("{{UNSUBSCRIBE_TOKEN}}", unsubscribeToken);

  const resendStart = Date.now();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "Fintech Briefing <briefing@cloudflash.com>",
      reply_to: "hello@cloudflash.com",
      to,
      subject,
      html: personalizedHtml,
      text: personalizedText,
      headers: {
        "List-Unsubscribe": `<https://cloudflash.com/unsubscribe?token=${unsubscribeToken}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  const resendDuration = Date.now() - resendStart;

  if (!res.ok) {
    const errText = await res.text();
    await logApi(db, "resend", false, { duration_ms: resendDuration, error_message: `${res.status} ${errText}` });
    throw new Error(`Resend error: ${res.status} ${errText}`);
  }

  await logApi(db, "resend", true, { duration_ms: resendDuration });
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

  const confirmStart = Date.now();
  const confirmRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Fintech Briefing <briefing@cloudflash.com>",
      reply_to: "hello@cloudflash.com",
      to: [email],
      subject: "Confirm your subscription to The Daily Fintech Briefing",
      html: confirmHtml,
    }),
  });
  const confirmDuration = Date.now() - confirmStart;
  if (!confirmRes.ok) {
    const errText = await confirmRes.text();
    await logApi(env.DB, "resend", false, { duration_ms: confirmDuration, error_message: `${confirmRes.status} ${errText}` });
  } else {
    await logApi(env.DB, "resend", true, { duration_ms: confirmDuration });
  }

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
    .prepare("UPDATE subscribers SET confirmed = 1, confirmed_at = CURRENT_TIMESTAMP WHERE unsubscribe_token = ? AND confirmed = 0 RETURNING email")
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
    .prepare("UPDATE subscribers SET confirmed = 0, unsubscribed_at = CURRENT_TIMESTAMP WHERE unsubscribe_token = ?")
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

  const existing = await env.DB
    .prepare("SELECT id FROM issues WHERE date = ?")
    .bind(dateISO)
    .first<{ id: number }>();
  if (existing) {
    console.log(`Issue already exists for ${dateISO} (id: ${existing.id}) — aborting to prevent duplicate send.`);
    return;
  }

  const config = await loadConfig(env.DB);

  console.log("Fetching news...");
  const articles = await fetchAllNews(config.sources, env.TAVILY_API_KEY, env.DB);
  console.log(`Fetched ${articles.length} articles`);

  console.log("Fetching tickers...");
  const tickers = await fetchTickers(env.FINNHUB_API_KEY, env.DB);
  console.log(tickers ? `Fetched ${tickers.length} tickers` : "Ticker fetch failed — omitting");

  // Save articles before Claude call so we have them even if generation fails
  const runId = await savePipelineRun(env.DB, dateISO, articles);

  console.log("Generating stories with Claude...");
  const stories = await generateStories(articles, config.topics, config.vendors, env.ANTHROPIC_API_KEY, env.DB);
  console.log(`Generated ${stories.length} stories`);

  await updatePipelineRunStories(env.DB, runId, stories);

  const subject = `The Daily Fintech Briefing · ${date}`;
  const html = buildEmailHtml(stories, tickers, date);
  const text = buildEmailText(stories, tickers, date);

  console.log("Saving issue to D1...");
  await saveIssue(env.DB, dateISO, subject, html);
  await savePreview(env.DB, dateISO, html);

  if (overrideTo) {
    console.log(`Test run — sending only to: ${overrideTo.join(", ")}`);
    let sent = 0, failed = 0;
    for (const email of overrideTo) {
      try {
        await sendBriefing(env.RESEND_API_KEY, [email], subject, html, text, "test", env.DB);
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
            await sendBriefing(env.RESEND_API_KEY, [sub.email], subject, html, text, sub.unsubscribe_token, env.DB);
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
  const alertStart = Date.now();
  const alertRes = await fetch("https://api.resend.com/emails", {
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
  const alertDuration = Date.now() - alertStart;
  if (!alertRes.ok) {
    const errText = await alertRes.text();
    await logApi(env.DB, "resend", false, { duration_ms: alertDuration, error_message: `${alertRes.status} ${errText}` });
  } else {
    await logApi(env.DB, "resend", true, { duration_ms: alertDuration });
  }
}

// --- Subscriber purge ---

async function purgeExpiredSubscribers(db: D1Database): Promise<void> {
  const result = await db
    .prepare("DELETE FROM subscribers WHERE confirmed = 0 AND unsubscribed_at IS NOT NULL AND unsubscribed_at < datetime('now', '-90 days')")
    .run();
  if (result.meta.changes > 0) {
    console.log(`Purged ${result.meta.changes} expired subscriber record(s)`);
  }
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
    await purgeExpiredSubscribers(env.DB);
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
        const resendStart = Date.now();
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
          body: JSON.stringify({ from: "Fintech Briefing <briefing@cloudflash.com>", to: [email], subject: issue.subject, html }),
        });
        const resendDuration = Date.now() - resendStart;

        if (!res.ok) {
          const errText = await res.text();
          await logApi(env.DB, "resend", false, { duration_ms: resendDuration, error_message: `${res.status} ${errText}` });
          return new Response(JSON.stringify({ error: `Resend error: ${errText}` }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        await logApi(env.DB, "resend", true, { duration_ms: resendDuration });
        return new Response(JSON.stringify({ status: "sent", to: email }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/test-tickers") {
      const result = await fetchTickers(env.FINNHUB_API_KEY, env.DB);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/test-run") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
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
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
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

    if (url.pathname === "/webhooks/resend" && request.method === "POST") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: { type: string; data: { to: string[] } };
      try {
        payload = await request.json() as { type: string; data: { to: string[] } };
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      const { type, data } = payload;
      const email = data?.to?.[0];

      if (!email) return new Response("OK", { status: 200 });

      // Hard bounce or spam complaint — remove subscriber
      if (type === "email.bounced" || type === "email.complained") {
        await env.DB
          .prepare("UPDATE subscribers SET confirmed = 0, unsubscribed_at = CURRENT_TIMESTAMP WHERE email = ?")
          .bind(email.toLowerCase())
          .run();
        console.log(`Webhook ${type}: soft-deleted ${email}`);
      }

      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/api/subscribers/count" && request.method === "GET") {
      const result = await env.DB
        .prepare("SELECT COUNT(*) as count FROM subscribers WHERE confirmed = 1")
        .first<{ count: number }>();
      return jsonResponse({ count: result?.count ?? 0 });
    }

    if (url.pathname === "/sitemap.xml" && request.method === "GET") {
      const issues = await env.DB
        .prepare("SELECT date FROM issues ORDER BY date DESC")
        .all<{ date: string }>();

      const staticUrls = [
        "https://cloudflash.com/fintech",
        "https://cloudflash.com/fintech/archive",
      ];

      const issueUrls = issues.results.map(
        (i) => `https://cloudflash.com/fintech/issue?date=${i.date}`
      );

      const urls = [...staticUrls, ...issueUrls]
        .map((u) => `  <url><loc>${u}</loc></url>`)
        .join("\n");

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
        {
          headers: {
            "Content-Type": "application/xml",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
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

    if (url.pathname === "/pipeline/fetch" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const now = new Date();
      const dateISO = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

      const config = await loadConfig(env.DB);
      const articles = await fetchAllNews(config.sources, env.TAVILY_API_KEY, env.DB);
      await savePipelineRun(env.DB, dateISO, articles);

      return jsonResponse({ status: "ok", articles: articles.length, date: dateISO });
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

    if (url.pathname === "/preview/live" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const run = await env.DB
        .prepare("SELECT articles_json FROM pipeline_runs ORDER BY id DESC LIMIT 1")
        .first<{ articles_json: string }>();

      if (!run?.articles_json) {
        return new Response("No pipeline run found. Run the pipeline at least once first.", {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const articles = JSON.parse(run.articles_json) as TavilyResult[];
      const config = await loadConfig(env.DB);
      const stories = await generateStories(articles, config.topics, config.vendors, env.ANTHROPIC_API_KEY, env.DB);

      const now = new Date();
      const date = now.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      });

      const tickers = await fetchTickers(env.FINNHUB_API_KEY, env.DB);
      const html = buildEmailHtml(stories, tickers, date);

      const dateISO = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const previewId = await savePreview(env.DB, dateISO, html);

      return new Response(html, {
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "X-Preview-ID",
          "X-Preview-ID": String(previewId),
        },
      });
    }

    if (url.pathname === "/preview/send" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const id = url.searchParams.get("id");
      const to = url.searchParams.get("to");
      if (!id || !to) {
        return jsonResponse({ error: "Missing id or to" }, 400);
      }

      const preview = await env.DB
        .prepare("SELECT date, html FROM previews WHERE id = ?")
        .bind(Number(id))
        .first<{ date: string; html: string }>();

      if (!preview) {
        return jsonResponse({ error: "Preview not found" }, 404);
      }

      const subject = `The Daily Fintech Briefing · Preview · ${preview.date}`;
      const html = preview.html.replace("{{UNSUBSCRIBE_TOKEN}}", "preview");

      const resendStart = Date.now();
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: "Fintech Briefing <briefing@cloudflash.com>", to: [to], subject, html }),
      });
      const resendDuration = Date.now() - resendStart;

      if (!res.ok) {
        const errText = await res.text();
        await logApi(env.DB, "resend", false, { duration_ms: resendDuration, error_message: `${res.status} ${errText}` });
        return jsonResponse({ error: `Resend error: ${res.status}` }, 500);
      }

      await logApi(env.DB, "resend", true, { duration_ms: resendDuration });
      return jsonResponse({ status: "sent", to });
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) return new Response("Unauthorized", { status: 401 });
      const config = await loadConfig(env.DB);
      return jsonResponse(config);
    }

    if (url.pathname === "/api/pipeline/runs" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) return new Response("Unauthorized", { status: 401 });
      const runs = await env.DB.prepare(
        "SELECT id, date, articles_json, stories_json, created_at FROM pipeline_runs ORDER BY created_at DESC LIMIT 20"
      ).all<{ id: number; date: string; articles_json: string | null; stories_json: string | null; created_at: string }>();
      const results = runs.results.map(run => ({
        id: run.id,
        date: run.date,
        articles: run.articles_json ? (JSON.parse(run.articles_json) as unknown[]).length : 0,
        stories: run.stories_json ? (JSON.parse(run.stories_json) as unknown[]).length : 0,
        created_at: run.created_at,
      }));
      return jsonResponse(results);
    }

    if (url.pathname === "/api/config/topics" && request.method === "PUT") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) return new Response("Unauthorized", { status: 401 });
      const rows = await request.json() as Array<{ order_pos: number; name: string; note: string }>;
      await env.DB.prepare("DELETE FROM config_topics").run();
      for (const row of rows) {
        await env.DB.prepare("INSERT INTO config_topics (order_pos, name, note) VALUES (?, ?, ?)")
          .bind(row.order_pos, row.name, row.note ?? "").run();
      }
      return jsonResponse({ status: "ok", count: rows.length });
    }

    if (url.pathname === "/api/config/vendors" && request.method === "PUT") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) return new Response("Unauthorized", { status: 401 });
      const rows = await request.json() as Array<{ order_pos: number; name: string; note: string }>;
      await env.DB.prepare("DELETE FROM config_vendors").run();
      for (const row of rows) {
        await env.DB.prepare("INSERT INTO config_vendors (order_pos, name, note) VALUES (?, ?, ?)")
          .bind(row.order_pos, row.name, row.note ?? "").run();
      }
      return jsonResponse({ status: "ok", count: rows.length });
    }

    if (url.pathname === "/api/config/sources" && request.method === "PUT") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.PREVIEW_KEY) return new Response("Unauthorized", { status: 401 });
      const rows = await request.json() as Array<{ order_pos: number; name: string; domain: string; query: string; note: string }>;
      await env.DB.prepare("DELETE FROM config_sources").run();
      for (const row of rows) {
        await env.DB.prepare("INSERT INTO config_sources (order_pos, name, domain, query, note) VALUES (?, ?, ?, ?, ?)")
          .bind(row.order_pos, row.name, row.domain, row.query, row.note ?? "").run();
      }
      return jsonResponse({ status: "ok", count: rows.length });
    }

    return new Response("Not Found", { status: 404 });
  },
};
