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

async function installFakeWebCodecs(page) {
  await page.evaluate(() => {
    const resources = {
      activeUrls: new Set(),
      canvases: [],
      videos: [],
      encoders: [],
      closedFrames: 0,
    };
    window.__webCodecsResources = resources;

    const createUrl = URL.createObjectURL.bind(URL);
    const revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => {
      const url = createUrl(value);
      resources.activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      resources.activeUrls.delete(url);
      revokeUrl(url);
    };

    const createElement = document.createElement.bind(document);
    document.createElement = (tagName, options) => {
      const element = createElement(tagName, options);
      if (String(tagName).toLowerCase() === 'canvas') resources.canvases.push(element);
      if (String(tagName).toLowerCase() === 'video') resources.videos.push(element);
      return element;
    };

    window.VideoFrame = class FakeVideoFrame {
      close() { resources.closedFrames += 1; }
    };
    window.VideoEncoder = class FakeVideoEncoder {
      constructor(init) {
        this.init = init;
        this.state = 'unconfigured';
        resources.encoders.push(this);
      }
      configure() { this.state = 'configured'; }
      encode() { this.init.output({}, {}); }
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed'; }
    };
    class FakeTarget {
      constructor() { this.buffer = null; }
    }
    class FakeMuxer {
      constructor({ target }) { this.target = target; }
      addVideoChunk() {}
      finalize() { this.target.buffer = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer; }
    }
    window.WebMMuxer = { Muxer: FakeMuxer, ArrayBufferTarget: FakeTarget };
  });
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

test('initial translated UI exposes the matching document language', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'ja'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#dropZone')).toContainText('ここに写真をドロップ');

  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#dropZone')).toContainText('Drop photos here');
});

test('empty import focus is visible and leaves the tab order after media is added', async ({ page }) => {
  const input = page.locator('#fileInput');
  await input.focus();
  await expect(input).toBeFocused();
  await expect(page.locator('.preview-empty-cta')).toHaveCSS('outline-style', 'solid');

  await uploadJpegs(page);

  await expect(input).toHaveAttribute('tabindex', '-1');
  await input.focus();
  await page.evaluate(() => window.updateUI());
  await expect(page.locator('#preview-1')).toBeFocused();
});

test('workspace resize separators support keyboard control and expose their values', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await uploadJpegs(page);

  const sidebarHandle = page.locator('#sidebarResizeHandle');
  await expect(sidebarHandle).toHaveRole('separator');
  await expect(sidebarHandle).toHaveAccessibleName('Resize settings panel');
  const sidebarBefore = Number(await sidebarHandle.getAttribute('aria-valuenow'));
  await sidebarHandle.focus();
  await sidebarHandle.press('ArrowRight');
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', String(sidebarBefore + 10));

  const mainHandle = page.locator('#mainResizeHandle');
  await expect(mainHandle).toBeVisible();
  await expect(mainHandle).toHaveRole('separator');
  await expect(mainHandle).toHaveAccessibleName('Resize preview panel');
  const previewBefore = Number(await mainHandle.getAttribute('aria-valuenow'));
  await mainHandle.focus();
  await mainHandle.press('ArrowDown');
  await expect(mainHandle).toHaveAttribute('aria-valuenow', String(previewBefore + 10));

  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('instaframe_prefs')));
  expect(prefs.sidebarWidth).toBe(sidebarBefore + 10);
  expect(prefs.previewHeight).toBe(`${previewBefore + 10}px`);

  const audit = await new AxeBuilder({ page })
    .include('#sidebarResizeHandle')
    .include('#mainResizeHandle')
    .analyze();
  expect(audit.violations).toEqual([]);

  await page.locator('#langToggleBtn').click();
  await expect(sidebarHandle).toHaveAccessibleName('設定パネルの幅を変更');
  await expect(mainHandle).toHaveAccessibleName('プレビューパネルの高さを変更');
});

test('every BFCache pagehide releases Blob URLs and restores a usable pending preview', async ({ page }) => {
  await page.evaluate(() => {
    const active = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => {
      const url = create(value);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      active.delete(url);
      revoke(url);
    };
    window.__activePageObjectUrls = active;
  });
  await uploadJpegs(page);
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await page.evaluate(() => window.triggerDownload(new Blob(['download']), 'resource-check.txt'));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBe(0);
  await expect(page.locator('#livePreviewCanvas')).toHaveJSProperty('width', 0);
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#livePreviewCanvas')).toBeVisible();
  await expect.poll(() => page.locator('#livePreviewCanvas').evaluate(canvas => canvas.width)).toBeGreaterThan(0);

  await page.evaluate(() => window.triggerDownload(new Blob(['download-again']), 'resource-check-2.txt'));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBe(0);
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

test('language switching preserves card identity, selection, and video thumbnails', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await page.locator('#fileInput').setInputFiles([
    {
      name: 'remove-before-language.jpg',
      mimeType: 'image/jpeg',
      buffer: createJpeg(),
    },
    {
      name: 'selected-video.webm',
      mimeType: 'video/webm',
      buffer: createWebm(),
    },
  ]);

  await expect(page.locator('#item-2 canvas.thumb-framed')).toBeVisible();
  await page.locator('#preview-2').click();
  await page.locator('#item-1 [data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('#preview-2')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#langToggleBtn').click();

  await expect(page.locator('#item-1')).toHaveCount(0);
  await expect(page.locator('#item-2 canvas.thumb-framed')).toBeVisible();
  await expect(page.locator('#preview-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#preview-2')).toHaveAttribute('aria-label', /selected-video\.webm/);
});

test('settings changes preserve a generated video thumbnail while re-encoding is pending', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'settings-video.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  const thumbnail = page.locator('#item-1 canvas.thumb-framed');
  await expect(thumbnail).toBeVisible();
  await page.evaluate(() => {
    window.FrameEngine.renderVideoFrameWhenReady = async () => new Blob(
      [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])],
      { type: 'video/webm' }
    );
  });

  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await expect(thumbnail).toBeVisible();

  await page.locator('#thicknessRange').evaluate(input => {
    input.value = '1.1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
  await expect(thumbnail).toBeVisible();
  await expect(page.locator('#item-1 img.thumb-orig')).toBeHidden();
});

test('share dialog supports axe, Escape, and focus return', async ({ page }) => {
  await page.locator('#shareAppBtn').focus();
  await page.locator('#shareAppBtn').press('Enter');
  await expect(page.locator('#shareAppModal')).toHaveClass(/open/);
  await expect(page.locator('#shareAppCloseBtn')).toBeFocused();
  const results = await new AxeBuilder({ page }).include('#shareAppModal').analyze();
  expect(results.violations.filter(violation => ['critical', 'serious'].includes(violation.impact))).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await page.locator('#copyShareUrlBtn').click();
  const status = page.locator('#shareModalStatus');
  await expect(status).toContainText(/copied|コピー/i);
  expect(await status.evaluate(element => element.closest('[aria-modal="true"]')?.id)).toBe('shareAppModal');
  await expect(page.locator('#toast')).not.toHaveAttribute('role', /.+/);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
  });
  await page.locator('#copyShareUrlBtn').click();
  await expect(status).toContainText(/could not|できません/i);
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

test('modal background stays inert and focus remains in the dialog across responsive changes', async ({ page }) => {
  await uploadJpegs(page);
  const remove = page.locator('[data-action="remove"]');
  await remove.focus();
  await remove.press('Enter');
  const modal = page.locator('#destructiveConfirmModal');
  await expect(page.locator('#destructiveConfirmCancelBtn')).toBeFocused();
  expect(await page.locator('.app-shell').evaluate(element => element.inert)).toBe(true);
  expect(await page.locator('#mobileTabBar').evaluate(element => element.inert)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(remove).toBeFocused();
  expect(await page.locator('.app-shell').evaluate(element => element.inert)).toBe(false);
  expect(await page.locator('#mobileTabBar').evaluate(element => element.inert)).toBe(false);
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
  await expect(page.locator('.accent-cyan')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.accent-blue').click();
  await expect(page.locator('.accent-blue')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.accent-cyan')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#accentColorPicker').evaluate(element => {
    element.value = '#123456';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#accentCustomBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.accent-blue')).toHaveAttribute('aria-pressed', 'false');
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

test('responsive transitions keep focus in the matching workspace panel', async ({ page }) => {
  await uploadJpegs(page);

  const photoPreview = page.locator('#preview-1');
  await photoPreview.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabPhotosBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(photoPreview).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  const fontSelect = page.locator('#fontFamily');
  await fontSelect.focus();
  await page.evaluate(() => document.body.setAttribute('data-mobile-tab', 'photos'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabSettingsBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(fontSelect).toBeFocused();

  await page.locator('#tabSettingsBtn').focus();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('#customizeBtn')).toBeFocused();
});

test('mobile import moves focus to a visible preview control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const input = page.locator('#fileInput');
  await input.focus();
  await input.setInputFiles({
    name: 'mobile-focus.jpg',
    mimeType: 'image/jpeg',
    buffer: createJpeg(),
  });
  await expect(page.locator('#tabPreviewBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#previewQualityBtn')).toBeFocused();
  expect(await page.locator('#photosPanel').evaluate(element => element.inert)).toBe(true);
});

test('privacy consent changes expose a focused polite status update', async ({ page }) => {
  await page.locator('#customizeBtn').click();
  const status = page.locator('#locationPrivacyStatus');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');

  const manage = page.locator('#manageLocationPrivacyBtn');
  await manage.click();
  await page.locator('#locationPrivacyAlwaysBtn').click();
  await expect(manage).toBeFocused();
  await expect(status).toContainText(/always|常に/i);

  await manage.click();
  await page.locator('#locationPrivacyRevokeBtn').click();
  await expect(manage).toBeFocused();
  await expect(status).toContainText(/off|オフ/i);
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

test('an unsupported video thumbnail is decoded only once before reporting an error', async ({ page }) => {
  await page.evaluate(() => {
    window.__thumbnailDecodeAttempts = 0;
    window.FrameEngine.captureVideoFrame = async () => {
      window.__thumbnailDecodeAttempts += 1;
      throw new Error('simulated unsupported codec');
    };
  });
  await page.locator('#fileInput').setInputFiles({
    name: 'unsupported-once.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/error/);
  expect(await page.evaluate(() => window.__thumbnailDecodeAttempts)).toBe(1);
});

test('a hung browser video decoder exits pending state through the app-level guard', async ({ page }) => {
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 25 : delay, ...args)
    );
    window.FrameEngine.captureVideoFrame = () => new Promise(() => {});
  });
  await page.locator('#fileInput').setInputFiles({
    name: 'hung-decoder.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#status-badge-1')).toHaveAttribute('aria-label', /decode|デコード/i);
});

test('thumbnail cancellation ignores a late canvas encoder callback without leaking a Blob URL', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const nativeCreateElement = document.createElement.bind(document);
    const nativeCreateUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeUrl = URL.revokeObjectURL.bind(URL);
    const activeUrls = new Set();
    URL.createObjectURL = value => {
      const url = nativeCreateUrl(value);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      activeUrls.delete(url);
      nativeRevokeUrl(url);
    };

    let encoderCallback = null;
    CanvasRenderingContext2D.prototype.drawImage = () => {};
    HTMLCanvasElement.prototype.toBlob = callback => { encoderCallback = callback; };
    window.Image = class PendingThumbnailImage {
      set src(value) { this._src = value; }
      removeAttribute(name) { if (name === 'src') this._src = ''; }
    };
    document.createElement = (tagName, options) => {
      if (String(tagName).toLowerCase() !== 'video') return nativeCreateElement(tagName, options);
      return {
        duration: 1,
        videoWidth: 320,
        videoHeight: 180,
        pause() {},
        removeAttribute() {},
        load() { queueMicrotask(() => this.onloadedmetadata?.()); },
        set currentTime(value) {
          this._currentTime = value;
          queueMicrotask(() => this.onseeked?.());
        },
      };
    };

    const controller = new AbortController();
    const pending = window.FrameEngine.captureVideoFrame(
      new File(['video'], 'late-thumbnail.webm', { type: 'video/webm' }),
      0,
      { signal: controller.signal }
    ).catch(error => error.name);
    while (!encoderCallback) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;
    encoderCallback(new Blob(['late'], { type: 'image/jpeg' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    return { outcome, activeUrls: activeUrls.size };
  });

  expect(result).toEqual({ outcome: 'AbortError', activeUrls: 0 });
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

test('ZIP cancellation interrupts a pending photo canvas encode', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    window.__photoEncodeStarted = false;
    window.__pendingPhotoEncodeCallback = null;
    HTMLCanvasElement.prototype.toBlob = callback => {
      window.__photoEncodeStarted = true;
      window.__pendingPhotoEncodeCallback = callback;
    };
  });
  let downloads = 0;
  page.on('download', () => { downloads += 1; });

  await page.locator('#downloadAllBtn').click();
  await expect.poll(() => page.evaluate(() => window.__photoEncodeStarted)).toBe(true);
  await page.locator('#cancelExportBtn').click();

  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
  await expect(page.locator('#downloadAllBtn')).toBeEnabled();
  await page.evaluate(() => {
    window.__pendingPhotoEncodeCallback(new Blob(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: 'image/jpeg' }
    ));
  });
  await page.waitForTimeout(50);
  expect(downloads).toBe(0);
});

test('single photo cancellation interrupts a pending canvas encode', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    window.__singlePhotoEncodeStarted = false;
    window.__pendingSinglePhotoEncodeCallback = null;
    HTMLCanvasElement.prototype.toBlob = callback => {
      window.__singlePhotoEncodeStarted = true;
      window.__pendingSinglePhotoEncodeCallback = callback;
    };
  });
  let downloads = 0;
  page.on('download', () => { downloads += 1; });

  await page.locator('#dl-btn-1').click();
  await expect.poll(() => page.evaluate(() => window.__singlePhotoEncodeStarted)).toBe(true);
  await expect(page.locator('#exportProgress')).toBeVisible();
  await page.locator('#cancelExportBtn').click();

  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
  await expect(page.locator('#dl-btn-1')).toBeEnabled();
  await page.evaluate(() => {
    window.__pendingSinglePhotoEncodeCallback(new Blob(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: 'image/jpeg' }
    ));
  });
  await page.waitForTimeout(50);
  expect(downloads).toBe(0);
});

test('removing a photo during its final encode discards the stale download', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    window.__singlePhotoEncodeStarted = false;
    window.__pendingSinglePhotoEncodeCallback = null;
    HTMLCanvasElement.prototype.toBlob = callback => {
      window.__singlePhotoEncodeStarted = true;
      window.__pendingSinglePhotoEncodeCallback = callback;
    };
  });
  let downloads = 0;
  page.on('download', () => { downloads += 1; });

  await page.locator('#dl-btn-1').click();
  await expect.poll(() => page.evaluate(() => window.__singlePhotoEncodeStarted)).toBe(true);
  await page.locator('#item-1 [data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('#item-1')).toHaveCount(0);
  await expect(page.locator('#exportProgress')).toBeHidden();

  await page.evaluate(() => {
    window.__pendingSinglePhotoEncodeCallback(new Blob(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: 'image/jpeg' }
    ));
  });
  await page.waitForTimeout(50);
  expect(downloads).toBe(0);
});

test('batch generation reports failed items instead of announcing complete success', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    const render = window.FrameEngine.renderFrameWhenReady;
    let calls = 0;
    window.FrameEngine.renderFrameWhenReady = (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated batch render failure');
      return render(...args);
    };
  });

  await page.locator('#generateAllBtn').click();

  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#imageGrid .status-dot.error')).toHaveCount(1);
  await expect(page.locator('#imageGrid .status-dot.done')).toHaveCount(1);
  await expect(page.locator('#toast')).toContainText('Frames that could not be generated: 1');
  await expect(page.locator('#toast')).not.toContainText('All frames generated');
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

test('MediaRecorder drawing failures reject and stop active output resources', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'draw-failure.webm', { type: 'video/webm' });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const activeUrls = new Set();
    URL.createObjectURL = value => {
      const url = create(value);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      activeUrls.delete(url);
      revoke(url);
    };

    const outputTrack = { stopped: false, stop() { this.stopped = true; } };
    const outputStream = {
      addTrack() {},
      getTracks() { return [outputTrack]; },
    };
    HTMLCanvasElement.prototype.captureStream = () => outputStream;
    const recorders = [];
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() {
        this.state = 'inactive';
        recorders.push(this);
      }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => this.onstop?.());
      }
    };

    let message = '';
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
        preserveAudio: true,
        onProgress: () => { throw new Error('simulated draw loop failure'); },
      });
    } catch (error) {
      message = error.message;
    }
    return {
      message,
      activeUrls: activeUrls.size,
      recorderStates: recorders.map(recorder => recorder.state),
      outputTrackStopped: outputTrack.stopped,
    };
  }, { base64: createWebm().toString('base64') });

  expect(result).toEqual({
    message: 'simulated draw loop failure',
    activeUrls: 0,
    recorderStates: ['inactive'],
    outputTrackStopped: true,
  });
});

test('WebCodecs video success closes its encoder and releases temporary media', async ({ page }) => {
  await installFakeWebCodecs(page);
  const fixture = await loadAudioVideoFixture();
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'webcodecs-success.webm', { type: 'video/webm' });
    const blob = await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { preserveAudio: false });
    const resources = window.__webCodecsResources;
    return {
      blobType: blob.type,
      blobSize: blob.size,
      activeUrls: resources.activeUrls.size,
      encoderStates: resources.encoders.map(encoder => encoder.state),
      canvasSizes: resources.canvases.map(canvas => [canvas.width, canvas.height]),
      videoSources: resources.videos.map(video => video.hasAttribute('src')),
      closedFrames: resources.closedFrames,
    };
  }, { base64: fixture.buffer.toString('base64') });

  expect(result.blobType).toBe('video/webm');
  expect(result.blobSize).toBe(4);
  expect(result.activeUrls).toBe(0);
  expect(result.encoderStates).toEqual(['closed']);
  expect(result.canvasSizes).toEqual([[0, 0]]);
  expect(result.videoSources).toEqual([false]);
  expect(result.closedFrames).toBeGreaterThan(0);
});

test('WebCodecs video cancellation does not fall through and releases its resources', async ({ page }) => {
  await installFakeWebCodecs(page);
  await page.evaluate(({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'webcodecs-cancel.webm', { type: 'video/webm' });
    window.__webCodecsAbortController = new AbortController();
    window.__webCodecsAbortResult = { state: 'pending' };
    const configure = window.VideoEncoder.prototype.configure;
    window.VideoEncoder.prototype.configure = function (...args) {
      const result = configure.apply(this, args);
      queueMicrotask(() => window.__webCodecsAbortController.abort());
      return result;
    };
    window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
      preserveAudio: false,
      signal: window.__webCodecsAbortController.signal,
    }).then(
      () => { window.__webCodecsAbortResult = { state: 'resolved' }; },
      error => { window.__webCodecsAbortResult = { state: 'rejected', name: error.name }; }
    );
  }, { base64: createWebm().toString('base64') });

  await expect.poll(() => page.evaluate(() => window.__webCodecsAbortResult)).toEqual({ state: 'rejected', name: 'AbortError' });
  const resources = await page.evaluate(() => ({
    activeUrls: window.__webCodecsResources.activeUrls.size,
    encoderStates: window.__webCodecsResources.encoders.map(encoder => encoder.state),
    canvasSizes: window.__webCodecsResources.canvases.map(canvas => [canvas.width, canvas.height]),
    videoSources: window.__webCodecsResources.videos.map(video => video.hasAttribute('src')),
  }));
  expect(resources).toEqual({
    activeUrls: 0,
    encoderStates: ['closed'],
    canvasSizes: [[0, 0]],
    videoSources: [false],
  });
});

test('WebCodecs output limits cannot be bypassed by MediaRecorder fallback', async ({ page }) => {
  await installFakeWebCodecs(page);
  const fixture = await loadAudioVideoFixture();
  const result = await page.evaluate(async ({ base64 }) => {
    window.__mediaRecorderFallbackUsed = false;
    window.WebMMuxer.Muxer.prototype.finalize = function () {
      this.target.buffer = { byteLength: 600 * 1024 * 1024 };
    };
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() {
        window.__mediaRecorderFallbackUsed = true;
        throw new Error('MediaRecorder fallback should not run');
      }
    };
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'webcodecs-limit.webm', { type: 'video/webm' });
    let errorCode = null;
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { preserveAudio: false });
    } catch (error) {
      errorCode = error.code;
    }
    const resources = window.__webCodecsResources;
    return {
      errorCode,
      fallbackUsed: window.__mediaRecorderFallbackUsed,
      activeUrls: resources.activeUrls.size,
      encoderStates: resources.encoders.map(encoder => encoder.state),
      canvasSizes: resources.canvases.map(canvas => [canvas.width, canvas.height]),
    };
  }, { base64: fixture.buffer.toString('base64') });

  expect(result).toEqual({
    errorCode: 'MEDIA_RESOURCE_LIMIT',
    fallbackUsed: false,
    activeUrls: 0,
    encoderStates: ['closed'],
    canvasSizes: [[0, 0]],
  });
});

test('video cancellation interrupts a pending audio-track sample read', async ({ page }) => {
  await page.evaluate(({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'audio-sniff-cancel.webm', { type: 'video/webm' });
    const arrayBuffer = Blob.prototype.arrayBuffer;
    window.__audioSniffStarted = false;
    Blob.prototype.arrayBuffer = function () {
      window.__audioSniffStarted = true;
      return new Promise(() => {});
    };
    window.__audioSniffAbortController = new AbortController();
    window.__audioSniffResult = { state: 'pending' };
    window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
      preserveAudio: true,
      signal: window.__audioSniffAbortController.signal,
    }).then(
      () => { window.__audioSniffResult = { state: 'resolved' }; },
      error => { window.__audioSniffResult = { state: 'rejected', name: error.name }; }
    ).finally(() => { Blob.prototype.arrayBuffer = arrayBuffer; });
  }, { base64: createWebm().toString('base64') });

  await expect.poll(() => page.evaluate(() => window.__audioSniffStarted)).toBe(true);
  await page.evaluate(() => window.__audioSniffAbortController.abort());
  await expect.poll(() => page.evaluate(() => window.__audioSniffResult)).toEqual({ state: 'rejected', name: 'AbortError' });
});

test('auto preview stays pixel-dense through 1200% zoom', async ({ page }) => {
  const largeJpeg = await createBrowserRaster(page, 'image/jpeg', 6400, 4267);
  await page.locator('#fileInput').setInputFiles({
    name: 'large-preview.jpg',
    mimeType: 'image/jpeg',
    buffer: largeJpeg,
  });
  const canvas = page.locator('#livePreviewCanvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => element.width / element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1.95);
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.compositionWidth))).toBeGreaterThan(6000);

  await page.locator('#zoomRange').evaluate(element => {
    element.value = '1200';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#zoomLabel')).toHaveText('1200%');
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.previewSourceLimit))).toBe(6144);
  await expect.poll(() => canvas.evaluate(element => element.width / parseFloat(element.style.width))).toBeGreaterThanOrEqual(11.9);
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

test('revoking location consent cancels an in-flight Mapbox image load', async ({ page }) => {
  let releaseMapRequest;
  await page.route('https://api.mapbox.com/**', async route => {
    await new Promise(resolve => { releaseMapRequest = resolve; });
    await route.abort().catch(() => {});
  });
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (String(value).startsWith('https://api.mapbox.com/')) {
          this.dataset.mapboxRequest = 'true';
          window.__activeMapboxImage = this;
        }
        return descriptor.set.call(this, value);
      },
    });
  });
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({
      locationNetworkConsent: 'always',
      mapboxPublicToken: 'pk.test.test',
    }));
  });
  await page.reload();

  try {
    const mapRequest = page.waitForRequest(request => request.url().startsWith('https://api.mapbox.com/'));
    await page.locator('#fileInput').setInputFiles({
      name: 'map-cancel.jpg',
      mimeType: 'image/jpeg',
      buffer: createJpeg({ gps: true }),
    });
    await page.locator('label:has(#showLocation)').click();
    await page.locator('label:has(#showMapOverlay)').click();
    await mapRequest;
    await expect.poll(() => page.evaluate(() => window.__activeMapboxImage?.hasAttribute('src'))).toBe(true);

    await page.locator('#customizeBtn').click();
    await page.locator('#manageLocationPrivacyBtn').click();
    await page.locator('#locationPrivacyRevokeBtn').click();
    await expect.poll(() => page.evaluate(() => window.__activeMapboxImage?.hasAttribute('src'))).toBe(false);
  } finally {
    releaseMapRequest?.();
  }
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
  await page.keyboard.press('Enter');
  const mapStatus = page.locator('#mapPickerCoords');
  await expect(mapStatus).toContainText(/click on the map|地図をクリック/i);
  expect(await mapStatus.evaluate(element => element.closest('[aria-modal="true"]')?.id)).toBe('mapPickerModal');
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

test('removing the final mobile Photos item focuses the visible import action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await uploadJpegs(page);
  await page.locator('#tabPhotosBtn').click();
  await page.locator('#item-1 [data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();

  await expect(page.locator('#mobileAddBtn')).toBeVisible();
  await expect(page.locator('#mobileAddBtn')).toBeFocused();
  await expect(page.locator('#fileInput')).toHaveAttribute('tabindex', '0');
});

test('mobile Photos empty state opens its own file picker and moves to the preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('#tabPhotosBtn').click();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#mobileAddBtn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'mobile-photos-import.jpg',
    mimeType: 'image/jpeg',
    buffer: createJpeg(),
  });

  await expect(page.locator('#livePreviewCanvas')).toBeVisible();
  await expect(page.locator('#tabPreviewBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#previewQualityBtn')).toBeFocused();
  await expect(page.locator('#dropZone')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#photosPanel')).toHaveAttribute('inert', '');
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

test('photo card and preview Blob URLs remain bounded across language refresh and removal', async ({ page }) => {
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
  await expect.poll(() => page.evaluate(() => (
    [...window.__blobUrls.created].filter(url => !window.__blobUrls.revoked.has(url)).length
  ))).toBe(0);
  const urlCounts = await page.evaluate(() => ({
    created: window.__blobUrls.created.size,
    revoked: window.__blobUrls.revoked.size,
  }));
  expect(urlCounts.created).toBeGreaterThanOrEqual(2);
  expect(urlCounts.revoked).toBe(urlCounts.created);
});

test('removing a card revokes its thumbnail URL even while image events are pending', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const addEventListener = EventTarget.prototype.addEventListener;
    window.__pendingThumbnailUrls = new Set();
    URL.createObjectURL = value => {
      const url = create(value);
      window.__pendingThumbnailUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      window.__pendingThumbnailUrls.delete(url);
      revoke(url);
    };
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLImageElement && this.classList.contains('thumb-orig') && ['load', 'error'].includes(type)) return;
      return addEventListener.call(this, type, listener, options);
    };
  });
  await page.reload();
  await page.locator('#fileInput').setInputFiles({
    name: 'pending-thumbnail.jpg',
    mimeType: 'image/jpeg',
    buffer: createJpeg(),
  });
  await expect(page.locator('#item-1')).toBeVisible();
  await page.locator('#item-1 [data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await expect(page.locator('#item-1')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__pendingThumbnailUrls.size)).toBe(0);
});

test('removal invalidates an in-flight preview before the next debounced render', async ({ page }) => {
  await page.evaluate(() => {
    window.__stalePreviewCanvas = null;
    window.__resolveStalePreview = null;
    window.FrameEngine.renderFrameWhenReady = () => new Promise(resolve => {
      const canvas = document.createElement('canvas');
      canvas.width = 4096;
      canvas.height = 2731;
      window.__stalePreviewCanvas = canvas;
      window.__resolveStalePreview = () => resolve(canvas);
    });
  });
  await page.locator('#fileInput').setInputFiles({
    name: 'stale-preview.jpg',
    mimeType: 'image/jpeg',
    buffer: createJpeg(),
  });
  await expect.poll(() => page.evaluate(() => typeof window.__resolveStalePreview)).toBe('function');
  await page.locator('#item-1 [data-action="remove"]').click();
  await page.locator('#destructiveConfirmAcceptBtn').click();
  await page.evaluate(() => window.__resolveStalePreview());
  await expect.poll(() => page.evaluate(() => ({
    staleWidth: window.__stalePreviewCanvas.width,
    liveWidth: document.getElementById('livePreviewCanvas').width,
  }))).toEqual({ staleWidth: 0, liveWidth: 0 });
});

test('superseded preview work receives an AbortSignal before the next render starts', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => {
    const render = window.FrameEngine.renderFrameWhenReady;
    window.__previewAbortObserved = false;
    window.__previewRenderStarted = false;
    let calls = 0;
    window.FrameEngine.renderFrameWhenReady = (...args) => {
      calls += 1;
      if (calls > 1) return render(...args);
      const signal = args[3].signal;
      window.__previewRenderStarted = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          window.__previewAbortObserved = true;
          reject(new DOMException('Preview cancelled', 'AbortError'));
        }, { once: true });
      });
    };
  });

  await page.locator('label:has(input[name="frameColor"][value="#1a1a1a"])').click();
  await expect.poll(() => page.evaluate(() => window.__previewRenderStarted)).toBe(true);
  await page.locator('label:has(input[name="frameColor"][value="#9E9E9E"])').click();

  await expect.poll(() => page.evaluate(() => window.__previewAbortObserved)).toBe(true);
  await expect.poll(() => page.locator('#livePreviewCanvas').getAttribute('data-composition-width')).not.toBeNull();
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
