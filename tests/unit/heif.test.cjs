const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const heif = require('../../js/heif.js');
const core = require('../../js/core-utils.js');

const fixture = name => new Uint8Array(fs.readFileSync(path.resolve(__dirname, '..', 'e2e', name)));

test('a plain HEIC exposes its primary image, size and colour', () => {
  const bytes = fixture('heic-plain.heic');
  assert.equal(heif.isHeif(bytes), true);
  const parsed = heif.parseHeif(bytes);
  assert.ok(parsed.items.get(parsed.primaryId));
  assert.equal(parsed.items.get(parsed.primaryId).type, 'hvc1');
  assert.deepEqual(heif.itemSize(parsed, parsed.primaryId), { width: 96, height: 64 });
  assert.equal(heif.stereoPair(parsed), null);
  assert.equal(heif.itemColorSpace(parsed, parsed.primaryId), 'srgb');
  assert.ok(heif.readItemData(parsed, parsed.primaryId).length > 100);
});

test('a spatial HEIC exposes its left and right eyes and camera parameters', () => {
  const parsed = heif.parseHeif(fixture('heic-spatial.heic'));
  assert.deepEqual(heif.stereoPair(parsed), { left: 1, right: 2, groupId: 3 });
  for (const id of [1, 2]) {
    assert.deepEqual(heif.itemSize(parsed, id), { width: 160, height: 120 });
    const intrinsics = heif.parseCameraIntrinsics(heif.itemProperty(parsed, id, 'cmin'));
    assert.ok(Math.abs(intrinsics.focalLengthX - 0.9) < 1e-6);
    assert.equal(intrinsics.principalPointX, 0.5);
    assert.ok(heif.itemProperty(parsed, id, 'cmex'));
  }
});

test('non-HEIF bytes are not mistaken for HEIC', () => {
  assert.equal(heif.isHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), false);
  assert.equal(heif.parseHeif(new Uint8Array(32)), null);
});

test('the HEIF writer round-trips items, properties, references and stereo groups', () => {
  const left = Uint8Array.from({ length: 40 }, (_, index) => index);
  const right = Uint8Array.from({ length: 24 }, (_, index) => 200 - index);
  const exif = Uint8Array.of(0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0);
  const hvcC = heif.box('hvcC', Uint8Array.of(1, 1, 0x60, 0, 0, 0));
  const ispe = heif.imageSizeBox(320, 240);
  const cmin = heif.cameraIntrinsicsBox({ focalLengthX: 0.8, principalPointX: 0.45, principalPointY: 0.55, anisotropic: true, focalLengthY: 1.1, skew: 0 });
  const bytes = heif.buildHeif({
    primaryId: 1,
    items: [
      { id: 1, type: 'hvc1', data: left, properties: [hvcC, ispe, heif.colourBox('display-p3'), cmin], essential: [true] },
      { id: 2, type: 'hvc1', data: right, properties: [hvcC, ispe], essential: [true] },
      { id: 3, type: 'Exif', data: exif, properties: [], hidden: true },
    ],
    references: [{ type: 'cdsc', from: 3, to: [1] }],
    groups: [{ type: 'ster', groupId: 4, entityIds: [1, 2] }],
  });
  const parsed = heif.parseHeif(bytes);
  assert.equal(parsed.primaryId, 1);
  assert.deepEqual([...parsed.items.values()].map(item => [item.id, item.type, item.hidden]), [
    [1, 'hvc1', false], [2, 'hvc1', false], [3, 'Exif', true],
  ]);
  assert.deepEqual(heif.readItemData(parsed, 1), left);
  assert.deepEqual(heif.readItemData(parsed, 2), right);
  assert.deepEqual(heif.readItemData(parsed, 3), exif);
  assert.deepEqual(parsed.references, [{ type: 'cdsc', from: 3, to: [1] }]);
  assert.deepEqual(heif.stereoPair(parsed), { left: 1, right: 2, groupId: 4 });
  // Shared properties are stored once and associated with both images.
  assert.equal(parsed.properties.filter(property => property.type === 'hvcC').length, 1);
  assert.equal(heif.itemProperties(parsed, 1)[0].essential, true);
  assert.equal(heif.itemColorSpace(parsed, 1), 'display-p3');
  const intrinsics = heif.parseCameraIntrinsics(heif.itemProperty(parsed, 1, 'cmin'));
  assert.ok(Math.abs(intrinsics.focalLengthY - 1.1) < 1e-6);
  assert.ok(Math.abs(intrinsics.principalPointY - 0.55) < 1e-6);
});

test('camera intrinsics follow a photo that is scaled and placed inside a frame', () => {
  const placed = heif.reframeCameraIntrinsics(
    { focalLengthX: 0.9, principalPointX: 0.5, principalPointY: 0.5, anisotropic: false },
    1000, 800, 100, 50, 1200, 1100, 1.1
  );
  // Focal length 900 px × 1.1 = 990 px; principal point (500, 400) × 1.1 + offset.
  assert.ok(Math.abs(placed.focalLengthX - 990 / 1200) < 1e-9);
  assert.ok(Math.abs(placed.focalLengthY - 990 / 1100) < 1e-9);
  assert.ok(Math.abs(placed.principalPointX - 650 / 1200) < 1e-9);
  assert.ok(Math.abs(placed.principalPointY - 490 / 1100) < 1e-9);
});

test('video containers report their codec, HEVC profile and Dolby Vision signalling', () => {
  const mov = fixture('hevc-10bit.mov');
  const moov = core.listMp4Boxes(mov).find(box => box.type === 'moov');
  const info = core.parseMp4VideoCodec(mov.subarray(moov.start, moov.end));
  assert.equal(info.codec, 'hevc');
  assert.equal(info.fourcc, 'hvc1');
  assert.equal(info.profile, 2);
  assert.equal(info.width, 64);
  assert.equal(info.height, 36);
  assert.equal(info.dolbyVision, false);

  const webm = new Uint8Array(fs.readFileSync(path.resolve(__dirname, '..', 'e2e', 'audio-fixture.webm')));
  assert.equal(core.parseMatroskaVideoCodec(webm).codec, 'vp8');
  assert.equal(core.parseMp4VideoCodec(new Uint8Array(16)), null);
});
