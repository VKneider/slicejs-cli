import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { cleanBundles } from '../commands/bundle/bundle.js';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

// Bundles are build output. `slice build` already wrote them to dist/bundles;
// `slice bundle` still defaulted to src/bundles, and clean/info read a path that
// never existed (src/bundle.config.json). One home: dist/bundles.

async function withProject(fn) {
  const dir = await createTestProject();
  const prevInitCwd = process.env.INIT_CWD;
  process.env.INIT_CWD = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = prevInitCwd;
    await cleanupTestProject(dir);
  }
}

test('the generator writes bundles under dist by default', async () => {
  await withProject(async (dir) => {
    const generator = new BundleGenerator(import.meta.url, null);
    assert.equal(
      path.resolve(generator.bundlesPath),
      path.join(path.resolve(dir), 'dist', 'bundles')
    );
  });
});

test('clean removes generated bundles and the config from dist/bundles', async () => {
  await withProject(async (dir) => {
    const bundles = path.join(dir, 'dist', 'bundles');
    await fs.ensureDir(bundles);
    await fs.writeFile(path.join(bundles, 'slice-bundle.critical.js'), '// bundle', 'utf8');
    await fs.writeFile(path.join(bundles, 'bundle.config.json'), '{}', 'utf8');
    await fs.writeFile(path.join(bundles, 'bundle.config.js'), '// config', 'utf8');

    await cleanBundles();

    assert.equal(await fs.pathExists(bundles), false, 'an emptied bundle folder is removed');
  });
});

test('clean keeps the folder and unrelated files', async () => {
  await withProject(async (dir) => {
    const bundles = path.join(dir, 'dist', 'bundles');
    await fs.ensureDir(bundles);
    await fs.writeFile(path.join(bundles, 'slice-bundle.critical.js'), '// bundle', 'utf8');
    await fs.writeFile(path.join(bundles, 'keep.txt'), 'not ours', 'utf8');

    await cleanBundles();

    assert.equal(await fs.pathExists(path.join(bundles, 'slice-bundle.critical.js')), false);
    assert.equal(await fs.pathExists(path.join(bundles, 'keep.txt')), true);
  });
});
