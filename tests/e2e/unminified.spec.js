import { test, expect } from '@playwright/test';

// Runs against a second server built with E2E_MINIFY=false, so the raw
// (un-minified, un-obfuscated) bundle output is exercised in the browser.
function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.describe('unminified production build', () => {
  test('boots and renders the home page', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');

    await expect(page.locator('slice-app-shell')).toBeAttached();
    await expect(page.locator('slice-home-section h1.home__title')).toHaveText(
      /Welcome to your Slice app/
    );

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('resolves the vendor-shared dependency with unminified bundles', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/services');

    await expect(page.locator('slice-servicespage')).toHaveAttribute('data-shared-tag', 'shared-kit-v1');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
