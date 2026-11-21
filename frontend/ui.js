const glyphs = {
  journal: '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18m4-12h4m-4 4h4m-4 4h2"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  screener: '<path d="M3 5h18M6 12h12m-9 7h6"/><path d="M7 3v4m9 3v4m-4 3v4"/>',
  rankings: '<path d="M3 20h18M5 16v-4m5 4V8m5 8V5m5 11V3"/>',
  industries: '<path d="M3 20V8l9-4 9 4v12H3Zm5 0v-5m4 5v-8m4 8v-5"/>',
  history: '<path d="M4 12a8 8 0 1 1 2.2 5.5M4 12V6m0 6h6m2-4v4l3 2"/>',
  screens: '<path d="M7 3h8l4 4v14H7zM15 3v5h4M10 12h6m-6 4h6"/>',
  watchlists: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  alerts: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-9 12a3 3 0 0 0 6 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="7"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.9"/><path d="m15 15 4.2 4.2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  'arrow-up-right': '<path d="M6 18 18 6m-8 0h8v8"/>',
  filter: '<path d="M4 6h16l-6 7v4l-4 2v-6L4 6Z"/>',
  down: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
  up: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  sort: '<path d="M8 5v14m-3-3 3 3 3-3m5 3V5m-3 3 3-3 3 3"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  columns: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14m6-14v14"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.4-5.9L4 8m0 0h5M4 8V3m0 10a8 8 0 0 0 13.4 5.9L20 16m0 0h-5m5 0v5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10h16M8 4v4m8-4v4"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5m0-8h.01"/>',
  warning: '<path d="M12 4 3 19h18L12 4Zm0 6v4m0 2h.01"/>',
  edit: '<path d="m4 15 11-11 5 5-11 11H4Zm9-9 5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-7 4v5m2-5v5"/>',
  folder: '<path d="M3 7h7l2 2h9v10H3Z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  layers: '<path d="m12 4 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  chart: '<path d="M4 4v16h16M7 15l4-5 4 3 5-6"/>',
};

export const names = {
  overview: 'Market Overview', monitor: 'Market Monitor', screener: 'Stock Screener', rankings: 'RS Rankings', industries: 'Industries',
  history: 'Historical Explorer', journal: 'Market Journal', screens: 'Saved Screens', watchlists: 'Watchlists', alerts: 'Alerts', settings: 'Settings & Data',
  stock: 'Ticker',
};
const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => escaped[char]);
export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${glyphs[name] || ''}</svg>`;
export const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
export const count = (value) => numeric(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value) : '—';
export const number = (value, digits = 1) => numeric(value) ? value.toFixed(digits) : '—';
export const percent = (value, digits = 1, sign = false) =>
  numeric(value) ? `${sign && value > 0 ? '+' : ''}${number(value, digits)}%` : '—';
export const rate = (value, digits = 2, sign = true) => numeric(value) ? percent(value * 100, digits, sign) : '—';
export const money = (value) => numeric(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : '—';
export const compact = (value, dollars = false) => numeric(value) ? new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 2, ...(dollars ? { style: 'currency', currency: 'USD' } : {}),
}).format(value) : '—';
export const direction = (value) => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
export const signed = (value, digits = 1) => numeric(value) ? `${value > 0 ? '+' : ''}${number(value, digits)}` : '—';
export const ratio = (value, state) => state === 'infinity' ? '∞' : numeric(value) ? `${number(value, 2)}×` : '—';
export const dash = (value) => value == null || value === '' ? '—' : safe(value);
export const dateLabel = (value, short = false) => value && !Number.isNaN(Date.parse(value))
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }) }).format(new Date(value)) : '—';
export const shiftDate = (value, days) => {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export const pathPart = (value) => encodeURIComponent(value);
export const option = (value, text, active, disabled = false) => `<option value="${safe(value)}"${value === active ? ' selected' : ''}${disabled ? ' disabled' : ''}>${safe(text)}</option>`;
export const attr = (name, value) => value == null ? '' : ` ${name}="${safe(value)}"`;
export const action = (label, name, glyph, extra = {}) => `<button type="button" class="button${extra.className ? ` ${extra.className}` : ''}" data-action="${name}"${attr('data-value', extra.value)}${attr('title', extra.title)}${extra.disabled ? ' disabled' : ''}>${glyph ? icon(glyph) : ''}${safe(label)}</button>`;
export const iconButton = (label, name, glyph, value) => `<button type="button" class="icon-button" data-action="${name}"${attr('data-value', value)} aria-label="${safe(label)}" title="${safe(label)}">${icon(glyph)}</button>`;
export const heading = (title, description, tools = '') => `<div class="page-intro"><div><h1>${safe(title)}</h1>${description ? `<p class="subtitle">${safe(description)}</p>` : ''}</div>${tools ? `<div class="actions">${tools}</div>` : ''}</div>`;
export const panelHead = (title, description = '', tools = '') => `<header class="panel-head"><div><h2>${safe(title)}</h2>${description ? `<p class="muted">${safe(description)}</p>` : ''}</div>${tools ? `<div class="actions">${tools}</div>` : ''}</header>`;
export const empty = (title, message, glyph = 'info', tools = '') => `<div class="empty">${icon(glyph)}<h3>${safe(title)}</h3><p>${safe(message)}</p>${tools}</div>`;
export const pending = (label = 'Loading analysis…') => `<div class="pending" role="status">${safe(label)}</div>`;
export const publishingHistory = (job) => {
  if (job.status === 'queued') return pending('Queued for background preparation');
  if (job.status === 'waiting_for_capture') {
    const completed = job.capture?.stages?.prices?.complete;
    return pending(`Waiting for market data import${numeric(completed) ? ` · ${count(completed)} symbol histories loaded` : '…'}`);
  }
  return pending(`Calculating historical sessions${numeric(job.progress) && job.progress > 0 ? ` · ${Math.round(job.progress)}%` : '…'}`);
};
export const warming = (job, subject = 'Historical metrics') => {
  const paused = job.status === 'waiting_for_capture';
  const label = paused ? 'Waiting for market data import' : `Preparing ${subject.toLowerCase()}`;
  const progress = numeric(job.progress) && job.progress > 0 ? ` · ${Math.round(job.progress)}%` : '';
  return `<div class="inline-progress" role="status">${icon('clock')} <span>${safe(label + progress)}</span></div>`;
};
export const notice = (title, message, tools = '', error = false) => `<div class="notice${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${icon(error ? 'info' : 'warning')}<div><strong>${safe(title)}</strong>${message ? `<p>${safe(message)}</p>` : ''}</div>${tools}</div>`;
export const chip = (label, style = '') => `<span class="chip ${style}">${safe(label)}</span>`;
export const segment = (name, choices, selected, classes = 'segmented') => `<div class="${classes}">${choices.map(([value, label]) =>
  `<button type="button" data-action="${name}" data-value="${safe(value)}" aria-pressed="${String(value) === String(selected)}">${safe(label)}</button>`).join('')}</div>`;
export const field = (label, control, tip = '') => `<label class="field"><span>${safe(label)}</span>${control}${tip ? `<small>${safe(tip)}</small>` : ''}</label>`;
export const breadthMovePresets = [
  { id:'daily', label:'Daily momentum', threshold:4, sessions:1 },
  { id:'swing', label:'Monthly momentum', threshold:25, sessions:20 },
  { id:'surge', label:'Large monthly moves', threshold:50, sessions:20 },
  { id:'quarter', label:'Quarterly momentum', threshold:25, sessions:63 },
  { id:'intermediate', label:'34-session moves', threshold:13, sessions:34 },
];
export const breadthMoveKey = (side, threshold, sessions) => `${side}_${threshold}pct${sessions > 1 ? `_${sessions}d` : ''}`;
export const breadthMoveHelp = {
  fixed: 'The fixed comparisons use ±4% over 1 session, ±25% and ±50% over 20, ±25% over 63, and ±13% over 34.',
  visible: 'How many dated rows the table shows. Each row uses the lookback listed in its column header.',
  window: 'Trading sessions between the two split-adjusted closing prices. 63 sessions is about three months and 126 is about six. Each row uses its own closing date.',
  threshold: 'For a 34-session comparison at 13%, the downside reading counts a 34-session return of −15% and excludes −5%. The upside reading counts returns of +13% or more.',
  scale: 'Auto gives each group a shared scale for gains and losses based on its largest visible reading. Common uses 0–100% for every group. The printed percentages retain their exact values.',
  counts: 'The numerator counts stocks that meet the rule. The denominator counts traded stocks with enough comparable price history for that rule. 100 of 1,000 is 10%.',
  extremes: 'Compare each reading with the prior 252 sessions. A marker requires at least 60 valid readings and identifies the top or bottom tenth.',
  statistics: 'SMA is the average of the last 5, 10, or 20 daily participation percentages. Δ is the change in percentage points versus 1, 5, or 21 trading sessions ago.',
};
export function helpTooltip(id, label, description) {
  return `<span class="help-tip"><button type="button" class="help-tip-trigger" aria-label="${safe(`About ${label}`)}"
    aria-describedby="${safe(id)}">${icon('info')}</button>
    <span class="help-tip-content" role="tooltip" id="${safe(id)}" hidden>${safe(description)}</span></span>`;
}
export function helpField(id, label, control, description) {
  const help = `${id}-help`;
  return `<div class="field"><div class="field-caption"><label for="${safe(id)}">${safe(label)}</label>${helpTooltip(help, label, description)}</div>
    ${control(`id="${safe(id)}" aria-describedby="${safe(help)}"`)}</div>`;
}
export function bindHelpTooltips(root) {
  for (const help of root.querySelectorAll('.help-tip')) {
    const button = help.querySelector('.help-tip-trigger');
    const content = help.querySelector('.help-tip-content');
    let hovering = false;
    let focused = false;
    let dismissed = false;
    const update = () => {
      content.hidden = dismissed || !(hovering || focused);
      if (!content.hidden) {
        content.style.removeProperty('--help-offset');
        const bounds = content.getBoundingClientRect();
        const width = help.ownerDocument.documentElement.clientWidth;
        if (width) content.style.setProperty('--help-offset', `${Math.max(0, 12 - bounds.left) - Math.max(0, bounds.right - width + 12)}px`);
      }
    };
    help.addEventListener('pointerenter', () => { hovering = true; dismissed = false; update(); });
    help.addEventListener('pointerleave', () => { hovering = false; update(); });
    button.addEventListener('focus', () => { focused = true; dismissed = false; update(); });
    button.addEventListener('blur', () => { focused = false; dismissed = false; update(); });
    button.addEventListener('click', () => { dismissed = false; button.focus(); update(); });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || content.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      dismissed = true;
      update();
    });
  }
}
export function observedCoverageFields(settings = {}) {
  const enabled = settings.coverageMode === 'observed';
  const disabled = enabled ? '' : ' disabled';
  return `<div class="inline-form" data-observed-coverage${enabled ? '' : ' hidden'}>
    ${field('Minimum traded sample', `<input name="observedMinimum" type="number" min="1" max="100000" step="1" required value="${safe(settings.observedMinimum ?? 20)}"${disabled}>`)}
    ${field('Comparable fraction', `<input name="observedThreshold" type="number" min=".001" max="1" step=".001" required value="${safe(settings.observedThreshold ?? 0.8)}"${disabled}>`, '0.80 = 80%')}
  </div>`;
}
export function bindObservedCoverage(form) {
  const select = form?.querySelector('[name="coverageMode"]');
  const fields = form?.querySelector('[data-observed-coverage]');
  if (!select || !fields) return;
  select.addEventListener('change', () => {
    fields.hidden = select.value !== 'observed';
    for (const input of fields.querySelectorAll('input')) input.disabled = fields.hidden;
  });
}
export function observedCoverageParams(values) {
  return values.coverageMode === 'observed'
    ? { coverageMode: 'observed', observedMinimum: Number(values.observedMinimum), observedThreshold: Number(values.observedThreshold) }
    : { coverageMode: 'verified' };
}
export function observedCoverageSummary(result) {
  return `Minimum ${count(result.observedMinimum)} traded securities · ${rate(result.observedThreshold, 1, false)} comparable coverage.`;
}
export const stockLink = (row) => `<button type="button" class="stock-link mono" data-action="stock" data-value="${safe(row.securityId || row.symbol)}">${safe(row.symbol || row.securityId)}</button>`;
export function tradingViewUrl(symbol, exchange) {
  const ticker = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,39}$/.test(ticker)) return null;
  const venue = String(exchange || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = /^(NASDAQ(?:GS|GM|CM|GLOBALSELECT(?:MARKET)?|GLOBALMARKET|CAPITALMARKET)?|XNAS)$/.test(venue) ? 'NASDAQ'
    : /^(NYSE|XNYS)$/.test(venue) ? 'NYSE'
    : /^(NYSEAMERICAN|NYSEMKT|NYSEARCA|ARCA|AMEX|XASE|ARCX)$/.test(venue) ? 'AMEX'
    : /^(OTC(?:ID|QX|QB|BB|MKTS|MARKETS)?|PINK(?:CURRENT|LIMITED)?|EXPERTMARKET)$/.test(venue) ? 'OTC' : '';
  const chartSymbol = prefix ? `${prefix}:${ticker.replace(/-([A-Z])$/, '.$1')}` : ticker;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(chartSymbol)}`;
}
export function tradingViewLink(row) {
  const href = tradingViewUrl(row.symbol, row.exchange);
  return href ? `<a class="text-link tradingview-link" href="${safe(href)}" target="_blank"
    rel="noopener noreferrer" aria-label="Open ${safe(row.symbol)} chart in TradingView, new tab">TradingView ${icon('arrow-up-right')}</a>` : '';
}
export function savedScreenRoute(definition = {}) {
  const context = { ...definition.context };
  const fixed = definition.dateMode === 'fixed' || definition.dateMode !== 'latest' && !!context.date;
  return { ...context, date: fixed ? context.date || null : null, dataVersion: fixed ? context.dataVersion ?? null : null };
}

const baseFields = [
  ['symbol', 'Ticker'], ['name', 'Company'], ['exchange', 'Exchange'], ['type', 'Security type'], ['close', 'Close', 'money'],
  ['return_1d', '1D return', 'rate'], ['return_5d', '5D return', 'rate'], ['return_10d', '10D return', 'rate'], ['return_20d', '20D return', 'rate'],
  ['return_21d', '1M return', 'rate'], ['return_42d', '42D return', 'rate'], ['return_63d', '3M return', 'rate'],
  ['return_126d', '6M return', 'rate'], ['return_252d', '12M return', 'rate'],
  ['rsRank', 'RS rank', 'integer'], ['rsPercentile', 'RS percentile', 'decimal'], ['rsScore', 'RS score', 'score'],
  ['velocity1w', '1W RS velocity', 'signed'], ['velocity4w', '4W RS velocity', 'signed'], ['velocity12w', '12W RS velocity', 'signed'],
  ['rankChange1w', '1W rank change', 'signed'], ['rankChange4w', '4W rank change', 'signed'], ['rankChange12w', '12W rank change', 'signed'],
  ['rsAcceleration', 'RS acceleration', 'signed'], ['leadingWeeks', 'Top-decile persistence', 'integer'], ['rsNewHigh', 'RS new high', 'bool'],
  ['lifecycle', 'Leadership state'], ['rsStatus', 'Ranking status'], ['rsScoreChange', 'RS score change', 'signed'], ['up_frequency_20d', 'Up-day frequency 20D', 'rate'], ['udv_10d', 'U/D volume 10D', 'ratio'], ['udv_20d', 'U/D volume 20D', 'ratio'],
  ['udv_50d', 'U/D volume 50D', 'ratio'], ['udv_100d', 'U/D volume 100D', 'ratio'], ['rvol_20d', 'Relative volume 20D', 'ratio'],
  ['volume', 'Share volume', 'compact'], ['dollar_volume', 'Dollar volume', 'compactMoney'], ['adv_20d', 'Avg dollar volume 20D', 'compactMoney'],
  ['adv_50d', 'Avg dollar volume 50D', 'compactMoney'], ['float', 'Public float', 'compact'], ['shares', 'Shares outstanding', 'compact'],
  ['market_cap', 'Market cap', 'compactMoney'], ['market_cap_change', '21D market cap change', 'rate'], ['marketCapBucket', 'Market cap bucket'],
  ['float_turnover_20d', 'Float turnover 20D', 'rate'], ['distance_high_252d', 'From 52W high', 'rate'],
  ['distance_low_252d', 'From 52W low', 'rate'], ['distance_all_time_high', 'From verified listing high', 'rate'],
  ['distance_loaded_history_high', 'From verified loaded-history high', 'rate'],
  ['relative_return_21d', '1M vs benchmark', 'rate'], ['volatility_20d', '20D volatility', 'rate'], ['atr_14d', 'ATR 14D', 'rate'],
  ['obv', 'On-balance volume', 'compact'], ['obv_slope', 'OBV slope', 'decimal'],
  ['mfi_14d', 'Money flow index', 'decimal'], ['cmf_20d', 'Chaikin money flow', 'decimal'], ['clv', 'Close location value', 'decimal'],
  ['ma_aligned', 'Bullish MA alignment', 'bool'], ['ma_50_above_200', '50D SMA above 200D', 'bool'],
  ['ma_rising_50', 'Rising 50D SMA', 'bool'], ['ma_rising_200', 'Rising 200D SMA', 'bool'],
  ['sector', 'Sector'], ['industry', 'Industry'], ['subindustry', 'Subindustry'], ['industryRS', 'Industry median RS', 'decimal'],
  ['industryBreadth', 'Industry 50D breadth', 'percent'], ['industryRelativeRS', 'RS vs industry', 'signed'],
  ['industryRelativeReturn', 'Return vs industry', 'rate'], ['sectorRelativeRS', 'RS vs sector', 'signed'],
  ['subsetRank', 'Result rank', 'integer'], ['groupRank', 'Group rank', 'integer'], ['group', 'Group'],
  ['periodRank', 'Period rank', 'integer'], ['periodPercentile', 'Period percentile', 'decimal'], ['periodReturn', 'Period return', 'rate'],
  ['traded', 'Traded', 'bool'], ['listingDate', 'Listing date', 'date'], ['fundamentalsDate', 'Fundamentals date', 'date'],
  ['breadthSelection', 'Participation'], ['contribution','Contribution','signed'], ['rsHighBeforePrice', 'RS high before price high', 'bool'],
  ['deterioratingOnPriceStrength', 'RS deteriorating on price strength', 'bool'], ['momentumImproving', 'Improving 3M momentum', 'bool'],
  ['priceAndVolumeStrength', 'Price and volume strength', 'bool'], ['industryImproving', 'Improving industry RS', 'bool'],
  ['industryVelocity', 'Industry RS velocity', 'signed'], ['high_volume_up_20d', 'High-volume up days 20D', 'integer'],
  ['high_volume_down_20d', 'High-volume down days 20D', 'integer'], ['accumulation_20d', 'Net high-volume up days 20D', 'integer'],
  ['volume_trend', '20D vs 50D volume', 'rate'], ['volume_contraction', '10D vs 50D volume', 'rate'], ['breakout_volume', 'Breakout volume', 'ratio'],
  ['rs_line_new_high', 'New benchmark RS line high', 'bool'], ['gap', 'Opening gap', 'rate'], ['volatility_compression', 'Volatility contraction', 'rate'],
  ['consolidation_range_20d', 'Consolidation range 20D', 'rate'], ['intraday_return', 'Intraday return', 'rate'],
  ['atr_contraction', '14D ATR contraction', 'rate'], ['consolidation_duration', 'Consolidation sessions', 'integer'],
  ['high_volume_up_2x_20d', '20D up days at 2× volume', 'integer'], ['high_volume_down_2x_20d', '20D down days at 2× volume', 'integer'],
  ['accumulation_2x_20d', '20D net 2× volume days', 'integer'], ['obv_slope_20d', '20D OBV change', 'compact'],
  ['industryEmerging', 'Emerging industry', 'bool'], ['volumeDemandImproving', 'Improving volume demand', 'bool'],
  ['udvChange4w', '4W U/D ratio change', 'signed'], ['upVolumeShareChange4w', '4W up-volume share change', 'rate'],
];
for (const weeks of [4, 8, 12]) {
  baseFields.push([`topDecileWeeks${weeks}w`, `Top-decile weeks in ${weeks}W`, 'integer'],
    [`topDecilePersistence${weeks}w`, `Top decile throughout ${weeks}W`, 'bool']);
}
for (const days of [10, 20, 50, 100, 150, 200]) {
  baseFields.push([`sma_${days}d`, `${days}D SMA`, 'money'], [`ema_${days}d`, `${days}D EMA`, 'money'],
    [`above_${days}d`, `Above ${days}D SMA`, 'bool'], [`vs_sma_${days}d`, `Price vs ${days}D SMA`, 'rate'], [`slope_sma_${days}d`, `${days}D SMA slope`, 'rate'],
    [`vs_ema_${days}d`, `Price vs ${days}D EMA`, 'rate'], [`slope_ema_${days}d`, `${days}D EMA slope`, 'rate']);
}
for (const band of [1, 5, 10, 20]) baseFields.push([`enteredTop${band}`, `Entered top ${band}% RS`, 'bool']);
for (const days of [20, 50, 100, 252]) baseFields.push([`new_high_${days}d`, `New ${days}D high`, 'bool'], [`new_low_${days}d`, `New ${days}D low`, 'bool']);
export const fields = new Map(baseFields.map(([id, label, format = 'text']) => [id, { id, label, format }]));
const rangeFieldPattern = /^range_(distance|since|age)_(high|low)_(\d+)d$/;
export const rangeFieldId = (metric, side, days) => `range_${metric}_${side}_${days}d`;
export function rangeFieldDetails(id) {
  const match = rangeFieldPattern.exec(id);
  if (!match) return null;
  const [, metric, side, days] = match;
  const labels = { distance: `From ${days}D ${side}`, since: `Sessions since ${days}D new ${side}`, age: `Age of ${days}D window ${side}` };
  return { id, label: labels[metric], format: metric === 'distance' ? 'rate' : 'integer', days: Number(days), metric, side };
}
export const screenColumns = ['symbol', 'name', 'close', 'return_1d', 'return_21d', 'rsPercentile', 'velocity4w', 'udv_50d', 'adv_20d', 'distance_high_252d'];
export const rankColumns = ['rsRank', 'symbol', 'name', 'rsPercentile', 'rsScore', 'velocity1w', 'velocity4w', 'velocity12w', 'return_63d', 'return_252d'];
export const fieldDetails = (id, computed = [], row = {}) => {
  if (fields.has(id)) return fields.get(id);
  const range = rangeFieldDetails(id);
  if (range) return range;
  const column = computed.find((item) => item.field === id);
  return { id, label: column?.label || id, format: column?.format || (numeric(row[id]) ? 'decimal' : 'text') };
};
export function cellValue(id, row, computed = []) {
  const value = row[id];
  if (id === 'symbol') return stockLink(row);
  if (id === 'rsPercentile' && numeric(value)) return `<span class="rs-cell" style="--rs:${Math.max(0, Math.min(100, value))}%">${number(value)}</span>`;
  if (id === 'breadthSelection') return chip({ numerator: 'Qualifies', nonqualifier: 'Comparable', advancer: 'Advancer', decliner: 'Decliner', unchanged: 'Unchanged', insufficient: 'Insufficient history', untraded: 'Untraded' }[value] || 'Unknown',
    ['numerator','advancer'].includes(value) ? 'accent' : value === 'insufficient' || value === 'untraded' ? 'warning' : '');
  const format = fieldDetails(id, computed, row).format;
  if (value == null && format !== 'ratio') return '<span class="quiet">—</span>';
  const formatted = {
    rate: () => rate(value), money: () => money(value), integer: () => count(value), score: () => number(value, 4),
    decimal: () => number(value, 2), signed: () => signed(value), compact: () => compact(value),
    compactMoney: () => compact(value, true), bool: () => value ? 'Yes' : 'No',
    ratio: () => ratio(value, row[id.replace(/^udv_/, 'udv_state_')]), percent: () => percent(value), date: () => dateLabel(value),
  }[format];
  return formatted ? `<span class="${['rate', 'signed'].includes(format) ? direction(value) : ''}">${formatted()}</span>` : dash(value);
}
const virtualTables = new Map();
let tableSequence = 0;
const tableRowHeight = 36;
const visibleTableRows = 30;

function windowRows(rows, start, size, columns) {
  const spacer = (count) => count > 0 ? `<tr class="range-spacer" aria-hidden="true" style="height:${count * tableRowHeight}px">
    <td colspan="${columns}"></td></tr>` : '';
  return spacer(start) + rows.slice(start, start + size).join('') + spacer(rows.length - start - size);
}

export function bindVirtualTable(container) {
  const scroll = container.querySelector('[data-virtual-table]');
  const config = virtualTables.get(scroll?.dataset.virtualTable);
  if (!config) return;
  virtualTables.delete(scroll.dataset.virtualTable);
  const body = scroll.querySelector('tbody');
  let current = 0;
  function renderWindow() {
    if (!scroll.isConnected) return;
    const start = Math.min(config.rows.length - 1, Math.max(0, Math.floor(scroll.scrollTop / tableRowHeight) - 6));
    if (start === current) return;
    const active = document.activeElement;
    const focused = body.contains(active);
    const rowIndex = focused ? Number(active.closest('tr').getAttribute('aria-rowindex')) : null;
    const selector = active?.matches('[data-change="select-stock"]') ? '[data-change="select-stock"]'
      : active?.matches('.tradingview-link') ? '.tradingview-link' : '[data-action="stock"]';
    current = start;
    body.innerHTML = windowRows(config.rows, start, visibleTableRows, config.columns);
    for (const input of body.querySelectorAll('[data-change="select-stock"]')) input.checked = config.selected?.has(input.value) || false;
    if (focused) (body.querySelector(`[aria-rowindex="${rowIndex}"] ${selector}`) || scroll).focus({ preventScroll: true });
  }
  scroll.addEventListener('scroll', renderWindow, { passive: true });
  scroll.addEventListener('focusout', () => setTimeout(renderWindow, 0));
}

export function table(rows, columns, options = {}) {
  const computed = options.computed || [];
  const sort = options.sort || [];
  const rowKey = (row) => row.securityId || row.symbol;
  const headers = columns.map((id) => {
    const index = sort.findIndex((item) => item.field === id);
    const direction = index === -1 ? '' : sort[index].direction;
    const sortLabel = direction ? `Sorted ${direction === 'asc' ? 'ascending' : 'descending'} · priority ${index + 1}` : 'Sort';
    const label = fieldDetails(id, computed, rows[0]).label;
    return `<th scope="col" class="${id === 'symbol' || id === 'name' ? `pin-${id}` : ''}"${direction && index === 0 ? attr('aria-sort', direction === 'asc' ? 'ascending' : 'descending') : ''}>${options.sortable
      ? `<button type="button" class="table-sort" data-action="sort" data-value="${safe(id)}" title="${sortLabel}. Hold Shift to add a sort.">${safe(label)}${direction ? `<span class="sort-index">${icon(direction === 'asc' ? 'up' : 'down')}${index + 1}</span>` : ''}</button>`
      : safe(label)}</th>`;
  }).join('');
  const rowMarkup = rows.map((row, index) => `<tr aria-rowindex="${index + 2}">${options.selectable ? `<td class="pin-check"><input type="checkbox" data-change="select-stock" value="${safe(rowKey(row))}" aria-label="Select ${safe(row.symbol)}"${options.selected.has(rowKey(row)) ? ' checked' : ''}></td>` : ''}
    ${columns.map((id) => `<td class="${id === 'symbol' || id === 'name' ? `pin-${id}` : ''}${fieldDetails(id, computed, row).format !== 'text' ? ' numeric' : ''}">${cellValue(id, row, computed)}</td>`).join('')}
    ${options.rowAction ? `<td>${options.rowAction(row)}</td>` : ''}</tr>`);
  const span = columns.length + Number(!!options.selectable) + Number(!!options.rowAction);
  const virtualId = options.virtualRows && rows.length > visibleTableRows ? `table-${++tableSequence}` : '';
  if (virtualId) virtualTables.set(virtualId, { rows: rowMarkup, columns: span, selected: options.selected });
  const body = virtualId ? windowRows(rowMarkup, 0, visibleTableRows, span) : rowMarkup.join('');
  const allSelected = rows.length && rows.every((row) => options.selected?.has(rowKey(row)));
  const widths = columns.map((id) => id === 'symbol' ? 91 : id === 'name' ? 200
    : Math.max(102, Math.min(232, 32 + fieldDetails(id, computed, rows[0]).label.length * 6)));
  if (options.selectable) widths.unshift(36);
  const fixedLayout = options.virtualRows ? ` class="warehouse-grid" style="--table-min-width:${widths.reduce((sum, value) => sum + value, 0)}px"` : '';
  const cols = options.virtualRows ? `<colgroup>${widths.map((width) => `<col style="width:${width}px">`).join('')}</colgroup>` : '';
  return `<div class="table-scroll${options.selectable ? ' selectable' : ''}" tabindex="0" role="region" aria-label="${safe(options.label || 'Security results')}"${attr('data-virtual-table', virtualId || null)}>
    <table aria-rowcount="${Math.max(2, rows.length + 1)}"${fixedLayout}>${cols}<thead><tr>
    ${options.selectable ? `<th scope="col" class="pin-check"><input type="checkbox" aria-label="Select all stocks on this page" data-change="select-page"${allSelected ? ' checked' : ''}></th>` : ''}${headers}${options.rowAction ? '<th scope="col">Actions</th>' : ''}</tr></thead>
    <tbody>${body || `<tr><td colspan="${columns.length + Number(!!options.selectable) + Number(!!options.rowAction)}" class="no-rows">${safe(options.emptyText || 'No matching securities for this selection.')}</td></tr>`}</tbody></table></div>`;
}
export const summary = (title, value, note, config = {}) => {
  const tag = config.action ? 'button' : 'article';
  return `<${tag} class="panel summary-card"${config.action ? ` type="button" data-action="${config.action}" data-value="${safe(config.value)}"` : ''}>
    <div class="summary-heading"><span>${safe(title)}</span>${icon(config.glyph || (config.action ? 'arrow-up-right' : 'pulse'))}</div>
    <div class="summary-value${config.small ? ' small' : ''} ${config.style || ''}">${safe(value)}</div>
    <div class="summary-foot">${safe(note)}</div></${tag}>`;
};
export const pagination = (data, name = 'page') => {
  const { total = 0, page = 1, perPage = 50 } = data;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return `<div class="pagination"><span>${total ? `${count((page - 1) * perPage + 1)}–${count(Math.min(total, page * perPage))} of ${count(total)}` : '0 results'}</span>
  <div class="actions">${action('Previous', name, 'chevron-left', { value: page - 1, disabled: page <= 1 })}<span class="mono">${page} / ${pages}</span>${action('Next', name, 'chevron-right', { value: page + 1, disabled: page >= pages })}</div></div>`;
};
export function csvDownload(rows, keys, filename) {
  const cell = (value) => {
    const text = String(value ?? '');
    const formula = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
    return `"${formula.replaceAll('"', '""')}"`;
  };
  return blobDownload(new Blob([[keys, ...rows.map((row) => keys.map((key) => row[key]))]
    .map((line) => line.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), filename);
}
export function blobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
