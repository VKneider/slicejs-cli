import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { isPackageManagerAvailable } from '../commands/utils/PackageManager.js';
import { SLICE_SCRIPTS } from '../commands/utils/sliceScripts.js';

// REAL end-to-end test of `slice init`, and the template contract that goes with
// it: the scaffolded project must build, boot and render, using the components
// init downloaded from the registry.
//
// This is the test that would have caught the starter shipping with routes or
// `slice.build()` calls for components nobody installs: the app built fine and
// rendered nothing, because `slice.build('Navbar')` returned null.
//
// Needs network (registry + GitHub) and takes ~2 minutes, so it is opt-in
// locally and runs in CI:
//
//   SLICE_INIT_E2E=1 node --test tests/init-e2e.test.js
//
const E2E_ENABLED = process.env.SLICE_INIT_E2E === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(__dirname, '..', 'client.js');

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any HTTP answer below 500 means the server is up; the route may not exist yet. */
async function waitForServer(baseUrl, deadline, server) {
  let last = '';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the app exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await delay(300);
  }
  throw new Error(`timed out waiting for ${baseUrl} (${last})`);
}

function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}

/**
 * Re-apply a candidate framework's template over a freshly initialised project.
 *
 * `init` copies the *published* template, so the only way to gate a local change
 * before releasing it is to install the packed tarball and put its template in
 * place. `components.js` is deliberately left alone: it holds the registry of
 * the components init downloaded, and it is regenerated from the folders below.
 */
async function applyCandidateTemplate({ projectDir, candidateRoot }) {
  await fs.copy(path.join(candidateRoot, 'api', 'index.js'), path.join(projectDir, 'api', 'index.js'));

  const components = path.join(projectDir, 'src', 'Components', 'AppComponents');
  await fs.remove(components);
  await fs.copy(path.join(candidateRoot, 'src', 'Components', 'AppComponents'), components, { recursive: true });

  for (const relative of ['src/App', 'src/public', 'src/routes.js', 'src/sliceConfig.json']) {
    const target = path.join(projectDir, relative);
    await fs.remove(target);
    await fs.copy(path.join(candidateRoot, relative), target, { recursive: true });
  }

  const list = spawnSync(process.execPath, [CLIENT, 'component', 'list'], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, INIT_CWD: projectDir, SLICE_NO_LOCAL_DELEGATION: '1', NO_COLOR: '1' }
  });
  assert.equal(list.status, 0, `the component registry must be regenerated for the candidate:\n${list.stdout}\n${list.stderr}`);
}

test('slice init -y creates a fully self-contained project (real run)', { skip: !E2E_ENABLED && 'set SLICE_INIT_E2E=1 to run' }, async () => {
  const pm = ['pnpm', 'npm'].find(isPackageManagerAvailable);
  assert.ok(pm, 'a package manager must be available');

  // Parent directory WITH a package.json — the ancestor the old code leaked into.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-init-e2e-'));
  const parentManifest = { name: 'parent-trap', version: '1.0.0' };
  await fs.writeJson(path.join(parent, 'package.json'), parentManifest);

  let server = null;
  let browser = null;

  try {
    const result = spawnSync(process.execPath, [CLIENT, 'init', '-y', 'demo-app', '--pm', pm], {
      cwd: parent,
      encoding: 'utf-8',
      env: { ...process.env, SLICE_NO_LOCAL_DELEGATION: '1' },
      timeout: 600_000
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `init must exit 0. Output:\n${output}`);

    const projectDir = path.join(parent, 'demo-app');

    // Everything must live INSIDE the project folder…
    const pkg = await fs.readJson(path.join(projectDir, 'package.json'));
    assert.equal(pkg.name, 'demo-app');
    assert.ok(pkg.packageManager?.startsWith(`${pm}@`), 'packageManager field must pin the chosen PM');
    assert.ok(pkg.dependencies?.['slicejs-web-framework'], 'framework must be a dependency');
    assert.ok(pkg.devDependencies?.['slicejs-cli'], 'CLI must be a devDependency');
    assert.equal(pkg.scripts?.dev, SLICE_SCRIPTS['slice:dev']);
    assert.equal(pkg.scripts?.build, SLICE_SCRIPTS['slice:build']);
    assert.equal(pkg.scripts?.start, SLICE_SCRIPTS['slice:start']);
    for (const [script, command] of Object.entries(SLICE_SCRIPTS)) {
      assert.equal(pkg.scripts?.[script], command, `script ${script} must be configured`);
    }

    assert.ok(await fs.pathExists(path.join(projectDir, 'node_modules', 'slicejs-web-framework', 'package.json')),
      'framework must be installed inside the project');
    assert.ok(await fs.pathExists(path.join(projectDir, 'node_modules', 'slicejs-cli', 'package.json')),
      'CLI must be installed inside the project');

    const lockfile = pm === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
    assert.ok(await fs.pathExists(path.join(projectDir, lockfile)), `${lockfile} must be inside the project`);

    assert.ok(await fs.pathExists(path.join(projectDir, 'src', 'sliceConfig.json')), 'src/ structure must exist');
    assert.ok(await fs.pathExists(path.join(projectDir, 'api', 'index.js')), 'api/ structure must exist');

    const componentsJs = await fs.readFile(path.join(projectDir, 'src', 'Components', 'components.js'), 'utf-8');
    for (const name of ['Button', 'MultiRoute', 'Navbar', 'FetchManager']) {
      assert.ok(componentsJs.includes(name), `starter component ${name} must be registered`);
    }

    // …and the parent must be untouched: same manifest, no node_modules, no lockfile.
    assert.deepEqual(await fs.readJson(path.join(parent, 'package.json')), parentManifest,
      'parent package.json must be untouched');
    assert.ok(!(await fs.pathExists(path.join(parent, 'node_modules'))), 'no node_modules may leak into the parent');
    assert.ok(!(await fs.pathExists(path.join(parent, 'pnpm-lock.yaml'))), 'no lockfile may leak into the parent');
    assert.ok(!(await fs.pathExists(path.join(parent, 'package-lock.json'))), 'no lockfile may leak into the parent');

    // Optional: gate a *candidate* framework before it is published. CI packs
    // the checkout and passes the tarball; init has already copied the published
    // template, so install the candidate and re-apply its template on top.
    const tarball = process.env.SLICE_TEMPLATE_TARBALL;
    if (tarball) {
      assert.ok(await fs.pathExists(tarball), `SLICE_TEMPLATE_TARBALL does not exist: ${tarball}`);
      const install = spawnSync(
        pm,
        [pm === 'pnpm' ? 'add' : 'install', `slicejs-web-framework@file:${tarball}`],
        {
          cwd: projectDir,
          encoding: 'utf-8',
          shell: process.platform === 'win32',
          env: { ...process.env, INIT_CWD: projectDir, SLICE_NO_LOCAL_DELEGATION: '1', NO_COLOR: '1' },
          timeout: 600_000
        }
      );
      assert.equal(install.status, 0, `the candidate tarball must install:\n${install.stdout}\n${install.stderr}`);

      const candidateRoot = path.join(projectDir, 'node_modules', 'slicejs-web-framework');
      await applyCandidateTemplate({ projectDir, candidateRoot });
    }

    // ── The template contract: build, boot, render ───────────────────────────
    // The CLI under test builds it (the project's own CLI would be the published
    // one, which is not what this repository is testing).
    const build = spawnSync(process.execPath, [CLIENT, 'build'], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: { ...process.env, INIT_CWD: projectDir, SLICE_NO_LOCAL_DELEGATION: '1', NO_COLOR: '1' },
      timeout: 600_000
    });
    assert.equal(build.status, 0, `the scaffolded project must build:\n${build.stdout}\n${build.stderr}`);

    const port = await freePort();
    // Pin the port in the config too: the server may read it from either place.
    const configPath = path.join(projectDir, 'src', 'sliceConfig.json');
    const config = await fs.readJson(configPath);
    await fs.writeJson(configPath, { ...config, server: { ...(config.server || {}), port } }, { spaces: 2 });

    server = spawn(process.execPath, ['api/index.js'], {
      cwd: projectDir,
      env: { ...process.env, INIT_CWD: projectDir, PORT: String(port), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', (chunk) => { serverLog += chunk; });
    server.stderr.on('data', (chunk) => { serverLog += chunk; });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, Date.now() + 120_000, server);

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('slice-app-shell').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('slice-nav-bar').count(), 1, 'the starter navbar must render');
    assert.equal(await page.locator('slice-home-section').count(), 1, 'the home section must render');

    await page.goto(`${baseUrl}/definitely-not-a-route`, { waitUntil: 'domcontentloaded' });
    await page.locator('slice-notfound').waitFor({ timeout: 30_000 });

    // The exact failure this test exists for: a name that is not registered logs
    // `not found in components.js`, slice.build returns null and the page blanks.
    const unregistered = errors.filter((message) => /not found in components\.js/.test(message));
    assert.deepEqual(unregistered, [], `the starter must not build unregistered components:\n${unregistered.join('\n')}`);

    // Uncaught exceptions are failures (appendChild(null) from a missing Navbar).
    // Console noise about optional files is not this test's business.
    const pageErrors = errors.filter((message) => message.startsWith('pageerror:'));
    assert.deepEqual(pageErrors, [], `the starter must render without exceptions:\n${pageErrors.join('\n')}\n\n--- server ---\n${serverLog.slice(-1500)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer(server);
    await fs.remove(parent);
  }
});
