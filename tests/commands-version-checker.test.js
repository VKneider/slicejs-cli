import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import versionChecker from '../commands/utils/VersionChecker.js';

describe('VersionChecker.compareVersions', () => {
  test('detects an outdated version', () => {
    assert.equal(versionChecker.compareVersions('1.0.0', '1.0.1'), 'outdated');
    assert.equal(versionChecker.compareVersions('1.2.0', '2.0.0'), 'outdated');
  });

  test('detects a newer (local) version', () => {
    assert.equal(versionChecker.compareVersions('2.0.0', '1.9.9'), 'newer');
  });

  test('detects an up-to-date version', () => {
    assert.equal(versionChecker.compareVersions('3.5.0', '3.5.0'), 'current');
  });

  test('handles version strings of differing length', () => {
    assert.equal(versionChecker.compareVersions('1.0', '1.0.0'), 'current');
    assert.equal(versionChecker.compareVersions('1.0.0', '1.0.0.1'), 'outdated');
    assert.equal(versionChecker.compareVersions('1.0.1', '1.0'), 'newer');
  });

  test('returns null when a version is missing', () => {
    assert.equal(versionChecker.compareVersions(null, '1.0.0'), null);
    assert.equal(versionChecker.compareVersions('1.0.0', undefined), null);
  });
});

describe('VersionChecker.getCurrentVersions', () => {
  test('reads the CLI version from the package.json (no network)', async () => {
    const current = await versionChecker.getCurrentVersions();
    assert.ok(current, 'should resolve current versions');
    assert.match(current.cli, /^\d+\.\d+\.\d+/);
  });
});
