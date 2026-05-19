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
  const [quote, profile, headlines, redditPosts] = await Promise.all([
    fetchFinnhubQuote(symbol),
    fetchFinnhubProfile(symbol),
    fetchNewsHeadlines(symbol),
    fetchRedditPosts(symbol)
  ]);

  const company_name = profile?.name || symbol;

  const aiAnalysis = await analyzeWithGemini({
    ticker: symbol,
    company_name,
    headlines: headlines.items,
    reddit_posts: redditPosts.items
  });

  const payload = {
    ticker: symbol,
    company_name,
    price: quote,
    headlines,
    reddit: redditPosts,
    ai: aiAnalysis,
    fetched_at: new Date().toISOString(),
    cached: false
  };

  cache.set(symbol, { data: payload, expires: Date.now() + CACHE_TTL_MS });
  res.json(payload);
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
