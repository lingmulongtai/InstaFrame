const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const mp4Fixture = fs.readFileSync(path.resolve(__dirname, 'codec-fixture.mp4'));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

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

test('valid H.264/AAC MP4 reaches a decoded preview or an explicit codec error', async ({ page }, testInfo) => {
  expect(mp4Fixture.subarray(4, 8).toString('ascii')).toBe('ftyp');
  await page.locator('#fileInput').setInputFiles({
    name: 'cross-browser.mp4',
    mimeType: 'video/mp4',
    buffer: mp4Fixture,
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

  if (testInfo.project.name !== 'webkit') {
    expect(outcome, `${testInfo.project.name} should decode the local MP4 fixture`).toBe('decoded');
  }
});
