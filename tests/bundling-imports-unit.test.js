import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@babel/parser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

// These tests exercise the cross-module import / variable handling of the
// bundler in isolation. They are written to assert *correct* behaviour, so a
// failure here documents a real gap/bug in the bundler rather than the test.

// A shared temp project whose src/public/ holds the assets the "kept absolute
// import" tests reference. Absolute imports are preserved only when the file
// exists under src/public/.
let TMP_ROOT;
let PUBLIC_SRC;

before(async () => {
  TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-imports-'));
  PUBLIC_SRC = path.join(TMP_ROOT, 'src');
  for (const rel of ['assets/lib.js', 'assets/lib/x.js', 'assets/a.js', 'assets/b.js']) {
    const p = path.join(PUBLIC_SRC, 'public', rel);
    await fs.ensureDir(path.dirname(p));
    await fs.writeFile(p, '');
  }
});
after(async () => { if (TMP_ROOT) await fs.remove(TMP_ROOT); });

function makeGenerator(sliceConfig = {}) {
  const gen = new BundleGenerator(import.meta.url, null, {});
  gen.sliceConfig = sliceConfig;
  if (PUBLIC_SRC) gen.srcPath = PUBLIC_SRC;
  return gen;
}

// Evaluate a generated JS snippet in a throwaway scope and return whatever the
// trailing `return` yields. Used to verify the *runtime* behaviour of the code
// the bundler emits (not just its shape).
function evalSnippet(code) {
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

describe('classifyImport', () => {
  // Absolute imports are kept only when the file exists under src/public/.
  const gen = makeGenerator({});
  before(() => { gen.srcPath = PUBLIC_SRC; });

  test('relative imports are dropped silently (no warning)', () => {
    const r = gen.classifyImport('./Foo.js');
    assert.equal(r.keep, false);
    assert.equal(r.warning, null);
  });

  test('parent-relative imports are dropped silently', () => {
    const r = gen.classifyImport('../shared/util.js');
    assert.equal(r.keep, false);
    assert.equal(r.warning, null);
  });

  test('absolute imports that exist under public/ are kept', () => {
    const r = gen.classifyImport('/assets/lib/x.js');
    assert.equal(r.keep, true);
    assert.equal(r.warning, null);
  });

  test('absolute import matching a public/ directory is kept', () => {
    const r = gen.classifyImport('/assets');
    assert.equal(r.keep, true);
  });

  test('absolute imports not present under public/ are dropped with warning', () => {
    const r = gen.classifyImport('/secret/key.js');
    assert.equal(r.keep, false);
    assert.match(r.warning, /absolute import/);
  });

  test('a public/ name must not match by prefix only (/assetsX)', () => {
    const r = gen.classifyImport('/assetsX/x.js');
    assert.equal(r.keep, false, '/assetsX should NOT be treated as inside /assets');
  });

  test('bare specifier imports are stripped as external (resolved from node_modules)', () => {
    const r = gen.classifyImport('lodash');
    assert.equal(r.keep, false);
    assert.equal(r.warning, null);
    assert.equal(r.external, true);
  });

  test('non-string import path is handled defensively', () => {
    const r = gen.classifyImport(undefined);
    assert.equal(r.keep, false);
  });
});

describe('stripImports', () => {
  test('removes relative + bare imports, keeps body intact', () => {
    const gen = makeGenerator();
    const code = [
      "import Foo from './Foo.js';",
      "import { x } from 'pkg';",
      'const value = 42;',
      'export default value;',
    ].join('\n');
    const out = gen.stripImports(code, { collectHoistedImports: true });
    assert.ok(!out.code.includes("from './Foo.js'"));
    assert.ok(!out.code.includes("from 'pkg'"));
    assert.ok(out.code.includes('const value = 42;'));
    assert.deepEqual(out.hoistedImports, []);
  });

  test('hoists kept public/ imports instead of inlining them', () => {
    const gen = makeGenerator();
    const code = "import lib from '/assets/lib.js';\nconst a = lib;";
    const out = gen.stripImports(code, { collectHoistedImports: true });
    assert.equal(out.hoistedImports.length, 1);
    assert.match(out.hoistedImports[0], /\/assets\/lib\.js/);
    // The hoisted import must NOT remain inline in the body.
    assert.ok(!out.code.includes("import lib from '/assets/lib.js'"));
  });

  test('code with no imports is returned unchanged', () => {
    const gen = makeGenerator();
    const code = 'const a = 1;\nconst b = 2;';
    const out = gen.stripImports(code, { collectHoistedImports: true });
    assert.equal(out.code, code);
  });

  test('falls back to regex scanner when Babel cannot parse', () => {
    const gen = makeGenerator();
    // `@decorator` + class field syntax with no plugin -> Babel throws -> fallback.
    const code = "import x from './x.js';\nconst valid = 1;\nthis is not ::: valid js @@@";
    // Should not throw; relative import must still be stripped.
    const out = gen.stripImports(code, { collectHoistedImports: true });
    assert.ok(!out.code.includes("from './x.js'"));
  });
});

describe('extractLocalBindingsFromImportStatement', () => {
  const gen = makeGenerator();

  test('default import', () => {
    assert.deepEqual(gen.extractLocalBindingsFromImportStatement("import Foo from 'x';"), ['Foo']);
  });

  test('named imports', () => {
    assert.deepEqual(
      gen.extractLocalBindingsFromImportStatement("import { a, b } from 'x';").sort(),
      ['a', 'b']
    );
  });

  test('aliased named import uses the local name', () => {
    assert.deepEqual(gen.extractLocalBindingsFromImportStatement("import { a as b } from 'x';"), ['b']);
  });

  test('namespace import', () => {
    assert.deepEqual(gen.extractLocalBindingsFromImportStatement("import * as NS from 'x';"), ['NS']);
  });

  test('mixed default + named', () => {
    assert.deepEqual(
      gen.extractLocalBindingsFromImportStatement("import Foo, { a, b as c } from 'x';").sort(),
      ['Foo', 'a', 'c']
    );
  });

  test('side-effect import has no bindings', () => {
    assert.deepEqual(gen.extractLocalBindingsFromImportStatement("import 'x';"), []);
  });
});

describe('validateHoistedImportCollisions', () => {
  const gen = makeGenerator();

  test('throws on the same binding from two different statements', () => {
    assert.throws(
      () => gen.validateHoistedImportCollisions([
        "import Foo from '/assets/a.js';",
        "import Foo from '/assets/b.js';",
      ]),
      /binding collision/
    );
  });

  test('does not throw when the identical statement appears twice', () => {
    assert.doesNotThrow(() => gen.validateHoistedImportCollisions([
      "import Foo from '/assets/a.js';",
      "import Foo from '/assets/a.js';",
    ]));
  });

  test('throws when a hoisted binding collides with a reserved identifier', () => {
    assert.throws(
      () => gen.validateHoistedImportCollisions(
        ["import SLICE_BUNDLE_META from '/assets/a.js';"],
        new Set(['SLICE_BUNDLE_META'])
      ),
      /reserved identifier collision/
    );
  });
});

describe('transformDependencyContent', () => {
  const gen = makeGenerator();

  function transformAndEval(content, moduleName = 'shared/util.js') {
    const transformed = gen.transformDependencyContent(content, '__d', moduleName);
    return evalSnippet(`const __d = {};\n${transformed}\nreturn __d;`);
  }

  test('export const / let / var are attached to the exports object', () => {
    const d = transformAndEval('export const A = 1;\nexport let B = 2;\nexport var C = 3;');
    assert.equal(d.A, 1);
    assert.equal(d.B, 2);
    assert.equal(d.C, 3);
  });

  test('export function is attached and callable', () => {
    const d = transformAndEval('export function fn() { return 7; }');
    assert.equal(typeof d.fn, 'function');
    assert.equal(d.fn(), 7);
  });

  test('export default maps to the <basename>Data fallback key', () => {
    const d = transformAndEval('export default 99;', 'shared/util.js');
    assert.equal(d.utilData, 99);
  });

  test('plain export { a, b } re-exports local bindings', () => {
    const d = transformAndEval('const a = 10;\nconst b = 20;\nexport { a, b };');
    assert.equal(d.a, 10);
    assert.equal(d.b, 20);
  });

  test('aliased export { internal as Public } exposes the PUBLIC name', () => {
    // A consumer writes `import { Public } from '...'`, so the exports object
    // must carry `Public`, mapped to the value of `internal`.
    const d = transformAndEval('const internal = 55;\nexport { internal as Public };');
    assert.equal(d.Public, 55, 'exported alias name should be the public key');
  });
});

describe('default export resolver (__sliceResolveDefaultExport)', () => {
  const gen = makeGenerator();
  function buildResolver() {
    const lines = gen.getDefaultExportResolverLines().join('\n');
    return evalSnippet(`${lines}\nreturn __sliceResolveDefaultExport;`);
  }

  test('returns .default when present', () => {
    const resolve = buildResolver();
    assert.equal(resolve({ default: 5, other: 9 }, 'm', null), 5);
  });

  test('returns the single non-default key when only one exists', () => {
    const resolve = buildResolver();
    assert.equal(resolve({ only: 42 }, 'm', null), 42);
  });

  test('honours the preferred key', () => {
    const resolve = buildResolver();
    assert.equal(resolve({ a: 1, utilData: 2 }, 'm', 'utilData'), 2);
  });

  test('primitive dependency is returned as-is', () => {
    const resolve = buildResolver();
    assert.equal(resolve(7, 'm', null), 7);
  });
});

describe('toSafeIdentifier', () => {
  const gen = makeGenerator();

  test('produces a valid JS identifier', () => {
    const id = gen.toSafeIdentifier('My-Component');
    assert.doesNotThrow(() => parse(`const ${id} = 1;`));
  });

  test('distinct component names must not collide to the same identifier', () => {
    // Two registered components differing only by a non-alphanumeric char would
    // otherwise emit two `const <id>` declarations -> duplicate-decl syntax error.
    assert.notEqual(
      gen.toSafeIdentifier('my-btn'),
      gen.toSafeIdentifier('my_btn'),
      'distinct names collapse to the same bundle identifier'
    );
  });
});
