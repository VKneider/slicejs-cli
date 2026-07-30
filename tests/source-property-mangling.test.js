// Source files must not mangle property names.
//
// af946f8 turned property mangling off for bundles, because Terser renames a
// property access but cannot see inside a string literal — a library doing
// `obj['_rep']` broke. That commit only touched BundleGenerator, so source files
// kept mangling `/^_/` while bundles did not. Both generators write into the
// same dist/, so one method ended up with two names: `_loadNotes` stayed itself
// inside dist/bundles/*.js and became `ki` in
// dist/Components/**/ConsensoService.js. A component loaded from its individual
// file then could not call one loaded from a bundle.
//
// A shared nameCache would only have made the individual files agree with each
// other, never with the bundles, since the bundler mangles no properties at all.
// Turning it off in both places is what actually closes the gap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import buildProduction from '../commands/buildProduction/buildProduction.js';
import { minifyJs, sourceFileOptions, bundleOptions } from '../commands/utils/JsMinifier.js';

// The real shape from Conclave: one file defines `_loadNotes`, two others call
// it on an object they obtained elsewhere.
const DEFINER = [
  'export default class ConsensoService {',
  '  _loadNotes() { return localStorage.getItem("notes"); }',
  '  _alpha() { return 1; }',
  '  _beta() { return 2; }',
  '}'
].join('\n');

const CALLER_A = [
  'export default class ExportService {',
  '  run(consenso) { return consenso._loadNotes(); }',
  '  _one() { return 1; }',
  '}'
].join('\n');

const CALLER_B = [
  'export default class ShareConsensoModal {',
  '  _x() {} _y() {} _z() {} _w() {}',
  '  send(cs) { return cs._loadNotes(); }',
  '}'
].join('\n');

describe('property mangling is off everywhere', () => {
  test('the source-file profile does not mangle properties', () => {
    assert.equal(sourceFileOptions().mangle.properties, false);
  });

  test('it matches the bundle profile, which has been off since af946f8', () => {
    assert.equal(bundleOptions({ minify: true }).mangle, false);
    assert.equal(bundleOptions({ minify: true, obfuscate: true }).mangle.properties, false);
  });

  test('a private name survives minification in every file', async () => {
    for (const [label, source] of [['definer', DEFINER], ['callerA', CALLER_A], ['callerB', CALLER_B]]) {
      const { code } = await minifyJs(source, sourceFileOptions);
      assert.match(code, /_loadNotes/, `${label} must keep the property name`);
    }
  });

  test('variable and function names are still mangled', async () => {
    // Only *properties* are exempt — the rest of minification is unchanged.
    const { code } = await minifyJs(
      'const aVeryLongLocalName = 1;\nexport function use() { return aVeryLongLocalName; }',
      sourceFileOptions
    );
    assert.doesNotMatch(code, /aVeryLongLocalName/, 'locals should still be shortened');
  });
});

describe('a real build keeps both artifacts in agreement', () => {
  async function writeSrc(root, rel, content) {
    const p = path.join(root, 'src', rel);
    await fs.ensureDir(path.dirname(p));
    await fs.writeFile(p, content, 'utf8');
  }

  test('a cross-file private call resolves after minification', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/definer.js', DEFINER);
      await writeSrc(root, 'App/callerA.js', CALLER_A);
      await writeSrc(root, 'App/callerB.js', CALLER_B);

      assert.equal(await buildProduction({ minify: true }), true);

      const read = (rel) => fs.readFile(path.join(root, 'dist', rel), 'utf8');
      for (const rel of ['App/definer.js', 'App/callerA.js', 'App/callerB.js']) {
        assert.match(await read(rel), /_loadNotes/, `${rel} must name the method identically`);
      }
    });
  });

  test('two builds of the same source produce identical output', async () => {
    // The file walk is sorted, so a rebuild cannot drift with the filesystem.
    await withTestProject(async (root) => {
      await writeSrc(root, 'App/definer.js', DEFINER);
      await writeSrc(root, 'App/zz-caller.js', CALLER_A);

      await buildProduction({ minify: true });
      const first = await fs.readFile(path.join(root, 'dist', 'App', 'definer.js'), 'utf8');

      await buildProduction({ minify: true });
      const second = await fs.readFile(path.join(root, 'dist', 'App', 'definer.js'), 'utf8');

      assert.equal(second, first, 'a rebuild must be byte-identical');
    });
  });
});
