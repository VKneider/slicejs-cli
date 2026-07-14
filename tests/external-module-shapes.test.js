import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ExternalModuleBundler, { nodeGlobalsBanner } from '../commands/utils/bundling/ExternalModuleBundler.js';

// Definitive coverage for every module SHAPE the external-dependency bundler is
// expected to handle: ESM, CommonJS, UMD, package.json `exports` maps (with
// conditions), the legacy `browser` field, scoped packages, subpath specifiers,
// transitive third-party graphs, and side-effect-only imports.
//
// Fixtures are synthesized into a throwaway node_modules so the test is
// deterministic and does not depend on which real packages happen to be
// installed. Resolution + interop are esbuild's job; these tests pin that the
// wrapper drives it correctly and that the emitted module namespace matches the
// runtime binding contract (named keys + a `default` when requested).

function evalModuleExpression(expression) {
  return new Function('window', 'document', 'globalThis', 'process', `return (${expression});`)(
    {}, { createElement: () => ({ set innerHTML(_v) {} }) }, globalThis, process
  );
}

// A document stub that records injected <style> elements and supports the
// querySelector the injection guard uses to de-duplicate.
function makeStyleCapturingDocument() {
  const appended = [];
  return {
    appended,
    createElement: () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = v; } }),
    querySelector: (sel) => {
      const m = /data-slice-external="([^"]+)"/.exec(sel);
      if (!m) return null;
      return appended.find((el) => el._attrs['data-slice-external'] === m[1]) || null;
    },
    head: { appendChild: (el) => appended.push(el) }
  };
}

// Eval variant with a style-capturing document, so CSS injection can be asserted.
function evalWithStyleCapture(expression, documentStub) {
  const doc = documentStub || makeStyleCapturingDocument();
  const mod = new Function('window', 'document', 'globalThis', 'process', `return (${expression});`)(
    {}, doc, globalThis, process
  );
  return { mod, styles: doc.appended.map((el) => el.textContent), document: doc };
}

/**
 * @param {Record<string, Record<string, string|object>>} pkgs
 *   name -> (relativeFilePath -> contents; objects are JSON-stringified)
 */
async function withPackages(pkgs, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-shapes-'));
  try {
    for (const [name, files] of Object.entries(pkgs)) {
      for (const [rel, contents] of Object.entries(files)) {
        const filePath = path.join(tmp, 'node_modules', name, rel);
        await fs.ensureDir(path.dirname(filePath));
        const data = Buffer.isBuffer(contents)
          ? contents
          : (typeof contents === 'string' ? contents : JSON.stringify(contents));
        await fs.writeFile(filePath, data);
      }
    }
    const bundler = new ExternalModuleBundler({ resolveDir: tmp });
    await fn(bundler);
  } finally {
    await fs.remove(tmp);
  }
}

async function bundleAndEval(bundler, spec, usage) {
  const { expression } = await bundler.bundle(spec, usage);
  return evalModuleExpression(expression);
}

describe('external module shapes', () => {
  test('ESM with a default export', async () => {
    await withPackages({
      'esm-default': {
        'package.json': { name: 'esm-default', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': 'export default function greet(n){ return "hi " + n; }'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'esm-default', { needsDefault: true });
      assert.equal(typeof mod.default, 'function');
      assert.equal(mod.default('x'), 'hi x');
    });
  });

  test('ESM with named exports and no default', async () => {
    await withPackages({
      'esm-named': {
        'package.json': { name: 'esm-named', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'esm-named', { needsDefault: false });
      assert.equal(mod.add(2, 3), 5);
      assert.equal(mod.mul(2, 3), 6);
      assert.equal(mod.default, undefined);
    });
  });

  test('CommonJS with module.exports = fn (interop default)', async () => {
    await withPackages({
      'cjs-default': {
        'package.json': { name: 'cjs-default', version: '1.0.0', main: 'index.js' },
        'index.js': 'module.exports = function shout(s){ return String(s).toUpperCase(); };'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'cjs-default', { needsDefault: true });
      assert.equal(typeof mod.default, 'function');
      assert.equal(mod.default('hi'), 'HI');
    });
  });

  test('CommonJS with exports.x named members', async () => {
    await withPackages({
      'cjs-named': {
        'package.json': { name: 'cjs-named', version: '1.0.0', main: 'index.js' },
        'index.js': 'exports.a = 1;\nexports.b = function(){ return 2; };'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'cjs-named', { needsDefault: false });
      // esbuild exposes CJS named members off the interop default.
      const ns = mod.default || mod;
      assert.equal(ns.a, 1);
      assert.equal(ns.b(), 2);
    });
  });

  test('UMD package (module.exports / global factory)', async () => {
    await withPackages({
      'umd-lib': {
        'package.json': { name: 'umd-lib', version: '1.0.0', main: 'umd.js' },
        'umd.js': [
          '(function (root, factory) {',
          '  if (typeof module === "object" && module.exports) { module.exports = factory(); }',
          '  else { root.UmdLib = factory(); }',
          '}(typeof self !== "undefined" ? self : this, function () {',
          '  return { hello: function(){ return "umd-ok"; } };',
          '}));'
        ].join('\n')
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'umd-lib', { needsDefault: true });
      const lib = mod.default || mod;
      assert.equal(lib.hello(), 'umd-ok');
    });
  });

  test('package.json "exports" conditional map resolves the browser/import condition', async () => {
    await withPackages({
      'cond-exports': {
        'package.json': {
          name: 'cond-exports', version: '1.0.0',
          exports: {
            '.': {
              browser: './browser.js',
              import: './esm.js',
              require: './cjs.cjs',
              default: './esm.js'
            }
          }
        },
        'browser.js': 'export const from = "browser";',
        'esm.js': 'export const from = "esm";',
        'cjs.cjs': 'exports.from = "cjs";'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'cond-exports', { needsDefault: false });
      // platform:'browser' → esbuild must pick the "browser" condition.
      assert.equal(mod.from, 'browser');
    });
  });

  test('legacy "browser" field remaps the entry', async () => {
    await withPackages({
      'browser-field': {
        'package.json': { name: 'browser-field', version: '1.0.0', main: './node.js', browser: './browser.js', type: 'module' },
        'node.js': 'export const env = "node";',
        'browser.js': 'export const env = "browser";'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'browser-field', { needsDefault: false });
      assert.equal(mod.env, 'browser');
    });
  });

  test('scoped package (@scope/name)', async () => {
    await withPackages({
      '@acme/widget': {
        'package.json': { name: '@acme/widget', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': 'export const version = "1.0.0";\nexport default () => "widget";'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, '@acme/widget', { needsDefault: true });
      assert.equal(mod.version, '1.0.0');
      assert.equal(mod.default(), 'widget');
    });
  });

  test('subpath specifier (pkg/feature) via exports map', async () => {
    await withPackages({
      'multi': {
        'package.json': {
          name: 'multi', version: '1.0.0', type: 'module',
          exports: { '.': './index.js', './feature': './feature.js' }
        },
        'index.js': 'export const core = true;',
        'feature.js': 'export const feature = () => "feature-ok";'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'multi/feature', { needsDefault: false });
      assert.equal(mod.feature(), 'feature-ok');
    });
  });

  test('transitive third-party graph is inlined (pkg-a -> pkg-b)', async () => {
    await withPackages({
      'dep-b': {
        'package.json': { name: 'dep-b', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': 'export const shout = (s) => s.toUpperCase();'
      },
      'dep-a': {
        'package.json': { name: 'dep-a', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import { shout } from 'dep-b';\nexport const greet = (n) => shout('hi ' + n);"
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'dep-a', { needsDefault: false });
      assert.equal(mod.greet('slice'), 'HI SLICE');
    });
  });

  test('side-effect-only package runs its effects', async () => {
    const marker = '__slice_shapes_side_effect__';
    delete globalThis[marker];
    await withPackages({
      'polyfillish': {
        'package.json': { name: 'polyfillish', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': `globalThis[${JSON.stringify(marker)}] = true;`
      }
    }, async (b) => {
      await bundleAndEval(b, 'polyfillish', { needsDefault: false });
      assert.equal(globalThis[marker], true, 'side-effect import should execute the module body');
    });
    delete globalThis[marker];
  });

  test('a package importing a .wasm asset inlines it as a data URL', async () => {
    // Valid WASM header bytes (\0asm + version). The dataurl loader base64s the
    // file as-is; content need not be a runnable module for this assertion.
    const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await withPackages({
      'wasm-lib': {
        'package.json': { name: 'wasm-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import wasmUrl from './thing.wasm';\nexport const url = wasmUrl;",
        'thing.wasm': wasmBytes
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'wasm-lib', { needsDefault: false });
      // esbuild may pick base64 or percent-encoding for the data URL — both are
      // valid; verify the mime and that it round-trips to the original bytes.
      assert.match(mod.url, /^data:application\/wasm[;,]/);
      const comma = mod.url.indexOf(',');
      const meta = mod.url.slice(0, comma);
      const payload = mod.url.slice(comma + 1);
      const bytes = meta.endsWith(';base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'latin1');
      assert.deepEqual(bytes, wasmBytes);
    });
  });

  test('a package importing its own CSS injects a <style> at runtime', async () => {
    await withPackages({
      'styled-lib': {
        'package.json': { name: 'styled-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import './styles.css';\nexport const name = 'styled-lib';",
        'styles.css': '.slice-external-probe { color: rgb(1, 2, 3); }'
      }
    }, async (b) => {
      const { expression } = await b.bundle('styled-lib', { needsDefault: false });
      const { mod, styles } = evalWithStyleCapture(expression);
      assert.equal(mod.name, 'styled-lib');
      assert.equal(styles.length, 1, 'exactly one <style> should be injected');
      assert.match(styles[0], /\.slice-external-probe/);
      assert.match(styles[0], /rgb\(1, 2, 3\)/);
    });
  });

  test('CSS injection is idempotent (same CSS injected only once)', async () => {
    await withPackages({
      'styled-lib': {
        'package.json': { name: 'styled-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import './styles.css';\nexport const name = 'styled-lib';",
        'styles.css': '.slice-external-probe { color: rgb(4, 5, 6); }'
      }
    }, async (b) => {
      const { expression } = await b.bundle('styled-lib', { needsDefault: false });
      const doc = makeStyleCapturingDocument();
      // Simulate the same package loading from two different bundles.
      evalWithStyleCapture(expression, doc);
      evalWithStyleCapture(expression, doc);
      assert.equal(doc.appended.length, 1, 'the same CSS must only be injected once');
    });
  });

  test('url() assets inside bundled CSS are inlined as data URLs (self-contained)', async () => {
    const fontBytes = Buffer.from('OTTO-fake-font-bytes');
    await withPackages({
      'font-lib': {
        'package.json': { name: 'font-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import './font.css';\nexport const ok = true;",
        'font.css': "@font-face { font-family: X; src: url('./x.woff2') format('woff2'); }",
        'x.woff2': fontBytes
      }
    }, async (b) => {
      const { expression } = await b.bundle('font-lib', { needsDefault: false });
      const { styles } = evalWithStyleCapture(expression);
      assert.equal(styles.length, 1);
      // The relative url() must have been inlined, not left as a broken path.
      assert.match(styles[0], /data:/);
      assert.doesNotMatch(styles[0], /url\(\.?\/?x\.woff2\)/);
    });
  });

  test('process.env.NODE_ENV and global are substituted (no polyfill needed)', async () => {
    await withPackages({
      'env-lib': {
        'package.json': { name: 'env-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        // Without the browser defines, referencing process/global would throw at
        // module eval; with them, both are substituted at bundle time.
        'index.js': 'export const env = process.env.NODE_ENV;\nexport const hasGlobal = (typeof global === "object");'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'env-lib', { needsDefault: false });
      assert.equal(mod.env, 'production');
      assert.equal(mod.hasGlobal, true);
    });
  });

  test('a package importing a text asset (.glsl) inlines it as a string', async () => {
    await withPackages({
      'shader-lib': {
        'package.json': { name: 'shader-lib', version: '1.0.0', type: 'module', main: 'index.js' },
        'index.js': "import src from './frag.glsl';\nexport const shader = src;",
        'frag.glsl': 'void main() { gl_FragColor = vec4(1.0); }'
      }
    }, async (b) => {
      const mod = await bundleAndEval(b, 'shader-lib', { needsDefault: false });
      assert.match(mod.shader, /gl_FragColor/);
    });
  });

  test('a package requiring Node built-ins is rejected with a clear error', async () => {
    await withPackages({
      'needs-node': {
        'package.json': { name: 'needs-node', version: '1.0.0', main: 'index.js' },
        'index.js': "const os = require('os');\nmodule.exports = () => os.platform();"
      }
    }, async (b) => {
      await assert.rejects(
        () => b.bundle('needs-node', { needsDefault: true }),
        /Could not bundle external dependency "needs-node"/
      );
    });
  });
});

describe('nodeGlobalsBanner (browser Node-global shim)', () => {
  // The banner only activates when `globalThis.process` is absent, which is
  // never true in Node. Run it inside a fresh vm context (no `process`) to
  // exercise the browser path the bundled banner takes in a real browser.
  test('shims process + global when absent', () => {
    const ctx = vm.createContext({});
    vm.runInContext(nodeGlobalsBanner('production'), ctx);
    assert.equal(typeof ctx.process, 'object');
    assert.equal(ctx.process.env.NODE_ENV, 'production');
    assert.equal(ctx.process.platform, 'browser');
    assert.equal(ctx.process.browser, true);
    assert.equal(typeof ctx.process.nextTick, 'function');
    // `global` is aliased to the context's own global object.
    assert.equal(vm.runInContext('global === globalThis', ctx), true);
  });

  test('carries the requested NODE_ENV (development)', () => {
    const ctx = vm.createContext({});
    vm.runInContext(nodeGlobalsBanner('development'), ctx);
    assert.equal(ctx.process.env.NODE_ENV, 'development');
  });

  test('never clobbers a pre-existing process', () => {
    const ctx = vm.createContext({ process: { env: { NODE_ENV: 'test', CUSTOM: '1' } } });
    vm.runInContext(nodeGlobalsBanner('production'), ctx);
    // A real process is left untouched (env preserved, not overwritten).
    assert.equal(ctx.process.env.NODE_ENV, 'test');
    assert.equal(ctx.process.env.CUSTOM, '1');
  });

  test('is idempotent (safe to prepend to every bundled package)', () => {
    const ctx = vm.createContext({});
    vm.runInContext(nodeGlobalsBanner('production'), ctx);
    ctx.process.env.MARKER = 'kept';
    vm.runInContext(nodeGlobalsBanner('production'), ctx);
    // Second run must not reset the already-created process.env.
    assert.equal(ctx.process.env.MARKER, 'kept');
  });
});
