import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate } from '../backend/database.mjs';

const originalIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

test('Gregorian date validation retains the original leap-year behavior for all four-digit years', () => {
  for (let year = 0; year < 10_000; year++) {
    const prefix = String(year).padStart(4, '0');
    for (const suffix of ['01-01', '02-28', '02-29', '02-30', '12-31']) {
      const date = `${prefix}-${suffix}`;
      assert.equal(isoDate(date), originalIsoDate(date), date);
    }
  }
});

test('date validation rejects out-of-range days, malformed strings and nonstrings', () => {
  for (let month = 0; month <= 13; month++) {
    for (let day = 0; day <= 32; day++) {
      const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      assert.equal(isoDate(date), originalIsoDate(date), date);
    }
  }
  for (const value of [null, undefined, false, 20261120, {}, new String('2026-11-20'), Symbol(),
    '2026-1-20', '2026-11-2', '2026/11/20', '2026-11-20\n', ' 2026-11-20', '2026-11-20T00:00:00Z',
    '2026-11-20\0', '２０２６-11-20', '2026-1²-20', '2026-11-x0', '10000-01-01', '-0001-01-01']) {
    assert.equal(isoDate(value), false, String(value));
  }
});
