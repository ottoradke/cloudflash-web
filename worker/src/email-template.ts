export interface Story {
  headline: string;
  body: string;
  cite: string;
  url: string;
}

export interface TickerData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

const TICKER_GROUPS: Record<string, string[]> = {
  "Digital Banking": ["ALKT", "VYX", "QTWO"],
  "Core Banking": ["FIS", "FI", "JKHY"],
  "Payments & Rails": ["ACIW", "GDOT", "MQ"],
  "AI & Lending": ["NCNO", "UPST"],
};

const TICKER_NAMES: Record<string, string> = {
  ALKT: "Alkami Technology",
  VYX: "NCR Voyix",
  QTWO: "Q2 Holdings",
  FIS: "FIS",
  FI: "Fiserv",
  JKHY: "Jack Henry",
  ACIW: "ACI Worldwide",
  GDOT: "Green Dot",
  MQ: "Marqeta",
  NCNO: "nCino",
  UPST: "Upstart",
};

function formatChange(change: number, pct: number): string {
  const color = change >= 0 ? "#1a6e1a" : "#b91c1c";
  const sign = change >= 0 ? "+" : "";
  return `<span style="color:${color}">${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
}

function buildTickerTable(tickers: TickerData[], date: string): string {
  const bySymbol = Object.fromEntries(tickers.map((t) => [t.symbol, t]));

  const groupRows = Object.entries(TICKER_GROUPS)
    .map(([group, symbols]) => {
      const rows = symbols
        .map((sym) => {
          const t = bySymbol[sym];
          if (!t) return "";
          return `<tr>
            <td style="padding:4px 12px 4px 0;font-family:Arial,sans-serif;font-size:13px;color:#333">${TICKER_NAMES[sym]} (${sym})</td>
            <td style="padding:4px 0;font-family:Arial,sans-serif;font-size:13px;color:#333;text-align:right">$${t.price.toFixed(2)}</td>
            <td style="padding:4px 0 4px 12px;font-family:Arial,sans-serif;font-size:13px;text-align:right">${formatChange(t.change, t.changePercent)}</td>
          </tr>`;
        })
        .join("");
      return `<tr><td colspan="3" style="padding:10px 0 4px;font-family:Arial,sans-serif;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.05em">${group}</td></tr>${rows}`;
    })
    .join("");

  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;margin-top:32px">
    <tr><td colspan="3" style="padding:16px 0 8px;font-family:Arial,sans-serif;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.05em">Market Snapshot</td></tr>
    ${groupRows}
    <tr><td colspan="3" style="padding:12px 0 0;font-family:Arial,sans-serif;font-size:11px;color:#bbb">Prices as of 10:30am ET · ${date} · Data via Finnhub</td></tr>
  </table>`;
}

export function buildEmailText(
  stories: Story[],
  tickers: TickerData[] | null,
  date: string
): string {
  const lines: string[] = [
    "THE DAILY FINTECH BRIEFING",
    date,
    "",
    "─".repeat(60),
    "",
  ];

  stories.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.headline}`);
    lines.push("");
    lines.push(s.body);
    lines.push(`   — ${s.cite}: ${s.url}`);
    lines.push("");
  });

  if (tickers && tickers.length > 0) {
    lines.push("─".repeat(60));
    lines.push("MARKET SNAPSHOT");
    lines.push(`Prices as of 10:30am ET · ${date} · Data via Finnhub`);
    lines.push("");
    for (const [group, symbols] of Object.entries(TICKER_GROUPS)) {
      lines.push(group.toUpperCase());
      for (const sym of symbols) {
        const t = tickers.find((x) => x.symbol === sym);
        if (!t) continue;
        const sign = t.change >= 0 ? "+" : "";
        lines.push(`  ${TICKER_NAMES[sym]} (${sym})  $${t.price.toFixed(2)}  ${sign}${t.change.toFixed(2)} (${sign}${t.changePercent.toFixed(2)}%)`);
      }
      lines.push("");
    }
  }

  lines.push("─".repeat(60));
  lines.push("© 2026 Cloudflash, Inc.");
  lines.push("Unsubscribe: https://cloudflash.com/unsubscribe?token={{UNSUBSCRIBE_TOKEN}}");

  return lines.join("\n");
}

export function buildEmailHtml(
  stories: Story[],
  tickers: TickerData[] | null,
  date: string
): string {
  const storyHtml = stories
    .map(
      (s, i) => `<tr><td style="padding:0 0 32px">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="vertical-align:top;text-align:center;width:70px;font-family:Arial,sans-serif;font-size:32px;font-weight:bold;color:#2179c8;line-height:1;padding:0 20px 20px 0">${i + 1}</td>
        <td style="vertical-align:top">
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:19px;font-weight:bold;color:#1a1a1a;line-height:1.3">${s.headline}</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:15px;color:#333;line-height:1.7">${s.body} <a href="${s.url}" style="font-family:Arial,sans-serif;font-size:12px;color:#999;white-space:nowrap;text-decoration:none">${s.cite} ↗</a></p>
        </td>
      </tr></table>
    </td></tr>`
    )
    .join("");

  const tickerHtml = tickers
    ? buildTickerTable(tickers, date)
    : `<p style="font-family:Arial,sans-serif;font-size:13px;color:#999;margin-top:32px">Market data unavailable for this issue.</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"></head>
<body style="margin:0;padding:0;background:#fff">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;padding:40px 24px">
      <tr><td style="padding:0 0 16px">
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px"><tr>
          <td style="vertical-align:middle;padding:0 10px 20px 0">
            <img src="https://cloudflash.com/logo.png" width="52" height="52" alt="Cloudflash" style="display:block">
          </td>
          <td style="vertical-align:middle;padding:0 0 20px 0">
            <h1 style="margin:0;font-family:Arial,sans-serif;font-size:36px;font-weight:bold;color:#111;line-height:1.1">The Daily Fintech Briefing</h1>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family:Arial,sans-serif;font-size:14px;color:#666">${date}</td>
          <td style="font-family:Arial,sans-serif;font-size:12px;color:#999;text-align:right">Forwarded this email? <a href="https://cloudflash.com/fintech" style="color:#999;text-decoration:underline">Subscribe here</a> for more.</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:0 0 16px;border-bottom:3px solid #111"></td></tr>
      <tr><td style="padding:16px 0 0"></td></tr>
      ${storyHtml}
      <tr><td>${tickerHtml}</td></tr>
      <tr><td style="padding:32px 0 0;border-top:1px solid #eee;font-family:Arial,sans-serif;font-size:12px;color:#bbb;line-height:1.6">
        <p style="margin:0 0 4px">Sources: PYMNTS · Finextra · American Banker · Reuters · Bloomberg · Finnhub</p>
        <p style="margin:0">&#169; 2026 Cloudflash, Inc. · Est. 2000 · <a href="https://cloudflash.com/unsubscribe?token={{UNSUBSCRIBE_TOKEN}}" style="color:#bbb">Unsubscribe</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
