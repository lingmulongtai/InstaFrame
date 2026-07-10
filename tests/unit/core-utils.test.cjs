const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../js/core-utils.js');

test('preview quality changes backing density without changing a layout input', () => {
  assert.equal(core.normalizePreviewQuality('unknown'), 'auto');
  assert.equal(core.getPreviewBackingScale('draft', 2, 1), 0.75);
  assert.equal(core.getPreviewBackingScale('normal', 2, 1), 1);
  assert.ok(core.getPreviewBackingScale('high', 1, 1) > 1);
  assert.ok(core.getPreviewBackingScale('max', 1, 1) > core.getPreviewBackingScale('high', 1, 1));
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
