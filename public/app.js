// =========================================================================
// Tickr -- client-side dashboard
// Watchlist is persisted in localStorage. No login, no accounts.
// =========================================================================

const STORAGE_KEY = 'tickr_watchlist';
const DEFAULT_TICKERS = ['AAPL', 'NVDA', 'TSLA'];

const cardsContainer = document.getElementById('cards');
const cardTemplate = document.getElementById('card-template');
const emptyState = document.getElementById('empty-state');
const statusLine = document.getElementById('status-line');
const addForm = document.getElementById('add-form');
const tickerInput = document.getElementById('ticker-input');
const refreshAllBtn = document.getElementById('refresh-all');

// In-memory map: ticker -> card element, used so we can re-render in place.
const cardMap = new Map();

// -------------------------------------------------------------------------
// Watchlist storage
// -------------------------------------------------------------------------
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_TICKERS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TICKERS];
    return parsed.filter((t) => typeof t === 'string' && t.length > 0);
  } catch {
    return [...DEFAULT_TICKERS];
  }
}

function saveWatchlist(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded etc. -- ignore for v1.
  }
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const list = loadWatchlist();
  if (list.length === 0) {
    showEmptyState(true);
  } else {
    showEmptyState(false);
    list.forEach(renderInitialCard);
    refreshAll();
  }
});

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = tickerInput.value.trim().toUpperCase();
  if (!raw) return;
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(raw)) {
    setStatus(`"${raw}" doesn't look like a valid ticker.`);
    return;
  }
  const watchlist = loadWatchlist();
  if (watchlist.includes(raw)) {
    setStatus(`${raw} is already on your watchlist.`);
    return;
  }
  watchlist.push(raw);
  saveWatchlist(watchlist);
  tickerInput.value = '';
  setStatus(`Added ${raw}.`);
  showEmptyState(false);
  renderInitialCard(raw);
  fetchTicker(raw);
});

refreshAllBtn.addEventListener('click', () => refreshAll(true));

// -------------------------------------------------------------------------
// Card rendering
// -------------------------------------------------------------------------
function renderInitialCard(ticker) {
  if (cardMap.has(ticker)) return;
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.ticker = ticker;
  node.querySelector('.ticker').textContent = ticker;
  node.querySelector('.company-name').textContent = '';
  node.querySelector('.remove-btn').addEventListener('click', () => removeTicker(ticker));
  node.querySelector('.card-refresh').addEventListener('click', () => fetchTicker(ticker, true));
  cardsContainer.appendChild(node);
  cardMap.set(ticker, node);
}

function removeTicker(ticker) {
  const list = loadWatchlist().filter((t) => t !== ticker);
  saveWatchlist(list);
  const node = cardMap.get(ticker);
  if (node) {
    node.remove();
    cardMap.delete(ticker);
  }
  setStatus(`Removed ${ticker}.`);
  if (list.length === 0) showEmptyState(true);
}

function showEmptyState(show) {
  emptyState.hidden = !show;
}

function setStatus(text) {
  statusLine.textContent = text;
  if (text) {
    clearTimeout(setStatus._timer);
    setStatus._timer = setTimeout(() => {
      statusLine.textContent = '';
    }, 4000);
  }
}

// -------------------------------------------------------------------------
// Data fetching
// -------------------------------------------------------------------------
async function fetchTicker(ticker, force = false) {
  const card = cardMap.get(ticker);
  if (!card) return;
  card.dataset.state = 'loading';
  card.querySelector('.ai-summary').textContent = 'Loading...';

  try {
    const url = `/api/ticker/${encodeURIComponent(ticker)}${force ? '?force=1' : ''}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Server returned ${r.status}`);
    populateCard(card, j);
    card.dataset.state = 'ready';
  } catch (e) {
    card.dataset.state = 'error';
    card.querySelector('.ai-summary').textContent = `Could not load: ${e.message}`;
  }
}

async function refreshAll(force = false) {
  const list = loadWatchlist();
  if (list.length === 0) return;
  setStatus(force ? 'Refreshing all tickers...' : 'Loading tickers...');
  await Promise.all(list.map((t) => fetchTicker(t, force)));
  setStatus('Done.');
}

// -------------------------------------------------------------------------
// Card populating
// -------------------------------------------------------------------------
function populateCard(card, data) {
  card.querySelector('.company-name').textContent = data.company_name && data.company_name !== data.ticker
    ? data.company_name
    : '';

  // Price + change
  const priceEl = card.querySelector('.price');
  const changeEl = card.querySelector('.price-change');
  if (data.price?.data) {
    const p = data.price.data;
    priceEl.textContent = `$${formatNumber(p.current)}`;
    const sign = p.change >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${formatNumber(p.change)} (${sign}${formatNumber(p.change_pct)}%)`;
    changeEl.dataset.direction = p.change >= 0 ? 'up' : 'down';
  } else {
    priceEl.textContent = '--';
    changeEl.textContent = data.price?.error ? 'price unavailable' : '--';
    changeEl.dataset.direction = 'flat';
  }

  // Sentiment
  const ai = data.ai || {};
  const badge = card.querySelector('.sentiment-badge');
  const scoreEl = card.querySelector('.sentiment-score');
  if (ai.error) {
    badge.textContent = 'no AI';
    badge.dataset.sentiment = 'neutral';
    scoreEl.textContent = '';
  } else {
    const sentiment = (ai.sentiment || 'neutral').toLowerCase();
    badge.textContent = sentiment;
    badge.dataset.sentiment = sentiment;
    scoreEl.textContent = typeof ai.score === 'number' ? `score ${ai.score.toFixed(2)}` : '';
  }

  // Summary + catalysts
  const summary = ai.error
    ? `AI unavailable: ${ai.error}`
    : (ai.summary || 'No summary available.');
  const catalyst = ai.rumors_or_catalysts && ai.rumors_or_catalysts !== 'None notable.'
    ? `\n\nCatalyst: ${ai.rumors_or_catalysts}`
    : '';
  card.querySelector('.ai-summary').textContent = summary + catalyst;

  // Headlines
  const headlinesList = card.querySelector('.headlines-list');
  headlinesList.innerHTML = '';
  const headlineItems = (data.headlines?.items || []).slice(0, 3);
  if (headlineItems.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = data.headlines?.error ? 'News unavailable.' : 'No recent headlines.';
    headlinesList.appendChild(li);
  } else {
    headlineItems.forEach((h) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = h.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = h.title;
      const src = document.createElement('span');
      src.className = 'source';
      src.textContent = h.source ? ` -- ${h.source}` : '';
      li.appendChild(a);
      li.appendChild(src);
      headlinesList.appendChild(li);
    });
  }

  // Reddit
  const redditList = card.querySelector('.reddit-list');
  redditList.innerHTML = '';
  const redditItems = (data.reddit?.items || []).slice(0, 2);
  if (redditItems.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = data.reddit?.error ? 'Reddit unavailable.' : 'No recent posts.';
    redditList.appendChild(li);
  } else {
    redditItems.forEach((p) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = p.title;
      const sub = document.createElement('span');
      sub.className = 'source';
      sub.textContent = ` -- r/${p.subreddit} (${p.score} pts)`;
      li.appendChild(a);
      li.appendChild(sub);
      redditList.appendChild(li);
    });
  }

  // Footer
  const cachedNote = data.cached ? ' (cached)' : '';
  card.querySelector('.card-footer-text').textContent =
    `Updated ${new Date(data.fetched_at).toLocaleTimeString()}${cachedNote}`;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
