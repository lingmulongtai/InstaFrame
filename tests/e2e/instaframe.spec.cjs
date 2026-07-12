const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createJpeg, createWebm } = require('./fixtures.cjs');

async function uploadJpegs(page, count = 1, gps = false) {
  const files = Array.from({ length: count }, (_, index) => ({
    name: `photo-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: createJpeg({ gps, colorShift: index * 35 }),
  }));
  await page.locator('#fileInput').setInputFiles(files);
  await expect(page.locator('#livePreviewCanvas')).toBeVisible();
  await expect.poll(() => page.locator('#livePreviewCanvas').getAttribute('data-composition-width')).not.toBeNull();
}

async function createBrowserRaster(page, mimeType, width = 96, height = 64) {
  const result = await page.evaluate(({ type, width: rasterWidth, height: rasterHeight }) => {
    const canvas = document.createElement('canvas');
    canvas.width = rasterWidth;
    canvas.height = rasterHeight;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#ff5a5f');
    gradient.addColorStop(1, '#2563eb');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(type, 0.9);
    return { actualType: dataUrl.slice(5, dataUrl.indexOf(';')), base64: dataUrl.split(',')[1] };
  }, { type: mimeType, width, height });
  expect(result.actualType).toBe(mimeType);
  return Buffer.from(result.base64, 'base64');
}

async function loadAudioVideoFixture() {
  return {
    buffer: await fs.readFile(path.resolve(__dirname, 'audio-fixture.webm')),
    mimeType: 'video/webm',
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('initial page and privacy consent modal have no axe violations', async ({ page }) => {
  await expect(page.locator('.preview-empty-cta')).toBeVisible();
  await expect(page.locator('#mobileAddBtn')).toBeHidden();
  await expect(page.locator('.empty-hint-card')).toHaveCount(4);
  const initial = await new AxeBuilder({ page }).analyze();
  expect(initial.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);

  await page.locator('#customizeBtn').click();
  await page.locator('#manageLocationPrivacyBtn').click();
  const consent = await new AxeBuilder({ page }).include('#locationPrivacyModal').analyze();
  expect(consent.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);
});

test('dynamic panels and selectors expose keyboard state without hidden focus targets', async ({ page }) => {
  const customize = page.locator('#customizePanel');
  await expect(customize).toHaveAttribute('aria-hidden', 'true');
  expect(await customize.evaluate(element => element.inert)).toBe(true);

  await page.locator('#customizeBtn').press('Enter');
  await expect(page.locator('#customizeBtn')).toHaveAttribute('aria-expanded', 'true');
  expect(await customize.evaluate(element => element.inert)).toBe(false);
  expect(await page.locator('#sidebarScroll').evaluate(element => element.inert)).toBe(true);
  const customizeAxe = await new AxeBuilder({ page }).include('#customizePanel').analyze();
  const seriousCustomizeViolations = customizeAxe.violations.filter(violation => ['critical', 'serious'].includes(violation.impact));
  expect(seriousCustomizeViolations.map(violation => violation.id), JSON.stringify(seriousCustomizeViolations, null, 2)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#customizeBtn')).toBeFocused();
  await expect(page.locator('#customizeBtn')).toHaveAttribute('aria-expanded', 'false');

  await uploadJpegs(page);
  await expect(page.locator('#preview-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.preview-exif-drawer-header').press('Enter');
  await expect(page.locator('#previewExifContent')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#previewExifContent').evaluate(element => element.inert)).toBe(true);
  await page.locator('.preview-exif-drawer-header').press('Enter');

  await page.locator('#previewQualityBtn').press('Enter');
  await expect(page.locator('#previewQualityBtn')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#previewQualityBtn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#previewQualityBtn')).toBeFocused();
  await expect(page.locator('.pq-option[data-q="draft"]')).toHaveAttribute('aria-checked', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#tabPreviewBtn').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tabPhotosBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tabPhotosBtn')).toBeFocused();
});

test('JPEG upload renders a preview and exports a framed image', async ({ page }) => {
  await uploadJpegs(page);
  await expect(page.locator('#live-exif-model')).toHaveValue('X-T5');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/photo-1_frame\.(jpg|jpeg)$/i);
});

test('core photo processing works when external network is blocked', async ({ page }) => {
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'http://127.0.0.1:4173') return route.continue();
    return route.abort();
  });
  await page.reload();
  await uploadJpegs(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/photo-1_frame\.(jpg|jpeg)$/i);
});

test('PNG and WebP inputs decode into switchable previews', async ({ page }) => {
  const [png, webp] = await Promise.all([
    createBrowserRaster(page, 'image/png'),
    createBrowserRaster(page, 'image/webp'),
  ]);
  await page.locator('#fileInput').setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: png },
    { name: 'photo.webp', mimeType: 'image/webp', buffer: webp },
  ]);

  await expect(page.locator('#preview-1')).toBeVisible();
  await expect(page.locator('#preview-2')).toBeVisible();
  await page.locator('#preview-1').click();
  await expect(page.locator('#livePreviewCanvas')).toHaveAttribute('data-composition-width', /\d+/);
  await page.locator('#preview-2').click();
  await expect(page.locator('#livePreviewCanvas')).toHaveAttribute('data-composition-width', /\d+/);
  await expect(page.locator('#status-badge-1 .status-dot')).not.toHaveClass(/error/);
  await expect(page.locator('#status-badge-2 .status-dot')).not.toHaveClass(/error/);
});

test('JPEG, PNG, and WebP exports have the requested file signatures', async ({ page }) => {
  await uploadJpegs(page);
  const formats = [
    { id: 'fmt-jpeg', extension: /\.jpg$/i, verify: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { id: 'fmt-png', extension: /\.png$/i, verify: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { id: 'fmt-webp', extension: /\.webp$/i, verify: bytes => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' },
  ];

  for (const format of formats) {
    await page.locator(`label[for="${format.id}"]`).click();
    await expect(page.locator(`#${format.id}`)).toBeChecked();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#dl-btn-1').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(format.extension);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const bytes = await fs.readFile(filePath);
    expect(bytes.length).toBeGreaterThan(100);
    expect(format.verify(bytes)).toBe(true);
  }
});

test('EXIF edits remain item-specific and visual settings persist', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.locator('#live-exif-model').fill('Edited Camera');
  await page.waitForTimeout(180);
  await page.locator('#preview-2').click();
  await expect(page.locator('#live-exif-model')).toHaveValue('X-T5');
  await page.locator('#preview-1').click();
  await expect(page.locator('#live-exif-model')).toHaveValue('Edited Camera');

  await page.locator('label[for="text-color-dark"]').click();
  await page.locator('#customizeBtn').click();
  await page.locator('#mapboxTokenInput').fill('pk.test.signature');
  await page.locator('#mapboxTokenInput').blur();
  await page.reload();
  await expect(page.locator('#text-color-dark')).toBeChecked();
  await expect(page.locator('#mapboxTokenInput')).toHaveValue('pk.test.signature');
});

test('batch export creates a ZIP for multiple JPEG files', async ({ page }) => {
  await uploadJpegs(page, 2);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadAllBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/instaframe.*\.zip$/i);
});

test('batch encoding failure restores controls and reports the error', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    window.FrameEngine.canvasToBlob = async () => { throw new Error('simulated encoder failure'); };
  });
  await page.locator('#downloadAllBtn').click();
  await expect(page.locator('#toast')).toContainText(/could not finish|完了できません/);
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#downloadAllBtn')).toBeEnabled();
});

test('heavy local processors load only when their features are used', async ({ page }) => {
  const loadedResources = () => page.evaluate(() => (
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
  ));

  await expect.poll(loadedResources).not.toContain('/vendor/exifr.js');
  await expect.poll(loadedResources).not.toContain('/vendor/jszip.min.js');
  expect((await loadedResources()).filter(pathname => pathname.endsWith('.woff2'))).toEqual([]);

  await uploadJpegs(page, 2);
  await expect.poll(loadedResources).toContain('/vendor/exifr.js');
  expect(await loadedResources()).not.toContain('/vendor/jszip.min.js');
  const loadedFonts = (await loadedResources()).filter(pathname => pathname.endsWith('.woff2'));
  expect(loadedFonts.length).toBeGreaterThan(0);
  expect(loadedFonts.length).toBeLessThanOrEqual(4);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadAllBtn').click();
  await downloadPromise;
  await expect.poll(loadedResources).toContain('/vendor/jszip.min.js');
});

test('oversized source files are rejected before decoding', async ({ page }) => {
  await page.evaluate(async () => {
    const file = new File(['not-decoded'], 'too-large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 257 * 1024 * 1024 });
    await window.addFiles([file]);
  });
  await expect(page.locator('#imageCounter')).toHaveText('');
  await expect(page.locator('#toast')).toContainText(/256 MiB|256 MiB/);
});

test('batch generation can be cancelled while keeping pending items', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    const render = window.FrameEngine.renderFrameWhenReady;
    window.FrameEngine.renderFrameWhenReady = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 800));
      return render(...args);
    };
  });
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#exportProgress')).toBeVisible();
  await page.locator('#cancelExportBtn').click();
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
});

test('video cancellation propagates an AbortSignal to the active encoder', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'cancel-me.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await page.evaluate(() => {
    window.__videoAbortObserved = false;
    window.FrameEngine.renderVideoFrameWhenReady = (_file, _exif, _settings, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        window.__videoAbortObserved = true;
        reject(new DOMException('Export cancelled', 'AbortError'));
      }, { once: true });
    });
  });
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#exportProgress')).toBeVisible();
  await page.locator('#cancelExportBtn').click();
  await expect.poll(() => page.evaluate(() => window.__videoAbortObserved)).toBe(true);
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
});

test('Japanese preview quality labels change raster density without moving composition', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'ja'));
  await page.reload();
  await uploadJpegs(page);
  const canvas = page.locator('#livePreviewCanvas');

  await page.locator('#previewQualityBtn').click();
  await expect(page.locator('.pq-option[data-q="high"]')).toHaveText('高画質');
  await page.locator('.pq-option[data-q="draft"]').click();
  await expect(canvas).toHaveAttribute('data-preview-quality', 'draft');
  const draft = await canvas.evaluate(el => ({
    cssWidth: el.getBoundingClientRect().width,
    cssHeight: el.getBoundingClientRect().height,
    backingWidth: el.width,
    compositionWidth: el.dataset.compositionWidth,
    compositionHeight: el.dataset.compositionHeight,
  }));

  await page.locator('#previewQualityBtn').click();
  await page.locator('.pq-option[data-q="max"]').click();
  await expect(canvas).toHaveAttribute('data-preview-quality', 'max');
  const max = await canvas.evaluate(el => ({
    cssWidth: el.getBoundingClientRect().width,
    cssHeight: el.getBoundingClientRect().height,
    backingWidth: el.width,
    compositionWidth: el.dataset.compositionWidth,
    compositionHeight: el.dataset.compositionHeight,
  }));

  expect(max.compositionWidth).toBe(draft.compositionWidth);
  expect(max.compositionHeight).toBe(draft.compositionHeight);
  expect(max.cssWidth).toBeCloseTo(draft.cssWidth, 0);
  expect(max.cssHeight).toBeCloseTo(draft.cssHeight, 0);
  expect(max.backingWidth).toBeGreaterThan(draft.backingWidth);
});

test('auto preview stays pixel-dense through 600% zoom', async ({ page }) => {
  const largeJpeg = await createBrowserRaster(page, 'image/jpeg', 4096, 2731);
  await page.locator('#fileInput').setInputFiles({
    name: 'large-preview.jpg',
    mimeType: 'image/jpeg',
    buffer: largeJpeg,
  });
  const canvas = page.locator('#livePreviewCanvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => element.width / element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1.95);
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.compositionWidth))).toBeGreaterThan(4000);

  await page.locator('#zoomRange').evaluate(element => {
    element.value = '600';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#zoomLabel')).toHaveText('600%');
  await expect.poll(() => canvas.evaluate(element => element.width / parseFloat(element.style.width))).toBeGreaterThanOrEqual(5.9);
});

test('blur background supports an explicit custom text color', async ({ page }) => {
  await uploadJpegs(page);
  await page.locator('label[for="bg-blur"]').click();
  await page.locator('label[for="text-color-custom"]').click();
  await page.locator('#textColorPicker').evaluate(element => {
    element.value = '#ff00ff';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(350);

  const magentaPixels = await page.locator('#livePreviewCanvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d');
    const y = Math.floor(canvas.height * 0.7);
    const pixels = ctx.getImageData(0, y, canvas.width, canvas.height - y).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 210 && pixels[index + 1] < 110 && pixels[index + 2] > 210 && pixels[index + 3] > 100) count += 1;
    }
    return count;
  });
  expect(magentaPixels).toBeGreaterThan(10);
});

test('social presets are labelled and enforce portrait composition', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'ja'));
  await page.reload();
  await uploadJpegs(page);
  await expect(page.locator('.ratio-pill-featured')).toContainText('Instagram投稿');
  await expect(page.locator('label[for="ratio-3-4"]')).toContainText('プロフィールグリッド');
  await expect(page.locator('label[for="ratio-9-16"]')).toContainText('ストーリー');

  for (const [id, expectedRatio] of [['ratio-4-5', 4 / 5], ['ratio-3-4', 3 / 4], ['ratio-9-16', 9 / 16]]) {
    await page.locator(`label[for="${id}"]`).click();
    await expect(page.locator('#aspect-orientation-portrait')).toBeChecked();
    await expect.poll(async () => page.locator('#livePreviewCanvas').evaluate(canvas => (
      Number(canvas.dataset.compositionWidth) / Number(canvas.dataset.compositionHeight)
    ))).toBeCloseTo(expectedRatio, 2);
  }
});

test('GPS import sends no coordinates until explicit consent', async ({ page }) => {
  const locationRequests = [];
  page.on('request', request => {
    if (/nominatim|ipapi|api\.mapbox|tile\.openstreetmap/.test(request.url())) locationRequests.push(request.url());
  });
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ address: { city: 'Kyoto', country: 'Japan' } }),
  }));

  await uploadJpegs(page, 1, true);
  await page.waitForTimeout(300);
  expect(locationRequests).toHaveLength(0);
  await expect(page.locator('#live-exif-location')).toHaveValue(/°N, .*°E/);

  await page.locator('#resolveLocationNameBtn').click();
  await expect(page.locator('#locationPrivacyModal')).toHaveClass(/open/);
  await page.locator('#locationPrivacyOnceBtn').click();
  await expect(page.locator('#live-exif-location')).toHaveValue('Kyoto, Japan');
  expect(locationRequests.some(url => url.includes('nominatim'))).toBe(true);
});

test('map picker loads its UI library locally after consent', async ({ page }) => {
  const requests = [];
  page.on('request', request => {
    if (/leaflet|tile\.openstreetmap|ipapi/.test(request.url())) requests.push(request.url());
  });
  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\//, route => route.abort());
  await page.route('https://ipapi.co/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({}),
  }));
  await uploadJpegs(page);
  await page.locator('#openMapPickerBtn').click();
  await expect(page.locator('#locationPrivacyModal')).toHaveClass(/open/);
  await page.locator('#locationPrivacyOnceBtn').click();
  await expect(page.locator('#mapPickerModal')).toHaveClass(/open/);
  expect(requests.some(url => url.includes('/vendor/leaflet/leaflet.js'))).toBe(true);
  expect(requests.some(url => url.includes('/vendor/leaflet/leaflet.css'))).toBe(true);
  expect(requests.some(url => /cdn\.jsdelivr\.net.*leaflet|unpkg\.com.*leaflet/.test(url))).toBe(false);
  await expect(page.locator('#mapPickerCloseBtn')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-i18n="mapConfirm"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#mapPickerCloseBtn')).toBeFocused();
});

test('unsupported browser codecs fail visibly instead of silently', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'unsupported.heic',
    mimeType: 'image/heic',
    buffer: Buffer.from('not-a-decodable-heic-file'),
  });
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#toast')).toContainText(/decode|デコード/i);
  await expect(page.locator('.preview-empty-format-note')).toContainText(/HEIC/i);
});

test('mobile layout exposes import, settings, and a readable EXIF editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.preview-empty-cta')).toBeVisible();
  await page.locator('#tabPhotosBtn').click();
  await expect(page.locator('#mobileAddBtn')).toBeVisible();
  const [buttonBox, viewportWidth] = await Promise.all([
    page.locator('#mobileAddBtn').boundingBox(),
    page.evaluate(() => innerWidth),
  ]);
  expect(buttonBox.x + buttonBox.width / 2).toBeCloseTo(viewportWidth / 2, 0);
  await page.locator('#tabPreviewBtn').click();
  await uploadJpegs(page);
  const drawer = page.locator('#previewExifDrawer');
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box.width).toBeGreaterThan(250);
  expect(box.width).toBeLessThanOrEqual(382);
  await page.locator('#tabSettingsBtn').click();
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('photo and generated WebM can be switched in the live preview', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: createJpeg() },
    { name: 'clip.webm', mimeType: 'video/webm', buffer: createWebm() },
  ]);
  await expect(page.locator('#preview-1')).toBeVisible();
  await expect(page.locator('#preview-2')).toBeVisible();
  await page.locator('#preview-2').click();
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  await expect(page.locator('#previewVideoBar')).toBeVisible();
  await page.locator('#preview-1').click();
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);
  expect(await page.locator('#livePreviewVideo').evaluate(video => ({
    hasSource: video.hasAttribute('src'),
    hasObjectUrl: !!video._objUrl,
    hasSourceId: !!video._srcId,
    paused: video.paused,
  }))).toEqual({ hasSource: false, hasObjectUrl: false, hasSourceId: false, paused: true });
});

test('photo card and preview Blob URLs are revoked after rerender and removal', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__blobUrls = { created: new Set(), revoked: new Set() };
    URL.createObjectURL = value => {
      const url = create(value);
      window.__blobUrls.created.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      window.__blobUrls.revoked.add(url);
      revoke(url);
    };
  });
  await page.reload();
  await uploadJpegs(page);
  await page.locator('#langToggleBtn').click();
  await page.locator('[data-action="remove"]').click();
  await expect(page.locator('#destructiveConfirmModal')).toHaveClass(/open/);
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect.poll(() => page.evaluate(() => ({
    created: window.__blobUrls.created.size,
    revoked: window.__blobUrls.revoked.size,
    active: [...window.__blobUrls.created].filter(url => !window.__blobUrls.revoked.has(url)).length,
  }))).toEqual({ created: 3, revoked: 3, active: 0 });
});

test('custom delete confirmation supports cancel, Escape, focus, and clear all', async ({ page }) => {
  await uploadJpegs(page, 2);
  const firstRemove = page.locator('#item-1 [data-action="remove"]');
  await firstRemove.focus();
  await firstRemove.press('Enter');
  await expect(page.locator('#destructiveConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#destructiveConfirmCancelBtn')).toBeFocused();
  const modalAxe = await new AxeBuilder({ page }).include('#destructiveConfirmModal').analyze();
  expect(modalAxe.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(firstRemove).toBeFocused();
  await expect(page.locator('#item-1')).toBeVisible();
  await firstRemove.press('Enter');
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('#item-1')).toHaveCount(0);
  await expect(page.locator('#preview-2')).toBeFocused();

  await page.locator('#clearAllBtn').click();
  await expect(page.locator('#destructiveConfirmTitle')).toContainText(/workspace|作業領域/i);
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('.image-card')).toHaveCount(0);
  await expect(page.locator('#fileInput')).toBeFocused();
});

test('WebM input exports a decodable framed video', async ({ page }) => {
  test.skip(process.platform === 'win32', 'Headless Chromium on Windows intermittently crashes while recording canvas video');
  await page.locator('#fileInput').setInputFiles({
    name: 'clip.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/clip_frame\.(webm|mp4)$/i);
  const filePath = await download.path();
  const bytes = await fs.readFile(filePath);
  expect(bytes.length).toBeGreaterThan(100);

  const mediaInfo = await page.evaluate(async ({ base64, mimeType }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const video = document.createElement('video');
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Exported video could not be decoded'));
    });
    const info = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    URL.revokeObjectURL(url);
    return info;
  }, {
    base64: bytes.toString('base64'),
    mimeType: download.suggestedFilename().endsWith('.mp4') ? 'video/mp4' : 'video/webm',
  });
  expect(mediaInfo.duration).toBeGreaterThan(0);
  expect(mediaInfo.width).toBeGreaterThan(0);
  expect(mediaInfo.height).toBeGreaterThan(0);
});

test('video export preserves an input audio track', async ({ page }) => {
  test.skip(process.platform === 'win32', 'Headless Chromium on Windows crashes while recording a canvas stream with audio');
  const fixture = await loadAudioVideoFixture();
  await page.locator('#fileInput').setInputFiles({
    name: 'clip-with-audio.webm',
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/clip-with-audio_frame\.(webm|mp4)$/i);
  const filePath = await download.path();
  const bytes = await fs.readFile(filePath);
  expect(bytes.length).toBeGreaterThan(100);

  const mediaInfo = await page.evaluate(async ({ base64, mimeType }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: mimeType });
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Exported video could not be decoded'));
    });
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 200));
    const captured = video.captureStream();
    const info = {
      duration: video.duration,
      videoTracks: captured.getVideoTracks().length,
      audioTracks: captured.getAudioTracks().length,
    };
    video.pause();
    captured.getTracks().forEach(track => track.stop());
    URL.revokeObjectURL(video.src);
    return info;
  }, {
    base64: bytes.toString('base64'),
    mimeType: download.suggestedFilename().endsWith('.mp4') ? 'video/mp4' : 'video/webm',
  });
  expect(mediaInfo.duration).toBeGreaterThan(0);
  expect(mediaInfo.videoTracks).toBeGreaterThan(0);
  expect(mediaInfo.audioTracks).toBeGreaterThan(0);
});
