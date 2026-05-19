# AppPlan.md

> This file is the spec for the app. Read this **before** editing anything. Treat the "In Scope" and "Out of Scope" sections as binding — do not add features that aren't listed under "In Scope" without asking.

---

## 1. App Idea

**Working name:** Tickr (placeholder — easy to change later)

**One-line pitch:** A dashboard that gives you a daily one-pager for each company you follow — combining news headlines, Reddit sentiment, stock price, and an AI-generated bullish/bearish read.

**Use case:** A user wants to keep tabs on 3–8 companies without reading 15 articles each morning. They open the app once a day, see one card per company with the price, a one-paragraph AI summary, a bull/bear score, and the top headlines/Reddit posts. They can click headlines to read more, and add or remove tickers as their watchlist changes.

**Intended user:** Retail investors, finance students, or anyone tracking a personal watchlist. For this school project, assume an MBA student demoing it to a class.

---

## 2. User Flow

1. User opens the app and sees their saved tickers as cards in a grid (default seed: `AAPL`, `NVDA`, `TSLA`).
2. Each card shows: ticker + company name, current price + % change today, a bull/bear/neutral badge with a score, a one-paragraph AI summary, top 3 news headlines (linked), top 2 Reddit posts (linked).
3. User can add a ticker via an input box at the top (e.g. types `MSFT`, presses Enter).
4. User can remove a ticker via an "x" button on each card.
5. User can hit a single "Refresh all" button to re-fetch everything.
6. Saved tickers persist in browser `localStorage` — no login, no database.

---

## 3. In Scope (build this)

- Add/remove/persist tickers (localStorage only)
- Stock price + % change (free API — Finnhub or Alpha Vantage free tier preferred)
- News headlines for each ticker (free API — NewsAPI.org or Marketaux; this is what covers CNBC, MarketWatch, etc.)
- Reddit posts mentioning the ticker from r/wallstreetbets, r/stocks, r/investing (public Reddit JSON API — no auth needed for read-only)
- Gemini call per ticker that takes the headlines + Reddit titles and returns structured JSON: `{sentiment, score, summary, key_themes}`
- A clean dashboard layout with cards
- A single "Refresh all" button + a per-card refresh button
- Loading states (spinners or "Loading…" text) so the user isn't staring at a blank card
- Graceful error handling — if one API fails, the rest of the card still renders

## 4. Out of Scope (do NOT build, even if it seems easy)

- Twitter / X integration (paid API, not worth it)
- Unusual Whales (paid)
- Hedge fund 13F / institutional flow data (delayed and complex)
- Industry-wide layoff tracker (no good free API)
- User accounts, login, signup, OAuth
- Database (Postgres, Mongo, anything) — localStorage is enough
- Email digests, push notifications, scheduling
- A chatbot interface — this is a dashboard, not a chat
- Charts/graphs of historical price — current price + % change is enough for v1
- Mobile-specific app — responsive web is fine

If a feature feels useful but isn't listed under "In Scope," add it to a `// FUTURE:` comment instead of building it.

---

## 5. Model Behavior (Gemini)

**System prompt** (make this a clearly labeled constant at the top of the server file so the team can edit it):

```
You are a financial news analyst. You will receive a JSON object containing:
- ticker: a stock ticker symbol
- company_name: the company name
- headlines: an array of recent news headlines (with sources)
- reddit_posts: an array of recent Reddit post titles from investing subreddits

Your job is to return ONLY a JSON object with this exact shape, no preamble, no markdown fences:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "score": <number from -1.0 (very bearish) to 1.0 (very bullish)>,
  "summary": "<one paragraph, 2-4 sentences, plain English, summarizing what's happening with this company today>",
  "key_themes": ["<short phrase>", "<short phrase>", "<short phrase>"],
  "rumors_or_catalysts": "<one sentence on any M&A talk, earnings, layoffs, or other catalysts — or 'None notable.' if there are none>"
}

Be neutral and factual. Do not give investment advice. If sources are sparse or contradictory, say so in the summary and lean toward "neutral".
```

**Model:** `gemini-2.5-flash` (already wired up in the kit — fast and cheap, good enough for this).

---

## 6. Visual Design

- **Layout:** Centered container, max width ~1100px. Header bar at top with app name + "Add ticker" input + "Refresh all" button. Below it: a responsive grid of ticker cards (1 column on mobile, 2 on tablet, 3 on desktop).
- **Card structure:** Ticker + company name (large), price + % change (color-coded green/red), bull/bear badge, AI summary paragraph, "Top headlines" list (3 items), "From Reddit" list (2 items), small remove button (x) in the top-right corner.
- **Color palette:** White background, dark navy (`#0F2742`) for headers and text, a single accent color (`#3B82F6` blue) for buttons and links, green (`#16A34A`) for bullish/up, red (`#DC2626`) for bearish/down, gray (`#6B7280`) for neutral and secondary text.
- **Typography:** System font stack (Inter if available, otherwise -apple-system / Segoe UI / sans-serif). Generous spacing, no busy borders.
- **Style direction:** Clean, professional, "Bloomberg-lite." Not a meme app, not a fintech bro app. Looks like something an MBA student would show to a hiring manager.

---

## 7. Data Sources & APIs

| Source | What it gives us | API | Cost |
|---|---|---|---|
| Finnhub (preferred) or Alpha Vantage | Stock price + day change | Free tier, requires API key | Free |
| NewsAPI.org or Marketaux | News headlines (CNBC, MarketWatch, Reuters, etc.) | Free tier, requires API key | Free |
| Reddit | Posts from r/wallstreetbets, r/stocks, r/investing | Public JSON endpoint (`https://www.reddit.com/r/wallstreetbets/search.json?q=TICKER&restrict_sr=1&limit=5&sort=new`) | Free, no auth |
| Gemini | Sentiment + summary | `gemini-2.5-flash` via API key already in kit | Free tier covers this |

**Important:** All third-party API keys go in `local.env` (locally) and Railway environment variables (in production). Never commit keys to git.

Add these to `local.env` alongside the existing `GEMINI_API_KEY`:
```
FINNHUB_API_KEY=your_finnhub_key_here
NEWS_API_KEY=your_news_api_key_here
```

---

## 8. Architecture (keep it simple)

- **Backend:** Single Node.js/Express server (already scaffolded in the kit). One route per data source — e.g. `GET /api/ticker/:symbol` returns `{price, change, headlines, reddit, ai_summary}` in one combined response. The server does the API key calls so keys never touch the browser.
- **Frontend:** Plain HTML + vanilla JS + a single CSS file. No React, no build step. Tickers stored in `localStorage` under key `tickr_watchlist`. On page load, read watchlist, fetch `/api/ticker/:symbol` for each, render cards.
- **Caching:** In-memory cache on the server keyed by ticker, TTL 10 minutes. This is important — free API tiers will throttle you fast if you re-fetch on every page reload.
- **Error handling:** If any sub-source fails (e.g. Reddit times out), the card still renders with whatever data did come back, and shows a small "couldn't load Reddit" note instead of breaking the whole page.

---

## 9. Iteration Plan

**v1 (target: end of week 1)** — Get the dashboard rendering with real data for 3 hardcoded tickers. No add/remove yet. No caching. Just prove the pipeline works end-to-end.

**v2 (target: mid week 2)** — Add ticker add/remove with localStorage, refresh button, error handling, server-side cache, visual polish.

**v3 (stretch, if time allows)** — Per-card "Ask about this company" input that sends a free-form question + that day's context to Gemini. This is the hybrid chat escape hatch we discussed.

---

## 10. Notes for the Coding Assistant

- This is a school project. Optimize for "works reliably and looks clean," not for production-grade architecture.
- Do not introduce new frameworks (no React, Next.js, TypeScript, Tailwind, etc.). The starter stack is fine.
- Keep the system prompt clearly labeled and easy to edit — the team will tune it.
- After making changes, tell the user exactly which files changed and how to test locally.
- If the user asks for a feature in the "Out of Scope" list, push back and ask if they really want to add it before building it.
