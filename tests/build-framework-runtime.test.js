import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FW_PKG = path.resolve(__dirname, '../node_modules/slicejs-web-framework');

// `slice build` must emit the framework runtime into dist/Slice/Slice.js so the
// production build is self-contained: the app bootstraps with
// `import Slice from '/Slice/Slice.js'`, and on serverless hosts (Vercel) only
// dist/** is guaranteed to ship — node_modules is pruned / pnpm-symlinked and
// cannot be relied on at runtime.

async function scaffold({ withFramework }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-fw-runtime-'));
  await fs.ensureDir(path.join(dir, 'src', 'App'));
  await fs.ensureDir(path.join(dir, 'src', 'Components'));
  await fs.writeFile(path.join(dir, 'src', 'sliceConfig.json'), JSON.stringify({ server: { port: 3001 } }));
  await fs.writeFile(path.join(dir, 'src', 'Components', 'components.js'), 'const components = {};\n\nexport default components;\n');
  await fs.writeFile(path.join(dir, 'src', 'App', 'index.js'), "import Slice from '/Slice/Slice.js';\n");
  await fs.writeFile(path.join(dir, 'src', 'App', 'index.html'), '<!doctype html><html><body></body></html>');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', dependencies: { 'slicejs-web-framework': '^3.5.0' } }));

  if (withFramework) {
    // Materialize the package (dereference) so require.resolve finds a real file,
    // matching how it resolves through pnpm's store on a real install.
    await fs.copy(FW_PKG, path.join(dir, 'node_modules', 'slicejs-web-framework'), { dereference: true });
  }
  return dir;
}

describe('slice build — framework runtime is bundled into dist', () => {
  test('emits dist/Slice/Slice.js matching the framework entry', async () => {
    const prevInitCwd = process.env.INIT_CWD;
    const prevNodeEnv = process.env.NODE_ENV;
    const dir = await scaffold({ withFramework: true });
    try {
      process.env.INIT_CWD = dir;
      process.env.NODE_ENV = 'production';
      const buildProduction = (await import('../commands/buildProduction/buildProduction.js')).default;

      const ok = await buildProduction({});
      assert.equal(ok, true, 'build should succeed');

      const distSlice = path.join(dir, 'dist', 'Slice', 'Slice.js');
      assert.ok(await fs.pathExists(distSlice), 'dist/Slice/Slice.js must exist');

      const emitted = await fs.readFile(distSlice, 'utf8');
      const source = await fs.readFile(path.join(dir, 'node_modules', 'slicejs-web-framework', 'Slice', 'Slice.js'), 'utf8');
      assert.equal(emitted, source, 'emitted runtime must match the framework entry');
      assert.ok(emitted.length > 0, 'emitted runtime must not be empty');
    } finally {
      if (prevInitCwd === undefined) delete process.env.INIT_CWD; else process.env.INIT_CWD = prevInitCwd;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
      await fs.remove(dir);
    }
  });

  test('build still succeeds (with a warning) when the framework cannot be resolved', async () => {
    const prevInitCwd = process.env.INIT_CWD;
    const dir = await scaffold({ withFramework: false });
    try {
      process.env.INIT_CWD = dir;
      const buildProduction = (await import('../commands/buildProduction/buildProduction.js')).default;

      const ok = await buildProduction({});
      assert.equal(ok, true, 'build should not fail just because the framework runtime is missing');
      assert.equal(
        await fs.pathExists(path.join(dir, 'dist', 'Slice', 'Slice.js')),
        false,
        'no runtime copy when the framework is unavailable'
      );
    } finally {
      if (prevInitCwd === undefined) delete process.env.INIT_CWD; else process.env.INIT_CWD = prevInitCwd;
      await fs.remove(dir);
    }
  });
});
