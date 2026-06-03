import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

const MODULE_URL = import.meta.url;

function makeGenerator() {
  const gen = new BundleGenerator(MODULE_URL, null, {});
  gen.sliceConfig = {};
  return gen;
}

function evalSnippet(code) {
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

// Build the dependency-exports object the bundler would emit for a single
// shared module, then read back its keys at runtime.
function evalDepExports(content, moduleName = 'shared/util.js') {
  const gen = makeGenerator();
  const block = gen.buildV2DependencyModuleBlockFromModules([{ name: moduleName, content }]);
  // The block declares `const __sliceDepExports0 = {}` and fills it; expose it.
  return evalSnippet(`${block}\nreturn typeof __sliceDepExports0 !== 'undefined' ? __sliceDepExports0 : {};`);
}

describe('shared dependency module transforms', () => {
  test('plain named exports resolve', () => {
    const d = evalDepExports('export const a = 1;\nexport const b = 2;');
    assert.equal(d.a, 1);
    assert.equal(d.b, 2);
  });

  test('multiline export list resolves every name', () => {
    const d = evalDepExports('const a = 1;\nconst b = 2;\nconst c = 3;\nexport {\n  a,\n  b,\n  c\n};');
    assert.deepEqual([d.a, d.b, d.c], [1, 2, 3]);
  });

  test('export { x as default } exposes a usable default', () => {
    // A consumer doing `import def from '...'` resolves default via the runtime
    // helper, which first checks `.default`. So the exports object should carry
    // a `default` (or the basename-Data fallback) for the aliased-default form.
    const d = evalDepExports('const x = 7;\nexport { x as default };', 'shared/util.js');
    const resolvable = d.default !== undefined || d.utilData !== undefined;
    assert.ok(resolvable, 'aliased default export is not resolvable by the bundle');
  });

  test('destructuring export does not silently drop the binding', () => {
    // `export const { a } = obj` is a valid ESM export; the consumer expects `a`.
    const d = evalDepExports('const obj = { a: 5 };\nexport const { a } = obj;');
    assert.equal(d.a, 5, 'destructured export binding was dropped');
  });

  test('exports that reference one another resolve at runtime', () => {
    // A helper export referencing a constant export must still find it — the
    // transform has to keep a usable local binding, not only the exports field.
    const d = evalDepExports(
      "export const TAG = 'x';\nexport function badge(label) { return '[' + TAG + '] ' + label; }"
    );
    assert.equal(d.TAG, 'x');
    assert.equal(typeof d.badge, 'function');
    assert.equal(d.badge('hi'), '[x] hi');
  });

  test('a transitive dependency is inlined and bound (topological order)', () => {
    const gen = makeGenerator();
    // mid imports leaf; pass mid FIRST so the topological sort must reorder.
    const block = gen.buildV2DependencyModuleBlockFromModules([
      {
        name: 'shared/mid.js',
        content: "import { LEAF } from './leaf.js';\nexport function midValue() { return 'mid:' + LEAF; }",
        moduleImports: [
          { depName: 'shared/leaf.js', bindings: [{ type: 'named', importedName: 'LEAF', localName: 'LEAF' }] },
        ],
      },
      { name: 'shared/leaf.js', content: "export const LEAF = 'leaf-value';", moduleImports: [] },
    ]);
    const deps = evalSnippet(`${block}\nreturn SLICE_BUNDLE_DEPENDENCIES;`);
    assert.equal(deps['shared/leaf.js'].LEAF, 'leaf-value');
    assert.equal(deps['shared/mid.js'].midValue(), 'mid:leaf-value');
  });
});

describe('transitive dependencies of a shared module', () => {
  function bundleWithDependency(depName, depContent, bindings) {
    const gen = makeGenerator();
    const comp = {
      name: 'Widget',
      category: 'Visual',
      categoryType: 'Visual',
      js: 'const C = class {};\nreturn C;',
      hoistedImports: [],
      html: '',
      css: '',
      externalDependencies: { [depName]: { content: depContent, bindings } },
      size: 100,
    };
    return gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [comp]);
  }

  test('a relative import inside a shared module must not leak into the bundle', () => {
    const code = bundleWithDependency(
      'shared/helper.js',
      "import deep from './deep.js';\nexport const helper = () => deep;",
      [{ type: 'named', importedName: 'helper', localName: 'helper' }]
    );
    // Whatever the strategy, the emitted bundle must not contain an unresolved
    // relative import — it would 404 / fail to resolve in production.
    assert.ok(
      !/import\s+[^;]*from\s+['"]\.\.?\//.test(code),
      'unresolved relative import leaked from a transitive dependency'
    );
  });

  test('a bare import inside a shared module must not leak into the bundle', () => {
    const code = bundleWithDependency(
      'shared/helper.js',
      "import 'side-effect-polyfill';\nexport const helper = () => 1;",
      [{ type: 'named', importedName: 'helper', localName: 'helper' }]
    );
    assert.ok(
      !/import\s+['"][^'"]+['"]/.test(code),
      'unresolved bare import leaked from a transitive dependency'
    );
  });
});
