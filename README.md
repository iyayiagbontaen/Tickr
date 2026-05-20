# Tickr

A daily stock dashboard with AI-powered sentiment analysis. Track the companies you follow, summarize the news and Reddit chatter, get a one-glance read on whether the day looks bullish, bearish, or neutral.

Built for UCLA Anderson MGMT298D (Science and Strategy of AI), Product Sprint.

**Live demo:** https://tickr-production-2ac9.up.railway.app

## Team

- Iyayi Agbontaen
- Issac Wurth
- Rachel Stewart
- Sreeja Kadari

---

## What it does

For each ticker you add to your watchlist, Tickr shows a card with:

- Current stock price and day change (live from Finnhub)
- AI-generated bullish / bearish / neutral sentiment + numeric score from -1 to +1
- A one-paragraph daily summary written by Google Gemini, based on the news and Reddit posts it sees
- Top 3 recent headlines from CNBC, MarketWatch, Yahoo Finance, etc. (via NewsAPI)
- Top 2 Reddit posts from r/wallstreetbets, r/stocks, and r/investing
- A "Catalyst" line that flags rumors, upcoming earnings, M&A activity, or layoffs

Add tickers with the input box at the top. Remove with the "×" button on each card. The watchlist persists in your browser via localStorage — no accounts, no login, no database.

## Screenshot

_Add a screenshot here: in the GitHub web editor, drag a PNG of the dashboard into this section and it will upload automatically._

## Tech stack

- **Backend:** Node.js 20+ with Express
- **Frontend:** Vanilla HTML / CSS / JavaScript, no build step
- **AI:** Google Gemini (`gemini-2.5-flash`) via `@google/genai`
- **Data sources:** Finnhub (prices), NewsAPI (headlines), public Reddit JSON endpoint (community chatter)
- **Deployment:** Railway

## Run it locally

You'll need Node.js 20 or later and your own API keys. All three providers have free tiers that are more than enough for development.

**1. Clone and install**

```bash
git clone https://github.com/iyayiagbontaen/Tickr.git myapp
cd myapp
npm install
```

**2. Get your API keys**

Each one takes about two minutes to sign up for:

- Gemini: https://aistudio.google.com/app/apikey
- Finnhub: https://finnhub.io
- NewsAPI: https://newsapi.org

**3. Create a `local.env` file** in the project root with your keys:

```
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
FINNHUB_API_KEY=your_finnhub_key
NEWS_API_KEY=your_newsapi_key
```

This file is in `.gitignore` and will never be committed. Each team member uses their own keys — don't share them.

**4. Start the app**

```bash
npm start
```

Open http://localhost:3000 in your browser.

## How it works

- `GET /api/ticker/:symbol` is the main endpoint. It fetches Finnhub price, Finnhub company profile, NewsAPI headlines, and Reddit posts in parallel, then sends the combined context to Gemini for a structured sentiment response.
- Responses are cached in memory for 10 minutes per ticker. Add `?force=1` to bypass the cache.
- `GET /api/health` returns which keys are configured and which tickers are currently cached. Useful for debugging.
- The frontend (`public/app.js`) reads/writes the watchlist to `localStorage` and renders cards from a `<template>` element.

The system prompt that guides Gemini's sentiment output lives at the top of `server.js` as a clearly labeled constant. Edit it there to tune behavior.

## Project structure

```
myapp/
├── server.js              # Express server + API endpoints
├── public/
│   ├── index.html         # Dashboard layout
│   ├── app.js             # Frontend logic (localStorage, fetch, render)
│   └── styles.css         # Styling
├── AppPlan.md             # Product spec (in/out of scope)
├── GITHUB_SETUP.md        # Team onboarding instructions
├── App_Development_Kit.html  # Original kit instructions from the course
├── package.json
├── .gitignore
└── local.env              # API keys (gitignored, create your own)
```

## Deployment

The live version is on Railway. To deploy your own copy:

1. Sign up at https://railway.com.
2. From the project folder, run `npm run railway -- login`, then `npm run railway -- init`, then `npm run railway -- up`.
3. Set your API keys as Railway environment variables with `npm run railway -- variables --set "KEY=value"` for each of `GEMINI_API_KEY`, `GEMINI_MODEL`, `FINNHUB_API_KEY`, `NEWS_API_KEY`. **Do not set `PORT`** — Railway sets it automatically.
4. Redeploy with `npm run railway -- up`, then run `npm run railway -- domain` to get a public URL.

Full deployment walkthrough is in `App_Development_Kit.html` Phase 3.

## For team members

See `GITHUB_SETUP.md` for the full clone-install-keys-run workflow plus day-to-day git commands.

Quick version:

```bash
git pull                                # before you start working
# ... make changes, test with npm start ...
git add .
git commit -m "what you changed"
git push                                # when you're done
```

## Known limitations

- **NewsAPI free tier** has a 24-hour delay and 100 requests/day cap. Headlines may be a day old, and rapid refreshing will hit the cap.
- **News matching is keyword-based on the ticker symbol**, so some unrelated articles (e.g. PyPI packages that mention "AAPL") can sneak through. A v2 improvement would be to search by company name instead.
- **Reddit rate-limits aggressive polling.** The 10-minute server cache protects against most of this, but rapid manual refreshes can return 429 errors.
- **Cache is in-memory only.** Restarting the server (or a fresh Railway deploy) clears it.

## Disclaimer

This is a school project. Not financial advice. Data quality depends on free-tier APIs and may be incomplete, delayed, or wrong. Don't make trading decisions based on what this app says.

## Credits

Built for **MGMT298D: Science and Strategy of AI** at UCLA Anderson, using the course's App Development Kit as a starting point. Powered by Google Gemini, Finnhub, NewsAPI, and Reddit's public JSON API.
