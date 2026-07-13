const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { createJpeg, createWebm } = require('./fixtures.cjs');

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

function readVideoPreviewOutcome(page) {
  return page.evaluate(() => {
    if (document.querySelector('#status-badge-1 .status-dot.error')) return 'error';
    const video = document.getElementById('livePreviewVideo');
    const thumbnail = document.querySelector('#preview-1 canvas.thumb-framed');
    const decodedVideo = video && video.videoWidth > 0 && video.videoHeight > 0 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    const decodedThumbnail = thumbnail && thumbnail.width > 0 && thumbnail.height > 0;
    return decodedVideo || decodedThumbnail ? 'decoded' : 'pending';
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('browser contract runs against the allowlisted release artifact', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const localAssets = [...document.querySelectorAll('link[href], script[src]')]
      .map(element => new URL(element.href || element.src, location.href))
      .filter(url => url.origin === location.origin);
    const assetStatuses = await Promise.all(localAssets.map(async url => ({
      path: url.pathname,
      status: (await fetch(url)).status,
    })));
    const revisions = [...new Set(localAssets.map(url => url.searchParams.get('v')))];
    const sensitiveStatuses = await Promise.all([
      '/package.json',
      '/.git/config',
      '/tests/e2e/instaframe.spec.cjs',
      '/.env',
    ].map(async pathName => ({ path: pathName, status: (await fetch(pathName)).status })));
    return { assetStatuses, revisions, sensitiveStatuses };
  });

  expect(result.assetStatuses.length).toBeGreaterThan(3);
  expect(result.assetStatuses.every(asset => asset.status === 200)).toBe(true);
  expect(result.revisions).toHaveLength(1);
  expect(result.revisions[0]).toMatch(/^[a-f0-9]{12}$/);
  expect(result.sensitiveStatuses).toEqual([
    { path: '/package.json', status: 404 },
    { path: '/.git/config', status: 404 },
    { path: '/tests/e2e/instaframe.spec.cjs', status: 404 },
    { path: '/.env', status: 404 },
  ]);
});

test('self-hosted fonts and initial UI are accessible without Google requests', async ({ page }) => {
  const families = [
    'Inter', 'Montserrat', 'DM Sans', 'Lato', 'Poppins', 'Raleway', 'Nunito',
    'Josefin Sans', 'Oswald', 'Work Sans', 'Playfair Display', 'Cormorant Garamond',
    'EB Garamond', 'Libre Baskerville', 'Cinzel', 'Source Serif 4',
  ];
  const externalFontRequests = [];
  page.on('request', request => {
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) externalFontRequests.push(request.url());
  });
  await page.reload();
  const fontResults = await page.evaluate(async expectedFamilies => Promise.all(
    expectedFamilies.map(async family => {
      const faces = await document.fonts.load(`400 16px "${family}"`, 'InstaFrame');
      return { family, count: faces.length, loaded: faces.every(face => face.status === 'loaded') };
    })
  ), families);
  expect(fontResults).toEqual(families.map(family => ({ family, count: 1, loaded: true })));
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
  let [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#dl-btn-1').press('Enter'),
  ]);
  let bytes = require('node:fs').readFileSync(await download.path());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await page.locator('label[for="fmt-webp"]').click();
  [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#dl-btn-2').press('Enter'),
  ]);
  bytes = require('node:fs').readFileSync(await download.path());
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
    window.FrameEngine.renderFrameWhenReady = async (...args) => {
      const signal = args[3]?.signal;
      await new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Export cancelled', 'AbortError'));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
      });
    };
  });
  await page.locator('#generateAllBtn').focus();
  await page.locator('#generateAllBtn').press('Enter');
  await expect(page.locator('#cancelExportBtn')).toBeFocused();
  await expect(page.locator('#exportProgressMeter')).toHaveAttribute('aria-valuenow', /\d+/);
  expect(await page.locator('#exportProgressStatus').evaluate(element => (
    element.closest('[aria-busy="true"]') !== null
  ))).toBe(false);
  await assertNoAxeViolations(page, '#exportProgress');
  await page.locator('#cancelExportBtn').press('Enter');
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#generateAllBtn')).toBeFocused();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
});

test('VP8 WebM input previews or fails explicitly with the browser codec', async ({ page }, testInfo) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'cross-browser.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#preview-1')).toBeVisible();
  const readOutcome = () => readVideoPreviewOutcome(page);
  await expect.poll(readOutcome, { timeout: 20_000 }).not.toBe('pending');
  const outcome = await readOutcome();
  if (outcome === 'error') {
    await expect(page.locator('#status-badge-1')).toHaveAttribute('aria-label', /decode|デコード/i);
  } else {
    expect(outcome).toBe('decoded');
  }
  if (testInfo.project.name !== 'webkit') expect(outcome).toBe('decoded');
});

test('crisp auto preview and custom delete confirmation are portable', async ({ page }) => {
  await uploadJpeg(page);
  const canvas = page.locator('#livePreviewCanvas');
  await expect.poll(() => canvas.evaluate(element => element.width / parseFloat(element.style.width))).toBeGreaterThanOrEqual(1.9);
  const zoomStyle = await page.locator('#zoomRange').evaluate(element => {
    const style = getComputedStyle(element);
    return { writingMode: style.writingMode, webkitAppearance: style.webkitAppearance || '' };
  });
  expect(zoomStyle.writingMode).toBe('vertical-lr');
  expect(zoomStyle.webkitAppearance).not.toBe('slider-vertical');
  await page.locator('#zoomRange').evaluate(element => {
    element.value = '1200';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#zoomLabel')).toHaveText('1200%');
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.previewBackingScale))).toBeGreaterThanOrEqual(11.9);
  const previewBudget = await canvas.evaluate(element => ({
    pixels: element.width * element.height,
    limit: Number(element.dataset.previewPixelBudget),
  }));
  expect(previewBudget.pixels).toBeLessThanOrEqual(previewBudget.limit + 10_000);

  const remove = page.locator('[data-action="remove"]');
  await remove.focus();
  await remove.press('Enter');
  await expect(page.locator('#destructiveConfirmCancelBtn')).toBeFocused();
  await assertNoAxeViolations(page, '#destructiveConfirmModal');
  await page.keyboard.press('Escape');
  await expect(remove).toBeFocused();
  await remove.press('Enter');
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('.image-card')).toHaveCount(0);
});
