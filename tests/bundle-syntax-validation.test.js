// Every emitted bundle must be verified to parse as an ES module before it is
// written, regardless of --minify.
//
// Both bundler bugs found so far had the same shape: the generator produced
// syntactically invalid JavaScript and nothing checked it. With minification on,
// the first sign was a Terser error naming the *generated* file; with
// minification off, applyBundleTransforms returns early, so the broken bundle
// was written silently and only failed in the browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeGenerator(options = {}) {
  const gen = new BundleGenerator(
    import.meta.url,
    { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } },
    { output: 'src', ...options }
  );
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

async function withTmp(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-bundle-validate-'));
  try {
    return await run(tmp);
  } finally {
    await fs.remove(tmp);
  }
}

function bindPaths(gen, tmp) {
  gen.srcPath = path.join(tmp, 'src');
  gen.bundlesPath = path.join(tmp, 'src', 'bundles');
  gen.distPath = path.join(tmp, 'dist');
}

const VALID_BUNDLE = [
  'export const SLICE_BUNDLE_META = { version: "2" };',
  'const SLICE_CLASS_FACTORY_SliceComponent_Widget = () => {',
  '  class Widget {}',
  '  return Widget;',
  '};',
  'export async function registerAll(controller) {',
  '  controller.classes.set("Widget", SLICE_CLASS_FACTORY_SliceComponent_Widget());',
  '}'
].join('\n');

// `export` inside the factory — exactly the named-export bug's output shape.
const INVALID_BUNDLE = [
  'export const SLICE_BUNDLE_META = { version: "2" };',
  'const SLICE_CLASS_FACTORY_SliceComponent_Widget = () => {',
  '  export const OOPS = 1;',
  '  class Widget {}',
  '  return Widget;',
  '};',
  'export async function registerAll() {}'
].join('\n');

describe('emitted bundles are validated before being written', () => {
  test('invalid content is rejected even with minification off', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      await assert.rejects(
        () => gen.emitBundleArtifact('slice-bundle.broken.js', INVALID_BUNDLE),
        /slice-bundle\.broken\.js/,
        'the error must name the bundle'
      );
    });
  });

  test('nothing is written when validation fails', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      await gen.emitBundleArtifact('slice-bundle.broken.js', INVALID_BUNDLE).catch(() => {});

      const written = (await fs.pathExists(gen.bundlesPath))
        ? await fs.readdir(gen.bundlesPath)
        : [];
      assert.deepEqual(written, [], 'a bundle that does not parse must not reach dist');
    });
  });

  test('the error attributes the offending code to its component', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      const error = await gen.emitBundleArtifact('slice-bundle.broken.js', INVALID_BUNDLE)
        .then(() => null, (e) => e);

      assert.ok(error, 'must reject');
      assert.match(error.message, /Widget/, 'must name the component whose code is invalid');
    });
  });

  test('a dependency module is attributed by its src-relative path', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      const content = [
        'export const SLICE_BUNDLE_META = { version: "2" };',
        'const SLICE_BUNDLE_DEPENDENCIES = {};',
        'const __sliceDepExports0 = (() => {',
        '  const __sliceExports = {};',
        '  export const NOPE = 1;',
        '  return __sliceExports;',
        '})();',
        'SLICE_BUNDLE_DEPENDENCIES["Components/Core/AppConfig/AppConfig.js"] = __sliceDepExports0;',
        'export async function registerAll() {}'
      ].join('\n');

      const error = await gen.emitBundleArtifact('slice-bundle.deps.js', content)
        .then(() => null, (e) => e);

      assert.ok(error, 'must reject');
      assert.match(error.message, /AppConfig\.js/);
    });
  });

  test('the failing bundle is saved for inspection', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      const error = await gen.emitBundleArtifact('slice-bundle.broken.js', INVALID_BUNDLE)
        .then(() => null, (e) => e);

      assert.match(error.message, /Saved bundle to /, 'must point at a copy on disk');
      const savedPath = error.message.match(/Saved bundle to (\S+)/)?.[1];
      assert.ok(savedPath && await fs.pathExists(savedPath), `expected ${savedPath} to exist`);
      assert.equal(await fs.readFile(savedPath, 'utf8'), INVALID_BUNDLE);
      await fs.remove(savedPath);
    });
  });

  test('valid bundles are emitted unchanged when not minifying', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      const { file } = await gen.emitBundleArtifact('slice-bundle.ok.js', VALID_BUNDLE);
      const written = await fs.readFile(path.join(gen.bundlesPath, file), 'utf8');
      assert.equal(written, VALID_BUNDLE);
    });
  });

  test('valid bundles still minify', async () => {
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: true });
      bindPaths(gen, tmp);

      const { file } = await gen.emitBundleArtifact('slice-bundle.ok.js', VALID_BUNDLE);
      const written = await fs.readFile(path.join(gen.bundlesPath, file), 'utf8');
      assert.ok(written.length < VALID_BUNDLE.length, 'should be smaller than the source');
      assert.match(written, /registerAll/);
    });
  });

  test('every bundle a real generate() emits is validated', async () => {
    // Structural guarantee: proves the guard covers critical, route, framework
    // and vendor-shared bundles, not just the paths a unit test happens to call.
    await withTmp(async (tmp) => {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const makeComp = async (name) => {
        const dir = path.join(tmp, 'src', 'Components', 'Visual', name);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, `${name}.js`), `export default class ${name} { r() { return 1; } }`);
        return {
          name, category: 'Visual', categoryType: 'Visual', path: dir,
          dependencies: new Set(), routes: new Set([`/${name.toLowerCase()}`]), size: 3000
        };
      };

      const gen = new BundleGenerator(import.meta.url, {
        components: [await makeComp('Alpha'), await makeComp('Beta')],
        routes: [
          { path: '/alpha', component: 'Alpha', dependencies: new Set(['Alpha']) },
          { path: '/beta', component: 'Beta', dependencies: new Set(['Beta']) }
        ],
        routeGroups: new Map(),
        metrics: { totalComponents: 2, totalRoutes: 2, sharedPercentage: 0, totalSize: 6000 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      bindPaths(gen, tmp);

      const validated = [];
      const realValidate = gen.validateGeneratedBundle.bind(gen);
      gen.validateGeneratedBundle = async (content, fileName) => {
        validated.push(fileName);
        return realValidate(content, fileName);
      };

      await gen.generate();

      const emitted = (await fs.readdir(gen.bundlesPath)).filter(
        (f) => f.endsWith('.js') && !f.includes('bundle.config')
      );
      assert.ok(emitted.length > 0, 'the fixture must emit at least one bundle');
      assert.equal(
        validated.length,
        emitted.length,
        `every emitted bundle must be validated — validated ${validated.join(', ')} vs emitted ${emitted.join(', ')}`
      );
    });
  });

  test('a component with top-level await is reported against its source, not the bundle', async () => {
    // The factory is emitted as a non-async arrow, so top-level await in a
    // component produces invalid output. Validation should say which component.
    await withTmp(async (tmp) => {
      const gen = makeGenerator({ minify: false });
      bindPaths(gen, tmp);

      const { code } = gen.cleanJavaScript(
        "const cfg = await fetch('/c.json');\nexport default class Widget { get() { return cfg; } }",
        'Widget',
        'Widget.js'
      );
      const content = gen.generateBundleFileContent(
        'slice-bundle.x.js',
        'route',
        [{ name: 'Widget', category: 'Visual', js: code, html: '', css: '', externalDependencies: {} }],
        '/x'
      );

      const error = await gen.emitBundleArtifact('slice-bundle.x.js', content)
        .then(() => null, (e) => e);

      assert.ok(error, 'must reject');
      assert.match(error.message, /Widget/, 'must name the component');
    });
  });
});
