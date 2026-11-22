import * as z from 'zod/v4';
import { BREADTH_METRICS } from './breadth.mjs';
import { researchEndpoints } from './ai-access.mjs';

const date = z.iso.date().refine((value) => value >= '1900-01-01', 'Dates start in 1900');
const label = z.string().min(1).max(180);
const symbol = z.string().regex(/^[A-Za-z0-9^][A-Za-z0-9._^=-]{0,29}$/);
const version = z.int().min(1);
const count = (max) => z.int().min(1).max(max);
const page = { offset: z.int().min(0).max(100000).optional(), limit: count(100).optional() };
const period = z.enum(['daily', 'weekly']);
const lists = z.enum(['watchlist', 'screen', 'chartbook', 'market-chartbook']);
const levels = z.enum(['sector', 'industry', 'subindustry', 'theme']);
const metrics = z.enum([...BREADTH_METRICS.map(({ key }) => key), 'down_13pct_34d', 'up_13pct_34d']);
const marketMetrics = z.union([metrics, z.enum(['adSpread', 'adRatio'])]);

export const stockFields = [
  'securityId', 'symbol', 'name', 'exchange', 'type', 'sector', 'industry', 'industryId', 'subindustry', 'traded', 'close', 'open', 'high', 'low',
  'volume', 'dollarVolume', 'market_cap', 'float', 'shares', 'floatDate', 'floatKnownAt', 'sharesDate', 'sharesKnownAt', 'return_1d', 'return_5d', 'return_10d', 'return_20d', 'return_21d',
  'return_42d', 'return_63d', 'return_126d', 'return_252d', 'relative_return_21d', 'distance_high_252d', 'adv_20d', 'rvol_20d', 'udv_50d',
  'udv_state_50d', 'rsScore', 'rsRank', 'rsPercentile', 'velocity4w', 'velocity12w', 'rankChange4w', 'rankChange12w', 'industryRS',
  'industryBreadth', 'industryVelocity', 'above_20d', 'above_50d', 'above_100d', 'above_200d', 'new_high_20d', 'new_low_20d', 'new_high_252d',
  'new_low_252d', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'ma_aligned', 'obv_slope', 'marketCapBucket',
];
const stock = z.enum(stockFields);
const fields = z.array(stock).min(1).max(20);
const scalar = z.union([z.string().max(180), z.number(), z.boolean(), z.null()]);
const filter = z.strictObject({ field: stock, op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'between', 'missing', 'present', 'true', 'false']),
  value: z.union([scalar, z.array(scalar).max(30)]).optional() });
const sort = z.strictObject({ field: stock, direction: z.enum(['asc', 'desc']) });
const context = z.strictObject({
  asOf: date.optional(), dataVersion: version.optional(), calculationVersion: z.string().regex(/^2-[a-f0-9]{12}$/).optional(),
  universe: label.optional(), universeVersion: version.optional(), model: label.optional(), modelVersion: version.optional(),
  basis: z.enum(['known', 'reconstructed']).optional(), benchmark: symbol.optional(),
  classification: label.optional(), reference: z.enum(['as-of', 'latest']).optional(), observedReferenceDate: date.optional(),
}).optional().describe('Use a verified dataRevision and the effective date to repeat or page a result. Omit to use the latest verified snapshot.');
const range = { from: date.optional(), to: date.optional(), sessions: count(2520).optional() };
const rows = z.array(z.record(z.string(), z.json()));
const outputPage = z.object({ offset: z.int(), limit: z.int(), total: z.int(), nextOffset: z.int().nullable() });
const outputContext = z.object({ date, dataVersion: version, calculationVersion: z.string(),
  basis: z.string(), benchmark: z.string(), classification: z.string(), reference: z.string(),
  universe: z.object({ id: z.string(), version, name: z.string() }), model: z.object({ id: z.string(), version, name: z.string() }),
  verifiedThrough: date, proofId: z.string(), observedReferenceDate: date, archiveFrom: date,
});
const dataObject = z.record(z.string(), z.json());
const result = z.object({
  state: z.string(), context: outputContext.nullable(), source: z.string(),
  coverage: dataObject, page: outputPage.optional(), rows: rows.optional(), data: dataObject.optional(),
});
const entry = (name, description, shape, scope = 'research:read') => ({
  name, description, scope, input: z.strictObject(shape), output: result,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

export const researchTools = [
  entry('describe_research', 'Discover metric definitions, units, preparation coverage, supported contexts and the latest verified analysis pin.', { context, q: label.optional(), ...page }),
  entry('search_stocks', 'Find dated securities in the prepared universe by ticker, company name, or permanent security ID.', { context, q: label, ...page }),
  entry('search_groups', 'Find sectors, industries, subindustries or themes in the selected prepared classification.', { context, q: label.optional(), level: levels.optional(), ...page }),
  entry('list_workspace_lists', 'List saved watchlists, screens, ChartBooks and market ChartBooks. Private notes and settings are excluded.', { context, kind: lists.optional(), ...page }),
  entry('read_workspace_list', 'Read a saved watchlist, screen or ChartBook definition, with prepared membership where supported.', { context, kind: lists, id: label, version: version.optional(), ...page }),
  entry('read_stock', 'Read selected calculated fields and coverage for one dated stock identifier.', { context, security: label, fields: fields.optional() }),
  entry('read_stock_history', 'Read prepared split-adjusted prices, archived ranks or dated calculated stock fields. Gaps remain visible.', {
    context, security: label, series: z.enum(['prices', 'ranks', 'calculated']), fields: fields.optional(), cadence: period.optional(), ...range, ...page,
  }),
  entry('read_market_history', 'Read stored market, breadth, health or NYSE Summation Index history with dated coverage and gaps.', {
    context, series: z.enum(['market', 'breadth', 'health', 'nyse-summation']), metrics: z.array(marketMetrics).min(1).max(12).optional(),
    healthModel: label.optional(), cadence: period.optional(), ...range, ...page,
  }),
  entry('market_timing', 'Read prepared session timing and historical evidence for benchmark trend, pressure, breadth and leadership.', {
    context, sessions: count(1260).optional(), ...page,
  }),
  entry('read_metric_constituents', 'Identify prepared stocks contributing to a breadth metric numerator or denominator at the selected date.', {
    context, metric: metrics, mode: z.enum(['matches', 'comparable']).optional(), ...page,
  }),
  entry('screen_stocks', 'Screen prepared calculated fields using typed comparisons, allowlisted columns and stable pagination.', {
    context, fields: fields.optional(), filters: z.array(filter).max(12).optional(), combine: z.enum(['and', 'or']).optional(),
    sort: z.array(sort).max(4).optional(), q: label.optional(), includeUntraded: z.boolean().optional(), ...page,
  }),
  entry('industry_strength', 'Rank dated industries by 12-week RS percentile improvement, current rank, or 12-week compounded equal-weight return. Report excluded and ambiguous sectors.', {
    context, order: z.enum(['rs-improvement', 'current-rank', 'trailing-return']).optional(),
    membership: z.enum(['auto', 'dated', 'current']).optional().describe('Auto uses prepared current membership for latest Nasdaq RS improvement when dated velocity is absent.'),
    excludeDefensive: z.boolean().optional(), excludedSectors: z.array(label).max(20).optional(),
    includeUnclassified: z.boolean().optional(), view: z.enum(['eligible', 'excluded', 'all']).optional(), ...page,
  }),
  entry('benchmark_event_study', 'Compare the current unrounded breadth reading or an explicit threshold against all earlier eligible sessions. Report benchmark outcomes, missing endpoints and right-censoring.', {
    context, metric: metrics, operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']).optional(), threshold: z.number().optional(),
    benchmark: symbol.optional(), horizons: z.array(count(252)).min(1).max(4).optional(),
    start: date.optional(), eventEnd: date.optional(), overlap: z.enum(['none', 'perHorizon', 'longest']).optional(),
    coverageMode: z.enum(['verified', 'observed']).optional(), ...page,
  }),
  entry('historical_analogs', 'Find similar past breadth conditions and summarize empirical forward benchmark outcomes. Returns the historical distribution, not a forecast.', {
    context, metrics: z.array(metrics).min(2).max(12).optional(), horizon: count(252).optional(), sampleLimit: count(100).optional(),
    minimumHistory: z.int().min(2).max(1000).optional(), start: date.optional(),
    overlap: z.enum(['nonoverlapping', 'allow']).optional(), coverageMode: z.enum(['verified', 'observed']).optional(), ...page,
  }),
  entry('read_research_notes', 'Read private dated research notes for a stock, industry or market subject. Requires explicit private-notes scope.', {
    context, subjectType: z.enum(['stock', 'industry', 'market']), subjectId: label, from: date.optional(), to: date.optional(), ...page,
  }, 'research:notes'),
  entry('read_journals', 'Read previously generated private market journals. Explicit as-of and end dates enforce historical New York calendar-day availability. Provider settings, prompts and keys are excluded.', {
    context, from: date.optional(), to: date.optional(), includeRetrospective: z.boolean().optional(), ...page,
  }, 'research:journals'),
];

export function availableTools(principal) {
  return researchTools.filter(({ scope }) => principal?.scopes.includes(scope));
}

export function toolManifest(principal) {
  return availableTools(principal).map(({ name, description, input, output, annotations }) => ({
    name, description, inputSchema: z.toJSONSchema(input, { target: 'draft-2020-12', unrepresentable: 'any' }),
    outputSchema: z.toJSONSchema(output, { target: 'draft-2020-12' }), annotations,
  }));
}

export function researchOpenApi(principal) {
  const paths = Object.fromEntries(toolManifest(principal).map(({ name, description, inputSchema, outputSchema }) => [
    `${researchEndpoints.tools}/${name}`, {
      post: { operationId: name, description, requestBody: { required: true, content: { 'application/json': { schema: inputSchema } } },
        responses: { 200: { description: 'Structured research result', content: { 'application/json': { schema: outputSchema } } },
          400: { description: 'Invalid tool arguments' }, 401: { description: 'Research bearer required' },
          403: { description: 'Integration does not have the required scope' }, 404: { description: 'Requested item unavailable' },
          503: { description: 'Verified data or requested preparation unavailable' } } },
    },
  ]));
  return { openapi: '3.1.0', info: { title: 'Market Intelligence Research', version: '1.0.0' },
    components: { securitySchemes: { researchBearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ researchBearer: [] }], paths };
}

export async function invokeResearchTool(research, principal, name, input) {
  const tool = researchTools.find((candidate) => candidate.name === name);
  if (!tool || !principal?.scopes.includes(tool.scope)) {
    throw Object.assign(new Error(tool ? 'This integration lacks the required research scope' : 'Research tool not found'),
      { status: tool ? 403 : 404 });
  }
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues.map(({ path, message }) =>
    `${path.length ? path.join('.') + ': ' : ''}${message}`).join('; ')), { status: 400 });
  const value = await research.run(name, parsed.data, principal);
  return tool.output.parse(JSON.parse(JSON.stringify(value)));
}
