import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'e2e/fixtures/components');
const FW_PKG = path.resolve(__dirname, '../node_modules/slicejs-web-framework');

// Performance budgets for the realistic starter app (App Shell + the vendored
// starter components). Bundle byte sizes are fully deterministic, so a surprise
// failure here means a change degraded the output — review it, and only bump a
// budget when the growth is intentional. (Actuals shown for reference.)
const BUDGET = {
  bundleCount: 5, //            actual: 4
  totalBundleBytes: 165_000, // actual: ~133.6 KB
  criticalBytes: 51_200, //     actual: ~40.8 KB (bundler's own critical cap is 50 KB)
  frameworkBytes: 85_000, //    actual: ~67.4 KB (tracks the slicejs-web-framework package)
  buildMs: 30_000, //           actual: ~1 s — generous ceiling to catch pathological slowdowns
};

async function assembleAndBuild() {
  process.env.NODE_ENV = 'production';
  const app = await createTestProject();

  await fs.ensureDir(path.join(app, 'node_modules'));
  await fs
    .ensureSymlink(FW_PKG, path.join(app, 'node_modules', 'slicejs-web-framework'), 'dir')
    .catch(() => fs.copy(FW_PKG, path.join(app, 'node_modules', 'slicejs-web-framework')));

  await fs.copy(path.join(FIXTURES, 'Visual'), path.join(app, 'src', 'Components', 'Visual'));
  await fs.copy(path.join(FIXTURES, 'Service'), path.join(app, 'src', 'Components', 'Service'));

  process.env.INIT_CWD = app;
  (await import('../commands/listComponents/listComponents.js')).default();

  const build = (await import('../commands/build/build.js')).default;
  const start = Date.now();
  const ok = await build({ minify: true, obfuscate: true });
  const buildMs = Date.now() - start;
  assert.equal(ok, true, 'build should succeed');
  return { app, buildMs };
}

test('production build stays within performance budgets', async () => {
  const { app, buildMs } = await assembleAndBuild();
  try {
    const bundlesDir = path.join(app, 'dist', 'bundles');
    const files = (await fs.readdir(bundlesDir)).filter(
      (f) => f.startsWith('slice-bundle.') && f.endsWith('.js')
    );

    const sizes = {};
    let totalBundleBytes = 0;
    for (const f of files) {
      sizes[f] = (await fs.stat(path.join(bundlesDir, f))).size;
      totalBundleBytes += sizes[f];
    }
    const cfg = await fs.readJson(path.join(bundlesDir, 'bundle.config.json'));
    const criticalBytes = sizes['slice-bundle.critical.js'] || 0;
    const frameworkBytes = sizes['slice-bundle.framework.js'] || 0;

    // Always print the metrics so trends are visible even on a passing run.
    console.log(
      `\n  [perf] bundles=${files.length} total=${Math.round(totalBundleBytes / 1024)}KB ` +
        `critical=${Math.round(criticalBytes / 1024)}KB framework=${Math.round(frameworkBytes / 1024)}KB ` +
        `requestReduction=${100 - Math.round((files.length / cfg.stats.totalComponents) * 100)}% build=${buildMs}ms`
    );

    assert.ok(files.length <= BUDGET.bundleCount, `bundle count ${files.length} exceeds budget ${BUDGET.bundleCount}`);
    assert.ok(
      totalBundleBytes <= BUDGET.totalBundleBytes,
      `total bundle bytes ${totalBundleBytes} exceeds budget ${BUDGET.totalBundleBytes}`
    );
    assert.ok(criticalBytes <= BUDGET.criticalBytes, `critical bundle ${criticalBytes} exceeds budget ${BUDGET.criticalBytes}`);
    assert.ok(frameworkBytes <= BUDGET.frameworkBytes, `framework bundle ${frameworkBytes} exceeds budget ${BUDGET.frameworkBytes}`);
    assert.ok(buildMs <= BUDGET.buildMs, `build took ${buildMs}ms, over budget ${BUDGET.buildMs}ms`);

    // Sanity: the realistic app actually bundled its full component set.
    assert.ok(cfg.stats.totalComponents >= 20, `unexpectedly few components bundled: ${cfg.stats.totalComponents}`);
  } finally {
    await cleanupTestProject(app);
  }
});
