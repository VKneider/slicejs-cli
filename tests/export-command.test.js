import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { withTestProject } from './helpers/setup.js';
import exportStatic from '../commands/export/export.js';

async function write(file, content = '') {
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
}

async function createFakeDist(root) {
  const dist = path.join(root, 'dist');
  await write(
    path.join(dist, 'App', 'index.html'),
    '<!doctype html><html><head><title>Shell</title></head><body><script type="module" src="/App/index.js"></script></body></html>'
  );
  await write(path.join(dist, 'App', 'index.js'), 'console.log("app");');
  await write(path.join(dist, 'App', 'style.css'), 'body{}');
  await write(path.join(dist, 'bundles', 'bundle.config.json'), '{"version":2}');
  await write(path.join(dist, 'bundles', 'slice-bundle.home.js'), 'export const x = 1;');
  await write(path.join(dist, 'Components', 'Visual', 'Button', 'Button.js'), 'export default class Button {}');
  await write(path.join(dist, 'Slice', 'Slice.js'), 'export default {};');
  await write(path.join(dist, 'public', 'Themes', 'Light.css'), ':root{}');
  await write(path.join(dist, 'public', 'images', 'logo.svg'), '<svg/>');
  await write(path.join(dist, 'public', 'manifest.json'), '{"name":"Test"}');
  await write(path.join(dist, 'sliceConfig.json'), '{"server":{"port":3000}}');
  await write(path.join(dist, 'robots.txt'), 'User-agent: *');
  await write(path.join(dist, 'slice-build.generated.d.ts'), 'export {};');
  await write(path.join(dist, 'bundle.js.map'), '{}');
}

test('export flattens dist/public and writes root index, env and host rules', async () => {
  await withTestProject(async (root) => {
    await createFakeDist(root);
    await write(
      path.join(root, 'dist', 'slice-env.json'),
      JSON.stringify({ mode: 'production', env: { SLICE_PUBLIC_FROM: 'dist' } })
    );

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare' });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    assert.equal(await fs.pathExists(path.join(out, 'index.html')), true);
    assert.equal(await fs.pathExists(path.join(out, 'public')), false);
    assert.equal(await fs.pathExists(path.join(out, 'Themes', 'Light.css')), true);
    assert.equal(await fs.pathExists(path.join(out, 'images', 'logo.svg')), true);
    assert.equal(await fs.pathExists(path.join(out, '404.html')), true);
    assert.equal(await fs.pathExists(path.join(out, '_redirects')), true);
    assert.equal(await fs.pathExists(path.join(out, '_headers')), true);
    assert.equal(await fs.pathExists(path.join(out, 'slice-build.generated.d.ts')), false);
    assert.equal(await fs.pathExists(path.join(out, 'bundle.js.map')), false);

    const env = JSON.parse(await fs.readFile(path.join(out, 'slice-env.json'), 'utf8'));
    assert.equal(env.mode, 'production');
    assert.deepEqual(env.env, { SLICE_PUBLIC_FROM: 'dist' });

    const shim = await fs.readFile(path.join(out, 'slice-env.generated.js'), 'utf8');
    assert.match(shim, /SLICE_PUBLIC_FROM/);
    assert.match(shim, /export default env/);

    const check = await exportStatic({ out: 'dist-static', check: true });
    assert.equal(check, true);
  }, { visualComponents: [] });
});

test('export writes vercel.json instead of Cloudflare files', async () => {
  await withTestProject(async (root) => {
    await createFakeDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'vercel' });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    const vercel = JSON.parse(await fs.readFile(path.join(out, 'vercel.json'), 'utf8'));
    assert.equal(Array.isArray(vercel.rewrites), true);
    assert.equal(await fs.pathExists(path.join(out, '_redirects')), false);
  }, { visualComponents: [] });
});

async function createSeoDist(root) {
  await createFakeDist(root);
  await write(path.join(root, 'dist', 'public', 'seo.json'), JSON.stringify({
    version: 1,
    origin: 'https://example.test',
    defaults: { siteName: 'Example', description: 'Example site' },
    routes: {
      '/': { title: 'Home', description: 'Home page' },
      '/about': { title: 'About', description: 'About page' }
    }
  }, null, 2));
  await write(
    path.join(root, 'dist', 'routes.js'),
    "export default [{ path: '/' }, { path: '/about' }];\n"
  );
}

test('export prerenders SEO routes and a real 404', async () => {
  await withTestProject(async (root) => {
    await createSeoDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare' });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    const home = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    const about = await fs.readFile(path.join(out, 'about', 'index.html'), 'utf8');
    const notFound = await fs.readFile(path.join(out, '404.html'), 'utf8');

    assert.match(home, /<title>Home/);
    assert.match(about, /<title>About/);
    assert.match(notFound, /noindex/);

    const redirects = await fs.readFile(path.join(out, '_redirects'), 'utf8');
    assert.doesNotMatch(redirects, /\/\*\s+\/index\.html/);

    const check = await exportStatic({ out: 'dist-static', check: true });
    assert.equal(check, true);
  }, { visualComponents: [] });
});

test('export --spa keeps the catch-all fallback with SEO', async () => {
  await withTestProject(async (root) => {
    await createSeoDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare', spa: true });
    assert.equal(ok, true);

    const redirects = await fs.readFile(path.join(root, 'dist-static', '_redirects'), 'utf8');
    assert.match(redirects, /\/\*\s+\/index\.html\s+200/);
  }, { visualComponents: [] });
});

test('export --no-prerender uses the shell and the SPA fallback', async () => {
  await withTestProject(async (root) => {
    await createSeoDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare', prerender: false });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    assert.equal(await fs.pathExists(path.join(out, 'about', 'index.html')), false);
    const home = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(home, /<title>Shell<\/title>/);
    const redirects = await fs.readFile(path.join(out, '_redirects'), 'utf8');
    assert.match(redirects, /\/\*\s+\/index\.html\s+200/);
  }, { visualComponents: [] });
});

async function createLocalizedSeoDist(root) {
  await createSeoDist(root);
  await write(path.join(root, 'dist', 'sliceConfig.json'), JSON.stringify({
    translator: {
      enabled: true,
      defaultLocale: 'en',
      locales: ['en', 'es'],
      path: '/locales',
      localePrefix: 'always'
    }
  }, null, 2));
}

test('export prerenders every locale and writes locale redirects', async () => {
  await withTestProject(async (root) => {
    await createLocalizedSeoDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare' });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    assert.equal(await fs.pathExists(path.join(out, 'en', 'index.html')), true);
    assert.equal(await fs.pathExists(path.join(out, 'es', 'index.html')), true);
    assert.equal(await fs.pathExists(path.join(out, 'en', 'about', 'index.html')), true);
    assert.equal(await fs.pathExists(path.join(out, 'es', 'about', 'index.html')), true);

    const redirects = await fs.readFile(path.join(out, '_redirects'), 'utf8');
    assert.match(redirects, /^\/\s+\/en\s+302$/m);
    assert.match(redirects, /^\/about\s+\/en\/about\s+302$/m);
  }, { visualComponents: [] });
});

test('export writes client redirect pages for hosts without server rules', async () => {
  await withTestProject(async (root) => {
    await createLocalizedSeoDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'github' });
    assert.equal(ok, true);

    const out = path.join(root, 'dist-static');
    assert.equal(await fs.pathExists(path.join(out, '.nojekyll')), true);

    const rootRedirect = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(rootRedirect, /http-equiv="refresh"/);
    assert.match(rootRedirect, /url=\/en/);

    const aboutRedirect = await fs.readFile(path.join(out, 'about', 'index.html'), 'utf8');
    assert.match(aboutRedirect, /http-equiv="refresh"/);
    assert.match(aboutRedirect, /url=\/en\/about/);
    assert.match(aboutRedirect, /rel="canonical"/);
  }, { visualComponents: [] });
});

test('export prunes Components by default and check enforces it', async () => {
  await withTestProject(async (root) => {
    await createFakeDist(root);

    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'cloudflare' });
    assert.equal(ok, true);
    assert.equal(await fs.pathExists(path.join(root, 'dist-static', 'Components')), false);
    assert.equal(await exportStatic({ out: 'dist-static', check: true }), true);

    const kept = await exportStatic({
      fromDist: true,
      out: 'dist-static-keep',
      host: 'cloudflare',
      keepComponents: true
    });
    assert.equal(kept, true);
    assert.equal(await fs.pathExists(path.join(root, 'dist-static-keep', 'Components')), true);
    assert.equal(await exportStatic({ out: 'dist-static-keep', check: true }), false);
    assert.equal(await exportStatic({ out: 'dist-static-keep', check: true, keepComponents: true }), true);
  }, { visualComponents: [] });
});

test('an unknown host fails before writing', async () => {
  await withTestProject(async (root) => {
    await createFakeDist(root);
    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'nope' });
    assert.equal(ok, false);
    assert.equal(await fs.pathExists(path.join(root, 'dist-static')), false);
  }, { visualComponents: [] });
});
