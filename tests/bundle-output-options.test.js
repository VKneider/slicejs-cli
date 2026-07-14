import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

// Source maps (--sourcemap) and content-hashed filenames (--hash-filenames) are
// exercised through the central bundle writer, emitBundleArtifact, with an
// isolated temp bundlesPath so no project fixture is needed.
async function withGen(options, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-emit-'));
  try {
    const gen = new BundleGenerator(import.meta.url, null, options);
    gen.bundlesPath = tmp;
    await fn(gen, tmp);
  } finally {
    await fs.remove(tmp);
  }
}

const CONTENT = 'export const SLICE_BUNDLE_META = { a: 1 };\nexport async function registerAll(){ return SLICE_BUNDLE_META; }\n';

describe('bundle output options (sourcemap + hash filenames)', () => {
  test('default: stable name, no .map, no sourceMappingURL comment', async () => {
    await withGen({ minify: true, obfuscate: true }, async (gen, tmp) => {
      const r = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      assert.equal(r.file, 'slice-bundle.home.js');
      const code = await fs.readFile(path.join(tmp, r.file), 'utf8');
      assert.doesNotMatch(code, /sourceMappingURL/);
      assert.equal(await fs.pathExists(path.join(tmp, 'slice-bundle.home.js.map')), false);
    });
  });

  test('--sourcemap: writes a .map and appends the sourceMappingURL', async () => {
    await withGen({ minify: true, sourcemap: true }, async (gen, tmp) => {
      const r = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      const code = await fs.readFile(path.join(tmp, r.file), 'utf8');
      assert.match(code, /\/\/# sourceMappingURL=slice-bundle\.home\.js\.map/);
      const mapPath = path.join(tmp, 'slice-bundle.home.js.map');
      assert.ok(await fs.pathExists(mapPath));
      const map = JSON.parse(await fs.readFile(mapPath, 'utf8'));
      assert.equal(map.version, 3);
      // includeSources embeds the readable pre-minified bundle in the map.
      assert.ok((map.sourcesContent || []).join('').includes('SLICE_BUNDLE_META'));
    });
  });

  test('--hash-filenames: content hash in the emitted name (+ matching .map name)', async () => {
    await withGen({ minify: true, sourcemap: true, hashFilenames: true }, async (gen, tmp) => {
      const r = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      assert.match(r.file, /^slice-bundle\.home\.[0-9a-f]{8}\.js$/);
      assert.ok(await fs.pathExists(path.join(tmp, r.file)));
      const code = await fs.readFile(path.join(tmp, r.file), 'utf8');
      assert.match(code, new RegExp(`sourceMappingURL=${r.file.replace(/\./g, '\\.')}\\.map`));
      assert.ok(await fs.pathExists(path.join(tmp, `${r.file}.map`)));
    });
  });

  test('hash is stable for identical content and changes with content', async () => {
    await withGen({ minify: true, hashFilenames: true }, async (gen) => {
      const a = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      const b = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      const c = await gen.emitBundleArtifact('slice-bundle.home.js', `${CONTENT}export const z = 2;\n`);
      assert.equal(a.file, b.file);
      assert.notEqual(a.file, c.file);
    });
  });

  test('hashing off by default keeps the plain filename', async () => {
    await withGen({ minify: true }, async (gen) => {
      const r = await gen.emitBundleArtifact('slice-bundle.home.js', CONTENT);
      assert.equal(r.file, 'slice-bundle.home.js');
    });
  });
});
