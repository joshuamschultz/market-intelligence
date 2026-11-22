import {
  action, chip, compact, count, dateLabel, direction, empty, icon, iconButton, money, notice, number, numeric, panelHead, pathPart, pending, publishingHistory, rate, ratio, safe, segment, signed, summary, warming,
} from './ui.js';
import { chart, exportChart } from './charts.js';
import { longestChartRange, rangeLimit, rangeSegment } from './chart-ranges.js';
import { stockQualityPanel } from './data-quality.js';

let drawerRequest = 0;
const maPeriods = [20, 50, 200];

export function plottableBar(bar) {
  return numeric(bar?.close) && bar.traded !== false && !bar.unverifiedSplit
    ? bar : { ...bar, close:null, open:null, high:null, low:null, volume:null };
}

function addMovingAverages(bars) {
  const sums = new Map(maPeriods.map((n) => [n, 0]));
  let consecutive = 0;
  return bars.map((rawBar, index) => {
    const bar = plottableBar(rawBar);
    if (!numeric(bar.close)) {
      consecutive = 0;
      for (const n of maPeriods) sums.set(n, 0);
      return bar;
    }
    consecutive++;
    const moving = {};
    for (const n of maPeriods) {
      const total = sums.get(n) + bar.close - (consecutive > n ? bars[index - n].close : 0);
      sums.set(n, total);
      moving[`sma_${n}`] = consecutive >= n ? total / n : null;
    }
    return { ...bar, ...moving };
  });
}

export function toWeekly(bars) {
  const byWeek = new Map();
  for (const bar of bars) {
    const date = new Date(`${bar.date}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = date.toISOString().slice(0, 10);
    const week = byWeek.get(key);
    if (!numeric(bar.close)) {
      byWeek.set(key, { date:bar.date, close:null,volume:null,incomplete:true,
        priceQuarantined:!!(bar.priceQuarantined||week?.priceQuarantined) });
    } else if (week?.incomplete) {
      byWeek.set(key, { ...week, date: bar.date });
    } else {
      byWeek.set(key, week ? { ...bar, open: week.open, high: Math.max(week.high, bar.high), low: Math.min(week.low, bar.low),
        volume:numeric(week.volume)&&numeric(bar.volume)?week.volume+bar.volume:null,
        volumeQuarantined:!!(week.volumeQuarantined||bar.volumeQuarantined) } : bar);
    }
  }
  return [...byWeek.values()];
}

export function describePricePoint(bar) {
  return [...(bar.priceQuarantined ? ['Source price quarantined · return unavailable'] : []),
    `Share volume: ${numeric(bar.volume) ? compact(bar.volume) : 'Unavailable'}${bar.volumeQuarantined ? ' · reviewed source override' : ''}`];
}

export function stockScreenMatches(env, result) {
  const { date, evaluated, screens } = result;
  const caption = `Evaluated ${count(evaluated)} saved screens as of ${dateLabel(date)}.`;
  if (!screens.length) return empty('No saved screen matches', caption, 'screens');
  return `<div class="stack">${screens.map((screen) => {
    const context = { ...env.snapshotContext, universe: screen.universe?.id || screen.universe || env.context.universe,
      universeVersion: screen.universe?.version || null, model: screen.model?.id || screen.model || env.context.model,
      modelVersion: screen.model?.version || null, date, screen: screen.id };
    return `<div class="simple-row"><div><strong>${safe(screen.name)}</strong><div class="muted">Saved version ${count(screen.version)}</div></div>
      <a href="${safe(env.routeUrl('screener', context))}" class="button">Open screen ${icon('chevron-right')}</a></div>`;
  }).join('')}</div><p class="muted section-space">${caption}</p>`;
}

const tile = (label, value, note = '') => `<div class="metric-tile"><span>${safe(label)}</span><strong>${safe(value)}</strong>${note ? `<small>${safe(note)}</small>` : ''}</div>`;

function currentSignals(data) {
  return [
    ['Public float', compact(data.float), data.fundamentalsDate ? dateLabel(data.fundamentalsDate) : 'Dated value unavailable'],
    ['Shares outstanding', compact(data.shares)],
    ['Market cap', compact(data.market_cap, true)],
    ['Avg dollar volume (20D)', compact(data.adv_20d, true)],
    ['Volume (1D)', numeric(data.volume)?compact(data.volume):'Unavailable',
      data.quality?.some((row)=>row.kind==='volume'&&row.effective_from<=data.date&&row.effective_to>=data.date)?'Reviewed source override':''],
    ['Relative volume (20D)', ratio(data.rvol_20d)],
    ['U/D volume (50D)', ratio(data.udv_50d, data.udv_state_50d), `${count(data.udv_obs_50d)} comparable observations`],
    ['Float turnover (20D)', rate(data.float_turnover_20d, 2, false)],
    ['From 52-week high', rate(data.distance_high_252d)],
    ['From verified listing high', rate(data.distance_all_time_high)],
    ['From verified loaded-history high', rate(data.distance_loaded_history_high), data.loadedHistoryHighFrom ? `Since ${dateLabel(data.loadedHistoryHighFrom)}` : ''],
    ['From 52-week low', rate(data.distance_low_252d)],
    ['1M vs benchmark', rate(data.relative_return_21d)],
    ['Price vs 20D SMA', rate(data.vs_sma_20d)], ['Price vs 50D SMA', rate(data.vs_sma_50d)], ['Price vs 200D SMA', rate(data.vs_sma_200d)],
    ['Price vs 20D EMA', rate(data.vs_ema_20d)], ['20D EMA slope', rate(data.slope_ema_20d), '5-session change'],
    ['14D ATR contraction', rate(data.atr_contraction)], ['Consolidation sessions', count(data.consolidation_duration)],
    ['20D OBV change', compact(data.obv_slope_20d)], ['20D up days at 2× volume', count(data.high_volume_up_2x_20d)],
    ['20D down days at 2× volume', count(data.high_volume_down_2x_20d)],
    ['20/50/200D alignment', data.ma_aligned == null ? '—' : data.ma_aligned ? 'Bullish' : 'Mixed'],
    ['Industry median RS', number(data.industryRS)], ['4W industry RS velocity', signed(data.industryVelocity)],
    ['20D annualized volatility', rate(data.risk?.annualizedVolatility, 2, false)], ['Maximum drawdown', rate(data.risk?.maximumDrawdown)],
    [`Beta vs ${data.benchmark || 'benchmark'}`, number(data.risk?.beta, 2)], ['Daily historical VaR (95%)', rate(data.risk?.dailyHistoricalVaR95)],
  ].map((values) => tile(...values)).join('');
}

export async function openStock(env, id) {
  const run = ++drawerRequest;
  const controller = new AbortController();
  env.signal?.addEventListener('abort',()=>controller.abort(),{once:true});
  env.detail.addEventListener('close',()=>controller.abort(),{once:true});
  const signal = controller.signal;
  let range = 126;
  let cadence = 'daily';
  let priceStyle = 'line';
  let rsCadence = 'weekly';
  let rsRange = 252;
  let tab = 'price';
  let data;
  let warmup = '';
  const series = {};
  let screenMembership;
  const body = env.showDialog(env.detail, `Security · ${id}`, pending('Loading stock detail…'));
  const stockPath = `stocks/${pathPart(id)}`;
  const stockParams = { lookback: longestChartRange };
  try {
    data = await env.api(stockPath,{params:stockParams,signal});
  } catch (error) {
    if (run === drawerRequest && body.isConnected) body.innerHTML = notice('Stock detail unavailable', error.message, '', true);
    return;
  }
  if (run !== drawerRequest || !body.isConnected) return;
  const full = addMovingAverages(data.chartBars || data.bars || []);
  const heading = env.detail.querySelector('.dialog-head h2');
  heading.textContent = `${data.symbol} · ${data.name || 'Security'}`;
  env.detail.setAttribute('aria-label', heading.textContent);

  async function loadSeries(target) {
    const cadence = rsCadence;
    const limit = rangeLimit(rsRange, cadence);
    const scope = () => `${rsCadence}:${rangeLimit(rsRange, rsCadence)}`;
    const key = scope();
    try {
      const result = series[key] || await env.publishedSeries(`stocks/${pathPart(data.securityId)}/rankings`,
        {signal,params:{cadence,limit}},(partial,job)=>{
          if (target.isConnected && key===scope()) target.innerHTML=publishingHistory(job);
        });
      series[key] = result;
      if (target.isConnected && key === scope()) {
        target.innerHTML = chart(result.rows, [
          { key: 'percentile', label: 'RS percentile', format: (v) => number(v) },
          { key: 'udv_50d', label: 'U/D volume 50D', axis: 'right', format: (v) => ratio(v) },
        ], { domain: [0, 100], fill: true, rightAxisFormat: (v) => number(v, 1), label: 'RS percentile and up/down volume history' });
      }
    } catch (error) {
      if (target.isConnected && error.name!=='AbortError') target.innerHTML = notice('Ranking history unavailable', error.message, '', true);
    }
  }

  async function loadScreenMembership(target) {
    try {
      screenMembership ||= await env.publishedSeries(`stocks/${pathPart(data.securityId)}/screens`, { signal }, (partial, job) => {
        if (target.isConnected) target.innerHTML = publishingHistory(job);
      });
      if (!target.isConnected) return;
      target.innerHTML = stockScreenMatches(env, screenMembership);
    } catch (error) {
      if (target.isConnected) target.innerHTML = notice('Screen membership unavailable', error.message, '', true);
    }
  }

  function draw() {
    const bars = full.slice(-range);
    const plot = cadence === 'weekly' && bars.length ? toWeekly(full).filter((bar) => bar.date >= bars[0].date) : bars;
    const sourceIssues = data.quality || [];
    const activeReasons = new Set(sourceIssues.map(({reason})=>reason));
    const otherWarnings = (data.warnings||[]).filter((reason)=>!activeReasons.has(reason));
    const currentPriceQuarantined = sourceIssues.some((row)=>row.kind==='price'&&row.effective_from<=data.date&&row.effective_to>=data.date);
    const tools = `${rangeSegment('stock-range-local', range)}${segment('stock-cadence-local', [['daily','Daily'],['weekly','Weekly']], cadence)}
      ${segment('stock-style-local', [['line','Line'],['candles','Candles']], priceStyle)}${iconButton('Export plotted prices CSV', 'stock-export-local', 'download')}`;
    body.innerHTML = `<div id="stock-warming">${warmup}</div><div class="stock-identity"><div class="inline-stack">${chip(data.exchange || 'Exchange unavailable')}${chip(data.type || 'Type unavailable')}
       ${chip(dateLabel(data.latestDate))}${data.rsStatus === 'NEW' ? chip('Newly ranked', 'accent') : ''}</div>
       ${action('Add to watchlist', 'stock-watch-local', 'watchlists')}</div>
      <div class="summary-grid three section-space">
        ${summary('Split-adjusted close', currentPriceQuarantined?'Unavailable':money(data.close),
          currentPriceQuarantined?'Source price quarantined':rate(data.return_1d),
          { style:currentPriceQuarantined?'':direction(data.return_1d), glyph:'chart',small:currentPriceQuarantined })}
        ${summary('RS percentile', number(data.rsPercentile), data.rsRank != null ? `Rank ${data.rsRank}` : 'Unranked', { glyph: 'rankings' })}
        ${summary('4W RS velocity', signed(data.velocity4w), 'Percentile-point change', { style: direction(data.velocity4w), glyph: 'pulse' })}
      </div>
      ${segment('stock-tab-local', [['price','Price & volume'],['rs','RS history'],['metrics','Metrics & data'],['screens','Screen membership']], tab, 'tabs')}
      ${tab === 'price' ? `<section class="panel panel-body">${panelHead('Price and volume', 'Split-adjusted closes and moving averages', tools)}
        ${chart(plot, [{ key: 'close', label: 'Close', format: money }, { key: 'sma_20', label: '20D SMA', format: money },
          { key: 'sma_50', label: '50D SMA', format: money }, { key: 'sma_200', label: '200D SMA', format: money }],
        { volume:true,fill:priceStyle==='line',candles:priceStyle==='candles',height:270,axisFormat:(value)=>`$${number(value,0)}`,
          exportFields:['open','high','low','close','volume'],
          describePoint:describePricePoint })}
        </section>
        <div class="metric-grid section-space">${[['1W return', data.return_5d], ['1M return', data.return_21d], ['3M return', data.return_63d],
          ['6M return', data.return_126d], ['12M return', data.return_252d]].map(([label, value]) => tile(label, rate(value))).join('')}</div>`
      : tab === 'rs' ? `<section class="panel panel-body">${panelHead('Relative strength and volume history', 'Percentile and 50-session U/D volume',
          segment('stock-rs-local', [['daily','Daily'],['weekly','Weekly']], rsCadence) + rangeSegment('stock-rs-range-local', rsRange) +
          iconButton('Export ranking chart CSV', 'export-chart', 'download', 'stock-rs-history.csv'))}
        <div id="stock-rs-chart">${pending('Loading stock ranks…')}</div></section>
        <div class="metric-grid section-space">${[1,4,12].map((n) => tile(`${n}W rank change`, signed(data[`rankChange${n}w`], 0),
          `${signed(data[`velocity${n}w`])} percentile points`)).join('')}
          ${[4,8,12].map((n)=>tile(`Top-decile weeks in ${n}W`, count(data[`topDecileWeeks${n}w`]))).join('')}
          ${tile('4W U/D ratio change',signed(data.udvChange4w))}${tile('4W up-volume share change',rate(data.upVolumeShareChange4w))}</div>`
      : tab === 'screens' ? `<section class="panel panel-body">${panelHead('Saved screen membership', 'Screen matches evaluated on the selected historical session.')}
        <div id="stock-screens">${pending('Evaluating saved screens…')}</div></section>`
      : `<section class="panel panel-body">${panelHead('Price, liquidity, and technical metrics')}<div class="metric-grid">${currentSignals(data)}</div></section>
        <section class="panel panel-body section-space">${panelHead('Company context')}<div class="metric-grid">
          ${tile('Sector', data.sector || 'Unavailable')}${tile('Industry', data.industry || 'Unavailable')}${tile('Subindustry', data.subindustry || 'Unavailable')}
          ${tile('Earliest observation', dateLabel(data.earliestDate))}${tile('Latest observation', dateLabel(data.latestDate))}
          ${tile('Reference through', dateLabel(data.referenceDate), data.referenceMode === 'latest' ? 'Separate from price session' : '')}
          ${tile('Warehouse version', data.dataVersion ?? '—')}${tile('Corporate actions', count(data.actions?.length))}
          ${tile('Watchlists', data.watchlists?.length ? data.watchlists.join(', ') : 'None')}
          </div>
          ${data.industryId || data.sectorId ? `<div class="actions section-space">
            ${data.industryId ? `<a class="button" href="${safe(env.routeUrl('industries', { group: data.industryId, level: 'industry' }))}">Industry peers ${icon('chevron-right')}</a>` : ''}
            ${data.sectorId ? `<a class="button" href="${safe(env.routeUrl('industries', { group: data.sectorId, level: 'sector' }))}">Sector peers ${icon('chevron-right')}</a>` : ''}
          </div>` : ''}</section>`}
      ${sourceIssues.length ? `<div class="section-space">${stockQualityPanel(sourceIssues,data.date)}</div>` : ''}
      ${otherWarnings.length ? `<div class="section-space">${notice('Data quality',otherWarnings.join(' '))}</div>` : ''}`;
    if (tab === 'rs') loadSeries(body.querySelector('#stock-rs-chart'));
    if (tab === 'screens') loadScreenMembership(body.querySelector('#stock-screens'));
  }
  body.onclick = async (event) => {
    const control = event.target.closest('[data-action]');
    const value = control?.dataset.value;
    switch (control?.dataset.action) {
      case 'stock-range-local': range = Number(value); draw(); break;
      case 'stock-cadence-local': cadence = value; draw(); break;
      case 'stock-style-local': priceStyle = value; draw(); break;
      case 'stock-tab-local': tab = value; draw(); break;
      case 'stock-rs-local': rsCadence = value; draw(); break;
      case 'stock-rs-range-local': rsRange = Number(value); draw(); break;
      case 'stock-export-local':
        exportChart(body.querySelector('[data-chart]'), `${data.symbol}-${cadence}-plotted-prices.csv`);
        break;
      case 'stock-watch-local': await env.openAddWatchlist([data.securityId]).catch((error) => env.toast(error.message)); break;
      default: break;
    }
  };
  draw();
  if (data.materialization?.pending || data.materialization?.captureInProgress) {
    try {
      const next = await env.publishedSeries(stockPath,{initialResponse:data,signal,params:stockParams},(partial,job)=>{
        warmup = warming(job,'Rank change and persistence');
        const mount = body.querySelector('#stock-warming');
        if (mount?.isConnected) mount.innerHTML = warmup;
      });
      if (run===drawerRequest && body.isConnected && env.detail.open) {
        data=next;
        warmup='';
        draw();
      }
    } catch (error) {
      const mount = body.querySelector('#stock-warming');
      if (mount?.isConnected && error.name!=='AbortError') mount.innerHTML=notice('Historical detail unavailable',error.message,'',true);
    }
  }
}
