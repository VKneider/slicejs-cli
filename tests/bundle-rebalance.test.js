import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

function makeGenerator() {
  const gen = new BundleGenerator(import.meta.url, null, {});
  gen.sliceConfig = {};
  return gen;
}

// codeSize drives budgeting; size (folder) is intentionally large to prove it is
// NOT what the rebalancer measures.
function comp(name, codeSize, folderSize = codeSize) {
  return { name, size: folderSize, codeSize };
}

describe('rebalanceBundlesByBudget — referential integrity + code-size budgeting', () => {
  test('a pinned bundle (shared-core) is never split, even when oversized', () => {
    const gen = makeGenerator();
    const bundles = {
      'shared-core': { paths: [], components: [comp('A', 60), comp('B', 60), comp('C', 60)], dependencies: ['critical'] },
      'home': { path: '/', components: [comp('X', 40)], dependencies: ['critical', 'shared-core'] }
    };
    gen.rebalanceBundlesByBudget(bundles, { maxBundleSize: 100, maxRequests: 50, pinnedKeys: new Set(['shared-core']) });

    // shared-core (180 code, > 100) stays whole because it is pinned...
    assert.ok(bundles['shared-core'], 'shared-core must survive rebalance');
    assert.ok(!Object.keys(bundles).some((k) => k.startsWith('shared-core--p')), 'shared-core must not be split into parts');
    // ...so the dependency reference from `home` still resolves.
    assert.ok(bundles['home'].dependencies.includes('shared-core'));
  });

  test('budget uses code size, not folder size (no split from sidecar assets)', () => {
    const gen = makeGenerator();
    // Two components with a huge FOLDER size (e.g. a demo dataset) but tiny code.
    const bundles = {
      'home': { path: '/', components: [comp('A', 40, 900_000), comp('B', 40, 900_000)] }
    };
    gen.rebalanceBundlesByBudget(bundles, { maxBundleSize: 100, maxRequests: 50 });
    // Code total is 80 (<100) → a single bundle, NOT split by the inflated folder size.
    assert.deepEqual(Object.keys(bundles), ['home']);
    assert.equal(bundles['home'].size, 80);
  });

  test('a non-pinned oversized bundle still splits (on code size)', () => {
    const gen = makeGenerator();
    const bundles = {
      'big': { path: '/big', components: [comp('A', 60), comp('B', 60), comp('C', 60)] }
    };
    gen.rebalanceBundlesByBudget(bundles, { maxBundleSize: 100, maxRequests: 50 });
    const keys = Object.keys(bundles);
    assert.ok(keys.length > 1, 'oversized non-pinned bundle should split');
    assert.ok(keys.every((k) => k.startsWith('big')), 'parts keep the base key');
  });

  test('pinned bundles count toward the request budget but are never merged away', () => {
    const gen = makeGenerator();
    const bundles = {
      'shared-core': { paths: [], components: [comp('S', 10)], dependencies: ['critical'] },
      'a': { path: '/a', components: [comp('A', 10)] },
      'b': { path: '/b', components: [comp('B', 10)] },
      'c': { path: '/c', components: [comp('C', 10)] }
    };
    gen.rebalanceBundlesByBudget(bundles, { maxBundleSize: 1000, maxRequests: 3, pinnedKeys: new Set(['shared-core']) });
    assert.ok(bundles['shared-core'], 'pinned bundle survives the merge pass');
    // Total bundles must respect the request budget (pinned counts toward it).
    assert.ok(Object.keys(bundles).length <= 3);
  });
});

describe('collectBundleReferentialIssues', () => {
  test('flags a dependency reference to a bundle that was not emitted', () => {
    const gen = makeGenerator();
    const config = {
      bundles: { critical: {}, routes: { home: { dependencies: ['critical', 'shared-core'] } } },
      routeBundles: { '/': ['critical', 'shared-core', 'home'] }
    };
    const { dangling } = gen.collectBundleReferentialIssues(config);
    assert.deepEqual(dangling, ['shared-core']);
  });

  test('flags an emitted bundle that no route references (orphan)', () => {
    const gen = makeGenerator();
    const config = {
      bundles: { critical: {}, routes: { home: { dependencies: ['critical'] }, ghost: { dependencies: ['critical'] } } },
      routeBundles: { '/': ['critical', 'home'] }
    };
    const { orphans } = gen.collectBundleReferentialIssues(config);
    assert.deepEqual(orphans, ['ghost']);
  });

  test('a well-formed config with shared-core has no issues', () => {
    const gen = makeGenerator();
    const config = {
      bundles: {
        critical: {},
        vendorShared: { file: 'x' },
        routes: {
          home: { dependencies: ['critical', 'shared-core'] },
          'shared-core': { dependencies: ['critical', 'vendor-shared'] }
        }
      },
      routeBundles: { '/': ['critical', 'shared-core', 'home'] }
    };
    const { dangling, orphans } = gen.collectBundleReferentialIssues(config);
    assert.deepEqual(dangling, []);
    assert.deepEqual(orphans, []);
  });
});
