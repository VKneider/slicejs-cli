import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildTimestamp } from '../commands/utils/bundling/BundleGenerator.js';

// SOURCE_DATE_EPOCH makes the timestamps embedded in bundle metadata / config
// deterministic, so a clean rebuild is byte-identical (reproducible builds).
describe('resolveBuildTimestamp (SOURCE_DATE_EPOCH)', () => {
  test('honors SOURCE_DATE_EPOCH (integer seconds) when set', () => {
    const prev = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = '1700000000';
      assert.equal(resolveBuildTimestamp(), new Date(1700000000 * 1000).toISOString());
      // Deterministic: two calls with the same epoch return the same value.
      assert.equal(resolveBuildTimestamp(), resolveBuildTimestamp());
    } finally {
      if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = prev;
    }
  });

  test('falls back to the current time when unset or invalid', () => {
    const prev = process.env.SOURCE_DATE_EPOCH;
    try {
      delete process.env.SOURCE_DATE_EPOCH;
      const now = resolveBuildTimestamp();
      assert.match(now, /^\d{4}-\d{2}-\d{2}T/);

      // A non-numeric value is ignored (not thrown), falling back to current time.
      process.env.SOURCE_DATE_EPOCH = 'not-a-number';
      assert.match(resolveBuildTimestamp(), /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = prev;
    }
  });
});
