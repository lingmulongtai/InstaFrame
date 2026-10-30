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

test('mouse-wheel steps animate in the sidebar while precise and nested scrolling stays native', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('#sidebarScroll');
  const result = await panel.evaluate(async element => {
    element.scrollTop = 0;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    element.dispatchEvent(wheel);
    const start = element.scrollTop;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { prevented: wheel.defaultPrevented, start, moving: element.scrollTop };
  });
  expect(result.prevented).toBe(true);
  expect(result.start).toBe(0);
  expect(result.moving).toBeGreaterThan(0);
  expect(result.moving).toBeLessThan(120);
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(120);
  const native = await panel.evaluate(element => {
    const precise = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 8.5 });
    element.dispatchEvent(precise);
    const nested = document.createElement('div');
    nested.style.cssText = 'height: 40px; overflow-y: auto';
    const content = document.createElement('div');
    content.style.height = '200px';
    nested.append(content);
    element.append(nested);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    nested.dispatchEvent(wheel);
    nested.remove();
    return { precisePrevented: precise.defaultPrevented, nestedPrevented: wheel.defaultPrevented };
  });
  expect(native).toEqual({ precisePrevented: false, nestedPrevented: false });
});

test('reduced motion leaves mouse wheel scrolling to the browser', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const panel = page.locator('#sidebarScroll');
  const prevented = await panel.evaluate(element => {
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    element.dispatchEvent(wheel);
    return wheel.defaultPrevented;
  });
  expect(prevented).toBe(false);
});


test('desktop wheel scrolls the sidebar in both directions', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('#sidebarScroll');
  await panel.hover({ position: { x: 8, y: 30 } });
  await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(240);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(120);
});

test('closed font picker does no positioning work during sidebar scrolling', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const original = document.getElementById.bind(document);
    window.fontPickerLookups = 0;
    document.getElementById = id => {
      if (id === 'fontFamily' || id === 'fontFamilyList') window.fontPickerLookups += 1;
      return original(id);
    };
  });
  const countScrollLookups = () => page.evaluate(() => {
    window.fontPickerLookups = 0;
    document.querySelector('#sidebarScroll').dispatchEvent(new Event('scroll'));
    return window.fontPickerLookups;
  });
  expect(await countScrollLookups()).toBe(0);
  const picker = page.locator('#fontFamily');
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  expect(await countScrollLookups()).toBeGreaterThan(0);
  await picker.press('Escape');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  expect(await countScrollLookups()).toBe(0);
});

test('mobile touch scroll retains native movement and horizontal slider control', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP touch input is available in Chromium');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.locator('#tabSettingsBtn').click();
    await expect(page.locator('#sidebarScroll')).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const swipe = async (x, y, dx, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const panel = page.locator('#sidebarScroll');
    const bounds = await panel.boundingBox();
    await swipe(bounds.x + 20, bounds.y + bounds.height * 0.7, 0, -200);
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    await panel.evaluate(element => { element.scrollTop = 0; });
    const slider = page.locator('#thicknessRange');
    const before = await slider.inputValue();
    const box = await slider.boundingBox();
    await swipe(box.x + box.width * 0.5, box.y + box.height / 2, 70, 0);
    await expect.poll(() => slider.inputValue()).not.toBe(before);
  } finally {
    await context.close();
  }
});
