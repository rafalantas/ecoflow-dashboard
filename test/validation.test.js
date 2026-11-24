'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidDateString, isValidPeriod } = require('../backend/validation');

test('accepts only supported scalar energy periods', () => {
  for (const period of ['day', 'week', 'month', 'year']) assert.equal(isValidPeriod(period), true);
  for (const period of [undefined, null, '', 'DAY', 'hour', [], ['day'], {}, 1]) {
    assert.equal(isValidPeriod(period), false);
  }
});

test('accepts real YYYY-MM-DD calendar dates only', () => {
  for (const date of ['2024-02-29', '2026-11-24', '0001-01-01']) assert.equal(isValidDateString(date), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10',
    '2026-1-01', '26-01-01', '2026-01-01T00:00:00Z', '', null, [], ['2026-01-01'], {}]) {
    assert.equal(isValidDateString(date), false);
  }
});
