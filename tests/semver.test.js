import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satisfies, rangeMismatch, parseVersion } from '../commands/utils/semver.js';

// Shared by `release-check` (does the CLI declare a framework it can install?)
// and `slice doctor` (does what is installed match what is declared?).

test('caret accepts later patches and minors of the same major', () => {
  assert.equal(satisfies('^4.0.2', '4.0.2'), true);
  assert.equal(satisfies('^4.0.2', '4.9.0'), true);
  assert.equal(satisfies('^4.0.2', '3.9.9'), false, 'a 3.x runtime is not ^4');
  assert.equal(satisfies('^4.0.2', '4.0.1'), false);
});

test('caret on 0.x stays inside the minor', () => {
  assert.equal(satisfies('^0.4.1', '0.4.9'), true);
  assert.equal(satisfies('^0.4.1', '0.5.0'), false);
});

test('tilde stays inside the minor and comparators compose', () => {
  assert.equal(satisfies('~4.3.0', '4.3.9'), true);
  assert.equal(satisfies('~4.3.0', '4.4.0'), false);
  assert.equal(satisfies('>=4.0.0 <5.0.0', '4.7.1'), true);
  assert.equal(satisfies('>=4.0.0 <5.0.0', '5.0.0'), false);
  assert.equal(satisfies('4.3.0 || 4.4.0', '4.4.0'), true);
});

test('an unknown form is not treated as a mismatch', () => {
  assert.equal(satisfies('latest', '4.0.0'), true);
  assert.equal(satisfies('*', '4.0.0'), true);
});

test('parseVersion ignores a leading range operator', () => {
  assert.deepEqual(parseVersion('^4.0.2'), { major: 4, minor: 0, patch: 2 });
  assert.equal(parseVersion('not-a-version'), null);
});

test('rangeMismatch skips specs that are not plain semver ranges', () => {
  assert.equal(rangeMismatch('file:../framework', '4.0.2'), null);
  assert.equal(rangeMismatch('link:../repos/slice.js', '4.0.2'), null);
  assert.equal(rangeMismatch('workspace:*', '4.0.2'), null);
});

test('rangeMismatch reports the range that rejects the installed version', () => {
  assert.equal(rangeMismatch('^4.0.2', '4.0.2'), null);
  assert.equal(rangeMismatch('^3.5.0', '4.0.2'), '^3.5.0');
});
