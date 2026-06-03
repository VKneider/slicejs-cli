import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import buildProduction from '../commands/buildProduction/buildProduction.js';

const MODULE_URL = import.meta.url;

async function writeSrc(root, rel, content) {
  const p = path.join(root, 'src', rel);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
  return p;
}

describe('buildProduction end-to-end', () => {
  test('produces a dist/ that preserves the Slice.js critical files', async () => {
    await withTestProject(async (root) => {
      const ok = await buildProduction({ minify: false });
      assert.equal(ok, true, 'build should succeed on the starter project');

      const dist = path.join(root, 'dist');
      assert.ok(await fs.pathExists(path.join(dist, 'sliceConfig.json')));
      assert.ok(await fs.pathExists(path.join(dist, 'Components', 'components.js')));
      assert.ok(await fs.pathExists(path.join(dist, 'App', 'index.js')));
    });
  });

  test('sliceConfig.json is copied verbatim (never minified)', async () => {
    await withTestProject(async (root) => {
      await buildProduction({ minify: true });
      const srcCfg = await fs.readFile(path.join(root, 'src', 'sliceConfig.json'), 'utf8');
      const distCfg = await fs.readFile(path.join(root, 'dist', 'sliceConfig.json'), 'utf8');
      assert.equal(distCfg, srcCfg);
    });
  });

  test('components.js keeps its registry structure after minification', async () => {
    await withTestProject(async (root) => {
      await buildProduction({ minify: true });
      const built = await fs.readFile(path.join(root, 'dist', 'Components', 'components.js'), 'utf8');
      assert.match(built, /const components/);
      assert.match(built, /export default/);
      assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
    });
  });

  test('--no-minify copies JS byte-for-byte', async () => {
    await withTestProject(async (root) => {
      const original = 'export function probe() {\n  return 1 + 1;\n}\n';
      await writeSrc(root, 'App/probe.js', original);
      await buildProduction({ minify: false });
      const built = await fs.readFile(path.join(root, 'dist', 'App', 'probe.js'), 'utf8');
      assert.equal(built, original);
    });
  });

  test('minification preserves reserved Slice identifiers', async () => {
    await withTestProject(async (root) => {
      await writeSrc(
        root,
        'App/probe.js',
        `export function probe() {\n` +
          `  const aVeryLongLocalNameThatShouldBeMangled = slice.build('Foo');\n` +
          `  return aVeryLongLocalNameThatShouldBeMangled;\n` +
          `}\nclass Controller {}\n`
      );
      await buildProduction({ minify: true });
      const built = await fs.readFile(path.join(root, 'dist', 'App', 'probe.js'), 'utf8');
      assert.match(built, /slice\.build/, 'reserved global "slice" must survive minification');
      assert.match(built, /Controller/, 'reserved class name "Controller" must survive');
      assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
    });
  });

  test('CSS is minified (whitespace collapsed)', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'Styles/probe.css', '.a {\n   color:  red;\n   margin: 0;\n}\n');
      await buildProduction({ minify: true });
      const built = await fs.readFile(path.join(root, 'dist', 'Styles', 'probe.css'), 'utf8');
      assert.ok(built.length < 30, `expected minified css, got: ${JSON.stringify(built)}`);
      assert.match(built, /\.a\{/);
    });
  });

  test('HTML minification preserves slice-* attributes', async () => {
    await withTestProject(async (root) => {
      await writeSrc(
        root,
        'App/probe.html',
        '<!DOCTYPE html>\n<html>\n  <body>\n    <div   slice-id="my-component"  >hi</div>\n  </body>\n</html>\n'
      );
      await buildProduction({ minify: true });
      const built = await fs.readFile(path.join(root, 'dist', 'App', 'probe.html'), 'utf8');
      assert.match(built, /slice-id="my-component"/, 'slice-* attribute must be preserved');
    });
  });

  describe('clean / skip-clean semantics', () => {
    test('a stale dist file is removed by default', async () => {
      await withTestProject(async (root) => {
        const stale = path.join(root, 'dist', 'STALE_ARTIFACT.txt');
        await fs.ensureDir(path.dirname(stale));
        await fs.writeFile(stale, 'old');
        await buildProduction({ minify: false });
        assert.equal(await fs.pathExists(stale), false, 'stale dist file should be cleaned');
      });
    });

    test('--skip-clean keeps a stale dist file', async () => {
      await withTestProject(async (root) => {
        const stale = path.join(root, 'dist', 'STALE_ARTIFACT.txt');
        await fs.ensureDir(path.dirname(stale));
        await fs.writeFile(stale, 'old');
        await buildProduction({ minify: false, skipClean: true });
        assert.equal(await fs.pathExists(stale), true, 'stale dist file should survive --skip-clean');
      });
    });
  });

  test('build fails (returns false) when a critical file is missing', async () => {
    await withTestProject(async (root) => {
      await fs.remove(path.join(root, 'src', 'App', 'index.js'));
      const ok = await buildProduction({ minify: false });
      assert.equal(ok, false, 'missing App/index.js must abort the build');
    });
  });

  test('bundle.config inside a bundles/ folder is renamed to bundle.build.config', async () => {
    await withTestProject(async (root) => {
      await writeSrc(root, 'bundles/bundle.config.json', '{"production":true}');
      await buildProduction({ minify: false });
      const dist = path.join(root, 'dist', 'bundles');
      assert.equal(await fs.pathExists(path.join(dist, 'bundle.build.config.json')), true);
      assert.equal(await fs.pathExists(path.join(dist, 'bundle.config.json')), false);
    });
  });
});
