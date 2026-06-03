import { test, expect } from '@playwright/test';

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.describe('default-export shared dependency', () => {
  test('/defaultdep resolves a default export at runtime', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/defaultdep');

    await expect(page.locator('slice-defaultdeppage')).toBeAttached();
    await expect(page.locator('slice-defaultdeppage')).toHaveAttribute('data-cfg-title', 'Configured');
    await expect(page.locator('slice-defaultdeppage')).toHaveAttribute(
      'data-cfg-tagline',
      'default-export-works'
    );

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('component CSS application', () => {
  test('/cssprobe applies the bundled component stylesheet', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/cssprobe');

    const marker = page.locator('slice-cssprobepage .css-probe-marker');
    await expect(marker).toBeVisible();
    await expect(marker).toHaveCSS('color', 'rgb(7, 113, 219)');
    await expect(marker).toHaveCSS('font-weight', '700');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('transitive dependency of a shared module', () => {
  // mid.js (imported by the component) itself imports leaf.js. The bundler must
  // recursively inline leaf.js and bind its exports inside mid's scope, or the
  // page breaks at runtime.
  test('/transitive renders and the transitively-imported helper works', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/transitive');

    await expect(page.locator('slice-transitivepage')).toBeAttached();
    await expect(page.locator('slice-transitivepage')).toHaveAttribute(
      'data-transitive',
      'mid(leaf-value)[leaf:leaf-value]'
    );

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
