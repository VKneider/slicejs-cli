// Regression tests for minification of module-only syntax in src files.
//
// buildProduction's minifyJavaScript() ran Terser without `module: true`, so
// every source was parsed in script mode. Top-level `await` is invalid there —
// Terser reads `await` as a plain identifier and throws
// `Unexpected token: name (<next token>)`. processFile() caught that, printed a
// red error and copied the file verbatim, so anything using top-level await
// silently shipped unminified. The starter App/index.js does
// `await slice.router.start()`, so this fired on every build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import buildProduction from '../commands/buildProduction/buildProduction.js';

async function writeSrc(root, rel, content) {
  const p = path.join(root, 'src', rel);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
  return p;
}

const readDist = (root, rel) => fs.readFile(path.join(root, 'dist', rel), 'utf8');

describe('buildProduction minifies module-only syntax', () => {
  test('a module with top-level await is minified, not copied verbatim', async () => {
    await withTestProject(async (root) => {
      const original = [
        "import '/Slice/Slice.js';",
        '',
        '// A comment that minification must strip.',
        'slice.router.afterEach((to) => {',
        "  document.title = to.metadata?.title ?? 'App';",
        '});',
        '',
        'await slice.router.start();',
        ''
      ].join('\n');
      await writeSrc(root, 'App/tla.js', original);

      await buildProduction({ minify: true });
      const built = await readDist(root, 'App/tla.js');

      assert.notEqual(built, original, 'must not be a verbatim copy of the source');
      assert.ok(
        Buffer.byteLength(built) < Buffer.byteLength(original),
        `minified output should be smaller (${Buffer.byteLength(built)} vs ${Buffer.byteLength(original)})`
      );
      assert.doesNotMatch(built, /A comment that minification must strip/);
      // The semantics have to survive the round trip.
      assert.match(built, /await slice\.router\.start\(\)/);
      assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
    });
  });

  test('top-level `await import()` is minified too', async () => {
    await withTestProject(async (root) => {
      const original = "const mod = await import('./other.js');\nexport default mod;\n";
      await writeSrc(root, 'App/lazy.js', original);

      await buildProduction({ minify: true });
      const built = await readDist(root, 'App/lazy.js');

      assert.notEqual(built.trim(), original.trim());
      assert.match(built, /await import\(/);
      assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
    });
  });

  test('the guards pattern the starter documents is minifiable', async () => {
    // The starter App/index.js ships this commented out and tells the developer
    // to "start the router EXPLICITLY" here — i.e. the documented way to add
    // navigation guards is exactly what used to break minification.
    await withTestProject(async (root) => {
      const original = [
        "import Slice from '/Slice/Slice.js';",
        '',
        'slice.router.beforeEach(async (to, from, next) => {',
        "  if (to.metadata?.private && !slice.context.getState('auth')?.isLoggedIn) {",
        "    return next({ path: '/login', replace: true });",
        '  }',
        '  next();',
        '});',
        '',
        'slice.router.afterEach((to) => {',
        "  document.title = to.metadata?.title ?? 'Slice App';",
        '});',
        '',
        'await slice.router.start();',
        ''
      ].join('\n');
      await fs.writeFile(path.join(root, 'src', 'App', 'index.js'), original, 'utf8');

      await buildProduction({ minify: true });
      const built = await readDist(root, 'App/index.js');

      assert.notEqual(built, original, 'App/index.js must not ship verbatim');
      assert.match(built, /await slice\.router\.start\(\)/);
      assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
    });
  });

  test('a classic script that only parses in sloppy mode still builds', async () => {
    await withTestProject(async (root) => {
      // `with` is a SyntaxError under module/strict mode. The fallback to the
      // previous script-mode parse must keep handling it.
      const original = 'function legacy(o) { with (o) { return value; } }\nwindow.legacy = legacy;\n';
      await writeSrc(root, 'App/legacy.js', original);

      const ok = await buildProduction({ minify: true });
      assert.equal(ok, true, 'the build must not fail because of a sloppy-mode file');

      const built = await readDist(root, 'App/legacy.js');
      assert.match(built, /with\s*\(/, 'the sloppy-mode construct must survive');
      assert.match(built, /window\.legacy/);
      // Not enough to check `with` survived: processFile() copies the file
      // verbatim when minification throws, so a broken fallback would pass that
      // check. Require it to have actually been minified.
      assert.notEqual(built, original, 'must be minified via the script-mode fallback, not copied');
    });
  });
});
