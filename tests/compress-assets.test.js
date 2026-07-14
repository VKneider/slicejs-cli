import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { precompressDirectory, isCompressibleFile, COMPRESSIBLE_EXTENSIONS } from '../commands/utils/compressAssets.js';

async function withDir(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-compress-'));
  try {
    await fn(tmp);
  } finally {
    await fs.remove(tmp);
  }
}

// A payload large enough to clear the min-size threshold and compress well.
const BIG_JS = `export const data = ${JSON.stringify('x'.repeat(4000))};\n`;

describe('precompressDirectory', () => {
  test('writes .gz and .br for a compressible file, both round-trip', async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, 'bundle.js');
      await fs.writeFile(file, BIG_JS);

      const stats = await precompressDirectory(dir);
      assert.equal(stats.files, 1);

      const gz = await fs.readFile(`${file}.gz`);
      const br = await fs.readFile(`${file}.br`);
      assert.equal(zlib.gunzipSync(gz).toString(), BIG_JS);
      assert.equal(zlib.brotliDecompressSync(br).toString(), BIG_JS);
      // Both must actually be smaller than the original.
      assert.ok(gz.length < Buffer.byteLength(BIG_JS));
      assert.ok(br.length < Buffer.byteLength(BIG_JS));
      // Brotli max-quality should beat gzip on this text.
      assert.ok(br.length <= gz.length);
    });
  });

  test('skips files below the min size', async () => {
    await withDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'tiny.js'), 'export const a = 1;');
      const stats = await precompressDirectory(dir, { minSize: 1024 });
      assert.equal(stats.files, 0);
      assert.equal(await fs.pathExists(path.join(dir, 'tiny.js.br')), false);
    });
  });

  test('skips non-compressible (binary) extensions', async () => {
    await withDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'image.png'), Buffer.alloc(5000, 7));
      const stats = await precompressDirectory(dir);
      assert.equal(stats.files, 0);
      assert.equal(await fs.pathExists(path.join(dir, 'image.png.br')), false);
    });
  });

  test('does not recompress existing .gz/.br artifacts on a second run', async () => {
    await withDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.css'), `.x{content:'${'y'.repeat(4000)}'}`);
      const first = await precompressDirectory(dir);
      assert.equal(first.files, 1);
      // Second run sees a.css again (recompresses it) but NOT a.css.br/.gz.
      const second = await precompressDirectory(dir);
      assert.equal(second.files, 1, 'only the original is recompressed, not the artifacts');
      assert.equal(await fs.pathExists(path.join(dir, 'a.css.br.br')), false);
      assert.equal(await fs.pathExists(path.join(dir, 'a.css.gz.gz')), false);
    });
  });

  test('recurses into subdirectories', async () => {
    await withDir(async (dir) => {
      await fs.ensureDir(path.join(dir, 'bundles'));
      await fs.writeFile(path.join(dir, 'bundles', 'x.js'), BIG_JS);
      const stats = await precompressDirectory(dir);
      assert.equal(stats.files, 1);
      assert.ok(await fs.pathExists(path.join(dir, 'bundles', 'x.js.br')));
    });
  });

  test('isCompressibleFile matches the documented extension set', () => {
    assert.ok(isCompressibleFile('a.js'));
    assert.ok(isCompressibleFile('a.CSS'));
    assert.ok(isCompressibleFile('a.svg'));
    assert.ok(!isCompressibleFile('a.png'));
    assert.ok(!isCompressibleFile('a.woff2'));
    assert.ok(COMPRESSIBLE_EXTENSIONS.has('.json'));
  });

  test('returns zeroed stats for a missing directory', async () => {
    const stats = await precompressDirectory('/no/such/dir/slice-xyz');
    assert.deepEqual(stats, { files: 0, originalBytes: 0, gzipBytes: 0, brotliBytes: 0 });
  });
});
