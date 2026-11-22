import { endianness } from 'node:os';
import { stockBaseFields } from './engine.mjs';
import { compressStoredBytes, decompressStoredBytes } from './storage-codec.mjs';

const magic = 'MSF2';
const legacyMagic = 'MSF1';
const layersPerShape = 2 ** 20;
const littleEndian = endianness() === 'LE';
const missingNumber = -Infinity;
const align = (offset) => Math.ceil(offset / 8) * 8;
const literals = [null, undefined, false, true];

function numericCell(value) {
  if (value === undefined) return missingNumber;
  if (!Number.isFinite(value)) return NaN;
  return value === 0 ? 0 : value;
}

function encodeVector(values, type) {
  if (littleEndian) return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const out = Buffer.allocUnsafe(values.byteLength);
  for (let index = 0; index < values.length; index++) {
    if (type === 'number') out.writeDoubleLE(values[index], index * 8);
    else out.writeUInt32LE(values[index], index * 4);
  }
  return out;
}

// Each stock field belongs to its original immutable layer. A context stores
// ordered references, so unchanged metadata and technicals are scanned once.
export function encodeStockFrame(plans, { codec } = {}) {
  const families = [];
  const familiesByKeys = new Map();
  const identities = new WeakMap();
  const text = [];
  const textIndexes = new Map();
  const jsonObjects = new WeakMap();
  const insertionOrders = [];
  const insertionIds = new WeakMap();
  const equalOrders = new Map();
  const chunks = [];
  let bytes = 0;
  function write(values, type) {
    const offset = align(bytes);
    const chunk = encodeVector(values, type);
    if (offset !== bytes) chunks.push(Buffer.alloc(offset - bytes));
    chunks.push(chunk);
    bytes = offset + chunk.length;
    return offset;
  }
  function layer(row) {
    if (!row) return 0;
    const found = identities.get(row);
    if (found !== undefined) return found;
    const names = Object.keys(row);
    const pattern = JSON.stringify(names);
    let family = familiesByKeys.get(pattern);
    if (!family) {
      family = { names, rows: [], index: families.length };
      familiesByKeys.set(pattern, family);
      families.push(family);
    }
    if (family.rows.length >= layersPerShape || family.index >= 4095) throw new RangeError('Prepared stock frame exceeded layer index capacity');
    const id = family.index * layersPerShape + family.rows.length + 1;
    family.rows.push(row);
    identities.set(row, id);
    return id;
  }
  function token(value, name) {
    const keyed = typeof value?.toJSON === 'function';
    if (keyed) value = value.toJSON(name);
    if (value == null) return value === null ? 0 : 1;
    if (typeof value === 'boolean') return value ? 3 : 2;
    if (typeof value === 'number' && !Number.isFinite(value)) return 0;
    if (typeof value === 'function' || typeof value === 'symbol') return 1;
    let entry = value;
    let key = typeof value === 'string' ? `s${value}` : value;
    if (typeof value === 'object' || typeof value === 'bigint') {
      if (!keyed && typeof value === 'object' && jsonObjects.has(value)) return jsonObjects.get(value);
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return 1;
      entry = [encoded];
      key = `j${encoded}`;
    }
    if (!textIndexes.has(key)) {
      textIndexes.set(key, text.length + 4);
      text.push(entry);
    }
    const index = textIndexes.get(key);
    if (!keyed && typeof value === 'object') jsonObjects.set(value, index);
    return index;
  }
  const orders = [];
  function insertionId(order) {
    if (!order?.length) return 0;
    if (insertionIds.has(order)) return insertionIds.get(order);
    const key = JSON.stringify(order);
    if (!equalOrders.has(key)) {
      insertionOrders.push(order);
      equalOrders.set(key, insertionOrders.length);
    }
    const id = equalOrders.get(key);
    insertionIds.set(order, id);
    return id;
  }
  for (const { index, positions, parts } of plans) {
    const values = new Uint32Array(positions.length * 7);
    for (let row = 0; row < positions.length; row++) {
      const position = positions[row];
      const [base, additions, parent, velocity, own] = parts(position);
      const offset = row * 7;
      values[offset] = position;
      values[offset + 1] = layer(base);
      values[offset + 2] = layer(additions?.order.length ? additions.values : null);
      values[offset + 3] = insertionId(additions?.order);
      values[offset + 4] = layer(parent);
      values[offset + 5] = layer(velocity);
      values[offset + 6] = layer(own);
    }
    orders[index] = [write(values), positions.length];
  }
  const shapes = families.map(({ names, rows }) => {
    const columns = names.map((name) => {
      let numeric = null;
      for (let row = 0; row < rows.length; row++) {
        const value = rows[row][name];
        if (value != null && typeof value !== 'number') {
          numeric = null;
          break;
        }
        (numeric ??= new Float64Array(rows.length))[row] = numericCell(value);
      }
      if (numeric) {
        const first = numeric[0];
        if (numeric.every((value) => Object.is(value, first))) {
          return first === missingNumber ? ['undefined'] : ['constant', Number.isNaN(first) ? null : first];
        }
        return ['number', write(numeric, 'number')];
      }
      const codes = new Uint32Array(rows.length);
      for (let row = 0; row < rows.length; row++) codes[row] = token(rows[row][name], name);
      return codes.every((value) => value === codes[0]) ? ['token', codes[0]] : ['tokens', write(codes)];
    });
    return [names, columns, rows.length];
  });
  const header = Buffer.from(JSON.stringify([orders, shapes, text, insertionOrders]));
  const prefix = Buffer.alloc(align(header.length + 8));
  prefix.write(magic);
  prefix.writeUInt32LE(header.length, 4);
  header.copy(prefix, 8);
  return compressStoredBytes(Buffer.concat([prefix, ...chunks], prefix.length + bytes), codec);
}

export function openStockFrame(value, fields) {
  const bytes = decompressStoredBytes(value);
  const format = bytes.toString('ascii', 0, 4);
  if (format !== magic && format !== legacyMagic || bytes.length < 8) throw new Error('Invalid prepared stock frame');
  const legacy = format === legacyMagic;
  const length = bytes.readUInt32LE(4);
  const start = align(length + 8);
  if (start > bytes.length) throw new Error('Truncated prepared stock frame');
  const [orders, shapes, dictionary, insertionOrders] = JSON.parse(bytes.toString('utf8', 8, length + 8));
  const views = shapes.map(([names, columns, rows], index) => ({ index, names, columns, rows, idField: names.indexOf('securityId'),
    visible: names.flatMap((name, index) => !fields || fields.has(name) ? [index] : []) }));
  function lookup(id) {
    if (!id) return null;
    const shape = views[Math.floor((id - 1) / layersPerShape)];
    const row = (id - 1) % layersPerShape;
    if (!shape || row >= shape.rows) throw new Error('Missing prepared stock frame layer');
    return [shape, row];
  }
  const combinedOrders = new Map();
  function mergedOrder(base, extra, orderId) {
    const key = `${base.index}:${extra.index}:${orderId}`;
    if (combinedOrders.has(key)) return combinedOrders.get(key);
    const rules = insertionOrders[orderId - 1];
    if (!rules) throw new Error('Missing prepared stock field insertion order');
    const extraFields = new Map(extra.names.map((name, index) => [name, index]));
    const baseFields = new Map(base.names.map((name, index) => [name, index]));
    const ordered = stockBaseFields(base.names, { order: rules }).flatMap((name) => {
      if (fields && !fields.has(name)) return [];
      return extraFields.has(name) ? [[name, 1, extra.columns[extraFields.get(name)]]] : [[name, 0, base.columns[baseFields.get(name)]]];
    });
    combinedOrders.set(key, ordered);
    return ordered;
  }
  return {
    decodedBytes: bytes.length,
    read(recipeIndex, selected) {
      if (!orders[recipeIndex]) throw new Error('Missing prepared stock frame recipe');
      const [offset, count] = orders[recipeIndex];
      const parsed = new Map();
      function decodeToken(code) {
        if (code < 4) return literals[code];
        const value = dictionary[code - 4];
        if (value === undefined) throw new Error('Missing prepared stock frame value');
        if (!Array.isArray(value)) return value;
        if (!parsed.has(code)) parsed.set(code, JSON.parse(value[0]));
        return parsed.get(code);
      }
      function field([type, value], row) {
        if (type === 'number') {
          const result = bytes.readDoubleLE(start + value + row * 8);
          return result === missingNumber ? undefined : Number.isNaN(result) ? null : result;
        }
        if (type === 'tokens') return decodeToken(bytes.readUInt32LE(start + value + row * 4));
        if (type === 'token') return decodeToken(value);
        return type === 'constant' ? value : undefined;
      }
      const results = [];
      for (let index = 0; index < count; index++) {
        const at = start + offset + index * (legacy ? 16 : 28);
        const position = bytes.readUInt32LE(at);
        const base = lookup(bytes.readUInt32LE(at + 4));
        const own = lookup(bytes.readUInt32LE(at + (legacy ? 12 : 24)));
        const identity = base ?? own;
        if (!identity || identity[0].idField < 0) throw new Error('Missing prepared stock frame identity');
        const id = field(identity[0].columns[identity[0].idField], identity[1]);
        if (selected && !selected.has(id)) continue;
        const parent = lookup(bytes.readUInt32LE(at + (legacy ? 8 : 16)));
        const extra = legacy ? null : lookup(bytes.readUInt32LE(at + 8));
        const velocity = legacy ? null : lookup(bytes.readUInt32LE(at + 20));
        const row = {};
        let omitted = null;
        function set(name, value) {
          if (name === '__proto__') Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true });
          else row[name] = value;
          if (value === undefined) (omitted ??= []).push(name);
        }
        if (extra) {
          if (!base) throw new Error('Prepared stock additions have no base layer');
          const orderId = bytes.readUInt32LE(at + 12);
          for (const [name, layer, column] of mergedOrder(base[0], extra[0], orderId)) set(name, field(column, layer ? extra[1] : base[1]));
        }
        for (const layer of [extra ? null : base, parent, velocity, own]) {
          if (!layer) continue;
          const [shape, ordinal] = layer;
          for (const column of shape.visible) {
            const name = shape.names[column];
            const value = field(shape.columns[column], ordinal);
            set(name, value);
          }
        }
        if (omitted) for (const name of omitted) if (row[name] === undefined) delete row[name];
        if (row.securityId !== id) throw new Error('Prepared stock frame changed a permanent security ID');
        results.push([position, row]);
      }
      return results;
    },
  };
}

export function readStockFrame(value, recipeIndex, selected, fields) {
  return openStockFrame(value, fields).read(recipeIndex, selected);
}
