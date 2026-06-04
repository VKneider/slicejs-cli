import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isPackageManagerAvailable } from '../commands/utils/PackageManager.js';
import { SLICE_SCRIPTS } from '../commands/utils/sliceScripts.js';

// REAL end-to-end test of `slice init`: spawns the actual CLI, installs real
// packages from the registry and downloads starter components from GitHub.
// Needs network and takes ~1-2 minutes, so it is opt-in:
//
//   SLICE_INIT_E2E=1 node --test tests/init-e2e.test.js
//
const E2E_ENABLED = process.env.SLICE_INIT_E2E === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(__dirname, '..', 'client.js');

test('slice init -y creates a fully self-contained project (real run)', { skip: !E2E_ENABLED && 'set SLICE_INIT_E2E=1 to run' }, async () => {
  const pm = ['pnpm', 'npm'].find(isPackageManagerAvailable);
  assert.ok(pm, 'a package manager must be available');

  // Parent directory WITH a package.json — the ancestor the old code leaked into.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-init-e2e-'));
  const parentManifest = { name: 'parent-trap', version: '1.0.0' };
  await fs.writeJson(path.join(parent, 'package.json'), parentManifest);

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
    assert.equal(pkg.scripts?.dev, 'slice dev');
    assert.equal(pkg.scripts?.build, 'slice build');
    assert.equal(pkg.scripts?.start, 'slice start');
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
  } finally {
    await fs.remove(parent);
  }
});
