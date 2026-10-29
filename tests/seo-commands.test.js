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

test('the manifest is also found inside the deployed public folder', { skip }, async (t) => {
  const projectRoot = makeProject(t, null);
  fs.mkdirSync(path.join(projectRoot, 'src', 'public'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'public', 'seo.json'), JSON.stringify(MANIFEST));

  const result = await generateSeoFiles({ projectRoot, framework });

  assert.deepEqual(result.errors, []);
  assert.equal(result.files[0].status, 'created');
  assert.match(fs.readFileSync(sitemapPath(projectRoot), 'utf8'), /<loc>https:\/\/acme.dev\/pricing<\/loc>/);
});

// -- Translator (framework feature 0003) -----------------------------

const TRANSLATED_MANIFEST = {
  version: 1,
  origin: 'https://acme.dev',
  defaults: { titleSuffix: { t: 'seo.titleSuffix' } },
  routes: {
    '/': { title: { t: 'home.title' }, titleSuffix: false },
    '/pricing': { title: { t: 'pricing.title' } }
  }
};

const withTranslator = (root, { missingInEnglish = false } = {}) => {
  fs.writeFileSync(path.join(root, 'src', 'sliceConfig.json'), JSON.stringify({
    translator: {
      enabled: true,
      defaultLocale: 'es',
      fallbackLocale: 'es',
      locales: ['es', 'en'],
      path: '/locales',
      localePrefix: 'except-default'
    }
  }));
  fs.mkdirSync(path.join(root, 'src', 'locales'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'locales', 'es.json'), JSON.stringify({
    seo: { titleSuffix: ' | Acme' },
    home: { title: 'Inicio' },
    pricing: { title: 'Precios' }
  }));
  fs.writeFileSync(path.join(root, 'src', 'locales', 'en.json'), JSON.stringify({
    seo: { titleSuffix: ' | Acme' },
    home: { title: 'Home' },
    pricing: missingInEnglish ? {} : { title: 'Pricing' }
  }));
  return root;
};

test('translator: the sitemap lists every locale with alternates', { skip }, async (t) => {
  const projectRoot = withTranslator(makeProject(t, TRANSLATED_MANIFEST));

  const result = await generateSeoFiles({ projectRoot, framework });

  assert.deepEqual(result.errors, []);
  const xml = fs.readFileSync(sitemapPath(projectRoot), 'utf8');
  assert.equal((xml.match(/<url>/g) || []).length, 4);
  assert.match(xml, /<loc>https:\/\/acme.dev\/pricing<\/loc>/);
  assert.match(xml, /<loc>https:\/\/acme.dev\/en\/pricing<\/loc>/);
  assert.match(xml, /hreflang="en" href="https:\/\/acme.dev\/en\/pricing"/);
  assert.match(xml, /hreflang="x-default" href="https:\/\/acme.dev\/pricing"/);
  assert.match(xml, /xmlns:xhtml=/);
});

test('translator: a { t } key missing in one locale blocks the sitemap', { skip }, async (t) => {
  const projectRoot = withTranslator(makeProject(t, TRANSLATED_MANIFEST), { missingInEnglish: true });

  const result = await generateSeoFiles({ projectRoot, framework });

  assert.ok(result.errors.some((error) => /missing translation "pricing\.title" for "en"/.test(error)));
  assert.equal(fs.existsSync(sitemapPath(projectRoot)), false);
});
