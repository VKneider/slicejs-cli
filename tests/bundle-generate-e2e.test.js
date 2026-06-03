import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import DependencyAnalyzer from '../commands/utils/bundling/DependencyAnalyzer.js';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

const MODULE_URL = import.meta.url;

function parsesAsModule(code) {
  parse(code, { sourceType: 'module', plugins: ['jsx'] });
}

describe('bundle generation end-to-end (real starter project)', () => {
  test('generate() emits parseable v2 bundles that honour the runtime contract', async () => {
    await withTestProject(async (projectRoot) => {
      const analyzer = new DependencyAnalyzer(MODULE_URL);
      const analysisData = await analyzer.analyze();

      const generator = new BundleGenerator(MODULE_URL, analysisData, {
        minify: false,
        obfuscate: false,
        output: 'src',
      });
      const result = await generator.generate();

      assert.ok(result.files.length > 0, 'at least one bundle file should be produced');

      const bundlesDir = path.join(projectRoot, 'src', 'bundles');
      const written = (await fs.readdir(bundlesDir)).filter(
        (f) => f.startsWith('slice-bundle.') && f.endsWith('.js')
      );
      assert.ok(written.length > 0, 'bundle files should be on disk');

      for (const file of written) {
        const code = await fs.readFile(path.join(bundlesDir, file), 'utf8');
        // Oracle #1: the emitted bundle must be syntactically valid ES module JS.
        assert.doesNotThrow(() => parsesAsModule(code), `bundle ${file} is not valid JS`);
        // Oracle #2: every v2 bundle must export the runtime contract symbols.
        assert.match(code, /export const SLICE_BUNDLE_META\b/, `${file} missing SLICE_BUNDLE_META`);
        assert.match(code, /export async function registerAll\b/, `${file} missing registerAll`);
      }
    });
  });

  test('generateBundleConfig produces a well-formed v2 config', async () => {
    await withTestProject(async () => {
      const analyzer = new DependencyAnalyzer(MODULE_URL);
      const analysisData = await analyzer.analyze();
      const generator = new BundleGenerator(MODULE_URL, analysisData, { output: 'src' });
      const result = await generator.generate();

      const cfg = result.config;
      assert.equal(cfg.production, true);
      assert.equal(cfg.format, 'v2');
      assert.ok(cfg.stats, 'config carries stats');
      assert.equal(typeof cfg.generated, 'string');
    });
  });
});

describe('generateBundleFileContent — controlled inputs', () => {
  function makeGenerator() {
    const gen = new BundleGenerator(MODULE_URL, null, {});
    gen.sliceConfig = {};
    return gen;
  }

  function component(name, extra = {}) {
    return {
      name,
      category: 'Visual',
      categoryType: 'Visual',
      js: 'const C = class {};\nreturn C;',
      hoistedImports: [],
      html: '<div></div>',
      css: '.x{}',
      externalDependencies: {},
      size: 100,
      ...extra,
    };
  }

  test('single component bundle is valid JS', () => {
    const gen = makeGenerator();
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [component('Button')]);
    assert.doesNotThrow(() => parsesAsModule(code));
  });

  test('two component names that differ only by a non-word char must not break the bundle', () => {
    // my-btn and my_btn both sanitize to SliceComponent_my_btn -> two `const`
    // declarations with the same name -> SyntaxError in the emitted bundle.
    const gen = makeGenerator();
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [
      component('my-btn'),
      component('my_btn'),
    ]);
    assert.doesNotThrow(
      () => parsesAsModule(code),
      'distinct component names collided into a duplicate identifier'
    );
  });

  test('hoisted public imports appear at the top of the bundle', () => {
    const gen = makeGenerator();
    const comp = component('Button', {
      hoistedImports: ["import lib from '/assets/lib.js';"],
    });
    const code = gen.generateBundleFileContent('slice-bundle.critical.js', 'critical', [comp]);
    assert.match(code, /^import lib from '\/assets\/lib\.js';/);
    assert.doesNotThrow(() => parsesAsModule(code));
  });
});
