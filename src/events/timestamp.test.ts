import assert from 'node:assert/strict';
import test from 'node:test';

import { millisecondsToIso, secondsToIso } from './timestamp.js';

test('secondsToIso treats the value as Unix seconds', () => {
  assert.equal(secondsToIso(1760000001), '2025-10-09T08:53:21.000Z');
  });

test('millisecondsToIso treats the value as Unix milliseconds', () => {
  assert.equal(millisecondsToIso(1760000050123), '2025-10-09T08:54:10.123Z');
});

test('the same number differs by a factor of 1000 between the two units', () => {
  assert.equal(secondsToIso(1760000000), millisecondsToIso(1760000000000));
  assert.notEqual(secondsToIso(1760000000), millisecondsToIso(1760000000));
});

test('returns null for missing, non-numeric or non-finite values', () => {
  for (const bad of [undefined, null, '1760000001', {}, [], true, NaN, Infinity, -Infinity]) {
    assert.equal(secondsToIso(bad), null, `seconds: ${String(bad)}`);
    assert.equal(millisecondsToIso(bad), null, `milliseconds: ${String(bad)}`);
  }
});

test('returns null for negative values and values outside the Date range', () => {
  assert.equal(secondsToIso(-1), null);
  assert.equal(millisecondsToIso(-1), null);
  assert.equal(secondsToIso(Number.MAX_SAFE_INTEGER), null);
  assert.equal(millisecondsToIso(Number.MAX_VALUE), null);
});

test('rejects zero and the epoch, which are placeholders rather than real times', () => {
  assert.equal(secondsToIso(0), null);
  assert.equal(millisecondsToIso(0), null);
});

test('rejects milliseconds passed as seconds (would be a year-57000 date)', () => {
  assert.equal(secondsToIso(1760000050123), null);
});

test('rejects seconds passed as milliseconds (would be a January 1970 date)', () => {
  assert.equal(millisecondsToIso(1760000050), null);
});

test('window lower bound 2000-01-01T00:00:00Z is inclusive', () => {
  assert.equal(secondsToIso(946684800), '2000-01-01T00:00:00.000Z');
  assert.equal(millisecondsToIso(946684800000), '2000-01-01T00:00:00.000Z');
  assert.equal(secondsToIso(946684799), null);
  assert.equal(millisecondsToIso(946684799999), null);
});

test('window upper bound 2100-01-01T00:00:00Z is exclusive', () => {
  assert.equal(secondsToIso(4102444799), '2099-12-31T23:59:59.000Z');
  assert.equal(millisecondsToIso(4102444799999), '2099-12-31T23:59:59.999Z');
  assert.equal(secondsToIso(4102444800), null);
  assert.equal(millisecondsToIso(4102444800000), null);
});
