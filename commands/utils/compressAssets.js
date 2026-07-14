// commands/utils/compressAssets.js
//
// Precompresses text assets in a built `dist/` tree to `.gz` (gzip) and `.br`
// (brotli) siblings, so a static server can serve the already-compressed file
// directly (with Content-Encoding) instead of compressing on every request.
// Brotli is run at maximum quality — that only makes sense offline, which is
// exactly what a build step is.
//
// Uses Node's built-in `zlib` only — no external dependency (team rule: no new
// deps without confirmation, and none is needed here).

import fs from 'fs-extra';
import path from 'path';
import zlib from 'node:zlib';

// Text-ish assets that compress well and are safe to serve pre-encoded. Binary
// assets already compressed (png/jpg/woff2/…) are intentionally excluded.
export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.htm',
  '.json', '.svg', '.xml', '.txt', '.map', '.webmanifest'
]);

// Files below this size don't benefit — the encoding overhead and the extra
// request negotiation aren't worth it, so the server should serve the original.
const DEFAULT_MIN_SIZE = 1024;

export function isCompressibleFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return COMPRESSIBLE_EXTENSIONS.has(ext);
}

/** Deterministic max-level gzip of a buffer. */
export function gzipBuffer(buffer) {
  return zlib.gzipSync(buffer, { level: zlib.constants.Z_BEST_COMPRESSION });
}

/** Deterministic max-quality brotli of a buffer (size hint aids the encoder). */
export function brotliBuffer(buffer) {
  return zlib.brotliCompressSync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
    }
  });
}

async function* walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Walks `dir` and writes a `.gz` and `.br` next to every compressible file over
 * `minSize`. Already-compressed siblings (`.gz`/`.br`) are skipped so re-runs
 * don't recurse. Best-effort per file: a failure on one file is logged and
 * skipped, not fatal.
 * @param {string} dir directory to precompress (e.g. the dist root)
 * @param {object} [options]
 * @param {number} [options.minSize] minimum original size to compress (bytes)
 * @returns {Promise<{ files: number, originalBytes: number, gzipBytes: number, brotliBytes: number }>}
 */
export async function precompressDirectory(dir, options = {}) {
  const minSize = typeof options.minSize === 'number' ? options.minSize : DEFAULT_MIN_SIZE;
  const stats = { files: 0, originalBytes: 0, gzipBytes: 0, brotliBytes: 0 };

  if (!await fs.pathExists(dir)) {
    return stats;
  }

  for await (const filePath of walkFiles(dir)) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.gz' || ext === '.br') continue; // never recompress an artifact
    if (!COMPRESSIBLE_EXTENSIONS.has(ext)) continue;

    try {
      const buffer = await fs.readFile(filePath);
      if (buffer.length < minSize) continue;

      const gz = gzipBuffer(buffer);
      const br = brotliBuffer(buffer);
      await fs.writeFile(`${filePath}.gz`, gz);
      await fs.writeFile(`${filePath}.br`, br);

      stats.files += 1;
      stats.originalBytes += buffer.length;
      stats.gzipBytes += gz.length;
      stats.brotliBytes += br.length;
    } catch (error) {
      console.warn(`Warning: could not precompress ${filePath}: ${error.message}`);
    }
  }

  return stats;
}

export default precompressDirectory;
