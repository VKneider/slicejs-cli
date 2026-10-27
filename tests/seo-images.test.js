import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCardHtml,
  checkImages,
  imageSize,
  routeSlug,
  selectRoutes
} from '../commands/seo/images.js';

const project = (t, manifest, cards = null) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-og-'));
  fs.mkdirSync(path.join(root, 'src', 'public', 'og'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'public', 'seo.json'), JSON.stringify(manifest));
  if (cards) {
    fs.writeFileSync(path.join(root, 'src', 'public', 'og', 'manifest.json'), JSON.stringify(cards));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

/** A buffer whose PNG header claims the given size; enough for imageSize(). */
const fakePng = (width, height) => {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const MANIFEST = {
  version: 1,
  origin: 'https://acme.dev',
  routes: {
    '/': { title: 'Home' },
    '/pricing': { title: 'Pricing' },
    '/private': { title: 'Private', robots: false },
    '/producto/${id}': { title: 'Producto' }
  },
  sitemap: false
};

test('routeSlug keeps names readable and stable', () => {
  assert.equal(routeSlug('/'), 'home');
  assert.equal(routeSlug('/docs/input/button'), 'docs-input-button');
  assert.equal(routeSlug('/a_b/ç'), 'a-b');
});

test('only indexable literal routes get a card', () => {
  assert.deepEqual(
    selectRoutes(MANIFEST).map((item) => item.route),
    ['/', '/pricing']
  );
  assert.deepEqual(
    selectRoutes(MANIFEST, '/pricing').map((item) => item.route),
    ['/pricing']
  );
});

test('the built-in card escapes its input', () => {
  const html = buildCardHtml({ title: 'A & <b>', route: '/x', host: 'acme.dev' });
  assert.match(html, /A &amp; &lt;b&gt;/);
  assert.match(html, /1200px/);
});

test('a template replaces the card and fills the placeholders', () => {
  const html = buildCardHtml({
    title: 'A "<b>"',
    route: '/pricing',
    host: 'acme.dev',
    template: '<h1>{{title}}</h1><p>{{route}}</p><span>{{host}}</span><img src="{{image}}">'
  });
  assert.match(html, /A &quot;&lt;b&gt;&quot;/);
  assert.match(html, /<p>\/pricing<\/p>/);
  assert.match(html, /<span>acme\.dev<\/span>/);
});

test('imageSize reads a PNG header', () => {
  assert.deepEqual(imageSize(fakePng(1200, 630)), { width: 1200, height: 630, type: 'image/png' });
});

test('check passes when every indexable route has a 1200x630 card', (t) => {
  const root = project(t, MANIFEST, {
    images: {
      '/': { path: '/og/home-abc.png', width: 1200, height: 630, type: 'image/png' },
      '/pricing': { path: '/og/pricing-abc.png', width: 1200, height: 630, type: 'image/png' }
    }
  });
  fs.writeFileSync(path.join(root, 'src', 'public', 'og', 'home-abc.png'), fakePng(1200, 630));
  fs.writeFileSync(path.join(root, 'src', 'public', 'og', 'pricing-abc.png'), fakePng(1200, 630));

  const result = checkImages({ projectRoot: root });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checks, ['/', '/pricing']);
});

test('check reports a missing card, a wrong size and a missing file', (t) => {
  const root = project(t, MANIFEST, {
    images: {
      '/': { path: '/og/home-abc.png', width: 800, height: 600, type: 'image/png' },
      '/pricing': { path: '/og/pricing-gone.png', width: 1200, height: 630, type: 'image/png' }
    }
  });
  fs.writeFileSync(path.join(root, 'src', 'public', 'og', 'home-abc.png'), fakePng(800, 600));

  const result = checkImages({ projectRoot: root });

  assert.ok(result.errors.some((message) => /800×600, expected 1200×630/.test(message)));
  assert.ok(result.errors.some((message) => /missing \/og\/pricing-gone\.png/.test(message)));
});
