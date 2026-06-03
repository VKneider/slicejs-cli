import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import build from '../commands/build/build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_SLICE_JS = path.resolve(
  __dirname,
  '../node_modules/slicejs-web-framework/Slice/Slice.js'
);

const CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Minimal static server that mirrors the production serving contract the
// framework's api/index.js implements (index/SPA fallback, /slice-env.json,
// /Slice/Slice.js from the framework package, and dist static files), without
// pulling in express. Enough to assert that a production build is servable.
function startServer(distDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

      if (pathname === '/slice-env.json') {
        res.setHeader('Content-Type', CONTENT_TYPES['.json']);
        res.end(JSON.stringify({ mode: 'production', env: {} }));
        return;
      }
      if (pathname === '/Slice/Slice.js') {
        const body = await fs.readFile(FRAMEWORK_SLICE_JS).catch(() => null);
        if (!body) { res.statusCode = 404; res.end('Slice.js not found'); return; }
        res.setHeader('Content-Type', CONTENT_TYPES['.js']);
        res.end(body);
        return;
      }

      const filePath = path.join(distDir, pathname);
      if (!filePath.startsWith(distDir)) { res.statusCode = 403; res.end('forbidden'); return; }

      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.isFile()) {
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
        res.end(await fs.readFile(filePath));
        return;
      }

      // SPA fallback -> App/index.html
      const index = await fs.readFile(path.join(distDir, 'App', 'index.html')).catch(() => null);
      if (index) { res.setHeader('Content-Type', CONTENT_TYPES['.html']); res.end(index); return; }
      res.statusCode = 404;
      res.end('not found');
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('end-to-end: production build is correctly servable', () => {
  test('build() output serves the app shell, framework runtime and valid bundles', async () => {
    await withTestProject(async (root) => {
      const ok = await build({ minify: false, obfuscate: false });
      assert.equal(ok, true, 'build should succeed');

      const distDir = path.join(root, 'dist');
      const { server, port } = await startServer(distDir);
      const base = `http://127.0.0.1:${port}`;

      try {
        // 1. The HTML shell is served and mounts the app + entry module.
        const indexRes = await fetch(`${base}/`);
        assert.equal(indexRes.status, 200);
        const indexHtml = await indexRes.text();
        assert.match(indexHtml, /id="app"/);
        assert.match(indexHtml, /\/App\/index\.js/);

        // 2. The entry module loads and bootstraps the framework runtime.
        const entryRes = await fetch(`${base}/App/index.js`);
        assert.equal(entryRes.status, 200);
        assert.match(entryRes.headers.get('content-type') || '', /javascript/);
        assert.match(await entryRes.text(), /\/Slice\/Slice\.js/);

        // 3. The framework runtime itself is reachable.
        const sliceRes = await fetch(`${base}/Slice/Slice.js`);
        assert.equal(sliceRes.status, 200);

        // 4. Config + runtime mode endpoints.
        const cfgRes = await fetch(`${base}/sliceConfig.json`);
        assert.equal(cfgRes.status, 200);
        const cfg = await cfgRes.json();
        assert.ok(cfg.paths?.components, 'sliceConfig exposes component paths');

        const envRes = await fetch(`${base}/slice-env.json`);
        assert.equal((await envRes.json()).mode, 'production');

        // 5. The bundle manifest is served and well-formed.
        const manifestRes = await fetch(`${base}/bundles/bundle.config.json`);
        assert.equal(manifestRes.status, 200);
        const manifest = await manifestRes.json();
        assert.equal(manifest.production, true);
        assert.equal(manifest.format, 'v2');

        // 6. Every emitted bundle is served as JS and is syntactically valid.
        const bundlesDir = path.join(distDir, 'bundles');
        const bundleFiles = (await fs.readdir(bundlesDir)).filter(
          (f) => f.startsWith('slice-bundle.') && f.endsWith('.js')
        );
        assert.ok(bundleFiles.length > 0, 'at least one bundle is produced');
        for (const file of bundleFiles) {
          const res = await fetch(`${base}/bundles/${file}`);
          assert.equal(res.status, 200, `${file} should be served`);
          assert.match(res.headers.get('content-type') || '', /javascript/);
          const code = await res.text();
          assert.doesNotThrow(
            () => parse(code, { sourceType: 'module', plugins: ['jsx'] }),
            `${file} is not valid JS`
          );
        }

        // 7. Unknown client routes fall back to the SPA shell.
        const spaRes = await fetch(`${base}/some/client/route`);
        assert.equal(spaRes.status, 200);
        assert.match(await spaRes.text(), /id="app"/);
      } finally {
        await closeServer(server);
      }
    });
  });
});
