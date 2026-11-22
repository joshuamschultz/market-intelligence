import { dateLabel, pathPart, safe } from './ui.js';

const lookback = 63;
const stockRoute = 'a.stock-link[href^="#stock?"]';
const selector = `[data-action="stock"][data-value], [data-ticker-preview], ${stockRoute}`;
const tooltipId = 'workspace-ticker-preview';
const scopes = new WeakMap();
const priceLabel = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 4 });

export function setTickerPreviewContext(container, context) {
  scopes.set(container, { ...context });
}

function scopeFor(anchor) {
  for (let node = anchor; node; node = node.parentElement) {
    if (scopes.has(node)) return scopes.get(node);
  }
}

function miniCandles(bars) {
  const valid = bars.filter((bar) => !bar.gap && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (!valid.length) return '';
  const low = Math.min(...valid.map((bar) => bar.low));
  const high = Math.max(...valid.map((bar) => bar.high));
  const pad = (high - low || high * 0.08) * 0.07;
  const [left, right, top, bottom] = [2, 267, 9, 140];
  const y = (price) => top + (high + pad - price) / (high - low + 2 * pad) * (bottom - top);
  const step = (right - left) / bars.length;
  const width = Math.min(9, step * 0.7);
  const marks = new Set(valid);
  const grid = [...new Set([low, (low + high) / 2, high])].map((price) =>
    `<path class="ticker-preview-grid" d="M${left} ${y(price)}H${right}"/><text x="${right + 5}" y="${y(price) + 3}">${priceLabel.format(price)}</text>`).join('');
  const candles = bars.map((bar, index) => {
    if (!marks.has(bar)) return '';
    const x = left + (index + 0.5) * step;
    const open = y(bar.open);
    const close = y(bar.close);
    return `<g class="ticker-preview-candle ${bar.close >= bar.open ? 'up' : 'down'}" data-date="${safe(bar.date)}">
      <path d="M${x} ${y(bar.high)}V${y(bar.low)}"/><rect x="${x - width / 2}" y="${Math.min(open, close)}" width="${width}" height="${Math.max(1, Math.abs(close - open))}"/>
      </g>`;
  }).join('');
  return `<svg viewBox="0 0 314 148" aria-hidden="true">${grid}${candles}</svg>`;
}

function describe(anchor, enabled) {
  const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltipId);
  if (enabled) ids.push(tooltipId);
  if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
  else anchor.removeAttribute('aria-describedby');
}

function place(tooltip, anchor, window) {
  const viewport = window.visualViewport;
  const { clientWidth, clientHeight } = window.document.documentElement;
  const width = viewport?.width || clientWidth || window.innerWidth;
  const height = viewport?.height || clientHeight || window.innerHeight;
  const padding = 8;
  const left = (viewport?.offsetLeft || 0) + padding;
  const top = (viewport?.offsetTop || 0) + padding;
  const right = left + width - 2 * padding;
  const bottom = top + height - 2 * padding;
  tooltip.style.maxWidth = `${Math.max(0, right - left)}px`;
  tooltip.style.maxHeight = `${Math.max(0, bottom - top)}px`;
  const size = tooltip.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const above = rect.top - padding - size.height;
  const below = rect.bottom + padding;
  const vertical = below + size.height > bottom && above >= top ? above : below;
  tooltip.style.left = `${Math.max(left, Math.min(rect.left, right - size.width))}px`;
  tooltip.style.top = `${Math.max(top, Math.min(vertical, bottom - size.height))}px`;
}

const messages = {
  'not-prepared': 'Price history has yet to be prepared for this session.',
  'requires-exact-date': 'Price history requires preparation for this exact session.',
  'outside-listing': 'No active listing on this session.',
  'no-observations': 'No complete, verified OHLC observations in this window.',
};

export function mountTickerPreview({ api, getContext, getGeneration = () => 0, document = globalThis.document, delay = 180, cacheSize = 100 }) {
  const window = document.defaultView;
  const listeners = new window.AbortController();
  const tooltip = document.createElement('div');
  tooltip.id = tooltipId;
  tooltip.className = 'ticker-preview';
  tooltip.setAttribute('role', 'tooltip');
  const cache = new Map();
  let active;
  const reset = () => {
    if (!active) return;
    const previous = active;
    active = null;
    window.clearTimeout(previous.timer);
    previous.request?.abort();
    observer.disconnect();
    describe(previous.anchor, false);
    tooltip.remove();
  };
  const contextFor = (anchor) => {
    const route = anchor.matches(stockRoute) ? Object.fromEntries(new URLSearchParams(anchor.getAttribute('href').slice(7))) : {};
    const { symbol, ...routeContext } = route;
    const { calculationVersion, ...context } = { ...getContext(), ...scopeFor(anchor), ...routeContext };
    const params = Object.fromEntries(Object.entries(context).filter(([, value]) => value != null && value !== '').sort());
    const id = symbol || anchor.dataset.tickerPreview || anchor.dataset.value;
    return { id, params, calculationVersion, key: JSON.stringify([id, calculationVersion, params]) };
  };
  const available = (anchor) => anchor?.isConnected && !anchor.matches(':disabled, [aria-disabled="true"]') &&
    !anchor.closest('[hidden], dialog:not([open])');
  const isCurrent = (item) => active === item && available(item.anchor) && item.anchor.matches(selector) &&
    item.generation === getGeneration() && item.hash === window.location.hash && item.key === contextFor(item.anchor).key;
  const observer = new window.MutationObserver(() => {
    if (active && !isCurrent(active)) reset();
  });
  function keepCurrent(item) {
    if (isCurrent(item)) return true;
    if (active === item) reset();
    return false;
  }

  function paint(item, data, message) {
    if (!keepCurrent(item)) return;
    const date = data?.date || item.params.date;
    const symbol = data?.symbol || item.anchor.querySelector('strong')?.textContent || item.anchor.textContent.trim() || item.id;
    const graph = data?.state === 'ready' ? miniCandles(data.bars || []) : '';
    const span = data?.span;
    const range = !span?.from || !span.through || span.from === span.through ? dateLabel(span?.through)
      : `${dateLabel(span.from, span.from.slice(0, 4) === span.through.slice(0, 4))} – ${dateLabel(span.through)}`;
    const asOf = date ? `As of ${dateLabel(date)}` : '';
    tooltip.innerHTML = `<div class="ticker-preview-title"><strong>${safe(symbol)}</strong><span>3M daily candles</span></div>
      ${asOf ? `<div class="ticker-preview-as-of">${safe(asOf)}</div>` : ''}
      ${graph && span?.observations ? `${graph}<div class="ticker-preview-span"><span>${safe(range)}</span>
        <span>${safe(span.observations)} ${span.observations === 1 ? 'candle' : 'candles'}${span.gaps ? ` · ${safe(span.gaps)} ${span.gaps === 1 ? 'gap' : 'gaps'}` : ''}</span></div>`
        : `<div class="ticker-preview-message">${safe(message || messages[data?.state] || 'Prepared price preview is unavailable.')}</div>`}`;
    (item.anchor.closest('dialog[open]') || document.body).append(tooltip);
    place(tooltip, item.anchor, window);
    describe(item.anchor, true);
  }

  async function load(item) {
    if (!keepCurrent(item)) return;
    const { id, params, calculationVersion, key } = item;
    item.request = new window.AbortController();
    const { signal } = item.request;
    paint(item, null, 'Loading prepared prices…');
    try {
      const data = await api(`stocks/${pathPart(id)}/chart`, { plain: true, params: { ...params, lookback }, signal });
      if (signal.aborted || !keepCurrent(item)) return;
      if (data.securityId !== id && data.symbol?.toUpperCase() !== id.toUpperCase() ||
          params.date && (data.requestedDate !== params.date || data.date > params.date) ||
          params.dataVersion != null && Number(data.dataVersion) !== Number(params.dataVersion) ||
          params.basis && data.basis !== params.basis ||
          calculationVersion && data.calculationVersion !== calculationVersion) {
        paint(item, null, 'Price history is unavailable for this analysis context.');
        return;
      }
      if (data.state === 'ready' && params.date && params.dataVersion != null && cacheSize > 0) {
        cache.set(key, data);
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
      }
      paint(item, data);
    } catch (error) {
      if (!signal.aborted) paint(item, null, error.status === 404
        ? 'No prepared prices for this security and session.' : 'Prepared price preview is unavailable.');
    }
  }

  function start(anchor, mode, focusOwner = anchor) {
    if (!available(anchor)) return;
    const context = contextFor(anchor);
    if (!context.id || (active?.anchor === anchor && isCurrent(active))) return;
    reset();
    const item = { anchor, mode, focusOwner, ...context, generation: getGeneration(), hash: window.location.hash };
    active = item;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['open', 'hidden', 'disabled', 'aria-disabled', 'data-value', 'data-ticker-preview', 'href'] });
    const cached = cache.get(item.key);
    if (cached) {
      cache.delete(item.key);
      cache.set(item.key, cached);
      paint(item, cached);
    } else item.timer = window.setTimeout(() => load(item), delay);
  }

  const bind = (target, type, handler, capture = false) => target?.addEventListener(type, handler, { capture, signal: listeners.signal });
  const anchorFor = (node) => node?.closest?.(selector);
  const inside = (anchor, node) => node instanceof window.Node && anchor.contains(node);
  bind(document, 'pointerover', (event) => {
    if (event.pointerType === 'touch' || window.matchMedia?.('(pointer: coarse)').matches) return;
    const anchor = anchorFor(event.target);
    if (anchor && !inside(anchor, event.relatedTarget)) start(anchor, 'hover');
  });
  bind(document, 'pointerout', (event) => {
    const anchor = anchorFor(event.target);
    if (anchor && active?.anchor === anchor && active.mode === 'hover' && !inside(anchor, event.relatedTarget)) reset();
  });
  bind(document, 'focusin', (event) => start(anchorFor(event.target), 'focus'));
  bind(document, 'focusout', (event) => {
    if (active?.focusOwner === event.target && !inside(active.focusOwner, event.relatedTarget)) reset();
  });
  bind(document, 'keydown', (event) => { if (event.key === 'Escape') reset(); }, true);
  for (const type of ['pointerdown', 'pointercancel', 'scroll', 'close', 'workspace:dialog-change']) bind(document, type, reset, true);
  for (const type of ['hashchange', 'resize', 'blur', 'scroll']) bind(window, type, reset);
  for (const type of ['resize', 'scroll']) bind(window.visualViewport, type, reset);
  return {
    reset,
    focusOption(option, input) {
      if (option?.matches(selector)) start(option, 'focus', input);
      else if (active?.focusOwner === input) reset();
    },
    destroy() {
      reset();
      cache.clear();
      listeners.abort();
    },
  };
}
