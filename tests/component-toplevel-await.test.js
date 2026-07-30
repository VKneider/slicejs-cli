// A component module may use top-level await. Its code is emitted inside the
// class factory, so the factory has to be async — otherwise the bundle is a
// syntax error (`Unexpected token: name (...)` from Terser, or a browser parse
// failure when minification is off).
//
// registerAll is already async and the framework awaits it
// (Controller.loadBundleWithDependencies), so awaiting the factory there keeps
// `controller.classes` holding the class and never a promise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { minify } from 'terser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

function makeGenerator() {
  const gen = new BundleGenerator(
    import.meta.url,
    { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } },
    { output: 'src', minify: true }
  );
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

function buildBundle(gen, source, name = 'Widget') {
  const cleaned = gen.cleanJavaScript(source, name, `${name}.js`);
  return gen.generateBundleFileContent(
    'slice-bundle.x.js',
    'route',
    [{
      name, category: 'Visual', js: cleaned.code, html: '', css: '',
      externalDependencies: {}, hasTopLevelAwait: cleaned.hasTopLevelAwait
    }],
    '/x'
  );
}

const TLA_SOURCE = [
  "const cfg = await fetch('/config.json').then((r) => r.json());",
  'export default class Widget {',
  '  get() { return cfg; }',
  '}'
].join('\n');

describe('hasModuleTopLevelAwait', () => {
  const gen = makeGenerator();

  test('detects a bare top-level await', () => {
    assert.equal(gen.hasModuleTopLevelAwait("const x = await y();"), true);
  });

  test('detects top-level `for await`', () => {
    assert.equal(gen.hasModuleTopLevelAwait('for await (const c of stream) { use(c); }'), true);
  });

  test('ignores awaits inside functions and methods', () => {
    assert.equal(gen.hasModuleTopLevelAwait('async function f() { await g(); }'), false);
    assert.equal(
      gen.hasModuleTopLevelAwait('export default class A { async init() { await this.load(); } }'),
      false,
      'the overwhelmingly common case must not opt into an async factory'
    );
  });

  test('ignores `for await` inside an async method', () => {
    assert.equal(
      gen.hasModuleTopLevelAwait('class A { async run(s) { for await (const c of s) { use(c); } } }'),
      false
    );
  });

  test('unparseable source does not claim top-level await', () => {
    assert.equal(gen.hasModuleTopLevelAwait('this is not js((('), false);
  });
});

describe('bundles for components with top-level await', () => {
  test('the factory is async and its registration awaits it', () => {
    const gen = makeGenerator();
    const bundle = buildBundle(gen, TLA_SOURCE);

    assert.match(bundle, /const SLICE_CLASS_FACTORY_\S+ = async \(\) => \{/, 'factory must be async');
    assert.match(bundle, /controller\.classes\.set\("Widget", await SLICE_CLASS_FACTORY_\S+\(\)\)/,
      'registration must await the factory');
  });

  test('the bundle parses and minifies', async () => {
    const gen = makeGenerator();
    const bundle = buildBundle(gen, TLA_SOURCE);

    assert.doesNotThrow(() => parse(bundle, { sourceType: 'module' }));
    const result = await minify(bundle, { module: true, compress: {}, mangle: {} });
    assert.ok(result.code);
  });

  test('registerAll resolves the class, not a promise', async () => {
    const gen = makeGenerator();
    // Keep the await resolvable without a network: a resolved promise still
    // makes this a top-level await module.
    const bundle = buildBundle(gen, [
      'const cfg = await Promise.resolve({ ok: true });',
      'export default class Widget { get() { return cfg; } }'
    ].join('\n'));

    // The factory assigns the class onto `window` for bundle evaluation.
    globalThis.window = globalThis.window || globalThis;

    // Evaluate the emitted module the way the runtime does.
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(
      bundle.replace("document.createElement('template')", '({ innerHTML: "" })'),
      'utf8'
    ).toString('base64');
    const mod = await import(dataUrl);

    const controller = { classes: new Map(), templates: new Map(), componentCategories: new Map() };
    const stylesManager = { registerComponentStyles() {}, __sliceRegisteredComponentStyles: new Set() };
    await mod.registerAll(controller, stylesManager);

    const WidgetClass = controller.classes.get('Widget');
    assert.equal(typeof WidgetClass, 'function', 'classes must hold the class, not a promise');
    assert.deepEqual(new WidgetClass().get(), { ok: true }, 'the awaited value must be available');
  });

  test('a component without top-level await keeps a plain factory', () => {
    const gen = makeGenerator();
    const bundle = buildBundle(gen, 'export default class Widget { get() { return 1; } }');

    assert.match(bundle, /const SLICE_CLASS_FACTORY_\S+ = \(\) => \{/);
    assert.doesNotMatch(bundle, /async \(\) => \{/, 'must not become async gratuitously');
    assert.doesNotMatch(bundle, /await SLICE_CLASS_FACTORY/);
  });
});
