// A build that silently degrades is worse than one that fails.
//
// processFile() catches any per-file error, prints it and copies the source
// through, so the file ships unminified while the build still reports success —
// that is how a red `Processing index.js: ...` line sat in every build for
// however long. checkBuildDependencies() went further and returned true even
// when the minifiers were missing, so a broken install produced a
// fully-unoptimized "successful" build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import buildProduction from '../commands/buildProduction/buildProduction.js';

async function writeSrc(root, rel, content) {
  const p = path.join(root, 'src', rel);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
  return p;
}

// Neither module nor script mode can parse this, so minifyJavaScript throws and
// processFile falls back to copying.
const UNMINIFIABLE = 'function broken( { \nthis is not javascript\n';

describe('a degraded build does not report success', () => {
  test('the build fails when a file could not be optimized', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/broken.js', UNMINIFIABLE);

      const ok = await buildProduction({ minify: true });
      assert.equal(ok, false, 'a build that shipped an unoptimized file must not return true');
    });
  });

  test('the unoptimized file is still copied, so dist stays usable', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/broken.js', UNMINIFIABLE);

      await buildProduction({ minify: true });

      const built = await fs.readFile(path.join(root, 'dist', 'App', 'broken.js'), 'utf8');
      assert.equal(built, UNMINIFIABLE, 'the fallback copy must still happen');
    });
  });

  test('--allow-unoptimized accepts the degradation', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/broken.js', UNMINIFIABLE);

      const ok = await buildProduction({ minify: true, allowUnoptimized: true });
      assert.equal(ok, true, 'the escape hatch must let the build succeed');
    });
  });

  test('a clean build still succeeds', async () => {
    await withTestProject(async () => {
      const ok = await buildProduction({ minify: true });
      assert.equal(ok, true, 'nothing degraded, so the build must succeed');
    });
  });

  test('the failure count does not leak between builds', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/broken.js', UNMINIFIABLE);
      assert.equal(await buildProduction({ minify: true }), false);

      // Same process, second build, nothing wrong with it.
      await fs.remove(path.join(root, 'src', 'App', 'broken.js'));
      assert.equal(
        await buildProduction({ minify: true }),
        true,
        'degradations must be reset per build, not accumulated'
      );
    });
  });

  test('--no-minify is not treated as a degradation', async () => {
    await withTestProject(async (root) => {
      // Copying by design is not a failure; only a failed optimization is.
      await writeSrc(root, 'App/probe.js', 'export function probe() {\n  return 1 + 1;\n}\n');

      const ok = await buildProduction({ minify: false });
      assert.equal(ok, true);
    });
  });
});
