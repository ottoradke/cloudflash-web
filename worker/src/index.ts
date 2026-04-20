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
  days: number;
  max_results: number;
  note: string;
}

interface ConfigTicker {
  id: number;
  order_pos: number;
  symbol: string;
  name: string;
  group: string;
  note: string;
}

interface Config {
  topics: ConfigTopic[];
  vendors: ConfigVendor[];
  sources: ConfigSource[];
  tickers: ConfigTicker[];
  prompt: string;
}

async function loadConfig(db: D1Database): Promise<Config> {
  const [topics, vendors, sources, tickers, promptRow] = await Promise.all([
    db.prepare("SELECT id, order_pos, name, note FROM config_topics ORDER BY order_pos ASC").all<ConfigTopic>(),
    db.prepare("SELECT id, order_pos, name, note FROM config_vendors ORDER BY order_pos ASC").all<ConfigVendor>(),
    db.prepare("SELECT id, order_pos, name, domain, query, days, max_results, note FROM config_sources ORDER BY order_pos ASC").all<ConfigSource>(),
    db.prepare("SELECT id, order_pos, symbol, name, ticker_group AS 'group', note FROM config_tickers ORDER BY order_pos ASC").all<ConfigTicker>(),
    db.prepare("SELECT template FROM config_prompt WHERE id = 1").first<{ template: string }>(),
  ]);
  return {
    topics: topics.results,
    vendors: vendors.results,
    sources: sources.results,
    tickers: tickers.results,
    prompt: promptRow?.template ?? DEFAULT_PROMPT,
  };
}

function buildTickerGroupsFromConfig(tickers: ConfigTicker[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const t of tickers) {
    const g = t.group || "Other";
    if (!groups[g]) groups[g] = [];
    groups[g].push(t.symbol);
  }
  return groups;
}

function buildTickerNamesFromConfig(tickers: ConfigTicker[]): Record<string, string> {
  return Object.fromEntries(tickers.map((t) => [t.symbol, t.name || t.symbol]));
}

const DEFAULT_PROMPT = `You are writing The Daily Fintech Briefing — a weekday AI-generated email newsletter in the style of a senior fintech analyst writing to a trusted colleague. Conversational and personal in voice — write as if you have a point of view, not just a summary. Each story should include thoughtful analysis of what the news actually means for banks, vendors, or the industry, and where relevant, a strategic observation about what it signals or what comes next. Dry wit is welcome but secondary to genuine insight.

Below is a collection of fintech news articles gathered this morning. Select and write exactly 10 stories, prioritized in this order:
{TOPICS}

Stories involving these vendors should be bumped ahead of generic stories on the same topic: {VENDORS}.

The following stories have already been covered in recent issues. Do not repeat them or any substantially similar story:
{RECENT_HEADLINES}

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

function buildPrompt(
  template: string,
  topics: ConfigTopic[],
  vendors: ConfigVendor[],
  recentHeadlines: string[] = []
): string {
  const topicList  = topics.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
  const vendorList = vendors.map((v) => v.name).join(", ");
  const headlineList = recentHeadlines.length > 0
    ? recentHeadlines.map((h, i) => `${i + 1}. ${h}`).join("\n")
    : "(none)";
  return template
    .replace("{TOPICS}",  topicList)
    .replace("{VENDORS}", vendorList)
    .replace("{RECENT_HEADLINES}", headlineList);
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
      topic: "news",
      search_depth: "basic",
      include_domains: [source.domain],
      max_results: source.max_results ?? 5,
      include_answer: false,
      days: source.days ?? 7,
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

async function fetchTickers(finnhubKey: string, db: D1Database, symbols: string[]): Promise<TickerData[] | null> {
  if (!symbols.length) return null;
  try {
    const allResults: (TickerData | null)[] = [];
    for (let i = 0; i < symbols.length; i += FINNHUB_BATCH) {
      const batch = symbols.slice(i, i + FINNHUB_BATCH);
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
      if (i + FINNHUB_BATCH < symbols.length) {
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

async function fetchRecentHeadlines(db: D1Database, limit = 5): Promise<string[]> {
  const rows = await db
    .prepare("SELECT subject FROM issues ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ subject: string }>();
  // subject is "The Daily Fintech Briefing · Month DD, YYYY" — extract the actual story headlines
  // Story headlines are stored per-issue in stories_json on pipeline_runs; use subjects as a
  // coarse dedup signal and also pull story headlines from recent pipeline_runs
  const runRows = await db
    .prepare("SELECT stories_json FROM pipeline_runs WHERE stories_json IS NOT NULL ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ stories_json: string }>();
  const headlines: string[] = [];
  for (const row of runRows.results) {
    try {
      const stories = JSON.parse(row.stories_json) as Story[];
      for (const s of stories) headlines.push(s.headline);
    } catch { /* skip malformed rows */ }
  }
  return headlines;
}

async function generateStories(
  articles: TavilyResult[],
  topics: ConfigTopic[],
  vendors: ConfigVendor[],
  anthropicKey: string,
  db: D1Database,
  promptTemplate = DEFAULT_PROMPT,
  recentHeadlines: string[] = [],
  attempt = 1
): Promise<Story[]> {
  const articleText = articles
    .map(
      (a, i) =>
        `[${i + 1}] ${a.title}\nSource: ${a.source}\nURL: ${a.url}\n${a.content}`
    )
    .join("\n\n---\n\n");

  const prompt = buildPrompt(promptTemplate, topics, vendors, recentHeadlines).replace("{ARTICLES}", articleText);

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

  const retry = (reason: string, err?: unknown): Promise<Story[]> => {
    console.warn(`Stories JSON parse failed (attempt ${attempt}): ${reason}. Claude returned:\n${text.slice(0, 2000)}`);
    if (err) console.warn(err);
    if (attempt < 3) {
      return generateStories(articles, topics, vendors, anthropicKey, db, promptTemplate, recentHeadlines, attempt + 1);
    }
    throw new Error(`Could not parse stories JSON from Claude after ${attempt} attempts. Last response: ${text.slice(0, 500)}`);
  };

  // Strip markdown code fences if Claude wraps the response
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  const jsonMatch = stripped.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return retry("no JSON array found in response");
  }
  try {
    return JSON.parse(jsonMatch[0]) as Story[];
  } catch (err) {
    return retry("JSON.parse threw", err);
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

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function goneResponse(): Response {
  return jsonResponse(
    {
      error: "Gone",
      message: "The Daily Fintech Briefing has moved to BriefTen.",
      url: "https://brieften.com",
    },
    410
  );
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
  const tickers = await fetchTickers(env.FINNHUB_API_KEY, env.DB, config.tickers.map((t) => t.symbol));
  console.log(tickers ? `Fetched ${tickers.length} tickers` : "Ticker fetch failed — omitting");

  // Save articles before Claude call so we have them even if generation fails
  const runId = await savePipelineRun(env.DB, dateISO, articles);

  console.log("Generating stories with Claude...");
  const recentHeadlines = await fetchRecentHeadlines(env.DB);
  const stories = await generateStories(articles, config.topics, config.vendors, env.ANTHROPIC_API_KEY, env.DB, config.prompt, recentHeadlines);
  console.log(`Generated ${stories.length} stories`);

  await updatePipelineRunStories(env.DB, runId, stories);

  const tickerGroups = buildTickerGroupsFromConfig(config.tickers);
  const tickerNames  = buildTickerNamesFromConfig(config.tickers);
  const subject = `The Daily Fintech Briefing · ${date}`;
  const sourceNames = config.sources.map((s) => s.name);
  const html = buildEmailHtml(stories, tickers, date, tickerGroups, tickerNames, sourceNames);
  const text = buildEmailText(stories, tickers, date, tickerGroups, tickerNames, sourceNames);

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
      .prepare("SELECT email, unsubscribe_token FROM subscribers WHERE confirmed = 1 AND (unsubscribed_at IS NULL OR confirmed_at > unsubscribed_at)")
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
          "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/confirm") {
      return Response.redirect(`https://brieften.com/confirm${url.search}`, 301);
    }

    if (url.pathname === "/unsubscribe") {
      return Response.redirect(`https://brieften.com/unsubscribe${url.search}`, 301);
    }

    // Resend webhook still points here until the Resend dashboard is
    // repointed at BriefTen. 200 no-op — anything else would make Resend
    // retry the delivery queue.
    if (url.pathname === "/webhooks/resend" && request.method === "POST") {
      return new Response("OK", { status: 200 });
    }

    // Retired routes — BriefTen handles these now.
    const retiredRoutes = new Set([
      "/subscribe",
      "/resend-to",
      "/test-tickers",
      "/test-run",
      "/run",
      "/api/logs",
      "/api/subscribers",
      "/api/subscribers/confirm",
      "/api/subscribers/remove",
      "/pipeline/fetch",
      "/preview",
      "/preview/live",
      "/preview/send",
      "/api/config",
      "/api/config/tickers",
      "/api/config/prompt",
      "/api/pipeline/runs",
      "/api/config/topics",
      "/api/config/vendors",
      "/api/config/sources",
    ]);
    if (retiredRoutes.has(url.pathname)) {
      return goneResponse();
    }

    // Historical archive — still read by /fintech/archive and /fintech/issue.
    if (url.pathname === "/api/subscribers/count" && request.method === "GET") {
      const result = await env.DB
        .prepare("SELECT COUNT(*) as count FROM subscribers WHERE confirmed = 1 AND (unsubscribed_at IS NULL OR confirmed_at > unsubscribed_at)")
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

    return new Response("Not Found", { status: 404 });
  },
};
