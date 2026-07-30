// Build-time diagnostics for broken source, reported against the developer's
// file rather than against generated output.
//
// Two gaps this closes:
//
//  1. A component with a syntax error flowed through every transform (each of
//     which silently falls back to a regex when it cannot parse) and into the
//     bundle, where the generated-bundle validation reported a position in the
//     *generated* file and said "this is a bundler bug" — the opposite of true.
//     The real position only ever appeared in warnings.
//
//  2. A relative import that resolved to nothing was dropped without a word:
//     `import { x } from './typo.js'` produced a bundle where `x` was undefined,
//     with nothing at build time and no clue at runtime.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import ExternalModuleBundler from '../commands/utils/bundling/ExternalModuleBundler.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeGenerator() {
  const gen = new BundleGenerator(
    import.meta.url,
    { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } },
    { output: 'src' }
  );
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

/** Builds a one-component project and returns the error generate() threw, if any. */
async function generateWith(componentSource, extraFiles = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-diag-'));
  try {
    await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const dir = path.join(tmp, 'src', 'Components', 'Visual', 'Widget');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'Widget.js'), componentSource);
    for (const [rel, content] of Object.entries(extraFiles)) {
      const target = path.join(tmp, 'src', rel);
      await fs.ensureDir(path.dirname(target));
      await fs.writeFile(target, content);
    }

    const gen = new BundleGenerator(import.meta.url, {
      components: [{
        name: 'Widget', category: 'Visual', categoryType: 'Visual', path: dir,
        dependencies: new Set(), routes: new Set(['/w']), size: 3000
      }],
      routes: [{ path: '/w', component: 'Widget', dependencies: new Set(['Widget']) }],
      routeGroups: new Map(),
      metrics: { totalComponents: 1, totalRoutes: 1, sharedPercentage: 0, totalSize: 3000 }
    }, { output: 'src' });
    gen.sliceConfig = { externalDependencies: { enabled: true } };
    gen.srcPath = path.join(tmp, 'src');
    gen.bundlesPath = path.join(tmp, 'src', 'bundles');
    gen.distPath = path.join(tmp, 'dist');
    gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
      await gen.generate();
      return { error: null, bundlesDir: gen.bundlesPath, tmp };
    } catch (error) {
      return { error, bundlesDir: gen.bundlesPath, tmp };
    } finally {
      Object.assign(console, real);
    }
  } finally {
    await fs.remove(tmp).catch(() => {});
  }
}

describe('a component that does not parse', () => {
  const BROKEN = 'export default class Widget {\n  method( {\n}';

  test('the build fails', () => {
    const gen = makeGenerator();
    assert.throws(() => gen.cleanJavaScript(BROKEN, 'Widget', 'src/Components/Visual/Widget/Widget.js'));
  });

  test('the error points at the source file, line and column', () => {
    const gen = makeGenerator();
    try {
      gen.cleanJavaScript(BROKEN, 'Widget', 'src/Components/Visual/Widget/Widget.js');
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.message, /src\/Components\/Visual\/Widget\/Widget\.js:\d+:\d+/,
        'must give an editor-jumpable location');
      assert.match(error.message, /Syntax error in component "Widget"/);
    }
  });

  test('it shows a source frame with a caret', () => {
    const gen = makeGenerator();
    try {
      gen.cleanJavaScript(BROKEN, 'Widget', 'Widget.js');
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.message, /> \d+ \|/, 'the offending line must be marked');
      assert.match(error.message, /\|\s*\^/, 'and a caret must point at the column');
      assert.match(error.message, /export default class Widget/, 'with surrounding context');
    }
  });

  test('it does not blame the bundler', () => {
    // The generated-bundle validation says "this is a bundler bug"; for a source
    // error that is exactly the wrong thing to tell someone.
    const gen = makeGenerator();
    try {
      gen.cleanJavaScript(BROKEN, 'Widget', 'Widget.js');
      assert.fail('should have thrown');
    } catch (error) {
      assert.doesNotMatch(error.message, /bundler bug/);
    }
  });

  test('through a real generate(), the error is the source one', async () => {
    const { error } = await generateWith(BROKEN);
    assert.ok(error, 'the build must fail');
    assert.match(error.message, /Syntax error in component "Widget"/);
    assert.doesNotMatch(error.message, /bundler bug/, 'must not be reported as generated-bundle breakage');
  });

  test('valid source is untouched', () => {
    const gen = makeGenerator();
    assert.doesNotThrow(() =>
      gen.cleanJavaScript('export default class Widget { r() { return 1; } }', 'Widget', 'Widget.js'));
  });
});

describe('a relative import that resolves to nothing', () => {
  test('the build fails instead of dropping it', async () => {
    const { error } = await generateWith(
      "import { x } from './missing.js';\nexport default class Widget { r() { return x; } }"
    );
    assert.ok(error, 'an unresolved relative import must fail the build');
    assert.match(error.message, /Cannot resolve 1 import\(s\)/);
    assert.match(error.message, /\.\/missing\.js/);
  });

  test('the error names the importing file and the path it tried', async () => {
    const { error } = await generateWith(
      "import { x } from './missing.js';\nexport default class Widget { r() { return x; } }"
    );
    assert.match(error.message, /Widget\.js/, 'must name the file with the bad import');
    assert.match(error.message, /missing\.js/, 'and the path it resolved to');
    assert.match(error.message, /becomes `undefined` at runtime/, 'and say why it matters');
  });

  test('several bad imports are reported together', () => {
    const gen = makeGenerator();
    try {
      gen.assertRelativeImportsResolve(['./a.js', './b.js', '../c.js'], '/project/src/Widget', '/project/src/Widget/Widget.js');
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.message, /Cannot resolve 3 import\(s\)/, 'do not make them fix one per build');
      for (const spec of ['./a.js', './b.js', '../c.js']) {
        assert.ok(error.message.includes(spec), `${spec} must be listed`);
      }
    }
  });

  test('an extensionless import that resolves is fine', async () => {
    const { error } = await generateWith(
      "import { x } from './helper';\nexport default class Widget { r() { return x; } }",
      { 'Components/Visual/Widget/helper.js': 'export const x = 1;' }
    );
    assert.equal(error, null, 'resolution still tries .js/.json/.mjs');
  });

  test('a relative asset import is left alone', () => {
    // Only specifiers that name a JS module are enforced; an asset has its own
    // delivery story and is not the bundler's business.
    const gen = makeGenerator();
    assert.doesNotThrow(() =>
      gen.assertRelativeImportsResolve(['./logo.svg', './styles.css'], '/project/src/Widget'));
  });

  test('nothing unresolved means nothing thrown', () => {
    const gen = makeGenerator();
    assert.doesNotThrow(() => gen.assertRelativeImportsResolve([], '/project/src/Widget'));
  });
});
