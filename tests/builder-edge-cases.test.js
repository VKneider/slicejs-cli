import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

const MODULE_URL = import.meta.url;

function makeGenerator(sliceConfig = {}) {
  const gen = new BundleGenerator(MODULE_URL, null, {});
  gen.sliceConfig = sliceConfig;
  return gen;
}

function evalSnippet(code) {
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

function parsesAsModule(code) {
  parse(code, { sourceType: 'module', plugins: ['jsx'] });
}

// Run the dependency block the bundler would emit for a single shared module
// and return the resulting exports object so we can assert runtime behaviour.
function depExports(content, moduleName = 'shared/util.js') {
  const gen = makeGenerator();
  const block = gen.buildV2DependencyModuleBlockFromModules([{ name: moduleName, content }]);
  return { block, exports: evalSnippet(`${block}\nreturn __sliceDepExports0;`) };
}

describe('transformDependencyContent — declaration forms', () => {
  test('export function (sync) is callable', () => {
    const { exports: d } = depExports('export function fn() { return 7; }');
    assert.equal(d.fn(), 7);
  });

  test('export async function keeps its async-ness', () => {
    const { exports: d } = depExports('export async function fn() { return 1; }');
    assert.equal(d.fn.constructor.name, 'AsyncFunction');
  });

  test('export generator function yields', () => {
    const { exports: d } = depExports('export function* gen() { yield 42; }');
    assert.equal(d.gen().next().value, 42);
  });

  test('export class is constructable', () => {
    const { exports: d } = depExports('export class Box { value() { return 8; } }');
    assert.equal(new d.Box().value(), 8);
  });

  test('multiple declarators in one statement', () => {
    const { exports: d } = depExports('export const a = 1, b = 2;');
    assert.deepEqual([d.a, d.b], [1, 2]);
  });

  test('export without initializer keeps the key (undefined)', () => {
    const { exports: d } = depExports('export let pending;');
    assert.ok('pending' in d);
    assert.equal(d.pending, undefined);
  });
});

describe('transformDependencyContent — destructuring exports', () => {
  test('nested object destructuring', () => {
    const { exports: d } = depExports('const o = { a: { b: 7 } };\nexport const { a: { b } } = o;');
    assert.equal(d.b, 7);
  });

  test('array destructuring', () => {
    const { exports: d } = depExports('const arr = [10, 20];\nexport const [x, y] = arr;');
    assert.deepEqual([d.x, d.y], [10, 20]);
  });

  test('destructuring with a default value', () => {
    const { exports: d } = depExports('export const { a = 5 } = {};');
    assert.equal(d.a, 5);
  });

  test('rest element in destructuring', () => {
    const { exports: d } = depExports('const o = { a: 1, b: 2, c: 3 };\nexport const { a, ...rest } = o;');
    assert.equal(d.a, 1);
    assert.deepEqual(d.rest, { b: 2, c: 3 });
  });
});

describe('transformDependencyContent — default exports', () => {
  test('default named function exposes .default and the basename fallback key', () => {
    const { exports: d } = depExports('export default function build() { return 3; }', 'shared/util.js');
    assert.equal(d.default(), 3);
    assert.equal(d.utilData, d.default);
  });

  test('default anonymous class is constructable', () => {
    const { exports: d } = depExports('export default class { constructor() { this.v = 9; } }');
    assert.equal(new d.default().v, 9);
  });

  test('default object literal', () => {
    const { exports: d } = depExports('export default { k: 1 };');
    assert.deepEqual(d.default, { k: 1 });
  });
});

describe('transformDependencyContent — specifier & re-export forms', () => {
  test('mixed aliased + plain specifiers', () => {
    const { exports: d } = depExports('const a = 1;\nconst b = 2;\nexport { a as alpha, b };');
    assert.equal(d.alpha, 1);
    assert.equal(d.b, 2);
  });

  test('re-export from another module is dropped (not leaked)', () => {
    const { block } = depExports("export { a } from './other.js';");
    assert.ok(!/from\s+['"]\.\/other\.js['"]/.test(block), 're-export leaked into the bundle');
  });

  test('export * is dropped (not leaked)', () => {
    const { block } = depExports("export * from './other.js';");
    assert.ok(!/export\s*\*/.test(block) && !/\.\/other\.js/.test(block));
  });
});

describe('transformDependencyContent — robustness', () => {
  test('the word "export" inside a string is never transformed', () => {
    const { block, exports: d } = depExports('const s = "export const x = 1";\nexport const real = 2;');
    assert.equal(d.real, 2);
    assert.ok(block.includes('"export const x = 1"'), 'string literal was mangled');
    assert.equal(d.x, undefined);
  });

  test('a module with no exports is left runnable', () => {
    const { exports: d } = depExports('const internalOnly = 5;');
    assert.deepEqual(d, {});
  });

  test('imports inside a dependency module are stripped', () => {
    const { block } = depExports(
      "import dep from './dep.js';\nimport 'polyfill';\nimport * as ns from './ns.js';\nexport const y = 1;"
    );
    assert.ok(!/\bimport\b/.test(block), 'an import leaked into the dependency block');
  });

  test('every transformed dependency block is valid module JS', () => {
    const samples = [
      'export const a = 1, b = 2;',
      'export function f() {}',
      'export class C {}',
      'export default class { }',
      'const o = {a:1};\nexport const { a } = o;',
      'export { x as default };\nconst x = 1;',
    ];
    for (const content of samples) {
      const gen = makeGenerator();
      const block = gen.buildV2DependencyModuleBlockFromModules([{ name: 'm/x.js', content }]);
      assert.doesNotThrow(() => parsesAsModule(block), `block invalid for: ${content}`);
    }
  });

  test('TypeScript-ish content falls back without throwing', () => {
    const gen = makeGenerator();
    // TS type annotations are not understood by the fallback regex; the point
    // here is only that the fallback path is reached without throwing.
    const out = gen.transformDependencyContent('export const y: number = 2;', '__d', 'm/x.ts');
    assert.equal(typeof out, 'string');
  });
});

describe('cleanJavaScript', () => {
  test('exposes the component class globally and returns it', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript('export default class Button extends HTMLElement {}', 'Button');
    assert.match(code, /window\.Button = Button;/);
    assert.match(code, /return Button;/);
    // The cleaned code is a factory *body* (ends in `return Button;`), so allow
    // a top-level return when checking it is otherwise syntactically valid.
    assert.doesNotThrow(() =>
      parse(code, { sourceType: 'script', allowReturnOutsideFunction: true })
    );
  });

  test('guards customElements.define against duplicate registration', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      "class El extends HTMLElement {}\ncustomElements.define('my-el', El);",
      'El'
    );
    assert.match(code, /if \(!customElements\.get\('my-el'\)\)/);
  });

  test('strips relative imports and hoists public-folder imports', () => {
    const gen = makeGenerator({ publicFolders: ['/assets'] });
    const { code, hoistedImports } = gen.cleanJavaScript(
      "import './local.js';\nimport lib from '/assets/lib.js';\nclass C {}\nreturn C;",
      'C'
    );
    assert.ok(!code.includes('./local.js'));
    assert.equal(hoistedImports.length, 1);
    assert.match(hoistedImports[0], /\/assets\/lib\.js/);
  });
});

describe('toSafeIdentifier — injectivity sweep', () => {
  test('a batch of tricky names all map to distinct, valid identifiers', () => {
    const gen = makeGenerator();
    const names = ['my-btn', 'my_btn', 'my.btn', 'my btn', 'btn', '1btn', 'Ünïcode', 'a-b', 'a_b'];
    const ids = names.map((n) => gen.toSafeIdentifier(n));
    assert.equal(new Set(ids).size, names.length, 'two names collided to the same identifier');
    for (const id of ids) {
      assert.doesNotThrow(() => parse(`const ${id} = 1;`));
    }
  });
});

describe('generateBundleFileContent — broader cases', () => {
  function component(name, extra = {}) {
    return {
      name,
      category: 'Visual',
      categoryType: 'Visual',
      js: 'const C = class {};\nreturn C;',
      hoistedImports: [],
      html: '',
      css: '',
      externalDependencies: {},
      size: 100,
      ...extra,
    };
  }

  test('an empty component list still emits a valid registerAll module', () => {
    const gen = makeGenerator();
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', []);
    assert.doesNotThrow(() => parsesAsModule(code));
    assert.match(code, /export async function registerAll/);
  });

  test('a unicode component name produces a valid bundle', () => {
    const gen = makeGenerator();
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [component('Ünïcode')]);
    assert.doesNotThrow(() => parsesAsModule(code));
  });

  test('a component with default + named dependencies parses and binds both', () => {
    const gen = makeGenerator();
    const comp = component('Widget', {
      externalDependencies: {
        'shared/util.js': {
          content: 'export default () => 1;\nexport const helper = () => 2;',
          bindings: [
            { type: 'default', importedName: 'default', localName: 'main' },
            { type: 'named', importedName: 'helper', localName: 'helper' },
          ],
        },
      },
    });
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [comp]);
    assert.doesNotThrow(() => parsesAsModule(code));
    assert.match(code, /const main = __sliceResolveDefaultExport\(/);
    assert.match(code, /const helper = SLICE_BUNDLE_DEPENDENCIES\["shared\/util\.js"\]\.helper;/);
  });

  // IIFE scoping: two dependency modules that each declare the same private
  // (non-exported) top-level binding must NOT collide at bundle scope.
  test('dependency modules with a colliding private helper name stay isolated', () => {
    const gen = makeGenerator();
    const mk = (name, depName, depContent) =>
      component(name, {
        externalDependencies: {
          [depName]: {
            content: depContent,
            bindings: [{ type: 'named', importedName: 'x', localName: 'x' }],
          },
        },
      });
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [
      mk('A', 'a/util.js', 'const helper = 1;\nexport const x = helper;'),
      mk('B', 'b/util.js', 'const helper = 2;\nexport const x = helper;'),
    ]);
    assert.doesNotThrow(() => parsesAsModule(code));
    // And each dependency keeps its own value for the shared export name.
    assert.match(code, /SLICE_BUNDLE_DEPENDENCIES\["a\/util\.js"\]/);
    assert.match(code, /SLICE_BUNDLE_DEPENDENCIES\["b\/util\.js"\]/);
  });

  test('two IIFE-scoped dependencies resolve to independent values at runtime', () => {
    const gen = makeGenerator();
    const block = gen.buildV2DependencyModuleBlockFromModules([
      { name: 'a/util.js', content: 'const helper = 1;\nexport const x = helper;' },
      { name: 'b/util.js', content: 'const helper = 2;\nexport const x = helper;' },
    ]);
    const deps = evalSnippet(`${block}\nreturn SLICE_BUNDLE_DEPENDENCIES;`);
    assert.equal(deps['a/util.js'].x, 1);
    assert.equal(deps['b/util.js'].x, 2);
  });
});

describe('classifyImport / stripImports — more edge cases', () => {
  test('dynamic import() expressions are preserved', () => {
    const gen = makeGenerator({ publicFolders: [] });
    const code = "const m = import('./lazy.js');\nconst v = 1;";
    const out = gen.stripImports(code, { collectHoistedImports: true });
    assert.match(out.code, /import\('\.\/lazy\.js'\)/);
  });

  test('windows-style backslashes in a public import are normalized and kept', () => {
    const gen = makeGenerator({ publicFolders: ['/assets'] });
    const r = gen.classifyImport('/assets\\lib\\x.js', gen.getConfiguredPublicFolders());
    assert.equal(r.keep, true);
  });

  test('a public import with a query string is kept', () => {
    const gen = makeGenerator({ publicFolders: ['/assets'] });
    const r = gen.classifyImport('/assets/lib.js?v=2', gen.getConfiguredPublicFolders());
    assert.equal(r.keep, true);
  });

  test('publicFolders configured without a leading slash still match', () => {
    const gen = makeGenerator({ publicFolders: ['assets'] });
    const r = gen.classifyImport('/assets/lib.js', gen.getConfiguredPublicFolders());
    assert.equal(r.keep, true);
  });
});
