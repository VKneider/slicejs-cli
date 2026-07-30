// Guards the shared Terser configuration.
//
// Terser used to be configured by hand in three places, and they drifted: only
// one set `parse.ecma`, none set `module`, and the missing `module` flag made
// Terser parse sources in script mode — breaking top-level `await` on every
// build. These tests fail if a profile stops sharing the invariants, or if any
// module outside the wrapper imports terser directly and starts its own
// dialect.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERSER_ECMA,
  RESERVED_NAMES,
  sourceFileOptions,
  componentsRegistryOptions,
  bundleOptions,
  minifyJs
} from '../commands/utils/JsMinifier.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Factories, not objects: Terser mutates whatever it is handed, so each call
// must build its own (see minifyJs).
const PROFILE_FACTORIES = {
  sourceFile: sourceFileOptions,
  componentsRegistry: componentsRegistryOptions,
  bundleMinified: () => bundleOptions({ minify: true }),
  bundleObfuscated: () => bundleOptions({ minify: true, obfuscate: true }),
  bundlePlain: () => bundleOptions()
};

const PROFILES = Object.fromEntries(
  Object.entries(PROFILE_FACTORIES).map(([name, factory]) => [name, factory()])
);

describe('shared Terser configuration', () => {
  test('every profile parses, compresses and formats at the same ECMA level', () => {
    for (const [name, options] of Object.entries(PROFILES)) {
      assert.equal(options.parse?.ecma, TERSER_ECMA, `${name}: parse.ecma`);
      assert.equal(options.ecma, TERSER_ECMA, `${name}: ecma`);
      assert.equal(options.format?.ecma, TERSER_ECMA, `${name}: format.ecma`);
    }
  });

  test('every profile preserves function and class names', () => {
    // Slice resolves components by class name and hooks by function name.
    for (const [name, options] of Object.entries(PROFILES)) {
      assert.equal(options.keep_fnames, true, `${name}: keep_fnames`);
      assert.equal(options.keep_classnames, true, `${name}: keep_classnames`);
    }
  });

  test('every profile strips comments', () => {
    for (const [name, options] of Object.entries(PROFILES)) {
      assert.equal(options.format?.comments, false, `${name}: format.comments`);
    }
  });

  test('only JsMinifier imports terser', async () => {
    const offenders = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        if (full.endsWith(path.join('utils', 'JsMinifier.js'))) continue;
        const content = await fs.readFile(full, 'utf8');
        // A static `from 'terser'` import means that module is configuring
        // Terser on its own again. `await import('terser')` is only an
        // availability probe, so it does not count.
        if (/from\s+['"]terser['"]/.test(content)) {
          offenders.push(path.relative(CLI_ROOT, full));
        }
      }
    };
    await walk(path.join(CLI_ROOT, 'commands'));

    assert.deepEqual(offenders, [], `these modules must minify through JsMinifier: ${offenders.join(', ')}`);
  });

  test('the reserved list covers the names the runtime resolves by string', () => {
    for (const required of ['slice', 'HTMLElement', 'customElements', 'build', 'getComponent', 'sliceId']) {
      assert.ok(RESERVED_NAMES.includes(required), `RESERVED_NAMES must contain ${required}`);
    }
    assert.ok(Object.isFrozen(RESERVED_NAMES), 'RESERVED_NAMES must not be mutable by callers');
  });
});

describe('profile-specific guarantees', () => {
  test('the components registry is never compressed or renamed', () => {
    const options = componentsRegistryOptions();
    assert.equal(options.compress, false);
    assert.equal(options.mangle, false);
  });

  test('source files do not mangle properties either', () => {
    // Matches the bundle profile. The two generators write into the same dist/,
    // so mangling in one and not the other gave a method two names — see
    // tests/source-property-mangling.test.js.
    const options = sourceFileOptions();
    assert.equal(options.mangle.properties, false);
    assert.ok(options.mangle.reserved.includes('slice'));
  });

  test('bundles never mangle properties, and obfuscation stays scope-local', () => {
    assert.equal(bundleOptions({ minify: true }).mangle, false);
    const obfuscated = bundleOptions({ minify: true, obfuscate: true });
    assert.equal(obfuscated.mangle.properties, false);
    // module: true implies toplevel mangling; pinned off so turning module
    // parsing on did not change what obfuscated bundles look like.
    assert.equal(obfuscated.mangle.toplevel, false);
  });

  test('a source map is only requested when asked for', () => {
    assert.equal('sourceMap' in bundleOptions({ minify: true }), false);
    const withMap = bundleOptions({ minify: true, sourcemap: true, fileName: 'slice-bundle.x.js' });
    assert.deepEqual(withMap.sourceMap, { includeSources: true, filename: 'slice-bundle.x.js' });
  });
});

describe('minifyJs module handling', () => {
  test('module-only syntax is parsed by every profile', async () => {
    const code = "import '/Slice/Slice.js';\nawait slice.router.start();";
    for (const [name, factory] of Object.entries(PROFILE_FACTORIES)) {
      const result = await minifyJs(code, factory);
      assert.match(result.code, /await slice\.router\.start\(\)/, `${name} must keep the top-level await`);
    }
  });

  test('sloppy-mode-only sources fall back instead of failing', async () => {
    const code = 'function legacy(o) { with (o) { return value; } }\nwindow.legacy = legacy;';
    const result = await minifyJs(code, sourceFileOptions);
    assert.match(result.code, /with\s*\(/);
  });

  test('a genuine syntax error still throws', async () => {
    await assert.rejects(() => minifyJs('function ( { oops', sourceFileOptions));
  });
});
