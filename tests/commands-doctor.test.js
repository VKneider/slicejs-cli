import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import os from 'node:os';
import {
  checkNodeVersion,
  checkDirectoryStructure,
  checkConfig,
  checkComponents,
  checkPackageManagerSetup,
  checkExternalDependencies,
} from '../commands/doctor/doctor.js';

describe('doctor checks', () => {
  test('checkNodeVersion passes on the supported runtime', async () => {
    const r = await checkNodeVersion();
    assert.equal(r.pass, true);
    assert.match(r.message, /Node\.js version/);
  });

  test('checkDirectoryStructure passes on the starter project', async () => {
    await withTestProject(async () => {
      const r = await checkDirectoryStructure();
      assert.equal(r.pass, true);
    });
  });

  test('checkDirectoryStructure fails when src/ is missing', async () => {
    await withTestProject(async (root) => {
      await fs.remove(path.join(root, 'src'));
      const r = await checkDirectoryStructure();
      assert.equal(r.pass, false);
      assert.match(r.message, /Missing directories/);
      assert.match(r.message, /src\//);
    });
  });

  test('checkConfig passes for a valid sliceConfig.json', async () => {
    await withTestProject(async () => {
      const r = await checkConfig();
      assert.equal(r.pass, true);
    });
  });

  test('checkConfig fails on invalid JSON', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, 'src', 'sliceConfig.json'), '{ not valid json ');
      const r = await checkConfig();
      assert.equal(r.pass, false);
      assert.match(r.message, /invalid JSON/);
    });
  });

  test('checkConfig fails when paths.components is missing', async () => {
    await withTestProject(async (root) => {
      await fs.writeJson(path.join(root, 'src', 'sliceConfig.json'), { server: { port: 3000 } });
      const r = await checkConfig();
      assert.equal(r.pass, false);
      assert.match(r.message, /missing paths\.components/);
    });
  });

  test('checkComponents reports OK when every component folder has its .js', async () => {
    await withTestProject(async () => {
      const r = await checkComponents();
      assert.equal(r.pass, true);
      assert.match(r.message, /components checked/);
    });
  });

  test('checkComponents warns when a component folder lacks its .js file', async () => {
    await withTestProject(async (root) => {
      // AppShell ships with AppShell.js; remove it to simulate a broken component.
      const broken = path.join(root, 'src', 'Components', 'AppComponents', 'Broken');
      await fs.ensureDir(broken); // directory with no Broken.js
      const r = await checkComponents();
      assert.equal(r.warn, true);
      assert.match(r.message, /missing files/);
    });
  });
});

describe('checkExternalDependencies', () => {
  test('warns when an imported node_modules package is not installed', async () => {
    await withTestProject(async (root) => {
      const compJs = path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js');
      await fs.writeFile(compJs, "import x from 'totally-not-installed-xyz';\nexport default class Widget {}");
      const r = await checkExternalDependencies();
      assert.equal(r.warn, true);
      assert.match(r.message, /totally-not-installed-xyz/);
      assert.ok((r.details || []).some((d) => /Widget/.test(d)));
    }, { visualComponents: ['Widget'] });
  });

  test('passes when imported packages are present in node_modules', async () => {
    await withTestProject(async (root) => {
      const compJs = path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js');
      await fs.writeFile(compJs, "import x from 'fake-installed';\nexport default class Widget {}");
      const pkgDir = path.join(root, 'node_modules', 'fake-installed');
      await fs.ensureDir(pkgDir);
      await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-installed', version: '1.0.0' }));
      const r = await checkExternalDependencies();
      assert.equal(r.pass, true);
      assert.match(r.message, /all installed/);
    }, { visualComponents: ['Widget'] });
  });
});

describe('checkPackageManagerSetup', () => {
  async function makeProject({ pkg, files = [] } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-doctor-pm-'));
    if (pkg) await fs.writeJson(path.join(dir, 'package.json'), pkg);
    for (const f of files) await fs.outputFile(path.join(dir, f), '');
    return dir;
  }

  test('passes on a consistent pnpm project with local CLI', async () => {
    const dir = await makeProject({
      pkg: { name: 'x', packageManager: 'pnpm@11.0.0' },
      files: ['pnpm-lock.yaml', 'node_modules/slicejs-cli/package.json']
    });
    try {
      const r = await checkPackageManagerSetup(dir);
      assert.equal(r.pass, true);
    } finally { await fs.remove(dir); }
  });

  test('warns on mixed lockfiles', async () => {
    const dir = await makeProject({
      pkg: { name: 'x', packageManager: 'pnpm@11.0.0' },
      files: ['pnpm-lock.yaml', 'package-lock.json', 'node_modules/slicejs-cli/package.json']
    });
    try {
      const r = await checkPackageManagerSetup(dir);
      assert.equal(r.warn, true);
      assert.match(r.message, /Mixed lockfiles/);
      assert.match(r.suggestion, /pnpm-lock\.yaml/);
    } finally { await fs.remove(dir); }
  });

  test('warns when packageManager field is missing', async () => {
    const dir = await makeProject({
      pkg: { name: 'x' },
      files: ['pnpm-lock.yaml', 'node_modules/slicejs-cli/package.json']
    });
    try {
      const r = await checkPackageManagerSetup(dir);
      assert.equal(r.warn, true);
      assert.match(r.message, /packageManager/);
    } finally { await fs.remove(dir); }
  });

  test('warns when packageManager field disagrees with the lockfile', async () => {
    const dir = await makeProject({
      pkg: { name: 'x', packageManager: 'pnpm@11.0.0' },
      files: ['package-lock.json', 'node_modules/slicejs-cli/package.json']
    });
    try {
      const r = await checkPackageManagerSetup(dir);
      assert.equal(r.warn, true);
      assert.match(r.message, /packageManager is "pnpm" but the lockfile is package-lock\.json/);
    } finally { await fs.remove(dir); }
  });

  test('warns when slicejs-cli is not installed locally', async () => {
    const dir = await makeProject({
      pkg: { name: 'x', packageManager: 'pnpm@11.0.0' },
      files: ['pnpm-lock.yaml']
    });
    try {
      const r = await checkPackageManagerSetup(dir);
      assert.equal(r.warn, true);
      assert.match(r.message, /not installed locally/);
      assert.match(r.suggestion, /-D slicejs-cli/);
    } finally { await fs.remove(dir); }
  });
});
