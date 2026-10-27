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
  checkDependencies,
  checkServerEntry,
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

  test('checkComponents warns (never fails) on advice-only findings', async () => {
    await withTestProject(async () => {
      // The test scaffold registers a subset of the demo components, so its
      // slice.build() calls point at names that are not registered. That is
      // advice: the build does not block on it.
      const r = await checkComponents();
      assert.equal(r.pass, undefined);
      assert.equal(r.warn, true);
      assert.match(r.message, /none block the build/);
    });
  });

  test('checkComponents warns when a component folder lacks its .js file', async () => {
    await withTestProject(async (root) => {
      // A folder in a component category is auto-registered by the scan, so a
      // missing <Name>.js is a registration that cannot resolve. Advisory: the
      // build only trips on it when something reaches the name.
      const broken = path.join(root, 'src', 'Components', 'AppComponents', 'Broken');
      await fs.ensureDir(broken); // directory with no Broken.js
      const r = await checkComponents();
      assert.equal(r.warn, true);
      assert.match(r.message, /none block the build/);
      assert.match(r.suggestion, /Broken/);
    });
  });

  test('checkComponents fails when the build would be blocked', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js'),
        "export default class Widget {\n  static props = { label: { type: 'nope' } }\n}\n"
      );
      const r = await checkComponents();
      assert.equal(r.pass, undefined);
      assert.equal(r.warn, undefined);
      assert.match(r.message, /block "slice build"/);
      assert.match(r.suggestion, /Widget\.label/);
    }, { visualComponents: ['Widget'] });
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

describe('server entry, config schema and dependency skew', () => {
  test('checkServerEntry passes when api/index.js parses', async () => {
    await withTestProject(async () => {
      const r = await checkServerEntry();
      assert.equal(r.pass, true);
      assert.match(r.message, /parses/);
    });
  });

  test('checkServerEntry fails on a syntax error', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, 'api', 'index.js'), 'const broken = ;\n');
      const r = await checkServerEntry();
      assert.equal(r.pass, undefined);
      assert.equal(r.warn, undefined);
      assert.match(r.message, /does not parse/);
    });
  });

  test('checkServerEntry passes for a static app with no api/index.js', async () => {
    await withTestProject(async (root) => {
      await fs.remove(path.join(root, 'api', 'index.js'));
      const r = await checkServerEntry();
      assert.equal(r.pass, true);
      assert.match(r.message, /static app/);
    });
  });

  test('checkConfig fails on a value that does not match the published schema', async () => {
    await withTestProject(async (root) => {
      const schemaDir = path.join(root, 'node_modules', 'slicejs-web-framework');
      await fs.ensureDir(schemaDir);
      await fs.writeJson(path.join(schemaDir, 'sliceConfig.schema.json'), {
        type: 'object',
        properties: {
          server: { type: 'object', properties: { port: { type: 'number' } } }
        }
      });

      const configPath = path.join(root, 'src', 'sliceConfig.json');
      const config = await fs.readJson(configPath);
      config.server = { ...(config.server || {}), port: '3001' };
      await fs.writeJson(configPath, config);

      const r = await checkConfig();
      assert.equal(r.pass, false);
      assert.match(r.message, /does not match the published schema/);
      assert.match(r.suggestion, /sliceConfig\.server\.port/);
    });
  });

  test('checkDependencies warns when the declared range rejects the installed version', async () => {
    await withTestProject(async (root) => {
      const pkgPath = path.join(root, 'package.json');
      const pkg = (await fs.pathExists(pkgPath)) ? await fs.readJson(pkgPath) : { name: 'x' };
      pkg.dependencies = { ...(pkg.dependencies || {}), 'slicejs-web-framework': '^3.5.0' };
      await fs.writeJson(pkgPath, pkg);

      const frameworkDir = path.join(root, 'node_modules', 'slicejs-web-framework');
      await fs.ensureDir(frameworkDir);
      await fs.writeJson(path.join(frameworkDir, 'package.json'), { name: 'slicejs-web-framework', version: '4.0.2' });

      const r = await checkDependencies();
      assert.equal(r.warn, true);
      assert.match(r.message, /\^3\.5\.0/);
      assert.match(r.message, /4\.0\.2/);
    });
  });

  test('checkDependencies passes when the range accepts the installed version', async () => {
    await withTestProject(async (root) => {
      const pkgPath = path.join(root, 'package.json');
      const pkg = (await fs.pathExists(pkgPath)) ? await fs.readJson(pkgPath) : { name: 'x' };
      pkg.dependencies = { ...(pkg.dependencies || {}), 'slicejs-web-framework': '^4.0.2' };
      await fs.writeJson(pkgPath, pkg);

      const frameworkDir = path.join(root, 'node_modules', 'slicejs-web-framework');
      await fs.ensureDir(frameworkDir);
      await fs.writeJson(path.join(frameworkDir, 'package.json'), { name: 'slicejs-web-framework', version: '4.0.2' });

      const r = await checkDependencies();
      assert.equal(r.pass, true);
    });
  });
});
