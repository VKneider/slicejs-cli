import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import build from '../commands/build/build.js';
import { cleanBundles, bundleInfo } from '../commands/bundle/bundle.js';

const MODULE_URL = import.meta.url;

describe('slice build (full pipeline: buildProduction + bundle -> dist)', () => {
  test('produces a dist/ with parseable bundles', async () => {
    await withTestProject(async (root) => {
      const ok = await build({ minify: false, obfuscate: false });
      assert.equal(ok, true);

      const dist = path.join(root, 'dist');
      assert.ok(await fs.pathExists(path.join(dist, 'App', 'index.js')));

      const bundlesDir = path.join(dist, 'bundles');
      assert.ok(await fs.pathExists(bundlesDir), 'dist/bundles should exist');

      const bundleFiles = (await fs.readdir(bundlesDir)).filter(
        (f) => f.startsWith('slice-bundle.') && f.endsWith('.js')
      );
      assert.ok(bundleFiles.length > 0, 'at least one bundle in dist/bundles');

      for (const f of bundleFiles) {
        const code = await fs.readFile(path.join(bundlesDir, f), 'utf8');
        assert.doesNotThrow(
          () => parse(code, { sourceType: 'module', plugins: ['jsx'] }),
          `dist bundle ${f} is not valid JS`
        );
      }
    });
  });
});

describe('bundle clean / info subcommands', () => {
  test('cleanBundles removes slice-bundle.* files and the config', async () => {
    await withTestProject(async (root) => {
      const src = path.join(root, 'src');
      await fs.writeFile(path.join(src, 'slice-bundle.critical.js'), '// x');
      await fs.writeFile(path.join(src, 'slice-bundle.home.js'), '// x');
      await fs.writeFile(path.join(src, 'bundle.config.json'), '{}');

      await cleanBundles();

      assert.equal(await fs.pathExists(path.join(src, 'slice-bundle.critical.js')), false);
      assert.equal(await fs.pathExists(path.join(src, 'slice-bundle.home.js')), false);
      assert.equal(await fs.pathExists(path.join(src, 'bundle.config.json')), false);
    });
  });

  test('cleanBundles is a no-op (no throw) when there are no bundles', async () => {
    await withTestProject(async () => {
      await assert.doesNotReject(() => cleanBundles());
    });
  });

  test('bundleInfo does not throw when a config exists', async () => {
    await withTestProject(async (root) => {
      const cfg = {
        version: '2.0.0',
        strategy: 'hybrid',
        generated: '2025-01-01T00:00:00.000Z',
        stats: {
          totalComponents: 3,
          totalRoutes: 2,
          sharedComponents: 1,
          sharedPercentage: 33,
          totalSize: 2048,
        },
        bundles: { critical: { components: ['A'], size: 1024 }, routes: {} },
      };
      await fs.writeJson(path.join(root, 'src', 'bundle.config.json'), cfg);
      await assert.doesNotReject(() => bundleInfo());
    });
  });

  test('bundleInfo warns (no throw) when config is missing', async () => {
    await withTestProject(async () => {
      await assert.doesNotReject(() => bundleInfo());
    });
  });
});
