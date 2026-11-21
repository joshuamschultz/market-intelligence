import { finite } from './metrics.mjs';
import { rankBy } from './ranking.mjs';

const fieldPattern = /^[A-Za-z_][A-Za-z_0-9]{0,79}$/;
const isNull = (value) => value == null || (typeof value === 'number' && !finite(value));
const own = (row, key) => key && Object.hasOwn(row, key) ? row[key] : null;
const operators = new Map([
  ['or', 1], ['||', 1], ['and', 2], ['&&', 2], ['==', 3], ['!=', 3],
  ['<', 4], ['>', 4], ['<=', 4], ['>=', 4], ['+', 5], ['-', 5], ['*', 6], ['/', 6], ['%', 6],
]);
const functionNames = new Set(['min', 'max', 'abs', 'log', 'rank', 'percentile', 'change', 'previous', 'coalesce']);

export function parseExpression(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 1000) throw new Error('Expression must contain 1–1,000 characters');
  const tokens = [];
  const tokenPattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|([A-Za-z_][A-Za-z_0-9]*)|("(?:[^"\\]|\\["\\nrt])*")|(==|!=|<=|>=|&&|\|\||[()+\-*/%,<>!]))/y;
  let position = 0;
  while (position < source.length) {
    if (!source.slice(position).trim()) break;
    tokenPattern.lastIndex = position;
    const candidate = tokenPattern.exec(source);
    if (!candidate) throw new Error(`Invalid expression at character ${position + 1}`);
    const [, number, word, string, symbol] = candidate;
    tokens.push(number ? { literal: Number(candidate[0].trim()) }
      : string ? { literal: JSON.parse(string) }
      : { word: word || symbol });
    position = tokenPattern.lastIndex;
  }
  if (!tokens.length || tokens.length > 350) throw new Error('Expression is too complex');
  let cursor = 0;
  const peek = () => tokens[cursor]?.word;
  const take = () => tokens[cursor++];
  const require = (word) => {
    if (peek() !== word) throw new Error(`Expected ${word} in expression`);
    take();
  };
  function primary(depth) {
    if (depth > 25) throw new Error('Expression nesting exceeds 25 levels');
    const token = take();
    if (!token) throw new Error('Expression ended early');
    if ('literal' in token) return { literal: token.literal };
    const { word } = token;
    if (['true', 'false', 'null'].includes(word)) return { literal: word === 'null' ? null : word === 'true' };
    if (word === '(') {
      const node = expression(1, depth + 1);
      require(')');
      return node;
    }
    if (['-', '+', '!', 'not'].includes(word)) return { unary: word, arg: primary(depth + 1) };
    if (!fieldPattern.test(word)) throw new Error(`Unexpected expression token ${word}`);
    if (peek() !== '(') return { field: word };
    if (!functionNames.has(word)) throw new Error(`Unsupported function ${word}`);
    take();
    const args = [expression(1, depth + 1)];
    while (peek() === ',') {
      take();
      args.push(expression(1, depth + 1));
    }
    require(')');
    if (['abs', 'log', 'rank', 'percentile'].includes(word) && args.length !== 1) throw new Error(`${word} requires one argument`);
    if (['change', 'previous'].includes(word) && (args.length > 2 || !args[0].field)) throw new Error(`${word} requires a metric and optional lag`);
    if (['rank', 'percentile'].includes(word) && !args[0].field) throw new Error(`${word} requires a metric name`);
    return { fn: word, args };
  }
  function expression(min, depth) {
    let node = primary(depth);
    while ((operators.get(peek()) || 0) >= min) {
      const op = take().word;
      node = { op, left: node, right: expression(operators.get(op) + 1, depth + 1) };
    }
    return node;
  }
  const ast = expression(1, 0);
  if (cursor !== tokens.length) throw new Error('Unexpected trailing expression input');
  return ast;
}

function evaluate(node, row, runtime) {
  if ('literal' in node) return node.literal;
  if (node.field) {
    const value = own(row, node.field);
    return value == null && own(row, node.field.replace(/^udv_/, 'udv_state_')) === 'infinity' ? Infinity : value;
  }
  if (node.unary) {
    const value = evaluate(node.arg, row, runtime);
    if (isNull(value)) return null;
    if (node.unary === '!' || node.unary === 'not') return !value;
    if (!finite(value)) return null;
    return node.unary === '-' ? -value : value;
  }
  if (node.fn) {
    const { fn, args } = node;
    if (fn === 'rank' || fn === 'percentile') return runtime.ranking(args[0].field).get(row.securityId)?.[fn] ?? null;
    if (fn === 'change' || fn === 'previous') {
      const lag = args[1] ? evaluate(args[1], row, runtime) : 20;
      const prior = runtime.previous(args[0].field, row.securityId, lag);
      if (fn === 'previous') return prior;
      const value = own(row, args[0].field);
      return finite(value) && finite(prior) ? value - prior : null;
    }
    const values = args.map((arg) => evaluate(arg, row, runtime));
    if (fn === 'coalesce') return values.find((value) => !isNull(value)) ?? null;
    if (!values.every(finite)) return null;
    if (fn === 'min') return Math.min(...values);
    if (fn === 'max') return Math.max(...values);
    if (fn === 'abs') return Math.abs(values[0]);
    if (fn === 'log') return values[0] > 0 ? Math.log(values[0]) : null;
  }
  const left = evaluate(node.left, row, runtime);
  const right = evaluate(node.right, row, runtime);
  return compareOperation(node.op, left, right);
}

function compareOperation(operation, left, right) {
  if (operation === 'and' || operation === '&&') {
    if (left === false || right === false) return false;
    return isNull(left) || isNull(right) ? null : Boolean(left && right);
  }
  if (operation === 'or' || operation === '||') {
    if ((!isNull(left) && left) || (!isNull(right) && right)) return true;
    return isNull(left) || isNull(right) ? null : false;
  }
  const invalid = (value) => isNull(value) && value !== Infinity;
  if (invalid(left) || invalid(right)) return null;
  switch (operation) {
    case '==': case 'eq': return left === right;
    case '!=': case 'ne': return left !== right;
    case 'in': return Array.isArray(right) && right.includes(left);
    case 'contains': return String(left).toLowerCase().includes(String(right).toLowerCase());
    case 'between': return Array.isArray(right) && left >= right[0] && left <= right[1];
    case '<': case 'lt': return left < right;
    case '>': case 'gt': return left > right;
    case '<=': case 'lte': return left <= right;
    case '>=': case 'gte': return left >= right;
    default: break;
  }
  if (!finite(left) || !finite(right)) return null;
  let value;
  switch (operation) {
    case '+': value = left + right; break;
    case '-': value = left - right; break;
    case '*': value = left * right; break;
    case '/': value = right === 0 ? null : left / right; break;
    case '%': value = right === 0 ? null : left % right; break;
    default: return null;
  }
  return finite(value) ? value : null;
}

export function validateFilter(filter, depth = 0) {
  if (filter == null) return null;
  if (depth > 12 || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Filters must be nested no more than 12 levels');
  const nested = filter.filters || filter.rules || filter.children;
  if (nested) {
    const operator = String(filter.operator || filter.op || 'and').toLowerCase();
    if (!['and', 'or'].includes(operator) || !Array.isArray(nested) || nested.length > 35) throw new Error('Invalid nested filter group');
    return { operator, filters: nested.map((item) => validateFilter(item, depth + 1)).filter(Boolean) };
  }
  if (filter.expression) return { expression: String(filter.expression), ast: parseExpression(filter.expression) };
  const field = String(filter.field || '');
  const op = String(filter.op || 'eq');
  if (!fieldPattern.test(field) || !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'between', 'missing', 'present', 'true', 'false'].includes(op)) {
    throw new Error('Invalid filter metric or comparison');
  }
  if (['in', 'between'].includes(op) && (!Array.isArray(filter.value) || filter.value.length > 200
      || (op === 'between' && filter.value.length !== 2))) throw new Error('Provide the correct number of comparison values');
  return { field, op, value: filter.value ?? null };
}

function matchFilter(filter, row, runtime) {
  if (!filter) return true;
  if (filter.filters) {
    return filter.operator === 'or'
      ? filter.filters.some((item) => matchFilter(item, row, runtime))
      : filter.filters.every((item) => matchFilter(item, row, runtime));
  }
  if (filter.ast) return evaluate(filter.ast, row, runtime) === true;
  const value = evaluate({ field: filter.field }, row, runtime);
  if (filter.op === 'missing') return value == null;
  if (filter.op === 'present') return value != null;
  if (filter.op === 'true') return value === true;
  if (filter.op === 'false') return value === false;
  return compareOperation(filter.op, value, filter.value) === true;
}

export function validateScreen(input = {}) {
  const sort = Array.isArray(input.sort) ? input.sort : [{ field: 'rsRank', direction: 'asc' }];
  if (sort.length > 12) throw new Error('Use at most 12 sort columns');
  const computed = Array.isArray(input.computed) ? input.computed : [];
  if (computed.length > 12) throw new Error('Use at most 12 computed columns');
  const groupBy = input.groupBy || '';
  if (!['', 'industry', 'sector', 'marketCapBucket'].includes(groupBy)) throw new Error('Unknown grouping');
  const definition = {
    filter: validateFilter(input.filter), search: String(input.search || '').trim().slice(0, 100),
    sort: sort.map(({ field, direction }) => {
      if (!fieldPattern.test(field) || !['asc', 'desc'].includes(direction)) throw new Error('Invalid sort column or direction');
      return { field, direction };
    }),
    columns: (Array.isArray(input.columns) ? input.columns : []).filter((field) => fieldPattern.test(field)).slice(0, 90),
    computed: computed.map(({ field, label, expression }) => {
      if (!fieldPattern.test(field) || !field.startsWith('custom_')) throw new Error('Computed field names must begin custom_');
      return { field, label: String(label || field).slice(0, 100), expression, ast: parseExpression(expression) };
    }),
    groupBy, includeUntraded: Boolean(input.includeUntraded),
  };
  if (new Set(definition.computed.map(({ field }) => field)).size !== definition.computed.length) throw new Error('Computed metric names must be unique');
  return definition;
}

function compareValues(left, right, direction) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const cmp = typeof left === 'number' && typeof right === 'number' ? Math.sign(left - right) || 0
    : String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
  return direction === 'asc' ? cmp : -cmp;
}

function bucket(cap) {
  if (cap == null) return 'Unreported';
  if (cap >= 200_000_000_000) return 'Mega';
  if (cap >= 10_000_000_000) return 'Large';
  if (cap >= 2_000_000_000) return 'Mid';
  if (cap >= 300_000_000) return 'Small';
  return 'Micro';
}

export function screenStocks(snapshot, input = {}, { previous = () => null, all = false } = {}) {
  const definition = validateScreen(input);
  const universe = snapshot.stocks.filter((row) => definition.includeUntraded || row.traded)
    .map((row) => ({ ...row, marketCapBucket: bucket(row.market_cap) }));
  const ranks = new Map();
  const runtime = {
    previous,
    ranking(field) {
      if (!ranks.has(field)) ranks.set(field, rankBy(universe, (row) => own(row, field)));
      return ranks.get(field);
    },
  };
  for (const item of definition.computed) {
    for (const row of universe) row[item.field] = evaluate(item.ast, row, runtime);
  }
  const search = definition.search.toLowerCase();
  const selected = universe.filter((row) => (!search || [row.symbol, row.name, row.sector, row.industry].some((value) => value?.toLowerCase().includes(search)))
    && matchFilter(definition.filter, row, runtime));
  const sortField = (row, field) => evaluate({ field }, row, runtime);
  selected.sort((left, right) => {
    for (const { field, direction } of definition.sort) {
      const cmp = compareValues(sortField(left, field), sortField(right, field), direction);
      if (cmp) return cmp;
    }
    return left.symbol.localeCompare(right.symbol, 'en') || left.securityId.localeCompare(right.securityId, 'en');
  });
  const groupCounts = new Map();
  selected.forEach((row, index) => {
    row.subsetRank = index + 1;
    if (definition.groupBy) {
      const group = row[definition.groupBy] ?? 'Unclassified';
      groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
      row.group = group;
      row.groupRank = groupCounts.get(group);
    }
  });
  const perPage = Math.max(1, Math.min(250, Math.floor(Number(input.perPage) || 50)));
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  return { date: snapshot.date, total: selected.length, page, perPage, universeCount: universe.length, columns: definition.columns,
    groups: [...groupCounts].map(([name, count]) => ({ name, count })),
    rows: all ? selected : selected.slice((page - 1) * perPage, page * perPage) };
}

function csvCell(value) {
  if (value == null) return '';
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? "'" + value : String(value);
  return /[",\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}

export function csvRows(rows, columns) {
  return [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((field) => csvCell(row[field])).join(','))].join('\r\n') + '\r\n';
}
