const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../js/core-utils.js');

test('preview quality changes backing density without changing a layout input', () => {
  assert.equal(core.normalizePreviewQuality('unknown'), 'auto');
  assert.equal(core.getPreviewBackingScale('draft', 2, 1), 1);
  assert.equal(core.getPreviewBackingScale('normal', 1, 1), 1.5);
  assert.equal(core.getPreviewBackingScale('auto', 1, 1), 2);
  assert.equal(core.getPreviewBackingScale('auto', 1, 3), 3);
  assert.equal(core.getPreviewBackingScale('auto', 1, 6), 6);
  assert.equal(core.getPreviewBackingScale('auto', 1, 8), 8);
  assert.equal(core.getPreviewBackingScale('auto', 1, 12), 12);
  assert.equal(core.getPreviewBackingScale('max', 1, 12), 12);
  assert.equal(core.MAX_PREVIEW_ZOOM, 12);
  assert.ok(core.getPreviewBackingScale('high', 1, 1) >= core.getPreviewBackingScale('auto', 1, 1));
  assert.ok(core.getPreviewBackingScale('max', 1, 1) > core.getPreviewBackingScale('high', 1, 1));
});

test('preview backing density preserves normal zoom detail and caps extreme canvas memory', () => {
  assert.equal(core.getBudgetedPreviewBackingScale(6, 500, 400, 16_000_000), 6);
  const capped = core.getBudgetedPreviewBackingScale(6, 2_000, 1_500, 16_000_000);
  assert.ok(capped < 6);
  assert.ok(Math.round(2_000 * capped) * Math.round(1_500 * capped) <= 16_010_000);
  const mobile = core.getBudgetedPreviewBackingScale(6, 390, 700, 8_000_000);
  assert.ok(mobile > 5.4);
  assert.ok(mobile <= 6);
  assert.equal(core.getBudgetedPreviewBackingScale(8, 500, 400, 24_000_000), 8);
  assert.equal(core.getBudgetedPreviewBackingScale(12, 430, 330, 24_000_000), 12);
  assert.ok(core.getBudgetedPreviewBackingScale(12, 700, 500, 24_000_000) < 12);
  const panorama = core.getBudgetedPreviewBackingScale(12, 1_860, 145, 24_000_000);
  assert.ok(Math.round(1_860 * panorama) <= core.MAX_SAFE_CANVAS_SIDE);
  assert.ok(Math.round(145 * panorama) <= core.MAX_SAFE_CANVAS_SIDE);
});

test('preview zoom slider gives equal travel an equal visual scale ratio', () => {
  const positions = [50, 337.5, 625, 912.5, 1200];
  const zooms = positions.map(core.getPreviewZoomForSliderValue);
  const ratios = zooms.slice(1).map((zoom, index) => zoom / zooms[index]);
  assert.equal(zooms[0], 0.5);
  assert.equal(zooms.at(-1), 12);
  ratios.forEach(ratio => assert.ok(Math.abs(ratio - ratios[0]) < 1e-12));
  for (const zoom of [0.5, 1, 2, 4, 8, 12]) {
    const roundTrip = core.getPreviewZoomForSliderValue(core.getPreviewSliderValueForZoom(zoom));
    assert.ok(Math.abs(roundTrip - zoom) < 1e-12);
  }
});

test('ZIP peak estimate includes retained outputs, duplicate archive bytes, and entry overhead', () => {
  const mib = 1024 * 1024;
  assert.equal(core.estimateZipPeakBytes(300 * mib, 40 * mib, 40 * mib, 2), 380 * mib + 4096);
  assert.ok(core.estimateZipPeakBytes(384 * mib, 64 * mib, 64 * mib, 1) > 512 * mib);
  assert.equal(core.estimateZipPeakBytes(-1, NaN, 10, -3), 10);
});

test('coordinate labels are deterministic and remain local', () => {
  assert.equal(core.formatCoordinateLabel(35.6762, 139.6503), '35.6762°N, 139.6503°E');
  assert.equal(core.formatCoordinateLabel(-33.8688, 151.2093), '33.8688°S, 151.2093°E');
  assert.equal(core.formatCoordinateLabel('invalid', 1), '');
});

test('Mapbox origin allowlist supports exact and localhost wildcard origins', () => {
  const allowed = ['https://lingmulongtai.github.io', 'http://localhost:*'];
  assert.equal(core.isAllowedOrigin('https://lingmulongtai.github.io', allowed), true);
  assert.equal(core.isAllowedOrigin('http://localhost:4173', allowed), true);
  assert.equal(core.isAllowedOrigin('https://example.com', allowed), false);
});

test('custom text colors are normalized safely', () => {
  assert.equal(core.normalizeHexColor('#abc'), '#AABBCC');
  assert.equal(core.normalizeHexColor('#123456'), '#123456');
  assert.equal(core.normalizeHexColor('red', '#FFFFFF'), '#FFFFFF');
});

test('the repository ships without an unrestricted Mapbox token', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../js/config.js'), 'utf8');
  assert.match(config, /publicToken:\s*''/);
  assert.doesNotMatch(config, /publicToken:\s*'pk\./);
});

test('the published page has a self-only CSP with no inline handlers or styles', () => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  assert.match(index, /Content-Security-Policy/);
  assert.match(index, /script-src 'self'/);
  assert.match(index, /style-src 'self'; font-src 'self'/);
  assert.doesNotMatch(index, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.doesNotMatch(index, /frame-ancestors/);
  assert.doesNotMatch(index, /\bon(?:click|change|input)=/i);
  assert.doesNotMatch(index, /\bstyle\s*=/i);
  assert.match(index, /video\/3gpp/);
  assert.match(index, /video\/x-m4v/);
});
