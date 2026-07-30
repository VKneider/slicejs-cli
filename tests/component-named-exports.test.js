// Regression tests for module-level named exports in a component/service file.
//
// A component file is an ES module, so `export const` / `export function` /
// `export class` are valid and work in dev. The bundler embeds that code inside
// `SLICE_CLASS_FACTORY_* = () => { ... }`, where `export` is a syntax error —
// previously only `export default` was stripped, so the emitted bundle either
// failed Terser with `"Export" statement may only appear at the top level`
// (minified) or shipped broken and failed to parse in the browser (unminified).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { minify } from 'terser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

const ANALYSIS = { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } };

function makeGenerator() {
  const gen = new BundleGenerator(import.meta.url, ANALYSIS, { output: 'src', minify: true });
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

// Mirrors the real minify options (compress + mangle); Terser's parser only
// rejects a nested `export` once those passes run.
const terserOptions = { module: true, compress: {}, mangle: {} };

describe('stripModuleExports', () => {
  test('drops the keyword but keeps the declaration', () => {
    const gen = makeGenerator();
    const out = gen.stripModuleExports([
      "export const TOAST_DURATION = 4000;",
      "export let counter = 0;",
      "export var legacy = 1;",
      "export function helper() { return 1; }",
      "export async function load() { return 2; }",
      "export class Helper {}"
    ].join('\n'));

    assert.ok(!/\bexport\b/.test(out), `no export keyword should remain, got:\n${out}`);
    assert.match(out, /const TOAST_DURATION = 4000;/);
    assert.match(out, /let counter = 0;/);
    assert.match(out, /var legacy = 1;/);
    assert.match(out, /function helper\(\) \{ return 1; \}/);
    assert.match(out, /async function load\(\) \{ return 2; \}/);
    assert.match(out, /class Helper \{\}/);
  });

  test('leaves export default for the caller to strip', () => {
    const gen = makeGenerator();
    const out = gen.stripModuleExports("export default class MyService {}");
    assert.match(out, /export default class MyService/);
  });

  test('preserves destructuring and multi-declarator forms', () => {
    const gen = makeGenerator();
    const out = gen.stripModuleExports([
      "export const { a, b } = source;",
      "export const [x, y] = list;",
      "export const p = 1, q = 2;"
    ].join('\n'));

    assert.ok(!/\bexport\b/.test(out));
    assert.match(out, /const \{ a, b \} = source;/);
    assert.match(out, /const \[x, y\] = list;/);
    assert.match(out, /const p = 1, q = 2;/);
  });

  test('drops `export { a, b }` while keeping the declarations', () => {
    const gen = makeGenerator();
    const out = gen.stripModuleExports([
      "const a = 1;",
      "const b = 2;",
      "export { a, b };"
    ].join('\n'));

    assert.ok(!/\bexport\b/.test(out));
    assert.match(out, /const a = 1;/);
    assert.match(out, /const b = 2;/);
  });

  test('does not touch the word export inside strings or identifiers', () => {
    const gen = makeGenerator();
    const source = [
      "const label = 'export const not code';",
      "const exportCount = 3;",
      "function exportData() { return exportCount; }"
    ].join('\n');

    assert.equal(gen.stripModuleExports(source), source);
  });

  test('falls back to a keyword strip when the source cannot be parsed', () => {
    const gen = makeGenerator();
    // Deliberately unparseable by @babel/parser without a TS plugin.
    const out = gen.stripModuleExports("export const x: number = 1;\nthis is not js(((");
    assert.match(out, /^const x: number = 1;/m);
  });
});

describe('cleanJavaScript with named exports', () => {
  test('produces a factory body with no export keyword', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript([
      "export const TOAST_DURATION = 4000;",
      "export function helper() { return 1; }",
      "export default class MyService {",
      "  run() { return TOAST_DURATION + helper(); }",
      "}"
    ].join('\n'), 'MyService', 'MyService.js');

    assert.ok(!/\bexport\b/.test(code), `factory body must be export-free, got:\n${code}`);
    // The declarations survive, so the class can still reference them.
    assert.match(code, /const TOAST_DURATION = 4000;/);
    assert.match(code, /function helper\(\)/);
    assert.match(code, /return MyService;/);
  });
});

describe('generated bundle survives Terser', () => {
  const buildBundle = (source, name = 'MyService') => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(source, name, `${name}.js`);
    return gen.generateBundleFileContent(
      `slice-bundle.x.js`,
      'route',
      [{ name, category: 'Domain', js: code, html: '', css: '', externalDependencies: {} }],
      '/x'
    );
  };

  test('a service with named exports minifies cleanly', async () => {
    const bundle = buildBundle([
      "export const TOAST_DURATION = 4000;",
      "export default class MyService {",
      "  run() { return TOAST_DURATION; }",
      "}"
    ].join('\n'));

    const result = await minify(bundle, terserOptions);
    assert.ok(result.code, 'Terser must return minified output');
  });

  test('the same source used to fail — assert the old failure is gone', async () => {
    const bundle = buildBundle([
      "export const A = 1;",
      "export function f() { return A; }",
      "export class Extra {}",
      "export default class MyService { run() { return f(); } }"
    ].join('\n'));

    // None of the component's OWN declarations may still carry the keyword.
    // (The bundle legitimately has `export const SLICE_BUNDLE_META` of its own.)
    assert.doesNotMatch(bundle, /export\s+const\s+A\b/);
    assert.doesNotMatch(bundle, /export\s+function\s+f\b/);
    assert.doesNotMatch(bundle, /export\s+class\s+Extra\b/);

    const result = await minify(bundle, terserOptions);
    assert.ok(result.code);
  });

  test('a bundle still exports exactly the V2 contract', async () => {
    const bundle = buildBundle("export const A = 1;\nexport default class MyService {}");
    // Controller.validateBundleModule requires these two and nothing else.
    assert.match(bundle, /export const SLICE_BUNDLE_META = /);
    assert.match(bundle, /export async function registerAll\(/);
    // Those two are the ONLY top-level exports left.
    const topLevelExports = bundle.match(/^export\s/gm) || [];
    assert.equal(topLevelExports.length, 2, `expected 2 top-level exports, got ${topLevelExports.length}`);
  });
});
