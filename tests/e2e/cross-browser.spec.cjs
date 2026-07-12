const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { createJpeg } = require('./fixtures.cjs');

async function assertNoAxeViolations(page, include) {
  let audit = new AxeBuilder({ page });
  if (include) audit = audit.include(include);
  const result = await audit.analyze();
  expect(result.violations).toEqual([]);
}

async function uploadJpeg(page, count = 1) {
  await page.locator('#fileInput').setInputFiles(Array.from({ length: count }, (_, index) => ({
    name: `cross-browser-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: createJpeg({ colorShift: index * 15 }),
  })));
  await expect(page.locator('#livePreviewCanvas')).toBeVisible();
}

async function createBrowserImage(page, mimeType) {
  return page.evaluate(async type => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    context.fillStyle = '#125c78';
    context.fillRect(0, 0, 80, 60);
    context.fillStyle = '#f5c451';
    context.fillRect(20, 15, 40, 30);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.9));
    if (!blob || blob.type !== type) throw new Error(`${type} encoding is unavailable`);
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, mimeType);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('self-hosted fonts and initial UI are accessible without Google requests', async ({ page }) => {
  const externalFontRequests = [];
  page.on('request', request => {
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) externalFontRequests.push(request.url());
  });
  await page.reload();
  await page.evaluate(() => document.fonts.load("400 16px 'Inter'"));
  expect(await page.evaluate(() => document.fonts.check("400 16px 'Inter'"))).toBe(true);
  expect(externalFontRequests).toEqual([]);
  await assertNoAxeViolations(page);
});

test('photo export settings remain accessible and JPEG export is real', async ({ page }) => {
  await uploadJpeg(page);
  await page.locator('label[for="fmt-png"]').click();
  await expect(page.locator('#photoQualityRow')).toBeHidden();
  await expect(page.locator('#photoQualityRange')).toBeDisabled();
  await assertNoAxeViolations(page, '.sidebar');

  await page.locator('label[for="fmt-jpeg"]').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  const download = await downloadPromise;
  const bytes = require('node:fs').readFileSync(await download.path());
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});

test('PNG and WebP inputs decode and export with real signatures', async ({ page }) => {
  const png = Buffer.from(await createBrowserImage(page, 'image/png'));
  const webp = Buffer.from(await createBrowserImage(page, 'image/webp'));
  await page.locator('#fileInput').setInputFiles([
    { name: 'cross-browser.png', mimeType: 'image/png', buffer: png },
    { name: 'cross-browser.webp', mimeType: 'image/webp', buffer: webp },
  ]);
  await expect(page.locator('#preview-1')).toBeVisible();
  await expect(page.locator('#preview-2')).toBeVisible();

  await page.locator('label[for="fmt-png"]').click();
  let downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  let bytes = require('node:fs').readFileSync(await (await downloadPromise).path());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await page.locator('label[for="fmt-webp"]').click();
  downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-2').click();
  bytes = require('node:fs').readFileSync(await (await downloadPromise).path());
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
});

test('consent and map dialogs support axe, keyboard selection, Escape, and focus return', async ({ page }) => {
  const localLeafletResponses = [];
  page.on('response', response => {
    if (/\/vendor\/leaflet\/leaflet\.(?:js|css)$/.test(response.url())) {
      localLeafletResponses.push({ url: response.url(), status: response.status() });
    }
  });
  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\//, route => route.abort());
  await page.route('https://ipapi.co/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await uploadJpeg(page);
  await page.locator('#openMapPickerBtn').click();
  await expect(page.locator('#locationPrivacyModal')).toHaveClass(/open/);
  await assertNoAxeViolations(page, '#locationPrivacyModal');
  await page.locator('#locationPrivacyOnceBtn').click();
  await expect(page.locator('#mapPickerModal')).toHaveClass(/open/);
  await expect.poll(() => localLeafletResponses.length).toBe(2);
  expect(localLeafletResponses.every(response => response.status === 200)).toBe(true);
  expect(await page.evaluate(() => typeof window.L)).toBe('object');
  await assertNoAxeViolations(page, '#mapPickerModal');
  await page.locator('#selectMapCenterBtn').click();
  await expect(page.locator('#mapPickerCoords')).toContainText(/°[NS].*°[EW]/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#mapPickerModal')).not.toHaveClass(/open/);
  await expect(page.locator('#openMapPickerBtn')).toBeFocused();
});

test('export progress exposes a named meter, cancel control, and focus restoration', async ({ page }) => {
  await uploadJpeg(page, 2);
  await page.evaluate(() => {
    const render = window.FrameEngine.renderFrameWhenReady;
    window.FrameEngine.renderFrameWhenReady = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      return render(...args);
    };
  });
  await page.locator('#generateAllBtn').focus();
  await page.locator('#generateAllBtn').press('Enter');
  await expect(page.locator('#cancelExportBtn')).toBeFocused();
  await expect(page.locator('#exportProgressMeter')).toHaveAttribute('aria-valuenow', /\d+/);
  await assertNoAxeViolations(page, '#exportProgress');
  await page.locator('#cancelExportBtn').press('Enter');
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#generateAllBtn')).toBeFocused();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
});
