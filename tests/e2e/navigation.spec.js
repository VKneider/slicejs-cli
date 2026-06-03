import { test, expect } from '@playwright/test';

test.describe('navigation (App Shell + MultiRoute)', () => {
  test('navigates Home -> About via the in-page Button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('slice-home-section h1.home__title')).toBeVisible();

    await page.locator('slice-home-section slice-button button').click();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator('slice-about-section h1')).toHaveText('About');
    // The shell (navbar) persists across the content swap.
    await expect(page.locator('slice-nav-bar')).toBeAttached();
  });

  test('deep-links directly to /about', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('slice-app-shell')).toBeAttached();
    await expect(page.locator('slice-about-section h1')).toHaveText('About');
  });

  test('renders the NotFound page for the /404 route', async ({ page }) => {
    await page.goto('/404');
    await expect(page.locator('slice-notfound')).toBeAttached();
  });

  test('navbar links swap sections while keeping the shell mounted', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('slice-about-section')).toBeAttached();

    await page.locator('slice-nav-bar').getByText('Home', { exact: true }).click();

    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.locator('slice-home-section')).toBeAttached();
    await expect(page.locator('slice-nav-bar')).toBeAttached();
  });

  test('survives a full reload on a deep route', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('slice-about-section')).toBeAttached();
    await page.reload();
    await expect(page.locator('slice-about-section h1')).toHaveText('About');
  });
});
