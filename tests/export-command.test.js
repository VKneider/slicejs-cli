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
  await write(path.join(dist, 'App', 'index.html'), '<!doctype html><script type="module" src="/App/index.js"></script>');
  await write(path.join(dist, 'App', 'index.js'), 'console.log("app");');
  await write(path.join(dist, 'App', 'style.css'), 'body{}');
  await write(path.join(dist, 'bundles', 'bundle.config.json'), '{"version":2}');
  await write(path.join(dist, 'bundles', 'slice-bundle.home.js'), 'export const x = 1;');
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
    assert.deepEqual(env.env, {});

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

test('an unknown host fails before writing', async () => {
  await withTestProject(async (root) => {
    await createFakeDist(root);
    const ok = await exportStatic({ fromDist: true, out: 'dist-static', host: 'nope' });
    assert.equal(ok, false);
    assert.equal(await fs.pathExists(path.join(root, 'dist-static')), false);
  }, { visualComponents: [] });
});
