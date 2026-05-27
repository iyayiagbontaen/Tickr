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
const themeToggleBtn = document.getElementById('theme-toggle');

// -------------------------------------------------------------------------
// Theme (dark / light) -- persists in localStorage.
// -------------------------------------------------------------------------
const THEME_KEY = 'tickr_theme';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const icon = themeToggleBtn?.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
}
function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; }
  catch { return 'light'; }
}
applyTheme(loadTheme());
themeToggleBtn?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next);
});

// In-memory map: ticker -> card element, used so we can re-render in place.
const cardMap = new Map();

// Per-ticker chat history -- {role: 'user'|'model', text: string}[]. Session-only.
const chatHistory = new Map();

// Heatmap container -- one tile per ticker, colored by day change.
const heatmapEl = document.getElementById('heatmap');
const heatmapTiles = new Map(); // ticker -> tile element

// Market Pulse elements
const pulsePanel = document.getElementById('market-pulse');
const pulseSummaryEl = pulsePanel?.querySelector('.pulse-summary');
const pulseThemesEl = pulsePanel?.querySelector('.pulse-themes');
const pulseNotableEl = pulsePanel?.querySelector('.pulse-notable');
const pulseMoodBadge = pulsePanel?.querySelector('.pulse-mood-badge');
const pulseFooterEl = pulsePanel?.querySelector('.pulse-footer-text');
const pulseRefreshBtn = document.getElementById('pulse-refresh');
pulseRefreshBtn?.addEventListener('click', () => fetchPulse());

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
  if (addTicker(raw)) tickerInput.value = '';
});

refreshAllBtn.addEventListener('click', () => refreshAll(true));

// Empty-state starter chips. Delegated click so we don't bind in three places.
document.addEventListener('click', (event) => {
  const chip = event.target.closest('.starter-chip');
  if (!chip) return;
  const ticker = (chip.dataset.ticker || '').toUpperCase();
  if (ticker) addTicker(ticker);
});

function addTicker(rawIn) {
  const raw = String(rawIn || '').trim().toUpperCase();
  if (!raw) return false;
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(raw)) {
    setStatus(`"${raw}" doesn't look like a valid ticker.`);
    return false;
  }
  const watchlist = loadWatchlist();
  if (watchlist.includes(raw)) {
    setStatus(`${raw} is already on your watchlist.`);
    return false;
  }
  watchlist.push(raw);
  saveWatchlist(watchlist);
  setStatus(`Added ${raw}.`);
  showEmptyState(false);
  renderInitialCard(raw);
  fetchTicker(raw);
  return true;
}

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

  // Ask Tickr chat form.
  const askForm = node.querySelector('.ask-form');
  const askInput = node.querySelector('.ask-input');
  askForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = '';
    submitAsk(ticker, q);
  });

  cardsContainer.appendChild(node);
  cardMap.set(ticker, node);
  chatHistory.set(ticker, []);
}

function removeTicker(ticker) {
  const list = loadWatchlist().filter((t) => t !== ticker);
  saveWatchlist(list);
  const node = cardMap.get(ticker);
  if (node) {
    node.remove();
    cardMap.delete(ticker);
  }
  chatHistory.delete(ticker);
  removeHeatmapTile(ticker);
  setStatus(`Removed ${ticker}.`);
  if (list.length === 0) {
    showEmptyState(true);
    hidePulse();
    if (heatmapEl) heatmapEl.hidden = true;
  } else {
    fetchPulse();
  }
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
  if (list.length === 0) {
    hidePulse();
    return;
  }
  setStatus(force ? 'Refreshing all tickers...' : 'Loading tickers...');
  await Promise.all(list.map((t) => fetchTicker(t, force)));
  setStatus('Done.');
  // Kick off the cross-watchlist pulse synthesis. Reuses cached ticker data.
  fetchPulse();
}

// -------------------------------------------------------------------------
// Market Pulse
// -------------------------------------------------------------------------
async function fetchPulse() {
  if (!pulsePanel) return;
  const list = loadWatchlist();
  if (list.length === 0) {
    hidePulse();
    return;
  }
  showPulseLoading();
  try {
    const r = await fetch('/api/pulse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: list })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Server returned ${r.status}`);
    if (j.error) throw new Error(j.error);
    renderPulse(j);
  } catch (e) {
    pulsePanel.dataset.state = 'error';
    pulseSummaryEl.textContent = `Pulse unavailable: ${e.message}`;
    pulseThemesEl.innerHTML = '';
    pulseNotableEl.textContent = '';
    pulseFooterEl.textContent = '';
  }
}

function showPulseLoading() {
  pulsePanel.hidden = false;
  pulsePanel.dataset.state = 'loading';
  pulseSummaryEl.innerHTML = '<span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line short"></span>';
  pulseThemesEl.innerHTML = '';
  pulseNotableEl.textContent = '';
  pulseFooterEl.textContent = '';
  pulseMoodBadge.textContent = '...';
  pulseMoodBadge.dataset.mood = 'neutral';
}

function hidePulse() {
  if (!pulsePanel) return;
  pulsePanel.hidden = true;
}

function renderPulse(data) {
  pulsePanel.hidden = false;
  pulsePanel.dataset.state = 'ready';
  const mood = (data.mood || 'neutral').toLowerCase();
  pulseMoodBadge.textContent = mood;
  pulseMoodBadge.dataset.mood = mood;
  pulseSummaryEl.textContent = data.summary || 'No pulse summary available.';

  pulseThemesEl.innerHTML = '';
  (data.themes || []).slice(0, 5).forEach((t) => {
    const pill = document.createElement('span');
    pill.className = 'pulse-theme-pill';
    pill.textContent = t;
    pulseThemesEl.appendChild(pill);
  });

  pulseNotableEl.textContent = data.notable && data.notable !== 'None notable.' ? data.notable : '';

  const tickerCount = data.ticker_count || loadWatchlist().length;
  const time = data.generated_at ? new Date(data.generated_at).toLocaleTimeString() : '';
  pulseFooterEl.textContent = `Synthesized across ${tickerCount} ticker${tickerCount === 1 ? '' : 's'}${time ? ' at ' + time : ''}.`;
}

// -------------------------------------------------------------------------
// Card populating
// -------------------------------------------------------------------------
function populateCard(card, data) {
  card.querySelector('.company-name').textContent = data.company_name && data.company_name !== data.ticker
    ? data.company_name
    : '';

  // Logo + fallback letter
  renderLogo(card, data);

  // Price + change
  const priceEl = card.querySelector('.price');
  const changeEl = card.querySelector('.price-change');
  if (data.price?.data) {
    const p = data.price.data;
    priceEl.textContent = `$${formatNumber(p.current)}`;
    const sign = p.change >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${formatNumber(p.change)} (${sign}${formatNumber(p.change_pct)}%)`;
    changeEl.dataset.direction = p.change >= 0 ? 'up' : 'down';
    upsertHeatmapTile(data.ticker, p.change_pct, p.change);
  } else {
    priceEl.textContent = '--';
    changeEl.textContent = data.price?.error ? 'price unavailable' : '--';
    changeEl.dataset.direction = 'flat';
    upsertHeatmapTile(data.ticker, null, null);
  }

  // Sparkline (last ~30 days of closing prices)
  renderSparkline(card, data.sparkline?.points || []);

  // Sentiment
  const ai = data.ai || {};
  const badge = card.querySelector('.sentiment-badge');
  const scoreEl = card.querySelector('.sentiment-score');
  let sentimentForGauge = 'neutral';
  let scoreForGauge = 0;
  if (ai.error) {
    badge.textContent = 'no AI';
    badge.dataset.sentiment = 'neutral';
    scoreEl.textContent = '';
  } else {
    const sentiment = (ai.sentiment || 'neutral').toLowerCase();
    badge.textContent = sentiment;
    badge.dataset.sentiment = sentiment;
    scoreEl.textContent = typeof ai.score === 'number' ? `score ${ai.score.toFixed(2)}` : '';
    sentimentForGauge = sentiment;
    if (typeof ai.score === 'number') scoreForGauge = ai.score;
  }
  renderGauge(card, scoreForGauge, sentimentForGauge);

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
// Ask Tickr -- conversational chat per ticker
// -------------------------------------------------------------------------
async function submitAsk(ticker, question) {
  const card = cardMap.get(ticker);
  if (!card) return;
  const historyEl = card.querySelector('.ask-history');
  const submitBtn = card.querySelector('.ask-submit');
  const inputEl = card.querySelector('.ask-input');

  const history = chatHistory.get(ticker) || [];
  appendChatBubble(historyEl, 'user', question);
  const typingEl = appendTypingIndicator(historyEl);
  submitBtn.disabled = true;
  inputEl.disabled = true;

  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, question, history })
    });
    const j = await r.json();
    typingEl.remove();
    if (!r.ok) throw new Error(j.error || `Server returned ${r.status}`);
    const answer = j.answer || 'No response.';
    appendChatBubble(historyEl, 'model', answer);
    history.push({ role: 'user', text: question });
    history.push({ role: 'model', text: answer });
    // Cap history at last 10 turns to keep prompts manageable.
    if (history.length > 20) history.splice(0, history.length - 20);
    chatHistory.set(ticker, history);
  } catch (e) {
    typingEl.remove();
    appendChatBubble(historyEl, 'error', `Could not get an answer: ${e.message}`);
  } finally {
    submitBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function appendChatBubble(container, role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-${role}`;
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function appendTypingIndicator(container) {
  const el = document.createElement('div');
  el.className = 'chat-bubble chat-model chat-typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// -------------------------------------------------------------------------
// Heatmap helpers
// -------------------------------------------------------------------------
function upsertHeatmapTile(ticker, changePct, changeAbs) {
  if (!heatmapEl) return;
  heatmapEl.hidden = false;

  let tile = heatmapTiles.get(ticker);
  if (!tile) {
    tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'heatmap-tile';
    tile.dataset.ticker = ticker;
    tile.innerHTML = `<span class="ht-ticker"></span><span class="ht-change"></span>`;
    tile.addEventListener('click', () => {
      const card = cardMap.get(ticker);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    heatmapEl.appendChild(tile);
    heatmapTiles.set(ticker, tile);
  }

  tile.querySelector('.ht-ticker').textContent = ticker;
  const changeEl = tile.querySelector('.ht-change');

  if (typeof changePct === 'number' && isFinite(changePct)) {
    const sign = changePct >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${changePct.toFixed(2)}%`;
    tile.dataset.direction = changeAbs === 0 ? 'flat' : (changeAbs > 0 ? 'up' : 'down');
  } else {
    changeEl.textContent = '--';
    tile.dataset.direction = 'flat';
  }
}

function removeHeatmapTile(ticker) {
  const tile = heatmapTiles.get(ticker);
  if (tile) {
    tile.remove();
    heatmapTiles.delete(ticker);
  }
}

// -------------------------------------------------------------------------
// Visual helpers
// -------------------------------------------------------------------------
function renderLogo(card, data) {
  const img = card.querySelector('.company-logo');
  const fallback = card.querySelector('.logo-fallback');
  fallback.textContent = (data.ticker || '?').charAt(0);
  if (data.logo_url) {
    img.src = data.logo_url;
    img.alt = `${data.ticker} logo`;
    img.hidden = false;
    fallback.hidden = true;
    img.onerror = () => {
      img.hidden = true;
      fallback.hidden = false;
    };
  } else {
    img.hidden = true;
    fallback.hidden = false;
  }
}

function renderSparkline(card, points) {
  const linePath = card.querySelector('.sparkline-line');
  const areaPath = card.querySelector('.sparkline-area');
  if (!linePath || !areaPath) return;
  if (!points || points.length < 2) {
    linePath.setAttribute('d', '');
    areaPath.setAttribute('d', '');
    return;
  }
  const W = 120, H = 36, PAD = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = (W - PAD * 2) / (points.length - 1);

  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (H - PAD * 2) * (1 - (p - min) / range);
    return [x, y];
  });

  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  linePath.setAttribute('d', d);
  const area = `${d} L ${coords[coords.length - 1][0].toFixed(2)} ${H} L ${coords[0][0].toFixed(2)} ${H} Z`;
  areaPath.setAttribute('d', area);

  // Color sparkline by overall direction (first vs last point).
  const dir = points[points.length - 1] >= points[0] ? 'up' : 'down';
  card.querySelector('.sparkline').dataset.direction = dir;
}

function renderGauge(card, score, sentiment) {
  // Map score (-1..1) to needle angle (-90deg .. +90deg, where 0 = straight up).
  const clamped = Math.max(-1, Math.min(1, score || 0));
  const angle = clamped * 90;
  const needle = card.querySelector('.gauge-needle');
  if (needle) needle.style.transform = `rotate(${angle}deg)`;

  const gauge = card.querySelector('.sentiment-gauge');
  if (gauge) gauge.dataset.sentiment = sentiment || 'neutral';
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
