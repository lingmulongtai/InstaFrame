const { test, expect } = require('@playwright/test');
const { createJpeg } = require('./fixtures.cjs');

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`workspace remains usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#mobileTabBar')).toBeVisible();
    await expect(page.locator('#fileInput')).toBeAttached();
    await expect(page.locator('.preview-empty-cta')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.locator('#tabSettingsBtn').click();
    await expect(page.locator('#settingsPanel')).toBeVisible();
    await expect(page.locator('#bg-color')).toBeChecked();
    await page.locator('#tabPhotosBtn').click();
    await expect(page.locator('#mobileAddBtn')).toBeVisible();
    await page.locator('#mobileFileInput').setInputFiles({ name: 'workspace.jpg', mimeType: 'image/jpeg', buffer: createJpeg() });
    await expect(page.locator('#livePreviewCanvas')).toBeVisible();
    await page.locator('#tabPhotosBtn').click();
    await expect(page.locator('#preview-1')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('#dl-btn-1').click();
    expect((await download).suggestedFilename()).toMatch(/workspace_frame\.jpe?g$/i);
  });
}

test('short landscape keeps an accessible heading without experimental branding', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'InstaFrame', level: 1 })).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText('EXPERIMENTAL');
  await expect(page).toHaveTitle('InstaFrame by lingmulongtai');
});
