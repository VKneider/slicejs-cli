import { test, expect } from '@playwright/test';
import { parse } from '@babel/parser';

// Two routes (/services, /routing) live in different bundles and import the same
// module, so the build extracts it into a vendor-shared bundle. These specs
// validate both the produced artifact and that the shared dependency resolves at
// runtime (via window.__SLICE_SHARED_DEPS__) when the pages render.

test.describe('vendor-shared bundle (shared dependency across routes)', () => {
  test('the config advertises a real vendor-shared bundle wired into both routes', async ({ request }) => {
    const cfg = await (await request.get('/bundles/bundle.config.json')).json();

    expect(cfg.bundles.vendorShared, 'vendorShared present').toBeTruthy();
    expect(cfg.bundles.vendorShared.file).toBe('slice-bundle.vendor-shared.js');
    expect(cfg.bundles.vendorShared.dependencyCount).toBeGreaterThanOrEqual(1);

    expect(cfg.routeBundles['/services']).toContain('vendor-shared');
    expect(cfg.routeBundles['/routing']).toContain('vendor-shared');
  });

  test('the vendor-shared bundle is served as a valid, contract-compliant module', async ({ request }) => {
    const res = await request.get('/bundles/slice-bundle.vendor-shared.js');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] || '').toMatch(/javascript/);

    const code = await res.text();
    expect(() => parse(code, { sourceType: 'module', plugins: ['jsx'] })).not.toThrow();
    expect(code).toContain('SLICE_BUNDLE_META');
    expect(code).toContain('registerAll');
    expect(code).toContain('SLICE_BUNDLE_DEPENDENCIES');
    // The shared module's own content lives here, not duplicated per route.
    expect(code).toContain('shared-kit-v1');
  });

  test('/services renders and resolves the shared dependency at runtime', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/services');
    await expect(page.locator('slice-servicespage')).toBeAttached();
    // The data attribute is set in init() from the shared module — its presence
    // proves the vendor-shared dependency was registered and resolved.
    await expect(page.locator('slice-servicespage')).toHaveAttribute('data-shared-tag', 'shared-kit-v1');
    await expect(page.locator('slice-servicespage')).toHaveAttribute('data-shared-badge', /ServicesPage/);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('/routing renders and resolves the same shared dependency', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/routing');
    await expect(page.locator('slice-routingpage')).toBeAttached();
    await expect(page.locator('slice-routingpage')).toHaveAttribute('data-shared-tag', 'shared-kit-v1');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
