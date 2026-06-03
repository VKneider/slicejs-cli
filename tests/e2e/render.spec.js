import { test, expect } from '@playwright/test';

// Collect console errors / uncaught page errors for the whole test.
function trackErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test.describe('initial app render (production build)', () => {
  test('boots the framework and renders the home page with no console errors', async ({ page }) => {
    const errors = trackErrors(page);

    await page.goto('/');

    // The App Shell mounts, with its persistent navbar.
    await expect(page.locator('slice-app-shell')).toBeAttached();
    await expect(page.locator('slice-nav-bar')).toBeAttached();

    // The Home section renders its real content...
    await expect(page.locator('slice-home-section h1.home__title')).toHaveText(
      /Welcome to your Slice app/
    );
    // ...including a child Button built via slice.build with its label.
    await expect(
      page.locator('slice-home-section slice-button .slice_button_value')
    ).toHaveText(/Go to About/);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
