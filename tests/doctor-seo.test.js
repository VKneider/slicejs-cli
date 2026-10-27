import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { checkSeoConfiguration } from '../commands/doctor/doctor.js';

// The row is warn-first by design: an app that does not want SEO must not turn
// the doctor red. Only malformed input fails.

const MANIFEST = (origin = 'https://acme.dev') => ({
  version: 1,
  origin,
  defaults: { titleTemplate: '%s' },
  routes: {
    '/': { title: 'Home' },
    '/about': { title: 'About' },
    '/404': { title: 'Not Found', robots: false }
  },
  sitemap: false
});

test('SEO: a project without a server says so and passes', async () => {
  await withTestProject(async (root) => {
    fs.rmSync(path.join(root, 'api'), { recursive: true, force: true });
    const result = await checkSeoConfiguration();
    assert.equal(result.pass, true);
    assert.match(result.message, /Not a server app/);
  });
});

test('SEO: a server without a manifest warns instead of failing', async () => {
  await withTestProject(async (root) => {
    fs.rmSync(path.join(root, 'seo.json'), { force: true });
    const result = await checkSeoConfiguration();
    assert.equal(result.warn, true);
    assert.match(result.message, /Not configured/);
    assert.match(result.suggestion, /createSliceServer/);
  });
});

test('SEO: a consistent manifest passes', async () => {
  await withTestProject(async (root) => {
    fs.writeFileSync(path.join(root, 'seo.json'), JSON.stringify(MANIFEST()));
    const result = await checkSeoConfiguration();
    assert.equal(result.pass, true, result.message);
    assert.match(result.message, /origin https:\/\/acme\.dev/);
    assert.match(result.message, /3 routes/);
  });
});

test('SEO: a localhost origin warns (it would leak into canonicals)', async () => {
  await withTestProject(async (root) => {
    fs.writeFileSync(path.join(root, 'seo.json'), JSON.stringify(MANIFEST('http://localhost:3001')));
    const result = await checkSeoConfiguration();
    assert.equal(result.warn, true);
    assert.match(result.message, /localhost/);
  });
});

test('SEO: invalid JSON fails with the parse error', async () => {
  await withTestProject(async (root) => {
    fs.writeFileSync(path.join(root, 'seo.json'), '{ not json');
    const result = await checkSeoConfiguration();
    assert.equal(result.pass, undefined);
    assert.equal(result.warn, undefined);
    assert.match(result.message, /not valid JSON/);
  });
});
