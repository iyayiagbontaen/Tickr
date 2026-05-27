import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, 'local.env') });

const app = express();
const port = process.env.PORT || 3000;
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache, 10 minute TTL.
// Resets whenever the server restarts -- that's fine for a school project.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key: ticker (uppercased), value: {data, expires}

// =========================================================================
// SYSTEM PROMPT
// Edit this to tune Gemini's sentiment behavior.
// =========================================================================
const SYSTEM_PROMPT = `You are a financial news analyst. You will receive a JSON object containing:
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
  "rumors_or_catalysts": "<one sentence on any M&A talk, earnings, layoffs, or other catalysts -- or 'None notable.' if there are none>"
}

Be neutral and factual. Do not give investment advice. If sources are sparse or contradictory, say so in the summary and lean toward "neutral".`;

// Separate prompt for the Market Pulse cross-watchlist synthesis.
const PULSE_PROMPT = `You are a market analyst writing a daily briefing.

You will receive a JSON object containing:
- tickers: the list of stock tickers on the user's watchlist
- per_ticker: an array of {ticker, company, change_pct, headlines[], reddit_titles[]}

Synthesize ACROSS the whole watchlist -- do not just summarize each ticker individually.

Return ONLY a JSON object with this exact shape, no preamble, no markdown fences:
{
  "mood": "bullish" | "bearish" | "mixed" | "neutral",
  "summary": "<2-3 sentences in plain English about what the market is talking about across these tickers today>",
  "themes": ["<theme 1>", "<theme 2>", "<theme 3>"],
  "notable": "<one sentence calling out the biggest mover or most newsworthy ticker today, e.g. 'NVDA leads on continued AI-spend optimism.'>"
}

Themes should be short, punchy phrases (2-5 words each) like "AI capex surge", "Fed rate cut hopes", "China tariff fears", "earnings season", "Treasury yield jitters". Use 3 to 5 themes. Be specific to what the headlines actually say -- do not invent themes that aren't supported. If headlines/posts are too sparse or contradictory, say so in summary and use "mixed" or "neutral" for mood.`;

// Ask Tickr -- conversational follow-up on a specific ticker.
const ASK_PROMPT = `You are Tickr, a conversational financial assistant inside a stock dashboard.

You will be given context about a single ticker (price, change, recent headlines, recent Reddit posts, and your most recent sentiment summary). Then the user will ask follow-up questions about that ticker.

Rules:
- Answer in 2-4 short sentences. Plain English. No markdown.
- Ground answers in the context provided. If the context doesn't support an answer, say so honestly (e.g. "I don't see news on that in today's sources").
- You are NOT a financial advisor. Never tell the user to buy, sell, or hold. If asked for investment advice, redirect to discussing what the evidence suggests, not what they should do.
- It's fine to acknowledge uncertainty and present both sides when the data is mixed.
- Stay on-topic -- if asked about something totally unrelated to investing or this ticker, gently redirect.`;

// =========================================================================
// ROUTES
// =========================================================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: modelName,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasFinnhubKey: Boolean(process.env.FINNHUB_API_KEY),
    hasNewsKey: Boolean(process.env.NEWS_API_KEY),
    cachedTickers: [...cache.keys()]
  });
});

// Main endpoint: GET /api/ticker/:symbol
// Returns combined Finnhub price + NewsAPI headlines + Reddit posts + Gemini sentiment.
// Add ?force=1 to bypass the cache.
app.get('/api/ticker/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  if (!symbol || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid ticker symbol.' });
  }

  const forceRefresh = req.query.force === '1';
  if (!forceRefresh) {
    const cached = cache.get(symbol);
    if (cached && cached.expires > Date.now()) {
      return res.json({ ...cached.data, cached: true });
    }
  }

  // Fetch data sources in parallel. Each can fail independently
  // and the card will still render with whatever did succeed.
  const [quote, profile, headlines, redditPosts, sparkline] = await Promise.all([
    fetchFinnhubQuote(symbol),
    fetchFinnhubProfile(symbol),
    fetchNewsHeadlines(symbol),
    fetchRedditPosts(symbol),
    fetchSparkline(symbol)
  ]);

  const company_name = profile?.name || symbol;
  const logo_url = profile?.logo || null;

  const aiAnalysis = await analyzeWithGemini({
    ticker: symbol,
    company_name,
    headlines: headlines.items,
    reddit_posts: redditPosts.items
  });

  const payload = {
    ticker: symbol,
    company_name,
    logo_url,
    price: quote,
    sparkline,
    headlines,
    reddit: redditPosts,
    ai: aiAnalysis,
    fetched_at: new Date().toISOString(),
    cached: false
  };

  cache.set(symbol, { data: payload, expires: Date.now() + CACHE_TTL_MS });
  res.json(payload);
});

// Market Pulse: synthesize across the whole watchlist.
// Body: { tickers: ["AAPL", "NVDA", ...] }
// Reuses each ticker's cached data when available so it doesn't hammer APIs.
app.post('/api/pulse', async (req, res) => {
  const raw = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
  const tickers = raw
    .map((t) => String(t || '').trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t))
    .slice(0, 20); // safety cap
  if (tickers.length === 0) {
    return res.status(400).json({ error: 'No valid tickers provided.' });
  }

  // Pull from cache when possible; fall back to fresh fetches for cold tickers.
  const perTicker = await Promise.all(tickers.map(async (sym) => {
    const cached = cache.get(sym);
    if (cached && cached.expires > Date.now()) {
      const d = cached.data;
      return {
        ticker: sym,
        company: d.company_name,
        change_pct: d.price?.data?.change_pct ?? null,
        headlines: (d.headlines?.items || []).slice(0, 3).map((h) => h.title),
        reddit_titles: (d.reddit?.items || []).slice(0, 3).map((p) => p.title)
      };
    }
    // No cache entry -- be conservative, fetch the cheap stuff only.
    const [quote, headlines, reddit] = await Promise.all([
      fetchFinnhubQuote(sym),
      fetchNewsHeadlines(sym),
      fetchRedditPosts(sym)
    ]);
    return {
      ticker: sym,
      company: sym,
      change_pct: quote?.data?.change_pct ?? null,
      headlines: (headlines.items || []).slice(0, 3).map((h) => h.title),
      reddit_titles: (reddit.items || []).slice(0, 3).map((p) => p.title)
    };
  }));

  if (!process.env.GEMINI_API_KEY) {
    return res.json({ error: 'Missing GEMINI_API_KEY' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const payload = { tickers, per_ticker: perTicker };
    const prompt = `${PULSE_PROMPT}\n\nInput:\n${JSON.stringify(payload, null, 2)}`;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt
    });
    const text = (response.text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      return res.json({
        ...parsed,
        ticker_count: tickers.length,
        generated_at: new Date().toISOString()
      });
    } catch {
      return res.json({
        mood: 'neutral',
        summary: text.slice(0, 400),
        themes: [],
        notable: '',
        parse_warning: 'AI response was not valid JSON; showing raw text.',
        ticker_count: tickers.length,
        generated_at: new Date().toISOString()
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Gemini call failed' });
  }
});

// Ask Tickr: conversational follow-up on a specific ticker.
// Body: { ticker: "AAPL", question: "...", history: [{role: "user"|"model", text: "..."}] }
app.post('/api/ask', async (req, res) => {
  const symbol = String(req.body?.ticker || '').trim().toUpperCase();
  const question = String(req.body?.question || '').trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid ticker symbol.' });
  }
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'Question is too long (max 500 chars).' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
  }

  // Use cached ticker data when available (it's fresh enough -- 10 min TTL).
  // If not cached, do a fresh fetch so the chat still works for new tickers.
  let tickerData = cache.get(symbol)?.data;
  if (!tickerData || cache.get(symbol).expires <= Date.now()) {
    const [quote, profile, headlines, redditPosts] = await Promise.all([
      fetchFinnhubQuote(symbol),
      fetchFinnhubProfile(symbol),
      fetchNewsHeadlines(symbol),
      fetchRedditPosts(symbol)
    ]);
    tickerData = {
      ticker: symbol,
      company_name: profile?.name || symbol,
      price: quote,
      headlines,
      reddit: redditPosts,
      ai: cache.get(symbol)?.data?.ai || null
    };
  }

  // Compact context object for the prompt.
  const context = {
    ticker: symbol,
    company: tickerData.company_name,
    price_current: tickerData.price?.data?.current ?? null,
    change_pct: tickerData.price?.data?.change_pct ?? null,
    recent_sentiment: tickerData.ai?.sentiment || null,
    recent_score: tickerData.ai?.score ?? null,
    recent_summary: tickerData.ai?.summary || null,
    recent_headlines: (tickerData.headlines?.items || []).slice(0, 5).map((h) => `${h.title} (${h.source})`),
    recent_reddit: (tickerData.reddit?.items || []).slice(0, 5).map((p) => `${p.title} [r/${p.subreddit}]`)
  };

  // Build the Gemini contents array: system-style preface then history then new question.
  // @google/genai uses {role, parts:[{text}]} format; "model" for assistant turns.
  const preface = `${ASK_PROMPT}\n\nCONTEXT FOR ${symbol}:\n${JSON.stringify(context, null, 2)}`;
  const contents = [
    { role: 'user', parts: [{ text: preface }] },
    { role: 'model', parts: [{ text: `Got it -- I have the latest data for ${symbol}. What would you like to know?` }] }
  ];
  for (const turn of history.slice(-10)) {
    const role = turn.role === 'model' ? 'model' : 'user';
    const text = String(turn.text || '').slice(0, 1500);
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: question }] });

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: modelName,
      contents
    });
    const answer = (response.text || '').trim();
    return res.json({
      answer: answer || 'I could not generate a response. Try rephrasing.',
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Gemini call failed' });
  }
});

// =========================================================================
// DATA SOURCE HELPERS
// =========================================================================

async function fetchFinnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { error: 'Missing FINNHUB_API_KEY', data: null };
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
    const r = await fetch(url);
    if (!r.ok) return { error: `Finnhub returned ${r.status}`, data: null };
    const j = await r.json();
    if (!j || typeof j.c !== 'number' || j.c === 0) {
      return { error: 'No quote data (ticker may be invalid)', data: null };
    }
    return {
      data: {
        current: j.c,
        change: j.d,
        change_pct: j.dp,
        high: j.h,
        low: j.l,
        open: j.o,
        previous_close: j.pc
      }
    };
  } catch (e) {
    return { error: e.message || 'Finnhub quote fetch failed', data: null };
  }
}

async function fetchFinnhubProfile(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchNewsHeadlines(symbol) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return { error: 'Missing NEWS_API_KEY', items: [] };
  try {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&from=${fromDate}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${key}`;
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { error: `NewsAPI returned ${r.status}: ${body.slice(0, 120)}`, items: [] };
    }
    const j = await r.json();
    const items = (j.articles || []).slice(0, 5).map((a) => ({
      title: a.title,
      source: a.source?.name || '',
      url: a.url,
      published_at: a.publishedAt
    }));
    return { items };
  } catch (e) {
    return { error: e.message || 'NewsAPI fetch failed', items: [] };
  }
}

async function fetchSparkline(symbol) {
  // Pull ~1 month of daily close prices from Yahoo Finance's unofficial chart endpoint.
  // Used only for the tiny trend chart on each card. Falls back gracefully if blocked.
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 TickrDashboard/0.1 (school project)' }
    });
    if (!r.ok) return { error: `Yahoo returned ${r.status}`, points: [] };
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const points = closes.filter((c) => typeof c === 'number' && isFinite(c));
    return { points };
  } catch (e) {
    return { error: e.message || 'Sparkline fetch failed', points: [] };
  }
}

async function fetchRedditPosts(symbol) {
  try {
    const url = `https://www.reddit.com/r/wallstreetbets+stocks+investing/search.json?q=${encodeURIComponent(symbol)}&restrict_sr=on&sort=new&limit=10`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'TickrDashboard/0.1 (school project)' }
    });
    if (!r.ok) return { error: `Reddit returned ${r.status}`, items: [] };
    const j = await r.json();
    const posts = (j.data?.children || []).slice(0, 5).map((c) => ({
      title: c.data?.title || '',
      subreddit: c.data?.subreddit || '',
      url: c.data?.url || `https://www.reddit.com${c.data?.permalink || ''}`,
      score: c.data?.score ?? 0,
      created_utc: c.data?.created_utc ?? 0
    }));
    return { items: posts };
  } catch (e) {
    return { error: e.message || 'Reddit fetch failed', items: [] };
  }
}

async function analyzeWithGemini({ ticker, company_name, headlines, reddit_posts }) {
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'Missing GEMINI_API_KEY' };
  }
  if (!headlines.length && !reddit_posts.length) {
    return {
      sentiment: 'neutral',
      score: 0,
      summary: 'No recent news or Reddit chatter found for this ticker. The dashboard will show more useful information once data sources return results.',
      key_themes: [],
      rumors_or_catalysts: 'None notable.'
    };
  }
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const payload = {
      ticker,
      company_name,
      headlines: headlines.map((h) => `${h.title} (${h.source})`),
      reddit_posts: reddit_posts.map((p) => `${p.title} [r/${p.subreddit}]`)
    };
    const prompt = `${SYSTEM_PROMPT}\n\nInput:\n${JSON.stringify(payload, null, 2)}`;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt
    });
    const text = (response.text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.score === 'number') {
        parsed.score = Math.max(-1, Math.min(1, parsed.score));
      }
      return parsed;
    } catch {
      return {
        sentiment: 'neutral',
        score: 0,
        summary: text.slice(0, 400),
        key_themes: [],
        rumors_or_catalysts: 'None notable.',
        parse_warning: 'AI response was not valid JSON; showing raw text in summary.'
      };
    }
  } catch (e) {
    return { error: e.message || 'Gemini call failed' };
  }
}

app.listen(port, () => {
  console.log(`Tickr running at http://localhost:${port}`);
});
