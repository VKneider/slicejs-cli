import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ensureProjectManifest } from '../commands/init/init.js';
import { getPackageManagerVersion, isPackageManagerAvailable } from '../commands/utils/PackageManager.js';

// Regression tests for the "two package.json" bug: `slice init` used to run the
// framework install BEFORE writing the project manifest, so npm/pnpm walked up
// the directory tree and anchored node_modules + the dependency entry in an
// ancestor's package.json (outside the new project folder).

async function makeParentTrap() {
  // Parent directory WITH a package.json — the ancestor npm/pnpm would walk up to.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-init-isolation-'));
  await fs.writeJson(path.join(parent, 'package.json'), { name: 'parent-trap', version: '1.0.0' });
  const projectDir = path.join(parent, 'demo-app');
  await fs.ensureDir(projectDir);
  return { parent, projectDir };
}

test('ensureProjectManifest creates package.json inside the project folder', async () => {
  const { parent, projectDir } = await makeParentTrap();
  try {
    await ensureProjectManifest(projectDir, 'npm');

    const pkgPath = path.join(projectDir, 'package.json');
    assert.ok(await fs.pathExists(pkgPath), 'package.json must exist inside the project folder');

    const pkg = await fs.readJson(pkgPath);
    assert.equal(pkg.name, 'demo-app');
    assert.equal(pkg.type, 'module');

    // Parent manifest untouched
    const parentPkg = await fs.readJson(path.join(parent, 'package.json'));
    assert.deepEqual(parentPkg, { name: 'parent-trap', version: '1.0.0' });
  } finally {
    await fs.remove(parent);
  }
});

test('ensureProjectManifest persists the packageManager field when the PM version is known', async (t) => {
  const pm = ['pnpm', 'npm'].find(isPackageManagerAvailable);
  if (!pm) {
    t.skip('no package manager binary available');
    return;
  }
  const { parent, projectDir } = await makeParentTrap();
  try {
    await ensureProjectManifest(projectDir, pm);
    const pkg = await fs.readJson(path.join(projectDir, 'package.json'));
    const version = getPackageManagerVersion(pm);
    if (version) {
      assert.equal(pkg.packageManager, `${pm}@${version}`);
    }
  } finally {
    await fs.remove(parent);
  }
});

test('ensureProjectManifest does not overwrite an existing manifest', async () => {
  const { parent, projectDir } = await makeParentTrap();
  try {
    const existing = { name: 'keep-me', version: '2.0.0', scripts: { custom: 'echo hi' } };
    await fs.writeJson(path.join(projectDir, 'package.json'), existing);

    await ensureProjectManifest(projectDir, 'npm');

    const pkg = await fs.readJson(path.join(projectDir, 'package.json'));
    assert.deepEqual(pkg, existing, 'an existing package.json must be left untouched');
  } finally {
    await fs.remove(parent);
  }
});

test('with the manifest in place, the package manager anchors to the project folder (not the parent)', async (t) => {
  // `npm prefix` resolves the nearest package.json from cwd — exactly the
  // walk-up mechanism that caused the bug. No install or network needed.
  if (!isPackageManagerAvailable('npm')) {
    t.skip('npm binary not available');
    return;
  }
  const { parent, projectDir } = await makeParentTrap();
  try {
    // Without a manifest, npm anchors to the parent trap…
    const before = execSync('npm prefix', { cwd: projectDir, encoding: 'utf-8' }).trim();
    assert.equal(await fs.realpath(before), await fs.realpath(parent), 'precondition: npm walks up without a manifest');

    // …and with the manifest created first, it anchors to the project folder.
    await ensureProjectManifest(projectDir, 'npm');
    const after = execSync('npm prefix', { cwd: projectDir, encoding: 'utf-8' }).trim();
    assert.equal(await fs.realpath(after), await fs.realpath(projectDir), 'npm must anchor inside the project folder');
  } finally {
    await fs.remove(parent);
  }
});
