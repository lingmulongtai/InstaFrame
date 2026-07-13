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

async function trackCancellationToasts(page) {
  await page.evaluate(() => {
    const nativeShowToast = window.showToast;
    window.__cancellationToastCalls = 0;
    window.showToast = (message, ...args) => {
      if (/cancel|キャンセル/i.test(String(message))) window.__cancellationToastCalls += 1;
      return nativeShowToast(message, ...args);
    };
  });
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
      configure(config) { this.config = config; this.state = 'configured'; }
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

test('every theme keeps dynamic controls and destructive dialogs at WCAG contrast', async ({ page }) => {
  await uploadJpegs(page);
  const themes = [
    { value: 'light', colorScheme: 'light' },
    { value: 'soft-white', colorScheme: 'light' },
    { value: 'blue-grey-dark', colorScheme: 'dark' },
    { value: 'dark', colorScheme: 'dark' },
    { value: 'system', colorScheme: 'light' },
    { value: 'system', colorScheme: 'dark' },
  ];

  for (const { value, colorScheme } of themes) {
    await page.emulateMedia({ colorScheme });
    await page.locator('#customizeBtn').click();
    await page.locator(`.pill-option:has(input[name="themeChoice"][value="${value}"])`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);

    const controlsAudit = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(
      controlsAudit.violations,
      `${value}/${colorScheme} controls: ${JSON.stringify(controlsAudit.violations, null, 2)}`
    ).toEqual([]);

    await page.keyboard.press('Escape');
    await page.locator('[data-action="remove"]').click();
    const dialogAudit = await new AxeBuilder({ page })
      .include('#destructiveConfirmModal')
      .withRules(['color-contrast'])
      .analyze();
    expect(
      dialogAudit.violations,
      `${value}/${colorScheme} dialog: ${JSON.stringify(dialogAudit.violations, null, 2)}`
    ).toEqual([]);
    await page.keyboard.press('Escape');
  }
});

test('initial translated UI exposes the matching document language', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'ja'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#dropZone')).toContainText('ここに写真をドロップ');
  await uploadJpegs(page);
  await expect(page.locator('#status-badge-1 .status-text')).toHaveText('未適用');
  await page.evaluate(() => window.showProgress('処理中…', 0));
  await expect(page.locator('#cancelExportBtn')).toHaveAccessibleName('キャンセル');

  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#dropZone')).toContainText('Drop photos here');
  await uploadJpegs(page);
  await page.evaluate(() => window.showProgress('Processing…', 0));
  await expect(page.locator('#cancelExportBtn')).toHaveAccessibleName('Cancel');
});

test('in-page language changes refresh generated form control names', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await expect(page.locator('#thicknessRange')).toHaveAccessibleName('Frame Thickness');
  await expect(page.locator('#fontFamily')).toHaveAccessibleName('Font');

  await page.locator('#langToggleBtn').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#thicknessRange')).toHaveAccessibleName('フレームの太さ');
  await expect(page.locator('#fontFamily')).toHaveAccessibleName('フォント');
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

test('preview controls leave the tab order until their media state is visible', async ({ page }) => {
  const inactiveGroups = ['previewHistoryWrap', 'previewQualityWrap', 'previewExifWrap', 'previewZoomBar', 'previewResetViewBtn', 'previewVideoBar'];
  for (const id of inactiveGroups) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('inert', '');
    await expect(page.locator(`#${id}`)).toHaveAttribute('aria-hidden', 'true');
  }
  await page.locator('#fileInput').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(ids => ids.some(id => document.getElementById(id)?.contains(document.activeElement)), inactiveGroups)).toBe(false);

  await page.locator('#fileInput').setInputFiles([
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: createJpeg() },
    { name: 'video.webm', mimeType: 'video/webm', buffer: createWebm() },
  ]);
  await expect(page.locator('#preview-2')).toBeVisible();
  await expect(page.locator('#dropZone')).toHaveClass(/has-preview/);
  for (const id of ['previewHistoryWrap', 'previewQualityWrap', 'previewExifWrap', 'previewZoomBar']) {
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('inert', '');
    await expect(page.locator(`#${id}`)).toHaveAttribute('aria-hidden', 'false');
  }
  await expect(page.locator('#previewResetViewBtn')).toHaveAttribute('inert', '');
  await expect(page.locator('#previewVideoBar')).toHaveAttribute('inert', '');

  await page.locator('#previewQualityBtn').focus();
  await page.evaluate(() => window.selectItem(2));
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  await expect(page.locator('#previewQualityWrap')).toHaveAttribute('inert', '');
  await expect(page.locator('#previewVideoBar')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#videoPlayPauseBtn')).toBeFocused();

  await page.evaluate(() => window.selectItem(1));
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);
  await expect(page.locator('#previewVideoBar')).toHaveAttribute('inert', '');
  await expect(page.locator('#previewQualityWrap')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#previewQualityBtn')).toBeFocused();
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

test('photo cards replace full-resolution image decodes with bounded canvases', async ({ page }) => {
  const largeJpeg = await createBrowserRaster(page, 'image/jpeg', 1600, 1200);
  await page.locator('#fileInput').setInputFiles({
    name: 'bounded-card-thumbnail.jpg',
    mimeType: 'image/jpeg',
    buffer: largeJpeg,
  });

  const sourceCanvas = page.locator('#preview-1 canvas.thumb-source');
  await expect(sourceCanvas).toBeVisible();
  expect(await sourceCanvas.evaluate(canvas => [canvas.width, canvas.height])).toEqual([400, 300]);
  await expect(page.locator('#preview-1 img.thumb-orig')).not.toHaveAttribute('src');
});

test('failed photo thumbnail compaction releases its decoded image and canvas', async ({ page }) => {
  await page.evaluate(() => {
    const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.classList.contains('thumb-source')) {
        window.__failedCardThumbnailCanvas = this.canvas;
        throw new Error('simulated card thumbnail compaction failure');
      }
      return nativeDrawImage.apply(this, args);
    };
  });
  const jpeg = await createBrowserRaster(page, 'image/jpeg', 1600, 1200);
  await page.locator('#fileInput').setInputFiles({
    name: 'failed-card-thumbnail.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });

  const original = page.locator('#preview-1 img.thumb-orig');
  await expect(original).not.toHaveAttribute('src');
  await expect(original).toBeHidden();
  await expect(page.locator('#preview-1')).toHaveClass(/thumbnail-unavailable/);
  expect(await page.evaluate(() => [
    window.__failedCardThumbnailCanvas.width,
    window.__failedCardThumbnailCanvas.height,
  ])).toEqual([0, 0]);
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
  await expect(page.locator('#preview-1 canvas.thumb-framed')).toBeVisible();
  await page.evaluate(() => window.triggerDownload(new Blob(['download']), 'resource-check.txt'));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBe(0);
  await expect(page.locator('#livePreviewCanvas')).toHaveJSProperty('width', 0);
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/pending/);
  await expect(page.locator('#preview-1 canvas.thumb-framed')).toHaveCount(0);
  await expect(page.locator('#preview-1 canvas.thumb-source')).toBeVisible();
  await expect(page.locator('#preview-1 img.thumb-orig')).not.toHaveAttribute('src');

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#livePreviewCanvas')).toBeVisible();
  await expect.poll(() => page.locator('#livePreviewCanvas').evaluate(canvas => canvas.width)).toBeGreaterThan(0);

  await page.evaluate(() => window.triggerDownload(new Blob(['download-again']), 'resource-check-2.txt'));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__activePageObjectUrls.size)).toBe(0);
});

test('BFCache restore restarts a video thumbnail interrupted during suspension', async ({ page }) => {
  await page.evaluate(() => {
    window.__thumbnailCaptureCalls = 0;
    window.__thumbnailAbortCalls = 0;
    window.__finishSuspendedThumbnail = null;
    window.FrameEngine.captureVideoFrame = (_file, _time, { signal }) => {
      window.__thumbnailCaptureCalls += 1;
      if (window.__thumbnailCaptureCalls === 1) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            window.__thumbnailAbortCalls += 1;
            window.__finishSuspendedThumbnail = () => reject(
              new DOMException('Thumbnail cancelled', 'AbortError')
            );
          }, { once: true });
        });
      }
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
      return Promise.resolve(canvas);
    };
    window.FrameEngine.renderFrameWhenReady = async source => source;
  });

  await page.locator('#fileInput').setInputFiles({
    name: 'suspended-thumbnail.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect.poll(() => page.evaluate(() => window.__thumbnailCaptureCalls)).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__thumbnailAbortCalls)).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.__finishSuspendedThumbnail();
  });

  await expect.poll(() => page.evaluate(() => window.__thumbnailCaptureCalls)).toBe(2);
  await expect(page.locator('#preview-1 canvas.thumb-framed')).toBeVisible();
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

test('card progress remains described without competing with the export live region', async ({ page }) => {
  await uploadJpegs(page);
  const preview = page.locator('#preview-1');
  const badge = page.locator('#status-badge-1');

  await expect(preview).toHaveAttribute('aria-describedby', 'status-badge-1');
  await expect(badge).not.toHaveAttribute('role');
  await expect(badge).not.toHaveAttribute('aria-live');
  await expect(badge).toContainText(/pending|待機中/i);
  await expect(page.locator('#exportProgressStatus')).toHaveAttribute('role', 'status');
  await expect(page.locator('#exportProgressStatus')).toHaveAttribute('aria-live', 'polite');
});

test('share dialog supports axe, Escape, and focus return', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await page.locator('#shareAppBtn').focus();
  await page.locator('#shareAppBtn').press('Enter');
  await expect(page.locator('#shareAppModal')).toHaveClass(/open/);
  await expect(page.locator('#shareAppCloseBtn')).toBeFocused();
  await expect(page.locator('#shareUrlInput')).toHaveAccessibleName('Share URL');
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

  await page.locator('#langToggleBtn').click();
  await page.locator('#shareAppBtn').click();
  await expect(page.locator('#shareUrlInput')).toHaveAccessibleName('共有URL');
  await page.keyboard.press('Escape');
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
  await remove.evaluate(button => {
    const nativeFocus = button.focus.bind(button);
    window.__modalRestoreFocusCalls = 0;
    button.focus = (...args) => {
      window.__modalRestoreFocusCalls += 1;
      if (window.__modalRestoreFocusCalls > 1) nativeFocus(...args);
    };
  });
  expect(await page.locator('.app-shell').evaluate(element => element.inert)).toBe(true);
  expect(await page.locator('#mobileTabBar').evaluate(element => element.inert)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(remove).toBeFocused();
  expect(await page.evaluate(() => window.__modalRestoreFocusCalls)).toBe(2);
  expect(await page.locator('.app-shell').evaluate(element => element.inert)).toBe(false);
  expect(await page.locator('#mobileTabBar').evaluate(element => element.inert)).toBe(false);
});

test('modal focus return activates its hidden mobile workspace panel', async ({ page }) => {
  await page.locator('#customizeBtn').click();
  const managePrivacy = page.locator('#manageLocationPrivacyBtn');
  await managePrivacy.click();
  await expect(page.locator('#locationPrivacyOnceBtn')).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabPreviewBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settingsPanel')).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.locator('#locationPrivacyModal')).not.toHaveClass(/open/);
  await expect(page.locator('#tabSettingsBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settingsPanel')).toBeVisible();
  await expect(managePrivacy).toBeFocused();
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
  const exifToggle = page.locator('.preview-exif-drawer-header');
  await expect(exifToggle).toHaveJSProperty('tagName', 'BUTTON');
  await exifToggle.click();
  await expect(page.locator('#previewExifContent')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#previewExifContent').evaluate(element => element.inert)).toBe(true);
  await exifToggle.press('Enter');
  await expect(page.locator('#previewExifContent')).toHaveAttribute('aria-hidden', 'false');

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
  await expect(page.locator('#settingsPanel')).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-mobile-tab');
  expect(await page.locator('#settingsPanel').evaluate(element => element.inert)).toBe(false);
  const fontSelect = page.locator('#fontFamily');
  await fontSelect.focus();
  await page.evaluate(() => {
    document.body.setAttribute('data-mobile-tab', 'photos');
    document.activeElement.blur();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabSettingsBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(fontSelect).toBeFocused();

  await page.locator('#tabSettingsBtn').focus();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('#customizeBtn')).toBeFocused();

  await page.locator('#sidebarResizeHandle').focus();
  await expect(page.locator('#sidebarResizeHandle')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabSettingsBtn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tabSettingsBtn')).toBeFocused();
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

test('switching photos cannot discard a pending live EXIF edit', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    const input = document.getElementById('live-exif-make');
    input.value = 'Edited A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.selectItem(2);
  });
  await page.waitForTimeout(150);

  await page.locator('#preview-1').click();
  await expect(page.locator('#live-exif-make')).toHaveValue('Edited A');
  await page.locator('#preview-2').click();
  await expect(page.locator('#live-exif-make')).toHaveValue('FUJIFILM');
});

test('undo restores JPEG quality controls after a PNG history state', async ({ page }) => {
  await uploadJpegs(page);
  await page.locator('label[for="bg-blur"]').click();
  await page.locator('label[for="fmt-png"]').click();
  await page.locator('label:has(#showExifInfo)').click();
  await expect(page.locator('#photoQualityRow')).toBeHidden();
  await expect(page.locator('#photoQualityRange')).toBeDisabled();

  await page.locator('#undoEditBtn').click();
  await page.locator('#undoEditBtn').click();

  await expect(page.locator('#fmt-jpeg')).toBeChecked();
  await expect(page.locator('#photoQualityRow')).toBeVisible();
  await expect(page.locator('#photoQualityRow')).not.toHaveAttribute('hidden');
  await expect(page.locator('#photoQualityRange')).toBeEnabled();
});

test('batch export creates a ZIP for multiple JPEG files', async ({ page }) => {
  await uploadJpegs(page, 2);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadAllBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/instaframe.*\.zip$/i);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const bytes = await fs.readFile(filePath);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
});

test('ZIP creation stops before aggregate browser memory exceeds its safe peak', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await expect(page.locator('#status-badge-2 .status-dot')).toHaveClass(/done/);

  await page.evaluate(async () => {
    const JSZipCtor = await window.loadVendorScript('vendor/jszip.min.js', 'JSZip');
    window.__zipGenerateCalled = false;
    const originalGenerate = JSZipCtor.prototype.generateInternalStream;
    JSZipCtor.prototype.generateInternalStream = function (...args) {
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

test('supported video export selection survives a page reload', async ({ page }) => {
  const choices = await page.locator('input[name="exportVideoFormat"]').evaluateAll(inputs => (
    inputs.map(input => input.value)
  ));
  expect(choices.length).toBeGreaterThan(1);
  const savedChoice = choices.at(-1);

  await page.evaluate(value => {
    const saved = JSON.parse(localStorage.getItem('instaframe_settings') || '{}');
    localStorage.setItem('instaframe_settings', JSON.stringify({
      ...saved,
      exportVideoFormat: value,
    }));
  }, savedChoice);
  await page.reload();

  await expect(page.locator('input[name="exportVideoFormat"]:checked')).toHaveValue(savedChoice);
});

test('invalid persisted enum values cannot break application startup', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.evaluate(() => {
    const invalid = '\"]';
    localStorage.setItem('instaframe_settings', JSON.stringify({
      textColorMode: invalid,
      locationPosition: invalid,
      mapOverlayPosition: invalid,
      frameBackground: invalid,
      aspectRatio: invalid,
      aspectOrientation: invalid,
      exportPhotoFormat: invalid,
      exportVideoBitrate: invalid,
    }));
  });
  await page.reload();

  await expect(page.locator('.preview-empty-cta')).toBeVisible();
  await page.locator('#customizeBtn').click();
  await expect(page.locator('#customizePanel')).toHaveClass(/open/);
  expect(pageErrors).toEqual([]);
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

test('single export keeps every export action locked through final encoding', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    window.__releaseSingleExport = null;
    window.FrameEngine.canvasToBlob = () => new Promise(resolve => {
      window.__releaseSingleExport = () => resolve(new Blob([
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      ], { type: 'image/jpeg' }));
    });
  });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#dl-btn-1').click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseSingleExport)).toBe('function');

  await expect(page.locator('#dl-btn-1')).toBeDisabled();
  await expect(page.locator('#dl-btn-2')).toBeDisabled();
  await expect(page.locator('#generateAllBtn')).toBeDisabled();
  await expect(page.locator('#downloadAllBtn')).toBeDisabled();
  await expect(page.locator('#clearAllBtn')).toBeDisabled();

  await page.evaluate(() => window.__releaseSingleExport());
  await downloadPromise;
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#dl-btn-2')).toBeEnabled();
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

test('a stalled vendor script times out and can be retried', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const nativeAppendChild = document.head.appendChild;
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 12_000 ? 25 : delay, ...args)
    );
    document.head.appendChild = function holdVendorScript(node) {
      if (node instanceof HTMLScriptElement && node.src.includes('/vendor/jszip.min.js')) return node;
      return nativeAppendChild.call(this, node);
    };

    let firstError = '';
    try {
      await window.loadVendorScript('vendor/jszip.min.js', 'JSZip');
    } catch (error) {
      firstError = error.message;
    } finally {
      document.head.appendChild = nativeAppendChild;
      window.setTimeout = nativeSetTimeout;
    }

    const constructor = await window.loadVendorScript('vendor/jszip.min.js', 'JSZip');
    return {
      firstError,
      retryLoaded: typeof constructor === 'function',
      scriptCount: document.querySelectorAll('script[src*="/vendor/jszip.min.js"]').length,
    };
  });

  expect(result.firstError).toContain('Timed out loading vendor/jszip.min.js');
  expect(result.retryLoaded).toBe(true);
  expect(result.scriptCount).toBe(1);
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

test('concurrent imports share the aggregate item limit', async ({ page }) => {
  const jpegBase64 = createJpeg().toString('base64');
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    let releaseFirstMetadata;
    const firstMetadata = new Promise(resolve => { releaseFirstMetadata = resolve; });
    window.__importLimitStats = { parseCalls: 0 };
    window.exifr = {
      parse: () => {
        window.__importLimitStats.parseCalls += 1;
        return window.__importLimitStats.parseCalls === 1
          ? firstMetadata.then(() => null)
          : Promise.resolve(null);
      },
    };
    window.__makeImportBatch = prefix => Array.from({ length: 26 }, (_, index) => (
      new File([bytes], `${prefix}-${index + 1}.jpg`, { type: 'image/jpeg' })
    ));
    window.__releaseFirstMetadata = releaseFirstMetadata;
    window.__firstImport = window.addFiles(window.__makeImportBatch('first'));
  }, jpegBase64);

  await expect.poll(() => page.evaluate(() => window.__importLimitStats.parseCalls)).toBe(1);
  await page.evaluate(() => {
    window.__secondImport = window.addFiles(window.__makeImportBatch('second'));
  });
  await page.evaluate(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(await page.evaluate(() => window.__importLimitStats.parseCalls)).toBe(1);
  await page.evaluate(async () => {
    window.__releaseFirstMetadata();
    await Promise.all([window.__firstImport, window.__secondImport]);
  });

  await expect(page.locator('.image-card')).toHaveCount(50);
  await expect(page.locator('#toast')).toContainText(/2/);
});

test('a hung EXIF read cannot block later files in the import queue', async ({ page }) => {
  const jpegBase64 = createJpeg().toString('base64');
  await page.evaluate(base64 => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 25 : delay, ...args)
    );
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    window.__metadataGuardStats = { parseCalls: 0, finished: false };
    window.exifr = {
      parse: () => {
        window.__metadataGuardStats.parseCalls += 1;
        if (window.__metadataGuardStats.parseCalls === 1) return new Promise(() => {});
        return Promise.resolve({ Make: 'NEXT FILE' });
      },
    };
    window.addFiles([
      new File([bytes], 'hung-exif.jpg', { type: 'image/jpeg' }),
      new File([bytes], 'next-exif.jpg', { type: 'image/jpeg' }),
    ]).then(() => { window.__metadataGuardStats.finished = true; });
  }, jpegBase64);

  await expect.poll(() => page.evaluate(() => window.__metadataGuardStats)).toEqual({
    parseCalls: 2,
    finished: true,
  });
  await expect(page.locator('.image-card')).toHaveCount(2);
  await page.locator('#preview-2').click();
  await expect(page.locator('#live-exif-make')).toHaveValue('NEXT FILE');
});

test('a stalled source image decode cannot block the import queue', async ({ page }) => {
  const jpegBase64 = createJpeg().toString('base64');
  await page.evaluate(base64 => {
    const nativeImage = window.Image;
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    window.__imageDecodeGuardStats = { finished: false, sourceRemoved: false, urlRevoked: false };
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 20_000 ? 25 : delay, ...args)
    );
    window.exifr = { parse: () => Promise.resolve(null) };
    window.Image = class StalledImage {
      constructor() {
        this.complete = false;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
      }
      set src(value) {
        this._src = value;
        window.__stalledImageUrl = value;
      }
      get src() { return this._src || ''; }
      removeAttribute(name) {
        if (name === 'src') {
          this._src = '';
          window.__imageDecodeGuardStats.sourceRemoved = true;
        }
      }
    };
    URL.revokeObjectURL = url => {
      if (url === window.__stalledImageUrl) window.__imageDecodeGuardStats.urlRevoked = true;
      nativeRevokeObjectURL(url);
    };
    window.addFiles([
      new File([bytes], 'stalled-decode.jpg', { type: 'image/jpeg' }),
      new File([bytes], 'later-file.jpg', { type: 'image/jpeg' }),
    ]).finally(() => {
      window.Image = nativeImage;
      window.setTimeout = nativeSetTimeout;
      URL.revokeObjectURL = nativeRevokeObjectURL;
      window.__imageDecodeGuardStats.finished = true;
    });
  }, jpegBase64);

  await expect.poll(() => page.evaluate(() => window.__imageDecodeGuardStats)).toEqual({
    finished: true,
    sourceRemoved: true,
    urlRevoked: true,
  });
  await expect(page.locator('.image-card')).toHaveCount(2);
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/error/);
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

test('queued video thumbnails receive a full decoder timeout after starting', async ({ page }) => {
  await page.evaluate(async () => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 100 : delay, ...args)
    );
    window.readVideoMetadata = async () => window.emptyExif();
    window.__queuedThumbnailTimeoutStats = { active: 0, peak: 0, completed: 0, aborted: 0 };
    window.FrameEngine.captureVideoFrame = (_file, _time, { signal }) => new Promise((resolve, reject) => {
      const stats = window.__queuedThumbnailTimeoutStats;
      let settled = false;
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      const timer = nativeSetTimeout(() => {
        if (settled) return;
        settled = true;
        stats.active -= 1;
        stats.completed += 1;
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 64;
        resolve(canvas);
      }, 80);
      signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stats.active -= 1;
        stats.aborted += 1;
        reject(new DOMException('Thumbnail cancelled', 'AbortError'));
      }, { once: true });
    });
    window.FrameEngine.renderFrameWhenReady = async source => source;
    await window.addFiles(Array.from({ length: 6 }, (_, index) => (
      new File(['video'], `timeout-queued-${index}.webm`, { type: 'video/webm' })
    )));
  });

  await expect.poll(() => page.evaluate(() => {
    const stats = window.__queuedThumbnailTimeoutStats;
    return stats.completed + stats.aborted;
  })).toBe(6);
  expect(await page.evaluate(() => window.__queuedThumbnailTimeoutStats)).toEqual({
    active: 0,
    peak: 2,
    completed: 6,
    aborted: 0,
  });
  await expect(page.locator('canvas.thumb-framed')).toHaveCount(6);
});

test('video export waits for thumbnail decoder cleanup before encoding', async ({ page }) => {
  await page.evaluate(() => {
    window.__thumbnailExportOrder = { started: false, settled: false, encoderSawSettled: false };
    window.FrameEngine.captureVideoFrame = (_file, _time, options) => new Promise((resolve, reject) => {
      window.__thumbnailExportOrder.started = true;
      options.signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          window.__thumbnailExportOrder.settled = true;
          reject(new DOMException('Thumbnail cancelled', 'AbortError'));
        });
      }, { once: true });
    });
    window.FrameEngine.renderVideoFrameWhenReady = async () => {
      window.__thumbnailExportOrder.encoderSawSettled = window.__thumbnailExportOrder.settled;
      return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' });
    };
  });
  await page.locator('#fileInput').setInputFiles({
    name: 'thumbnail-before-export.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect.poll(() => page.evaluate(() => window.__thumbnailExportOrder.started)).toBe(true);

  await page.locator('#generateAllBtn').click();

  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  expect(await page.evaluate(() => window.__thumbnailExportOrder)).toEqual({
    started: true,
    settled: true,
    encoderSawSettled: true,
  });
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
  await trackCancellationToasts(page);
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
  expect(await page.evaluate(() => window.__cancellationToastCalls)).toBe(1);
});

test('changing frame settings aborts active work and invalidates the whole batch', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.evaluate(() => {
    window.__settingsChangeAbortObserved = false;
    window.FrameEngine.renderFrameWhenReady = (_image, _exif, _settings, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        window.__settingsChangeAbortObserved = true;
        reject(new DOMException('Export cancelled', 'AbortError'));
      }, { once: true });
    });
  });

  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#exportProgress')).toBeVisible();
  await page.locator('#thicknessRange').evaluate(input => {
    input.value = '1.1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect.poll(() => page.evaluate(() => window.__settingsChangeAbortObserved)).toBe(true);
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('.status-dot.pending')).toHaveCount(2);
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
});

test('ZIP cancellation interrupts a pending photo canvas encode', async ({ page }) => {
  await uploadJpegs(page);
  await trackCancellationToasts(page);
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
  expect(await page.evaluate(() => window.__cancellationToastCalls)).toBe(1);
});

test('ZIP cancellation interrupts a pending lazy dependency load', async ({ page }) => {
  await uploadJpegs(page);
  await trackCancellationToasts(page);
  await page.evaluate(() => {
    window.__zipDependencyLoadStarted = false;
    window.loadVendorScript = () => {
      window.__zipDependencyLoadStarted = true;
      return new Promise(() => {});
    };
  });

  await page.locator('#downloadAllBtn').click();
  await expect.poll(() => page.evaluate(() => window.__zipDependencyLoadStarted)).toBe(true);
  await page.locator('#cancelExportBtn').click();

  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#downloadAllBtn')).toBeEnabled();
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
  expect(await page.evaluate(() => window.__cancellationToastCalls)).toBe(1);
});

test('ZIP cancellation pauses active packing and restores the export UI', async ({ page }) => {
  await uploadJpegs(page);
  await trackCancellationToasts(page);
  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.evaluate(async () => {
    const JSZipCtor = await window.loadVendorScript('vendor/jszip.min.js', 'JSZip');
    window.__zipPackingState = { started: false, paused: false };
    JSZipCtor.prototype.generateInternalStream = function () {
      const listeners = { data: [], error: [], end: [] };
      let timer = null;
      let percent = 0;
      const stream = {
        on(event, listener) {
          listeners[event].push(listener);
          return stream;
        },
        resume() {
          window.__zipPackingState.started = true;
          const pump = () => {
            if (window.__zipPackingState.paused) return;
            percent = Math.min(percent + 5, 95);
            listeners.data.forEach(listener => listener(new Uint8Array(16 * 1024), { percent }));
            timer = setTimeout(pump, 5);
          };
          timer = setTimeout(pump, 0);
          return stream;
        },
        pause() {
          window.__zipPackingState.paused = true;
          clearTimeout(timer);
          return stream;
        },
      };
      return stream;
    };
  });

  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.locator('#downloadAllBtn').click();
  await expect.poll(() => page.evaluate(() => window.__zipPackingState.started)).toBe(true);
  await page.locator('#cancelExportBtn').click();

  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#downloadAllBtn')).toBeEnabled();
  await expect(page.locator('#toast')).toContainText(/cancel|キャンセル/i);
  expect(await page.evaluate(() => window.__zipPackingState.paused)).toBe(true);
  expect(await page.evaluate(() => window.__cancellationToastCalls)).toBe(1);
  expect(downloads).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('single photo cancellation interrupts a pending canvas encode', async ({ page }) => {
  await uploadJpegs(page);
  await trackCancellationToasts(page);
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
  expect(await page.evaluate(() => window.__cancellationToastCalls)).toBe(1);
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

test('a stalled photo export decoder times out, revokes its URL, and restores controls', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await uploadJpegs(page);
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const activeUrls = new Set();
    const stats = { activeUrls, sourceRemoved: 0 };
    window.__stalledExportImageStats = stats;
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 200 : delay, ...args)
    );
    URL.createObjectURL = value => {
      const url = nativeCreateObjectURL(value);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      activeUrls.delete(url);
      nativeRevokeObjectURL(url);
    };
    window.Image = class StalledImage {
      set src(value) { this._src = String(value); }
      get src() { return this._src || ''; }
      removeAttribute(name) {
        if (name === 'src' && this._src) {
          this._src = '';
          stats.sourceRemoved += 1;
        }
      }
    };
  });

  await page.locator('#generateAllBtn').click();
  await expect(page.locator('#exportProgress')).toBeVisible();
  await expect(page.locator('#exportProgress')).toBeHidden();
  await expect(page.locator('#status-badge-1')).toHaveAttribute('aria-label', /took too long/i);
  await expect(page.locator('#generateAllBtn')).toBeEnabled();
  expect(await page.evaluate(() => ({
    activeUrls: window.__stalledExportImageStats.activeUrls.size,
    sourceRemoved: window.__stalledExportImageStats.sourceRemoved,
  }))).toEqual({ activeUrls: 0, sourceRemoved: 1 });
});

test('font loading respects cancellation and falls back after its guard', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const nativeFontLoad = document.fonts.load.bind(document.fonts);
    const nativeSetTimeout = window.setTimeout.bind(window);
    document.fonts.load = () => new Promise(() => {});
    const source = document.createElement('canvas');
    source.width = 32;
    source.height = 24;
    source.getContext('2d').fillRect(0, 0, source.width, source.height);
    const settings = {
      fontFamily: 'Inter',
      frameColor: '#f0f0f0',
      frameBackground: 'color',
      showShotOn: false,
      showExifInfo: false,
      thicknessScale: 1,
    };

    const controller = new AbortController();
    const cancelled = window.FrameEngine.renderFrameWhenReady(
      source, {}, settings, { signal: controller.signal }
    );
    controller.abort();
    let cancelledError = '';
    try { await cancelled; }
    catch (error) { cancelledError = error.name; }

    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args)
    );
    try {
      const rendered = await window.FrameEngine.renderFrameWhenReady(source, {}, settings);
      const dimensions = { width: rendered.width, height: rendered.height };
      rendered.width = 0;
      rendered.height = 0;
      return { cancelledError, dimensions };
    } finally {
      document.fonts.load = nativeFontLoad;
      window.setTimeout = nativeSetTimeout;
    }
  });

  expect(result.cancelledError).toBe('AbortError');
  expect(result.dimensions.width).toBeGreaterThan(0);
  expect(result.dimensions.height).toBeGreaterThan(0);
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

  await page.evaluate(() => window.setPreviewZoom(8));
  await expect.poll(() => canvas.evaluate(element => Number(element.dataset.previewBackingScale))).toBeGreaterThanOrEqual(7.9);
});

test('zoom controls keep the same visual rate at low and high magnification', async ({ page }) => {
  await uploadJpegs(page);
  await page.evaluate(() => window.setPreviewZoom(1));
  await page.locator('#zoomInBtn').click();
  await expect(page.locator('#zoomLabel')).toHaveText('120%');

  await page.evaluate(() => window.setPreviewZoom(6));
  await page.locator('#zoomInBtn').click();
  await expect(page.locator('#zoomLabel')).toHaveText('720%');

  await page.evaluate(() => window.setPreviewZoom(1));
  await page.locator('#dropZone').dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('#zoomLabel')).toHaveText('112%');
  await page.evaluate(() => window.setPreviewZoom(6));
  await page.locator('#dropZone').dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('#zoomLabel')).toHaveText('672%');

  await page.locator('#zoomRange').evaluate(element => {
    element.value = '625';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#zoomLabel')).toHaveText('245%');
  await expect(page.locator('#zoomRange')).toHaveAttribute('aria-valuetext', '245%');
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

test('MediaRecorder cancellation ignores late metadata without reallocating resources', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'late-metadata.webm', { type: 'video/webm' });
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

    let lateMetadata = null;
    document.createElement = (tagName, options) => {
      if (String(tagName).toLowerCase() !== 'video') return nativeCreateElement(tagName, options);
      return {
        videoWidth: 320,
        videoHeight: 180,
        duration: 1,
        pause() {},
        removeAttribute() {},
        load() {},
        set onloadedmetadata(handler) {
          this._onloadedmetadata = handler;
          if (handler) lateMetadata = handler;
        },
        get onloadedmetadata() { return this._onloadedmetadata; },
        set onerror(handler) { this._onerror = handler; },
        get onerror() { return this._onerror; },
      };
    };

    let captureStreamCalls = 0;
    const nativeCaptureStream = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = () => {
      captureStreamCalls += 1;
      return { addTrack() {}, getTracks() { return []; } };
    };
    let recorderConstructions = 0;
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() { recorderConstructions += 1; }
    };

    const controller = new AbortController();
    const pending = window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
      preserveAudio: true,
      signal: controller.signal,
    }).catch(error => error.name);
    while (!lateMetadata) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;
    lateMetadata();
    await new Promise(resolve => setTimeout(resolve, 0));

    document.createElement = nativeCreateElement;
    HTMLCanvasElement.prototype.captureStream = nativeCaptureStream;
    return { outcome, captureStreamCalls, recorderConstructions, activeUrls: activeUrls.size };
  }, { base64: createWebm().toString('base64') });

  expect(result).toEqual({
    outcome: 'AbortError',
    captureStreamCalls: 0,
    recorderConstructions: 0,
    activeUrls: 0,
  });
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

test('MediaRecorder finalizes when playback ends without another animation frame', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'ended-without-frame.webm', { type: 'video/webm' });
    const nativeCreateElement = document.createElement.bind(document);
    const nativeCreateUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeUrl = URL.revokeObjectURL.bind(URL);
    const nativeCaptureStream = HTMLCanvasElement.prototype.captureStream;
    const NativeMediaRecorder = window.MediaRecorder;
    const nativeRequestAnimationFrame = window.requestAnimationFrame;
    const nativeCancelAnimationFrame = window.cancelAnimationFrame;
    const activeUrls = new Set();
    const outputTrack = { stopped: false, stop() { this.stopped = true; } };
    let recorderStopCalls = 0;

    URL.createObjectURL = value => {
      const url = nativeCreateUrl(value);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      activeUrls.delete(url);
      nativeRevokeUrl(url);
    };
    document.createElement = (tagName, options) => {
      if (String(tagName).toLowerCase() !== 'video') return nativeCreateElement(tagName, options);
      return {
        videoWidth: 320,
        videoHeight: 180,
        duration: 1,
        currentTime: 0,
        ended: false,
        paused: true,
        src: '',
        captureStream() { return { getAudioTracks() { return []; }, getTracks() { return []; } }; },
        play() {
          this.paused = false;
          setTimeout(() => {
            this.currentTime = this.duration;
            this.ended = true;
            this.paused = true;
            this.onended?.();
          }, 0);
          return Promise.resolve();
        },
        pause() { this.paused = true; },
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        load() { if (this.src) queueMicrotask(() => this.onloadedmetadata?.()); },
      };
    };
    HTMLCanvasElement.prototype.captureStream = () => ({
      addTrack() {},
      getTracks() { return [outputTrack]; },
    });
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        recorderStopCalls += 1;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded'], { type: 'video/webm' }) });
        queueMicrotask(() => this.onstop?.());
      }
    };
    window.requestAnimationFrame = () => 777;
    window.cancelAnimationFrame = () => {};

    const controller = new AbortController();
    const pending = window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
      preserveAudio: true,
      signal: controller.signal,
    });
    try {
      const outcome = await Promise.race([
        pending.then(blob => ({ status: 'resolved', blobSize: blob.size })),
        new Promise(resolve => setTimeout(() => resolve({ status: 'timeout', blobSize: 0 }), 500)),
      ]);
      if (outcome.status === 'timeout') {
        controller.abort();
        await pending.catch(() => {});
      }
      return {
        ...outcome,
        recorderStopCalls,
        outputTrackStopped: outputTrack.stopped,
        activeUrls: activeUrls.size,
      };
    } finally {
      document.createElement = nativeCreateElement;
      HTMLCanvasElement.prototype.captureStream = nativeCaptureStream;
      window.MediaRecorder = NativeMediaRecorder;
      window.requestAnimationFrame = nativeRequestAnimationFrame;
      window.cancelAnimationFrame = nativeCancelAnimationFrame;
      URL.createObjectURL = nativeCreateUrl;
      URL.revokeObjectURL = nativeRevokeUrl;
    }
  }, { base64: createWebm().toString('base64') });

  expect(result).toEqual({
    status: 'resolved',
    blobSize: 8,
    recorderStopCalls: 1,
    outputTrackStopped: true,
    activeUrls: 0,
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

test('WebCodecs video output uses the post-processed aspect ratio and releases its base canvas', async ({ page }) => {
  await installFakeWebCodecs(page);
  const fixture = await loadAudioVideoFixture();
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'webcodecs-portrait.webm', { type: 'video/webm' });
    await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {
      aspectRatio: '4:5',
      aspectOrientation: 'portrait',
      outerPadding: 0,
      frameColor: '#f0f0f0',
      frameBackground: 'blur',
      showShotOn: false,
      showExifInfo: false,
    }, { preserveAudio: false });
    const resources = window.__webCodecsResources;
    return {
      config: resources.encoders[0].config,
      activeUrls: resources.activeUrls.size,
      canvasSizes: resources.canvases.map(canvas => [canvas.width, canvas.height]),
    };
  }, { base64: fixture.buffer.toString('base64') });

  expect(result.config.width / result.config.height).toBeCloseTo(4 / 5, 2);
  expect(result.activeUrls).toBe(0);
  expect(result.canvasSizes.length).toBeGreaterThanOrEqual(2);
  expect(result.canvasSizes.slice(0, 2)).toEqual([[0, 0], [0, 0]]);
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

test('video output limit rejects an oversized estimate before MediaRecorder allocation', async ({ page }) => {
  const result = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const file = new File([bytes], 'remaining-budget.webm', { type: 'video/webm' });
    let recorderConstructed = false;
    const NativeMediaRecorder = window.MediaRecorder;
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() { recorderConstructed = true; }
    };
    let errorCode = null;
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
        preserveAudio: true,
        videoBitsPerSecond: 10_000_000,
        maxOutputBytes: 1,
      });
    } catch (error) {
      errorCode = error.code;
    } finally {
      window.MediaRecorder = NativeMediaRecorder;
    }
    return { errorCode, recorderConstructed };
  }, { base64: createWebm().toString('base64') });

  expect(result).toEqual({
    errorCode: 'MEDIA_RESOURCE_LIMIT',
    recorderConstructed: false,
  });
});

test('sequential video exports receive only the remaining retained-output budget', async ({ page }) => {
  const files = [1, 2].map(index => ({
    name: `budget-${index}.webm`,
    mimeType: 'video/webm',
    buffer: createWebm(),
  }));
  await page.locator('#fileInput').setInputFiles(files);
  await expect(page.locator('.image-card')).toHaveCount(2);
  await page.evaluate(() => {
    window.__videoOutputLimits = [];
    let callCount = 0;
    window.FrameEngine.renderVideoFrameWhenReady = async (_file, _exif, _settings, options) => {
      window.__videoOutputLimits.push(options.maxOutputBytes);
      const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' });
      if (callCount++ === 0) {
        Object.defineProperty(blob, 'size', { value: 300 * 1024 * 1024 });
      }
      return blob;
    };
  });

  await page.locator('#generateAllBtn').click();
  await expect(page.locator('.status-dot.done')).toHaveCount(2);
  expect(await page.evaluate(() => window.__videoOutputLimits)).toEqual([
    384 * 1024 * 1024,
    84 * 1024 * 1024,
  ]);
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

test('video layouts apply portrait presets and outer padding', async ({ page }) => {
  const result = await page.evaluate(() => {
    const base = {
      thicknessScale: 1,
      frameColor: '#f0f0f0',
      aspectRatio: 'original',
      aspectOrientation: 'auto',
      outerPadding: 0,
    };
    const layouts = {
      original: window.FrameEngine.computeVideoFrameLayout(1600, 900, base),
      portrait: window.FrameEngine.computeVideoFrameLayout(1600, 900, {
        ...base,
        aspectRatio: '4:5',
        aspectOrientation: 'portrait',
      }),
      padded: window.FrameEngine.computeVideoFrameLayout(1600, 900, {
        ...base,
        outerPadding: 10,
      }),
    };
    const source = document.createElement('canvas');
    source.width = 160;
    source.height = 90;
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#d02020';
    sourceContext.fillRect(0, 0, source.width, source.height);
    const drawSettings = {
      ...base,
      frameColor: '#2040d0',
      frameBackground: 'blur',
      aspectRatio: '4:5',
      aspectOrientation: 'portrait',
      outerPadding: 10,
      showShotOn: false,
      showExifInfo: false,
      showLocation: false,
    };
    const drawLayout = window.FrameEngine.computeVideoFrameLayout(160, 90, drawSettings);
    const output = document.createElement('canvas');
    output.width = drawLayout.canvasW;
    output.height = drawLayout.canvasH;
    const outputContext = output.getContext('2d');
    const scratch = window.FrameEngine.drawVideoFrameSync(
      outputContext, source, {}, drawSettings, drawLayout
    );
    const corner = [...outputContext.getImageData(0, 0, 1, 1).data];
    const draw = {
      frameX: drawLayout.frameX,
      frameY: drawLayout.frameY,
      scratchWidth: scratch?.width || 0,
      scratchHeight: scratch?.height || 0,
      baseCanvasW: drawLayout.baseCanvasW,
      baseCanvasH: drawLayout.baseCanvasH,
      corner,
    };
    source.width = 0;
    source.height = 0;
    output.width = 0;
    output.height = 0;
    if (scratch) { scratch.width = 0; scratch.height = 0; }
    return { layouts, draw };
  });

  expect(result.layouts.portrait.canvasW / result.layouts.portrait.canvasH).toBeCloseTo(4 / 5, 2);
  const expectedPad = Math.round(Math.max(result.layouts.original.canvasW, result.layouts.original.canvasH) * 0.1);
  expect(result.layouts.padded.canvasW).toBe(result.layouts.original.canvasW + expectedPad * 2);
  expect(result.layouts.padded.canvasH).toBe(result.layouts.original.canvasH + expectedPad * 2);
  expect(result.draw.frameX).toBeGreaterThan(0);
  expect(result.draw.frameY).toBeGreaterThan(0);
  expect(result.draw.scratchWidth).toBe(result.draw.baseCanvasW);
  expect(result.draw.scratchHeight).toBe(result.draw.baseCanvasH);
  expect(result.draw.corner[3]).toBeGreaterThan(0);
});

test('blur video frames reuse one automatic-contrast sampler', async ({ page }) => {
  const sampleCanvasCount = await page.evaluate(() => {
    const nativeCreateElement = document.createElement;
    const canvases = [];
    document.createElement = function trackedCreateElement(tagName, options) {
      const element = nativeCreateElement.call(this, tagName, options);
      if (String(tagName).toLowerCase() === 'canvas') canvases.push(element);
      return element;
    };

    try {
      const settings = {
        thicknessScale: 1,
        frameColor: '#f0f0f0',
        frameBackground: 'blur',
        blurBrightness: 80,
        textColorMode: 'auto',
        aspectRatio: 'original',
        aspectOrientation: 'auto',
        outerPadding: 0,
        showShotOn: false,
        showExifInfo: false,
        showLocation: false,
      };
      const source = document.createElement('canvas');
      source.width = 160;
      source.height = 90;
      const sourceContext = source.getContext('2d');
      sourceContext.fillStyle = '#203050';
      sourceContext.fillRect(0, 0, source.width, source.height);
      const layout = window.FrameEngine.computeVideoFrameLayout(source.width, source.height, settings);
      const output = document.createElement('canvas');
      output.width = layout.canvasW;
      output.height = layout.canvasH;
      const outputContext = output.getContext('2d');

      for (let frame = 0; frame < 6; frame += 1) {
        window.FrameEngine.drawVideoFrameSync(outputContext, source, {}, settings, layout);
      }
      return canvases.filter(canvas => canvas.width === 8 && canvas.height === 4).length;
    } finally {
      document.createElement = nativeCreateElement;
    }
  });

  expect(sampleCanvasCount).toBeLessThanOrEqual(1);
});

test('live video preview keeps the requested ratio and padding after seeking', async ({ page }) => {
  const fixture = await loadAudioVideoFixture();
  await page.locator('#fileInput').setInputFiles({
    name: 'live-video-layout.webm',
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  await expect.poll(() => page.locator('#livePreviewVideo').evaluate(video => video.videoWidth)).toBeGreaterThan(0);

  await page.locator('label[for="ratio-4-5"]').click();
  await page.locator('#outerPaddingRange').evaluate(element => {
    element.value = '10';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const expectedRatio = await page.locator('#livePreviewVideo').evaluate(video => {
    const layout = window.FrameEngine.computeVideoFrameLayout(video.videoWidth, video.videoHeight, {
      thicknessScale: 1,
      imageOffsetY: 0,
      showLocation: false,
      aspectRatio: '4:5',
      aspectOrientation: 'portrait',
      outerPadding: 10,
      frameColor: '#f0f0f0',
    });
    return layout.canvasW / layout.canvasH;
  });
  const canvas = page.locator('#livePreviewCanvas');
  await expect.poll(() => canvas.evaluate(element => element.width / element.height)).toBeCloseTo(expectedRatio, 2);

  await page.locator('#videoSeekRange').evaluate((element) => {
    element.value = String(Number(element.max) / 2);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => canvas.evaluate(element => element.width / element.height)).toBeCloseTo(expectedRatio, 2);
});

test('paused live preview redraws the decoded frame after seeking', async ({ page }) => {
  const fixture = await loadAudioVideoFixture();
  await page.locator('#fileInput').setInputFiles({
    name: 'paused-seek.webm',
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
  const video = page.locator('#livePreviewVideo');
  const canvas = page.locator('#livePreviewCanvas');
  await expect.poll(() => video.evaluate(element => element.videoWidth)).toBeGreaterThan(0);
  await video.evaluate(element => element.pause());

  const frameHash = () => canvas.evaluate(element => {
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext('2d');
    context.drawImage(element, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      hash = Math.imul(hash ^ pixels[index], 16777619);
      hash = Math.imul(hash ^ pixels[index + 1], 16777619);
      hash = Math.imul(hash ^ pixels[index + 2], 16777619);
    }
    sample.width = 0;
    sample.height = 0;
    return hash >>> 0;
  });
  const before = await frameHash();

  await video.evaluate(element => new Promise(resolve => {
    element.addEventListener('seeked', resolve, { once: true });
    element.currentTime = Math.min(element.duration * 0.8, 0.5);
  }));
  await expect.poll(frameHash).not.toBe(before);
});

test('paused live video preview redraws only when its frame changes', async ({ page }) => {
  await page.evaluate(() => {
    const original = window.FrameEngine.drawVideoFrameSync;
    window.__liveVideoDrawCount = 0;
    window.FrameEngine.drawVideoFrameSync = (...args) => {
      window.__liveVideoDrawCount += 1;
      return original(...args);
    };
  });
  await page.locator('#fileInput').setInputFiles({
    name: 'paused-preview.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect.poll(() => page.evaluate(() => window.__liveVideoDrawCount)).toBeGreaterThan(0);

  const pausedCount = await page.evaluate(async () => {
    const video = document.getElementById('livePreviewVideo');
    video.pause();
    await new Promise(resolve => setTimeout(resolve, 50));
    return window.__liveVideoDrawCount;
  });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__liveVideoDrawCount)).toBeLessThanOrEqual(pausedCount + 1);

  await page.evaluate(() => {
    const video = document.getElementById('livePreviewVideo');
    video.loop = true;
    return video.play();
  });
  await expect.poll(() => page.evaluate(() => window.__liveVideoDrawCount)).toBeGreaterThan(pausedCount + 2);
  await page.locator('#livePreviewVideo').evaluate(video => video.pause());
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

test('device location stays bound to the photo that requested it', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({ locationNetworkConsent: 'always' }));
  });
  await page.reload();
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ address: { city: 'Race City', country: 'Japan' } }),
  }));
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = success => {
      window.__resolveDeviceLocation = success;
    };
  });
  await uploadJpegs(page, 2);

  await page.locator('#getDeviceLocationBtn').click();
  await expect.poll(() => page.evaluate(() => typeof window.__resolveDeviceLocation)).toBe('function');
  await page.locator('#preview-2').click();
  await page.evaluate(() => window.__resolveDeviceLocation({
    coords: { latitude: 35.0116, longitude: 135.7681 },
  }));

  await expect(page.locator('#live-exif-location')).toHaveValue('');
  await expect(page.locator('#live-exif-location')).toBeEnabled();
  await page.locator('#preview-1').click();
  await expect(page.locator('#live-exif-location')).toHaveValue('Race City, Japan');
  await page.locator('#preview-2').click();
  await expect(page.locator('#live-exif-location')).toHaveValue('');
});

test('location requests time out instead of waiting indefinitely', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({ locationNetworkConsent: 'always' }));
  });
  await page.reload();

  const result = await page.evaluate(async () => {
    const nativeFetch = window.fetch;
    const nativeSetTimeout = window.setTimeout;
    let requestSignal = null;
    window.fetch = (input, options = {}) => {
      if (String(input).startsWith('https://nominatim.openstreetmap.org/')) {
        requestSignal = options.signal;
        return new Promise((resolve, reject) => {
          requestSignal.addEventListener('abort', () => {
            reject(new DOMException('Request cancelled', 'AbortError'));
          }, { once: true });
        });
      }
      return nativeFetch(input, options);
    };
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 10_000 ? 25 : delay, ...args)
    );

    try {
      const value = await window.reverseGeocode(35.0116, 135.7681);
      return { value, aborted: requestSignal?.aborted === true };
    } finally {
      window.fetch = nativeFetch;
      window.setTimeout = nativeSetTimeout;
    }
  });

  expect(result).toEqual({ value: null, aborted: true });
});

test('revoking location consent aborts an in-flight reverse geocode request', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({ locationNetworkConsent: 'always' }));
  });
  await page.reload();
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    window.__nativeLocationFetch = nativeFetch;
    window.fetch = (input, options = {}) => {
      if (String(input).startsWith('https://nominatim.openstreetmap.org/')) {
        window.__locationRequestSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('Request cancelled', 'AbortError'));
          }, { once: true });
        });
      }
      return nativeFetch(input, options);
    };
    window.__locationRequest = window.reverseGeocode(35.0116, 135.7681);
  });
  await expect.poll(() => page.evaluate(() => !!window.__locationRequestSignal)).toBe(true);

  await page.locator('#customizeBtn').click();
  await page.locator('#manageLocationPrivacyBtn').click();
  await page.locator('#locationPrivacyRevokeBtn').click();

  await expect.poll(() => page.evaluate(() => window.__locationRequestSignal?.aborted)).toBe(true);
  expect(await page.evaluate(async () => {
    const result = await window.__locationRequest;
    window.fetch = window.__nativeLocationFetch;
    delete window.__nativeLocationFetch;
    return result;
  })).toBeNull();
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

test('a stalled Mapbox image times out and releases its source', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({
      locationNetworkConsent: 'always',
      mapboxPublicToken: 'pk.test.test',
    }));
  });
  await page.reload();

  const result = await page.evaluate(async () => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const stats = { sourceAssigned: false, sourceRemoved: 0 };
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 50 : delay, ...args)
    );
    window.Image = class StalledMapImage {
      set src(value) {
        this._src = String(value);
        stats.sourceAssigned = this._src.startsWith('https://api.mapbox.com/');
      }
      get src() { return this._src || ''; }
      removeAttribute(name) {
        if (name === 'src' && this._src) {
          this._src = '';
          stats.sourceRemoved += 1;
        }
      }
    };

    const value = await window._fetchMapOverlayImage(35.0116, 135.7681);
    window._cancelMapImageLoads();
    return { value, ...stats };
  });

  expect(result).toEqual({ value: null, sourceAssigned: true, sourceRemoved: 1 });
});

test('failed Mapbox requests still consume the local safety limit', async ({ page }) => {
  await page.evaluate(() => {
    const day = new Date().toISOString().slice(0, 10);
    localStorage.setItem('instaframe_prefs', JSON.stringify({
      locationNetworkConsent: 'always',
      mapboxPublicToken: 'pk.test.test',
    }));
    localStorage.setItem('instaframe_mb_usage_v2', JSON.stringify({
      day,
      month: day.slice(0, 7),
      dayCount: 99,
      monthCount: 99,
    }));
  });
  await page.reload();

  const result = await page.evaluate(async () => {
    let requests = 0;
    window.Image = class FailedMapImage {
      set src(value) {
        this._src = String(value);
        requests += 1;
        queueMicrotask(() => this.onerror?.(new Event('error')));
      }
      get src() { return this._src || ''; }
      removeAttribute(name) { if (name === 'src') this._src = ''; }
    };

    const first = await window._fetchMapOverlayImage(35.0116, 135.7681);
    const second = await window._fetchMapOverlayImage(35.0117, 135.7682);
    const usage = JSON.parse(localStorage.getItem('instaframe_mb_usage_v2'));
    return {
      first,
      second,
      requests,
      dayCount: usage.dayCount,
      monthCount: usage.monthCount,
    };
  });

  expect(result).toEqual({
    first: null,
    second: null,
    requests: 1,
    dayCount: 100,
    monthCount: 100,
  });
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
  await expect(page.locator('#mapPickerModal')).toHaveAttribute('aria-busy', 'false');
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

  const mapSurface = page.getByRole('region', { name: /pick on map|マップで選択/i });
  await expect(mapSurface).toHaveAccessibleDescription(/use the arrow keys|矢印キー/i);
  await mapSurface.focus();
  const mapPosition = await mapSurface.locator('.leaflet-map-pane').evaluate(element => element.style.transform);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => mapSurface.locator('.leaflet-map-pane').evaluate(element => element.style.transform))
    .not.toBe(mapPosition);
});

test('map picker exposes accessible busy states and coalesces place-name lookup', async ({ page }) => {
  let releaseLeaflet;
  let markLeafletRequested;
  const leafletRequested = new Promise(resolve => { markLeafletRequested = resolve; });
  await page.route('**/vendor/leaflet/leaflet.js*', async route => {
    markLeafletRequested();
    await new Promise(resolve => { releaseLeaflet = resolve; });
    await route.continue();
  });
  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\//, route => route.abort());
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({ locationNetworkConsent: 'always' }));
  });
  await page.reload();
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = () => {};
  });
  await uploadJpegs(page);

  const modal = page.locator('#mapPickerModal');
  const mapContainer = page.locator('#mapPickerContainer');
  const selectCenter = page.locator('#selectMapCenterBtn');
  const confirm = page.locator('#confirmMapLocationBtn');
  const close = page.locator('#mapPickerCloseBtn');

  await page.locator('#openMapPickerBtn').click();
  await leafletRequested;
  await expect(modal).toHaveClass(/open/);
  await expect(modal).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mapPickerCoords')).toContainText(/loading map|マップを読み込んで/i);
  await expect(selectCenter).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await expect(close).toBeEnabled();
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  expect(await mapContainer.evaluate(element => ({
    inert: element.inert,
    ariaDisabled: element.getAttribute('aria-disabled'),
  }))).toEqual({ inert: true, ariaDisabled: 'true' });
  const loadingAxe = await new AxeBuilder({ page }).include('#mapPickerModal').analyze();
  expect(loadingAxe.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);

  releaseLeaflet();
  await expect(modal).toHaveAttribute('aria-busy', 'false');
  await expect(selectCenter).toBeEnabled();
  await expect(confirm).toBeEnabled();
  expect(await mapContainer.evaluate(element => ({
    inert: element.inert,
    ariaDisabled: element.getAttribute('aria-disabled'),
  }))).toEqual({ inert: false, ariaDisabled: 'false' });

  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    window.__mapLookupCalls = 0;
    window.fetch = (input, options = {}) => {
      if (String(input).startsWith('https://nominatim.openstreetmap.org/reverse')) {
        window.__mapLookupCalls += 1;
        if (window.__mapLookupCalls === 1) {
          window.__mapLookupSignal = options.signal;
          return new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('Request cancelled', 'AbortError'));
            }, { once: true });
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ address: { city: 'Kyoto', country: 'Japan' } }),
        });
      }
      return nativeFetch(input, options);
    };
  });

  await selectCenter.click();
  await confirm.click();
  await expect.poll(() => page.evaluate(() => window.__mapLookupCalls)).toBe(1);
  await expect(modal).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mapPickerCoords')).toContainText(/looking up place name|地名を検索/i);
  await expect(selectCenter).toBeDisabled();
  await expect(confirm).toBeDisabled();
  const lookupAxe = await new AxeBuilder({ page }).include('#mapPickerModal').analyze();
  expect(lookupAxe.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);
  await page.evaluate(() => void window.confirmMapLocation());
  expect(await page.evaluate(() => window.__mapLookupCalls)).toBe(1);

  await close.click();
  await expect(modal).not.toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => window.__mapLookupSignal?.aborted)).toBe(true);
  await expect(page.locator('#live-exif-location')).toHaveValue('');

  await page.locator('#openMapPickerBtn').click();
  await expect(modal).toHaveClass(/open/);
  await expect(modal).toHaveAttribute('aria-busy', 'false');
  await selectCenter.click();
  await confirm.click();
  await expect(modal).not.toHaveClass(/open/);
  await expect(page.locator('#live-exif-location')).toHaveValue('Kyoto, Japan');
  expect(await page.evaluate(() => window.__mapLookupCalls)).toBe(2);
});

test('closing the map picker aborts its IP fallback and releases the map', async ({ page }) => {
  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\//, route => route.abort());
  await page.evaluate(() => {
    localStorage.setItem('instaframe_prefs', JSON.stringify({ locationNetworkConsent: 'always' }));
  });
  await page.reload();
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (success, fail) => fail(new Error('Use IP fallback'));
    const nativeFetch = window.fetch;
    window.fetch = (input, options = {}) => {
      if (String(input).startsWith('https://ipapi.co/')) {
        window.__ipLocationSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('Request cancelled', 'AbortError'));
          }, { once: true });
        });
      }
      return nativeFetch(input, options);
    };
  });

  await uploadJpegs(page);
  await page.locator('#openMapPickerBtn').click();
  await expect(page.locator('#mapPickerModal')).toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => !!window.__ipLocationSignal)).toBe(true);
  await page.locator('#mapPickerCloseBtn').click();

  await expect(page.locator('#mapPickerModal')).not.toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => window.__ipLocationSignal?.aborted)).toBe(true);
  expect(await page.locator('#mapPickerContainer').evaluate(element => element._leaflet_id)).toBeUndefined();
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
  const [box, historyBox] = await Promise.all([
    drawer.boundingBox(),
    page.locator('#previewHistoryWrap').boundingBox(),
  ]);
  expect(box.width).toBeGreaterThan(250);
  expect(box.width).toBeLessThanOrEqual(382);
  expect(box.x + box.width).toBeLessThanOrEqual(historyBox.x - 8);
  await page.evaluate(() => document.documentElement.setAttribute('data-editor-size', 'large'));
  const largeBox = await drawer.boundingBox();
  expect(largeBox.x + largeBox.width).toBeLessThanOrEqual(historyBox.x - 8);
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

test('confirming removal after a mobile transition focuses visible preview controls', async ({ page }) => {
  await uploadJpegs(page, 2);
  await page.locator('#item-1 [data-action="remove"]').click();
  await expect(page.locator('#destructiveConfirmModal')).toHaveClass(/open/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tabPreviewBtn')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#destructiveConfirmAcceptBtn').click();

  await expect(page.locator('#item-1')).toHaveCount(0);
  await expect(page.locator('#previewQualityBtn')).toBeVisible();
  await expect(page.locator('#previewQualityBtn')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.closest('[inert]'))).toBeNull();
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

test('failed live video previews release source, RAF, and canvas resources', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: createJpeg() },
    { name: 'error.webm', mimeType: 'video/webm', buffer: createWebm() },
    { name: 'timeout.webm', mimeType: 'video/webm', buffer: createWebm() },
    { name: 'metadata-only.webm', mimeType: 'video/webm', buffer: createWebm() },
    { name: 'throw.webm', mimeType: 'video/webm', buffer: createWebm() },
  ]);
  await expect(page.locator('#preview-5')).toBeVisible();
  await expect.poll(() => page.locator('#preview-2 canvas, #preview-3 canvas, #preview-4 canvas, #preview-5 canvas').evaluateAll(
    canvases => canvases.length === 4 && canvases.every(canvas => canvas.width > 0 && canvas.height > 0)
  )).toBe(true);

  await page.evaluate(() => {
    const video = document.getElementById('livePreviewVideo');
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const nativeRemoveAttribute = video.removeAttribute.bind(video);
    const activeUrls = new Set();
    const activeRafs = new Set();
    const stats = {
      activeUrls,
      activeRafs,
      created: 0,
      revoked: 0,
      sourceRemoved: 0,
    };
    const control = { loadMode: 'stall' };
    window.__failedLiveVideoStats = stats;
    window.__failedLiveVideoControl = control;
    window.setTimeout = (callback, delay, ...args) => (
      nativeSetTimeout(callback, delay === 15_000 ? 500 : delay, ...args)
    );
    URL.createObjectURL = value => {
      const url = nativeCreateObjectURL(value);
      stats.created += 1;
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      stats.revoked += 1;
      activeUrls.delete(url);
      nativeRevokeObjectURL(url);
    };
    window.requestAnimationFrame = callback => {
      let id = null;
      id = nativeRequestAnimationFrame(timestamp => {
        activeRafs.delete(id);
        callback(timestamp);
      });
      activeRafs.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => {
      activeRafs.delete(id);
      nativeCancelAnimationFrame(id);
    };

    let stalledSource = '';
    Object.defineProperty(video, 'src', {
      configurable: true,
      get: () => stalledSource,
      set: value => { stalledSource = String(value); },
    });
    video.load = () => {
      if (control.loadMode === 'throw') throw new DOMException('Simulated media load failure');
    };
    video.removeAttribute = name => {
      if (name === 'src' && stalledSource) {
        stalledSource = '';
        stats.sourceRemoved += 1;
      }
      nativeRemoveAttribute(name);
    };
  });

  const resourceState = () => page.evaluate(() => {
    const video = document.getElementById('livePreviewVideo');
    const canvas = document.getElementById('livePreviewCanvas');
    const stats = window.__failedLiveVideoStats;
    return {
      activeUrls: stats.activeUrls.size,
      activeRafs: stats.activeRafs.size,
      created: stats.created,
      revoked: stats.revoked,
      sourceRemoved: stats.sourceRemoved,
      hasObjectUrl: !!video._objUrl,
      hasSourceId: !!video._srcId,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  });

  await page.locator('#preview-2').click();
  await expect.poll(() => page.locator('#livePreviewVideo').evaluate(video => !!video._objUrl)).toBe(true);
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  await page.locator('#livePreviewVideo').dispatchEvent('error');
  await expect(page.locator('#status-badge-2 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#livePreviewError')).toBeVisible();
  await expect(page.locator('#livePreviewError')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#livePreviewError')).toContainText('error.webm');
  await expect(page.locator('#toast')).toBeHidden();
  const errorAxe = await new AxeBuilder({ page }).include('#dropZone').analyze();
  expect(errorAxe.violations.filter(violation => ['critical', 'serious'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);
  await expect.poll(resourceState).toEqual({
    activeUrls: 0,
    activeRafs: 0,
    created: 1,
    revoked: 1,
    sourceRemoved: 1,
    hasObjectUrl: false,
    hasSourceId: false,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);

  await page.locator('#preview-3').click();
  await expect(page.locator('#dropZone')).toHaveClass(/has-video/);
  await expect(page.locator('#status-badge-3 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#livePreviewError')).toBeVisible();
  await expect(page.locator('#livePreviewError')).toContainText('timeout.webm');
  await expect.poll(resourceState).toEqual({
    activeUrls: 0,
    activeRafs: 0,
    created: 2,
    revoked: 2,
    sourceRemoved: 2,
    hasObjectUrl: false,
    hasSourceId: false,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);

  await page.locator('#preview-4').click();
  await expect.poll(() => page.locator('#livePreviewVideo').evaluate(video => !!video._objUrl)).toBe(true);
  await page.locator('#livePreviewVideo').dispatchEvent('loadedmetadata');
  await expect(page.locator('#status-badge-4 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#livePreviewError')).toContainText('metadata-only.webm');
  await expect.poll(resourceState).toEqual({
    activeUrls: 0,
    activeRafs: 0,
    created: 3,
    revoked: 3,
    sourceRemoved: 3,
    hasObjectUrl: false,
    hasSourceId: false,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);

  await page.evaluate(() => { window.__failedLiveVideoControl.loadMode = 'throw'; });
  await page.locator('#preview-5').click();
  await expect(page.locator('#status-badge-5 .status-dot')).toHaveClass(/error/);
  await expect(page.locator('#livePreviewError')).toContainText('throw.webm');
  await expect.poll(resourceState).toEqual({
    activeUrls: 0,
    activeRafs: 0,
    created: 4,
    revoked: 4,
    sourceRemoved: 4,
    hasObjectUrl: false,
    hasSourceId: false,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  await expect(page.locator('#dropZone')).not.toHaveClass(/has-video/);
});

test('video controls announce their current action and restore audible volume', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'ja'));
  await page.reload();
  await page.locator('#fileInput').setInputFiles({
    name: 'controls.webm',
    mimeType: 'video/webm',
    buffer: createWebm(),
  });
  await expect(page.locator('#previewVideoBar')).toBeVisible();
  const playPause = page.locator('#videoPlayPauseBtn');
  const mute = page.locator('#videoMuteBtn');
  const volume = page.locator('#videoVolumeRange');
  await expect(playPause).toHaveAccessibleName(/play|再生/i);
  await expect(mute).toHaveAccessibleName(/mute|ミュート/i);

  await page.evaluate(() => {
    const video = document.getElementById('livePreviewVideo');
    window.__previewPaused = false;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => window.__previewPaused,
    });
    Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
    video.dispatchEvent(new Event('play'));
  });
  await expect(playPause).toHaveAccessibleName(/pause|一時停止/i);
  await page.evaluate(() => {
    window.__previewPaused = true;
    document.getElementById('livePreviewVideo').dispatchEvent(new Event('pause'));
  });
  await expect(playPause).toHaveAccessibleName(/play|再生/i);

  await volume.fill('0.4');
  await volume.fill('0');
  await expect(mute).toHaveAccessibleName(/unmute|解除/i);
  await mute.click();
  expect(await page.locator('#livePreviewVideo').evaluate(video => ({
    muted: video.muted,
    volume: video.volume,
  }))).toEqual({ muted: false, volume: 0.4 });
  await expect(mute).toHaveAccessibleName(/mute|ミュート/i);

  await page.evaluate(() => {
    const video = document.getElementById('livePreviewVideo');
    video.muted = true;
    video.dispatchEvent(new Event('volumechange'));
  });
  await page.locator('#langToggleBtn').click();
  await expect(mute).toHaveAccessibleName('Unmute video');
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
  await expect.poll(() => page.locator('#livePreviewVideo').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await page.locator('label[for="ratio-9-16"]').click();
  await page.locator('#outerPaddingRange').evaluate(element => {
    element.value = '10';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const expectedLayout = await page.locator('#livePreviewVideo').evaluate(video => {
    const layout = window.FrameEngine.computeVideoFrameLayout(video.videoWidth, video.videoHeight, {
      thicknessScale: 1,
      imageOffsetY: 0,
      showLocation: false,
      aspectRatio: '9:16',
      aspectOrientation: 'portrait',
      outerPadding: 10,
      frameColor: '#f0f0f0',
    });
    return { width: layout.canvasW, height: layout.canvasH };
  });

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
  expect({ width: mediaInfo.width, height: mediaInfo.height }).toEqual(expectedLayout);
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
