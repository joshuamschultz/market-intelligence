import { count, dateLabel, money, number, numeric, panelHead, percent, safe, signed, stockLink } from './ui.js';

const participationSpecs = [
  ['above_50d', 'Intermediate participation', '50-session SMA', 'intermediate'],
  ['above_200d', 'Long-term participation', '200-session SMA', 'long-term'],
];
const momentumSpecs = [
  ['positive_21d', '1M momentum', '21-session return'],
  ['positive_63d', '3M momentum', '63-session return'],
];

function breadthMetric(breadth, key) {
  const metric = breadth?.[key];
  if (!Number.isSafeInteger(metric?.denominator) || metric.denominator <= 0 ||
    !Number.isSafeInteger(metric.numerator) || metric.numerator < 0 || metric.numerator > metric.denominator ||
    !numeric(metric.value) || metric.value < 0 || metric.value > 100) return null;
  return { key, value: metric.value, numerator: metric.numerator, denominator: metric.denominator };
}

const participationLabel = (value) => value >= 60 ? 'broad' : value < 40 ? 'weak' : 'mixed';

function dailyBreadth(breadth) {
  const up = breadthMetric(breadth, 'advancers');
  const down = breadthMetric(breadth, 'decliners');
  if (!up || !down || up.denominator !== down.denominator || up.numerator + down.numerator > up.denominator) return null;
  const net = up.numerator - down.numerator;
  return { key: 'adSpread', advancers: up.numerator, decliners: down.numerator, denominator: up.denominator,
    value: 100 * net / up.denominator, direction: Math.sign(net) };
}

function dollarBreadth(aggregates) {
  const { upDollar, downDollar, dollarVolumeObservations } = aggregates ?? {};
  if (!Number.isSafeInteger(dollarVolumeObservations) || dollarVolumeObservations <= 0 ||
    !numeric(upDollar) || upDollar < 0 || !numeric(downDollar) || downDollar < 0) return null;
  return { upDollar, downDollar, observations: dollarVolumeObservations,
    ratio: downDollar > 0 ? upDollar / downDollar : null, direction: Math.sign(upDollar - downDollar) };
}

function rankingLead(leaders) {
  return (leaders ?? []).filter((row) => typeof row?.symbol === 'string' && row.symbol.trim() &&
    Number.isSafeInteger(row.rsRank) && row.rsRank > 0).reduce((best, row) => !best || row.rsRank < best.rsRank ? row : best, null);
}

function industryLead(groups) {
  return (groups ?? []).filter((row) => row?.level === 'industry' && typeof row.name === 'string' && row.name.trim() &&
    numeric(row.medianRS) && Number.isSafeInteger(row.rankedCount) && row.rankedCount > 0)
    .reduce((best, row) => !best || row.medianRS > best.medianRS ? row : best, null);
}

export function buildMarketReading(snapshot) {
  const { date, universe, coverage, breadth, aggregates, leaders, groups } = snapshot ?? {};
  const participation = participationSpecs.flatMap(([key, title, rule, horizon]) => {
    const metric = breadthMetric(breadth, key);
    return metric ? [{ ...metric, title, rule, horizon, label: participationLabel(metric.value) }] : [];
  });
  const momentum = momentumSpecs.flatMap(([key, title, rule]) => {
    const metric = breadthMetric(breadth, key);
    return metric ? [{ ...metric, title, rule }] : [];
  });
  return { date, universe: universe?.name, verified: coverage?.state === 'complete', participation, momentum,
    daily: dailyBreadth(breadth), dollars: dollarBreadth(aggregates), leader: rankingLead(leaders), industry: industryLead(groups) };
}

function interpretation({ participation, daily, dollars }) {
  const trend = participation.map(({ horizon, label }) => `${horizon} participation was ${label}`).join(' and ');
  const breadth = daily && (daily.direction > 0 ? 'advancers outnumbered decliners' : daily.direction < 0
    ? 'decliners outnumbered advancers' : daily.advancers > 0 ? 'advancers and decliners were evenly matched' : 'comparable stocks closed unchanged');
  const volume = dollars && (dollars.direction > 0 ? 'recorded dollar volume favored advancers' : dollars.direction < 0
    ? 'recorded dollar volume favored decliners' : dollars.upDollar > 0 ? 'recorded dollar volume was evenly split' : '');
  const today = [breadth, volume].filter(Boolean).join(daily && dollars && daily.direction * dollars.direction < 0 ? ', while ' : ' and ');
  return [trend, today].filter(Boolean).map((line) => `${line[0].toUpperCase()}${line.slice(1)}.`).join(' ');
}

function tile(title, figure, details, key) {
  const content = `<span>${safe(title)}</span><strong>${safe(figure)}</strong>${details.map((detail) => `<small>${safe(detail)}</small>`).join('')}`;
  return key ? `<button class="metric-tile" type="button" data-action="breadth" data-value="${safe(key)}">${content}</button>`
    : `<div class="metric-tile">${content}</div>`;
}

const comparable = ({ numerator, denominator }) => `${count(numerator)} of ${count(denominator)} comparable`;

function leadership({ leader, industry }) {
  const rank = leader && `${leader.rsRank === 1 ? 'RS leader' : 'Ranked stock'} ${stockLink(leader)}
    <span>· Rank ${count(leader.rsRank)}${numeric(leader.rsPercentile) ? ` · RS percentile ${number(leader.rsPercentile)}` : ''}</span>`;
  const group = industry && `Industry leadership · ${safe(industry.name)} had a median RS percentile of ${number(industry.medianRS)} across ${count(industry.rankedCount)} ranked stocks.`;
  return [rank, group].filter(Boolean).map((line) => `<p class="muted section-space">${line}</p>`).join('');
}

export function renderMarketReading(snapshot) {
  const reading = buildMarketReading(snapshot);
  const { date, universe, verified, participation, daily, momentum, dollars } = reading;
  const description = [date && dateLabel(date), universe, verified ? 'Verified coverage' : 'Observed stocks'].filter(Boolean).join(' · ');
  const tiles = [
    ...participation.map((metric) => tile(metric.title, percent(metric.value), [`Above ${metric.rule}`, comparable(metric)], metric.key)),
    daily && tile('Daily advance / decline', `${signed(daily.value)} pp`, [
      `${count(daily.advancers)} advanced · ${count(daily.decliners)} declined`, `${count(daily.denominator)} comparable`,
    ], daily.key),
    ...momentum.map((metric) => tile(metric.title, percent(metric.value), [`Positive ${metric.rule}`, comparable(metric)], metric.key)),
    dollars && tile('Up / down dollar volume', dollars.ratio != null ? `${dollars.ratio.toFixed(2)}×` : dollars.upDollar > 0 ? 'No recorded down volume' : 'No directional volume', [
      `${money(dollars.upDollar)} up · ${money(dollars.downDollar)} down`, `${count(dollars.observations)} volume observations`,
    ]),
  ].filter(Boolean);
  const headline = interpretation(reading);
  const leadershipMarkup = leadership(reading);
  return `<section class="panel panel-body section-space">${panelHead('Market reading', description)}
    ${headline ? `<p>${safe(headline)}</p>` : ''}
    ${tiles.length ? `<div class="metric-grid${headline ? ' section-space' : ''}">${tiles.join('')}</div>` : ''}
    ${leadershipMarkup}
    ${participation.length ? '<p class="muted section-space">Participation bands use the share above each moving average. Broad is 60% or higher, mixed is 40% to under 60%, and weak is below 40%.</p>' : ''}
    ${!tiles.length && !leadershipMarkup ? '<p class="muted">No comparable market readings are available for this session.</p>' : ''}
  </section>`;
}
