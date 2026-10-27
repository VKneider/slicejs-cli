import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSeoFiles } from '../commands/seo/sitemap.js';
import { checkSeo } from '../commands/seo/check.js';

// The command consumes the framework's builders; resolve them from the sibling
// repository when it is there (the workspace layout) and skip otherwise.
// `import()` needs a URL, not a Windows path: `fileURLToPath` produces `C:\…`,
// which Node reads as the `c:` scheme.
const framework = await import(
  new URL('../../slice.js/api/framework/seo.js', import.meta.url).href
).catch(() => null);

const skip = framework ? false : 'needs the slice.js repository next to slicejs-cli';

const makeProject = (t, manifest) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-seo-cli-'));
  fs.mkdirSync(path.join(root, 'src', 'public'), { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(root, 'seo.json'), JSON.stringify(manifest));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const MANIFEST = {
  version: 1,
  origin: 'https://acme.dev',
  routes: {
    '/': { title: 'Home' },
    '/pricing': { title: 'Pricing' },
    '/private': { title: 'Private', robots: false }
  }
};

const sitemapPath = (root) => path.join(root, 'src', 'public', 'sitemap.xml');
const robotsPath = (root) => path.join(root, 'src', 'public', 'robots.txt');

test('writes sitemap.xml with the indexable routes only', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);

  const result = await generateSeoFiles({ projectRoot, framework });

  assert.deepEqual(result.errors, []);
  assert.equal(result.files.length, 1, 'no robots.txt when the manifest does not ask for it');
  assert.equal(result.files[0].status, 'created');

  const xml = fs.readFileSync(sitemapPath(projectRoot), 'utf8');
  assert.match(xml, /<loc>https:\/\/acme.dev\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/acme.dev\/pricing<\/loc>/);
  assert.doesNotMatch(xml, /private/);
  assert.equal(fs.existsSync(robotsPath(projectRoot)), false);
});

test('an unchanged file is not rewritten', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);
  await generateSeoFiles({ projectRoot, framework });
  const before = fs.statSync(sitemapPath(projectRoot)).mtimeMs;

  const again = await generateSeoFiles({ projectRoot, framework });

  assert.equal(again.files[0].status, 'unchanged');
  assert.equal(fs.statSync(sitemapPath(projectRoot)).mtimeMs, before);
});

test('refuses to overwrite without confirmation', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);
  fs.writeFileSync(sitemapPath(projectRoot), 'HAND WRITTEN');

  const result = await generateSeoFiles({
    projectRoot,
    framework,
    confirm: async () => false
  });

  assert.equal(result.files[0].status, 'skipped');
  assert.equal(fs.readFileSync(sitemapPath(projectRoot), 'utf8'), 'HAND WRITTEN');
});

test('--yes overwrites', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);
  fs.writeFileSync(sitemapPath(projectRoot), 'HAND WRITTEN');

  const result = await generateSeoFiles({ projectRoot, framework, yes: true });

  assert.equal(result.files[0].status, 'updated');
  assert.match(fs.readFileSync(sitemapPath(projectRoot), 'utf8'), /<urlset/);
});

test('--dry-run reports without writing', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);

  const result = await generateSeoFiles({ projectRoot, framework, dryRun: true });

  assert.equal(result.files[0].status, 'would-change');
  assert.equal(fs.existsSync(sitemapPath(projectRoot)), false);
});

test('refuses a localhost origin instead of shipping local URLs', { skip }, async (t) => {
  const projectRoot = makeProject(t, { ...MANIFEST, origin: 'http://localhost:3001' });

  const result = await generateSeoFiles({ projectRoot, framework });

  assert.ok(result.errors.some((message) => /localhost/.test(message)));
  assert.equal(fs.existsSync(sitemapPath(projectRoot)), false);
});

test('writes robots.txt only when the manifest asks for it', { skip }, async (t) => {
  const projectRoot = makeProject(t, {
    ...MANIFEST,
    robotsTxt: { disallow: ['/__test', '/playground'] }
  });

  await generateSeoFiles({ projectRoot, framework });

  const robots = fs.readFileSync(robotsPath(projectRoot), 'utf8');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Disallow: \/__test/);
  assert.match(robots, /Sitemap: https:\/\/acme.dev\/sitemap\.xml/);
});

test('check fails when the committed sitemap drifted', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);
  fs.writeFileSync(sitemapPath(projectRoot), '<?xml version="1.0"?><urlset></urlset>');

  const result = await checkSeo({ projectRoot, framework, routes: [] });

  assert.ok(result.errors.some((message) => /out of date/.test(message)));
  assert.equal(result.sitemap, 'drifted');
});

test('check passes on a matching sitemap', { skip }, async (t) => {
  const projectRoot = makeProject(t, MANIFEST);
  await generateSeoFiles({ projectRoot, framework });

  const result = await checkSeo({ projectRoot, framework, routes: [] });

  assert.deepEqual(result.errors, []);
  assert.equal(result.sitemap, 'ok');
});

test('check reports a missing manifest', { skip }, async (t) => {
  const projectRoot = makeProject(t, null);

  const result = await checkSeo({ projectRoot, framework, routes: [] });

  assert.ok(result.errors.some((message) => /seo\.json not found/.test(message)));
});
