// Assemble heic-spatial.heic from two single-image HEICs (left/right eye) with
// the app's own HEIF writer: a 'ster' stereo pair group plus camera
// intrinsics ('cmin') and extrinsics ('cmex'), as spatial photos carry.
//   node tests/e2e/make-spatial-fixture.cjs left.heic right.heic out.heic
const fs = require('node:fs');
const heif = require('../../js/heif.js');

const [leftPath, rightPath, outPath] = process.argv.slice(2);
const eye = file => {
  const parsed = heif.parseHeif(new Uint8Array(fs.readFileSync(file)));
  const id = parsed.primaryId;
  return {
    data: heif.readItemData(parsed, id),
    hvcC: heif.itemProperty(parsed, id, 'hvcC').box,
    ispe: heif.itemProperty(parsed, id, 'ispe').box,
    colr: heif.itemProperty(parsed, id, 'colr')?.box,
  };
};
const left = eye(leftPath);
const right = eye(rightPath);
const cmin = heif.cameraIntrinsicsBox({ focalLengthX: 0.9, principalPointX: 0.5, principalPointY: 0.5, anisotropic: false });
const cmex = x => heif.fullBox('cmex', 0, 0x01, Uint8Array.of((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255));
const item = (id, source, baseline) => {
  const properties = [source.hvcC, source.ispe, ...(source.colr ? [source.colr] : []), cmin, cmex(baseline)];
  return { id, type: 'hvc1', data: source.data, properties, essential: properties.map((_, index) => index === 0) };
};
fs.writeFileSync(outPath, heif.buildHeif({
  primaryId: 1,
  items: [item(1, left, -32000), item(2, right, 32000)],
  groups: [{ type: 'ster', groupId: 3, entityIds: [1, 2] }],
}));
