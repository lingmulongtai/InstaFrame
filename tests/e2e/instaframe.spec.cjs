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
  await expect(page.locator('#locationPrivacyCloseBtn')).toHaveAttribute('aria-label', /close|閉じる/i);
  const consent = await new AxeBuilder({ page }).include('#locationPrivacyModal').analyze();
  expect(consent.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);
});

test('translated dynamic controls and location icon radio state stay synchronized', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await page.locator('label[for="bg-blur"]').click();
  await expect(page.locator('#blurRadiusRange')).toHaveAccessibleName('Radius');
  await expect(page.locator('#blurStyleSelect')).toHaveAccessibleName('Style');
  await expect(page.locator('#blurBrightnessRange')).toHaveAccessibleName('Brightness');

  await page.locator('label:has(#showLocation)').click();
  await page.locator('.icon-pick-btn[data-icon="pin"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.icon-pick-btn[data-icon="dot"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.icon-pick-btn[data-icon="dot"]')).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.icon-pick-btn[data-icon="pin"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.icon-pick-btn[data-icon="dot"]')).toHaveAttribute('aria-checked', 'false');

  await page.locator('#langToggleBtn').click();
  await expect(page.locator('#blurRadiusRange')).toHaveAccessibleName('強さ');
  await expect(page.locator('#blurStyleSelect')).toHaveAccessibleName('スタイル');
  await expect(page.locator('.icon-pick-btn[data-icon="pin"]')).toHaveAttribute('aria-label', 'ピン');
});

test('share dialog supports axe, Escape, and focus return', async ({ page }) => {
  await page.locator('#shareAppBtn').focus();
  await page.locator('#shareAppBtn').press('Enter');
  await expect(page.locator('#shareAppModal')).toHaveClass(/open/);
  await expect(page.locator('#shareAppCloseBtn')).toBeFocused();
  const results = await new AxeBuilder({ page }).include('#shareAppModal').analyze();
  expect(results.violations.filter(violation => ['critical', 'serious'].includes(violation.impact))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#shareAppModal')).not.toHaveClass(/open/);
  await expect(page.locator('#shareAppBtn')).toBeFocused();
});

test('video shortcuts do not steal Space from destructive dialog buttons', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'keyboard-video.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  const remove = page.locator('[data-action="remove"]');
  await remove.focus();
  await remove.press('Space');
  await expect(page.locator('#destructiveConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#destructiveConfirmCancelBtn')).toBeFocused();
  await page.locator('#destructiveConfirmCancelBtn').press('Space');
  await expect(page.locator('#destructiveConfirmModal')).not.toHaveClass(/open/);
  await expect(page.locator('#item-1')).toBeVisible();
  await expect(remove).toBeFocused();
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
  await expect(page.locator('#tabPreviewBtn')).toHaveAttribute('aria-controls', 'dropZone');
  await expect(page.locator('#tabPhotosBtn')).toHaveAttribute('aria-controls', 'photosPanel');
  await expect(page.locator('#tabSettingsBtn')).toHaveAttribute('aria-controls', 'settingsPanel');
  expect(await page.locator('#dropZone').evaluate(element => ({ hidden: element.hidden, inert: element.inert }))).toEqual({ hidden: false, inert: false });
  expect(await page.locator('#photosPanel').evaluate(element => ({ hidden: element.hidden, inert: element.inert }))).toEqual({ hidden: true, inert: true });
  expect(await page.locator('#settingsPanel').evaluate(element => ({ hidden: element.hidden, inert: element.inert }))).toEqual({ hidden: true, inert: true });
  await page.locator('#tabPreviewBtn').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tabPhotosBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tabPhotosBtn')).toBeFocused();
  expect(await page.locator('#dropZone').evaluate(element => ({ hidden: element.hidden, inert: element.inert }))).toEqual({ hidden: true, inert: true });
  expect(await page.locator('#photosPanel').evaluate(element => ({ hidden: element.hidden, inert: element.inert }))).toEqual({ hidden: false, inert: false });
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

test('ZIP creation stops before aggregate browser memory exceeds its safe peak', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await expect(page.locator('#status-badge-2 .status-dot')).toHaveClass(/done/);

  await page.evaluate(async () => {
    const JSZipCtor = await window.loadVendorScript('vendor/jszip.min.js', 'JSZip');
    window.__zipGenerateCalled = false;
    const originalGenerate = JSZipCtor.prototype.generateAsync;
    JSZipCtor.prototype.generateAsync = function (...args) {
      window.__zipGenerateCalled = true;
      return originalGenerate.apply(this, args);
    };
    window.FrameEngine.canvasToBlob = async () => {
      const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
      Object.defineProperty(blob, 'size', { value: 160 * 1024 * 1024 });
      return blob;
    };
  });

  await page.locator('#downloadAllBtn').click();
  await expect(page.locator('#toast')).toContainText(/memory|メモリ/i);
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#downloadAllBtn')).toBeEnabled();
  expect(await page.evaluate(() => window.__zipGenerateCalled)).toBe(false);
});

test('photo export refuses a browser MIME fallback instead of mislabelling the file', async ({ page }) => {
  await uploadJpegs(page);
  await page.locator('label[for="fmt-webp"]').click();
  await page.evaluate(() => {
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function forcedFallback(callback, type, quality) {
      if (type === 'image/webp') {
        callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
        return;
      }
      nativeToBlob.call(this, callback, type, quality);
    };
  });
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });
  await page.locator('#dl-btn-1').click();
  await expect(page.locator('#toast')).toContainText(/could not finish|完了できません/);
  expect(downloadCount).toBe(0);
});

test('video export controls disappear when MediaRecorder supports no output MIME', async ({ page }) => {
  await page.evaluate(() => {
    window.MediaRecorder.isTypeSupported = () => false;
    window.initVideoFormatOptions();
  });
  await expect(page.locator('#videoFormatPills input[name="exportVideoFormat"]')).toHaveCount(0);
  await expect(page.locator('#videoFormatPills [role="status"]')).toContainText(/unavailable|書き出せません/i);
  const disabledBitrates = await page.locator('input[name="exportVideoBitrate"]:disabled').count();
  const allBitrates = await page.locator('input[name="exportVideoBitrate"]').count();
  expect(disabledBitrates).toBe(allBitrates);
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

test('a release revision follows the app into lazy EXIF and ZIP dependencies', async ({ page }) => {
  const revision = 'abcdef123456';
  await page.route('http://127.0.0.1:4173/', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /\b(src|href)="((?:js|css|vendor)\/[^"?]+)"/g,
      `$1="$2?v=${revision}"`
    );
    await route.fulfill({ response, body });
  });
  const requested = [];
  page.on('request', request => requested.push(request.url()));
  await page.reload();

  await uploadJpegs(page, 2);
  await expect(page.locator('#live-exif-make')).toHaveValue('FUJIFILM');
  await expect(page.locator('#live-exif-model')).toHaveValue('X-T5');
  await expect(page.locator('#live-exif-lens')).toHaveValue('XF35mmF1.4 R');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadAllBtn').click();
  await downloadPromise;

  const exifrUrl = new URL(requested.find(url => url.includes('/vendor/exifr.js')));
  const jszipUrl = new URL(requested.find(url => url.includes('/vendor/jszip.min.js')));
  expect(exifrUrl.searchParams.get('v')).toBe(revision);
  expect(jszipUrl.searchParams.get('v')).toBe(revision);
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

test('batch import only prewarms the selected photo decode', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    window.__fileUrlCounts = {};
    URL.createObjectURL = value => {
      if (value instanceof File && value.name) {
        window.__fileUrlCounts[value.name] = (window.__fileUrlCounts[value.name] || 0) + 1;
      }
      return create(value);
    };
  });
  await page.reload();
  await uploadJpegs(page, 3);
  await expect.poll(() => page.evaluate(() => window.__fileUrlCounts)).toEqual({
    'photo-1.jpg': 2,
    'photo-2.jpg': 1,
    'photo-3.jpg': 1,
  });
});

test('video thumbnail decoding is limited to two active jobs', async ({ page }) => {
  await page.evaluate(async () => {
    const releases = [];
    window.__thumbnailStats = { active: 0, peak: 0, completed: 0, releases };
    window.FrameEngine.captureVideoFrame = () => new Promise(resolve => {
      const stats = window.__thumbnailStats;
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      releases.push(() => {
        stats.active -= 1;
        stats.completed += 1;
        resolve({});
      });
    });
    window.FrameEngine.renderFrameWhenReady = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 60;
      return canvas;
    };
    await window.addFiles(Array.from({ length: 6 }, (_, index) => (
      new File(['video'], `queued-${index}.webm`, { type: 'video/webm' })
    )));
  });

  await expect.poll(() => page.evaluate(() => window.__thumbnailStats.peak)).toBe(2);
  await page.evaluate(async () => {
    const stats = window.__thumbnailStats;
    while (stats.completed < 6) {
      stats.releases.splice(0).forEach(release => release());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
  expect(await page.evaluate(() => ({
    peak: window.__thumbnailStats.peak,
    completed: window.__thumbnailStats.completed,
  }))).toEqual({ peak: 2, completed: 6 });
});

test('duplicate photo exports are coalesced and removal discards stale output', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    window.__photoRenderCalls = 0;
    window.__releasePhotoRender = null;
    window.__stalePhotoCanvas = null;
    window.FrameEngine.loadImage = async () => ({ naturalWidth: 480, naturalHeight: 320 });
    window.FrameEngine.renderFrameWhenReady = () => new Promise(resolve => {
      window.__photoRenderCalls += 1;
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      window.__stalePhotoCanvas = canvas;
      window.__releasePhotoRender = () => resolve(canvas);
    });
    window.__firstPhotoJob = window.applyAndDownloadSingle(1);
    window.__secondPhotoJob = window.applyAndDownloadSingle(1);
  });
  await expect.poll(() => page.evaluate(() => window.__photoRenderCalls)).toBe(1);
  await page.evaluate(async () => {
    await window.removeItem(1, { skipConfirm: true });
    window.__releasePhotoRender();
    await Promise.all([window.__firstPhotoJob, window.__secondPhotoJob]);
  });
  await expect(page.locator('#item-1')).toHaveCount(0);
  expect(await page.evaluate(() => ({
    calls: window.__photoRenderCalls,
    width: window.__stalePhotoCanvas.width,
    height: window.__stalePhotoCanvas.height,
  }))).toEqual({ calls: 1, width: 0, height: 0 });
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

test('photo cancellation aborts the active image decoder and restores pending state', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    window.__photoAbortObserved = false;
    window.FrameEngine.loadImage = (_file, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        window.__photoAbortObserved = true;
        reject(new DOMException('Image load cancelled', 'AbortError'));
      }, { once: true });
    });
  });
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#exportProgress')).toBeVisible();
  await page.locator('#cancelExportBtn').click();
  await expect.poll(() => page.evaluate(() => window.__photoAbortObserved)).toBe(true);
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
});

test('aborting an image decode revokes its temporary Blob URL', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'cancel-decode.jpg', { type: 'image/jpeg' });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const active = new Set();
    URL.createObjectURL = value => {
      const url = create(value);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      active.delete(url);
      revoke(url);
    };
    const controller = new AbortController();
    const pending = window.FrameEngine.loadImage(file, { signal: controller.signal });
    controller.abort();
    let errorName = '';
    try {
      await pending;
    } catch (error) {
      errorName = error.name;
    }
    return { errorName, activeUrls: active.size };
  }, { base64: createJpeg().toString('base64') });

  expect(result).toEqual({ errorName: 'AbortError', activeUrls: 0 });
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

  await page.locator('#zoomRange').evaluate(element => {
    element.value = '800';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.previewBackingScale))).toBeGreaterThanOrEqual(7.9);
});

test('large preview downscaling stays lossless and avoids a JPEG round-trip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const source = document.createElement('canvas');
    source.width = 200;
    source.height = 100;
    const sourceContext = source.getContext('2d');
    const gradient = sourceContext.createLinearGradient(0, 0, source.width, source.height);
    gradient.addColorStop(0, '#ff0000');
    gradient.addColorStop(1, '#0000ff');
    sourceContext.fillStyle = gradient;
    sourceContext.fillRect(0, 0, source.width, source.height);

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    let toBlobCalls = 0;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      toBlobCalls += 1;
      return originalToBlob.apply(this, args);
    };
    try {
      const output = await window.FrameEngine.renderFrameWhenReady(
        source,
        {},
        {},
        { maxPreviewPx: 50 }
      );
      const dimensions = { width: output.width, height: output.height };
      output.width = 0;
      output.height = 0;
      return { toBlobCalls, dimensions };
    } finally {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      source.width = 0;
      source.height = 0;
    }
  });

  expect(result.toBlobCalls).toBe(0);
  expect(result.dimensions.width).toBeGreaterThan(50);
  expect(result.dimensions.width).toBeLessThan(60);
});

test('MediaRecorder setup exceptions reject and revoke their source URL', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'setup-failure.webm', { type: 'video/webm' });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const active = new Set();
    URL.createObjectURL = value => {
      const url = create(value);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      active.delete(url);
      revoke(url);
    };
    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = () => { throw new Error('simulated captureStream failure'); };
    let message = '';
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { preserveAudio: true });
    } catch (error) {
      message = error.message;
    } finally {
      HTMLCanvasElement.prototype.captureStream = originalCaptureStream;
    }
    return { message, activeUrls: active.size };
  }, { base64: createWebm().toString('base64') });

  expect(result.message).toContain('simulated captureStream failure');
  expect(result.activeUrls).toBe(0);
});

test('auto preview stays pixel-dense through 800% zoom', async ({ page }) => {
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
    element.value = '800';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#zoomLabel')).toHaveText('800%');
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.previewSourceLimit))).toBe(5120);
  await expect.poll(() => canvas.evaluate(element => element.width / parseFloat(element.style.width))).toBeGreaterThanOrEqual(7.9);
  const backing = await canvas.evaluate(element => ({
    pixels: element.width * element.height,
    budget: Number(element.dataset.previewPixelBudget),
  }));
  expect(backing.pixels).toBeLessThanOrEqual(backing.budget + 10_000);

  await page.locator('[data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect.poll(() => canvas.evaluate(element => ({ width: element.width, height: element.height })))
    .toEqual({ width: 0, height: 0 });
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
  await expect(page.locator('#photosPanel')).toBeVisible();
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
  await page.locator('#tabPhotosBtn').click();
  await expect(page.locator('#photosPanel')).toBeVisible();
  await expect(page.locator('#imageSection')).toBeVisible();
  await expect(page.locator('#emptyHint')).toBeHidden();
  await page.locator('#tabSettingsBtn').click();
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(await page.locator('#dropZone').evaluate(element => element.inert)).toBe(true);
  expect(await page.locator('#photosPanel').evaluate(element => element.inert)).toBe(true);
  expect(await page.locator('#settingsPanel').evaluate(element => element.inert)).toBe(false);
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
