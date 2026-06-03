import { test, expect } from '@playwright/test';
import { parse } from '@babel/parser';

// Recursively collect every emitted bundle file referenced by the config.
// Only real bundle artifacts (slice-bundle.*.js) — not dependency identifiers
// that happen to end in `.js` (e.g. vendorShared.dependencies).
function collectBundleFiles(node, acc = new Set()) {
  if (typeof node === 'string') {
    if (node.startsWith('slice-bundle.') && node.endsWith('.js')) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectBundleFiles(n, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectBundleFiles(v, acc);
    return acc;
  }
  return acc;
}

async function getConfig(request) {
  const res = await request.get('/bundles/bundle.config.json');
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('bundle quality & content (served production artifacts)', () => {
  test('bundle.config.json is well-formed and maps every route', async ({ request }) => {
    const cfg = await getConfig(request);
    expect(cfg.production).toBe(true);
    expect(cfg.format).toBe('v2');
    expect(cfg.minified).toBe(true);
    expect(cfg.obfuscated).toBe(true);
    expect(cfg.bundles.framework, 'framework bundle present').toBeTruthy();
    expect(cfg.bundles.critical, 'critical bundle present').toBeTruthy();

    for (const route of ['/', '/about', '/404']) {
      expect(Array.isArray(cfg.routeBundles[route]), `route ${route} is mapped`).toBe(true);
      expect(cfg.routeBundles[route].length).toBeGreaterThan(0);
    }
  });

  test('every referenced bundle is served as valid, contract-compliant JS', async ({ request }) => {
    const cfg = await getConfig(request);
    const files = [...collectBundleFiles(cfg.bundles)];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const res = await request.get(`/bundles/${file}`);
      expect(res.status(), `${file} is served`).toBe(200);
      expect(res.headers()['content-type'] || '').toMatch(/javascript/);

      const code = await res.text();
      expect(() => parse(code, { sourceType: 'module', plugins: ['jsx'] }), `${file} is valid JS`).not.toThrow();
      // v2 runtime contract.
      expect(code, `${file} exports SLICE_BUNDLE_META`).toContain('SLICE_BUNDLE_META');
      expect(code, `${file} exports registerAll`).toContain('registerAll');
      // No unresolved relative import may leak into a production bundle.
      expect(/\bfrom\s+['"]\.\.?\//.test(code), `${file} leaks a relative import`).toBe(false);
    }
  });

  test('the framework bundle carries the structural runtime', async ({ request }) => {
    const code = await (await request.get('/bundles/slice-bundle.framework.js')).text();
    expect(code).toContain('Controller');
    expect(code).toContain('registerAll');
  });

  test('all starter component classes are registered across the bundles', async ({ request }) => {
    const cfg = await getConfig(request);
    const files = [...collectBundleFiles(cfg.bundles)];
    let combined = '';
    for (const file of files) {
      combined += await (await request.get(`/bundles/${file}`)).text();
    }
    // Component names are emitted as string literals in the register* calls and
    // survive minification (mangle.properties is off, strings are untouched).
    for (const comp of ['AppShell', 'Navbar', 'MultiRoute', 'HomeSection', 'Button', 'AboutSection', 'NotFound']) {
      expect(combined.includes(`"${comp}"`), `${comp} is registered in a bundle`).toBe(true);
    }
  });

  test('bundles are genuinely minified', async ({ request }) => {
    const code = await (await request.get('/bundles/slice-bundle.framework.js')).text();
    const longestLine = Math.max(...code.split('\n').map((l) => l.length));
    expect(longestLine, 'minified output has long lines').toBeGreaterThan(300);
    expect(code, 'comments are stripped').not.toContain('/**');
  });
});
