const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

test('visible preview detail restores a budget-limited crop without scaling off-screen pixels', () => {
  const plan = core.getVisiblePreviewDetailPlan({
    sourceWidth: 4096,
    sourceHeight: 6144,
    canvasRect: { left: -1800, top: -2500, width: 4200, height: 6300 },
    viewportRect: { left: 0, top: 0, width: 390, height: 700 },
    baseBackingWidth: 3000,
    baseBackingHeight: 4500,
    devicePixelRatio: 3,
    maxPixels: 8_000_000,
  });

  assert.ok(plan);
  assert.equal(plan.width, 390);
  assert.equal(plan.height, 700);
  assert.ok(plan.density > plan.baseDensity);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= 8_000_000);
  assert.ok(plan.sourceX > 0);
  assert.ok(plan.sourceY > 0);
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

test('preview wheel zoom scales smoothly with bounded trackpad and mouse deltas', () => {
  const micro = core.getPreviewWheelZoomFactor(-1);
  const mouse = core.getPreviewWheelZoomFactor(-100);
  assert.ok(micro > 1 && micro < 1.01);
  assert.ok(Math.abs(mouse - 1.12) < 1e-12);
  assert.ok(Math.abs(core.getPreviewWheelZoomFactor(100) - 1 / mouse) < 1e-12);
  assert.ok(Math.abs(core.getPreviewWheelZoomFactor(-3, 1) - mouse) < 1e-12);
  assert.equal(core.getPreviewWheelZoomFactor(-10_000), core.getPreviewWheelZoomFactor(-240));
  assert.equal(core.getPreviewWheelZoomFactor(10_000), core.getPreviewWheelZoomFactor(240));
});

test('preview pan keeps the same image point beneath wheel and moving pinch focus', () => {
  const anchored = core.getPreviewPanForZoomFocus(30, -10, 1, 2, 100, 50, 100, 50, 0, 0);
  assert.deepEqual(anchored, { x: -40, y: -70 });

  const restored = core.getPreviewPanForZoomFocus(
    anchored.x, anchored.y, 2, 1, 100, 50, 100, 50, 0, 0
  );
  assert.deepEqual(restored, { x: 30, y: -10 });

  const movedPinch = core.getPreviewPanForZoomFocus(0, 0, 1, 2, 80, 40, 100, 55, 0, 0);
  assert.deepEqual(movedPinch, { x: -60, y: -25 });
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
  const sandbox = { window: {} };
  vm.runInNewContext(config, sandbox, { filename: 'js/config.js' });
  const mapbox = sandbox.window.INSTAFRAME_CONFIG.mapbox;
  assert.equal(mapbox.publicToken, '');
  assert.deepEqual([...mapbox.allowedOrigins], ['https://lingmulongtai.github.io']);
  assert.equal(mapbox.dailyRequestLimitPerDevice, 100);
  assert.equal(mapbox.monthlyRequestLimitPerDevice, 1000);
  assert.equal(Object.isFrozen(mapbox), true);
});

test('the published page has a self-only CSP with no inline handlers or styles', () => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  assert.match(index, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
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

test('mobile layout prefers the dynamic viewport and reserves the safe area', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../css/style.css'), 'utf8');
  const fallback = 'height: calc(100vh - var(--tab-bar-h));';
  const dynamic = 'height: calc(100dvh - var(--tab-bar-h));';
  assert.ok(css.indexOf(fallback) >= 0);
  assert.ok(css.indexOf(dynamic) > css.indexOf(fallback));
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(css, new RegExp(`--safe-area-${side}:\\s*env\\(safe-area-inset-${side}, 0px\\)`));
  }
  assert.match(css, /--tab-bar-h:\s*calc\(56px \+ var\(--safe-area-bottom\)\)/);
  assert.match(css, /\.mobile-tab-bar\s*\{[^}]*height:\s*var\(--tab-bar-h\)[^}]*padding:[^;}]*var\(--safe-area-right\)[^;}]*var\(--safe-area-bottom\)[^;}]*var\(--safe-area-left\)/s);
  assert.match(css, /\.app-shell\s*\{[^}]*padding:\s*var\(--safe-area-top\) var\(--safe-area-right\) 0 var\(--safe-area-left\)/s);
  assert.match(css, /\.sidebar\s*\{[^}]*top:\s*var\(--safe-area-top\)[^}]*left:\s*var\(--safe-area-left\)[^}]*right:\s*var\(--safe-area-right\)/s);
});
