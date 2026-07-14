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
// starter components). Bundle byte sizes are deterministic, so a surprise
// failure here means a change degraded the output — review it, and only bump a
// budget when the growth is intentional.
//
// IMPORTANT: budget the APP's own output (critical + route bundles), NOT the
// framework bundle. slice-bundle.framework.js is the slicejs-web-framework
// package compiled in — its size tracks the installed framework version, which
// is outside the app author's / bundler's control. Counting it toward the app
// budget made this test fail whenever the framework grew between versions
// (a false signal). We track it separately with a generous ceiling instead.
const BUDGET = {
  bundleCount: 5, //             actual: 4
  appBundleBytes: 85_000, //     app's own code = total − framework; actual: ~66 KB
  criticalBytes: 51_200, //      actual: ~40 KB (bundler's own critical cap is 50 KB)
  frameworkBytesCeiling: 160_000, // framework package, not app code; actual: ~102 KB (fw 3.5.x). Catches only runaway.
  buildMs: 30_000, //            actual: ~1–3 s — generous ceiling to catch pathological slowdowns
};

async function assembleAndBuild() {
  process.env.NODE_ENV = 'production';
  const app = await createTestProject();

  await fs.ensureDir(path.join(app, 'node_modules'));
  await fs.copy(FW_PKG, path.join(app, 'node_modules', 'slicejs-web-framework'), { dereference: true });

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
    // The app's own output: everything except the framework package bundle.
    const appBundleBytes = totalBundleBytes - frameworkBytes;

    // Always print the metrics so trends are visible even on a passing run.
    console.log(
      `\n  [perf] bundles=${files.length} app=${Math.round(appBundleBytes / 1024)}KB ` +
        `critical=${Math.round(criticalBytes / 1024)}KB framework=${Math.round(frameworkBytes / 1024)}KB ` +
        `total=${Math.round(totalBundleBytes / 1024)}KB ` +
        `requestReduction=${100 - Math.round((files.length / cfg.stats.totalComponents) * 100)}% build=${buildMs}ms`
    );

    assert.ok(files.length <= BUDGET.bundleCount, `bundle count ${files.length} exceeds budget ${BUDGET.bundleCount}`);
    // The real signal: the app's own bundled code (bundler strategy + app size).
    assert.ok(
      appBundleBytes <= BUDGET.appBundleBytes,
      `app bundle bytes ${appBundleBytes} exceeds budget ${BUDGET.appBundleBytes} (framework excluded)`
    );
    assert.ok(criticalBytes <= BUDGET.criticalBytes, `critical bundle ${criticalBytes} exceeds budget ${BUDGET.criticalBytes}`);
    // Framework size is a dependency cost, not app code — only fail on runaway growth.
    assert.ok(
      frameworkBytes <= BUDGET.frameworkBytesCeiling,
      `framework bundle ${frameworkBytes} exceeds ceiling ${BUDGET.frameworkBytesCeiling} — the framework package grew a lot; verify it's intentional`
    );
    assert.ok(buildMs <= BUDGET.buildMs, `build took ${buildMs}ms, over budget ${BUDGET.buildMs}ms`);

    // Sanity: the realistic app actually bundled its full component set.
    assert.ok(cfg.stats.totalComponents >= 20, `unexpectedly few components bundled: ${cfg.stats.totalComponents}`);
  } finally {
    await cleanupTestProject(app);
  }
});
