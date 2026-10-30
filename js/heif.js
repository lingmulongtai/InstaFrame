/**
 * Minimal HEIF (ISO/IEC 23008-12) container reader and writer.
 *
 * Reading finds what the app needs before decoding: the primary image, the
 * left/right images of a stereo pair ('ster' entity group, used by spatial
 * photos), item properties such as colour and camera parameters, and item
 * data. Writing assembles a still-image HEIF from already-coded images, which
 * is how a framed spatial photo is saved with its stereo pair intact.
 */
(function initInstaFrameHeif(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InstaFrameHeif = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'mif2', 'avif']);

  const text = (bytes, start, length) => {
    let out = '';
    for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[start + index]);
    return out;
  };
  const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];
  const u32 = (bytes, offset) => ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  const i32 = (bytes, offset) => u32(bytes, offset) | 0;
  const readUint = (bytes, offset, size) => {
    if (size === 0) return 0;
    if (size === 1) return bytes[offset];
    if (size === 2) return u16(bytes, offset);
    if (size === 4) return u32(bytes, offset);
    if (size === 8) return u32(bytes, offset) * 2 ** 32 + u32(bytes, offset + 4);
    throw new Error(`Unsupported HEIF field size ${size}`);
  };

  /** Child boxes of bytes[start, end): {type, start, end, body}. */
  function listBoxes(bytes, start = 0, end = bytes.length) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = u32(bytes, offset);
      const type = text(bytes, offset + 4, 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = readUint(bytes, offset + 8, 8);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) break;
      boxes.push({ type, start: offset, end: offset + size, body: offset + header });
      offset += size;
    }
    return boxes;
  }

  /** True when the bytes start with an 'ftyp' box naming a HEIF brand. */
  function isHeif(bytes) {
    if (!bytes || bytes.length < 16 || text(bytes, 4, 4) !== 'ftyp') return false;
    const size = Math.min(u32(bytes, 0), bytes.length);
    for (let offset = 8; offset + 4 <= size; offset += 4) {
      if (offset === 12) continue; // minor version
      if (HEIF_BRANDS.has(text(bytes, offset, 4))) return true;
    }
    return false;
  }

  /**
   * Parse the file-level 'meta' box. Returns null when the bytes are not a
   * still-image HEIF that this reader understands.
   */
  function parseHeif(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isHeif(bytes)) return null;
    const top = listBoxes(bytes);
    const meta = top.find(box => box.type === 'meta');
    if (!meta) return null;
    const metaChildren = listBoxes(bytes, meta.body + 4, meta.end);
    const find = type => metaChildren.find(box => box.type === type);
    const result = {
      bytes,
      primaryId: null,
      items: new Map(),
      references: [],
      properties: [],
      associations: new Map(),
      groups: [],
      locations: new Map(),
      idat: null,
    };

    const pitm = find('pitm');
    if (pitm) result.primaryId = bytes[pitm.body] === 0 ? u16(bytes, pitm.body + 4) : u32(bytes, pitm.body + 4);

    const iinf = find('iinf');
    if (iinf) {
      const version = bytes[iinf.body];
      const entriesStart = iinf.body + 4 + (version === 0 ? 2 : 4);
      for (const infe of listBoxes(bytes, entriesStart, iinf.end).filter(box => box.type === 'infe')) {
        const infeVersion = bytes[infe.body];
        if (infeVersion < 2) continue;
        const flags = (bytes[infe.body + 1] << 16) | (bytes[infe.body + 2] << 8) | bytes[infe.body + 3];
        let offset = infe.body + 4;
        const id = infeVersion === 2 ? u16(bytes, offset) : u32(bytes, offset);
        offset += infeVersion === 2 ? 2 : 4;
        offset += 2; // item_protection_index
        const type = text(bytes, offset, 4);
        result.items.set(id, { id, type, hidden: (flags & 1) === 1 });
      }
    }

    const iref = find('iref');
    if (iref) {
      const wide = bytes[iref.body] !== 0;
      for (const ref of listBoxes(bytes, iref.body + 4, iref.end)) {
        let offset = ref.body;
        const from = wide ? u32(bytes, offset) : u16(bytes, offset);
        offset += wide ? 4 : 2;
        const count = u16(bytes, offset);
        offset += 2;
        const to = [];
        for (let index = 0; index < count; index += 1) {
          to.push(wide ? u32(bytes, offset) : u16(bytes, offset));
          offset += wide ? 4 : 2;
        }
        result.references.push({ type: ref.type, from, to });
      }
    }

    const iprp = find('iprp');
    if (iprp) {
      const iprpChildren = listBoxes(bytes, iprp.body, iprp.end);
      const ipco = iprpChildren.find(box => box.type === 'ipco');
      if (ipco) {
        result.properties = listBoxes(bytes, ipco.body, ipco.end).map((box, index) => ({
          index: index + 1,
          type: box.type,
          box: bytes.subarray(box.start, box.end),
          body: bytes.subarray(box.body, box.end),
        }));
      }
      for (const ipma of iprpChildren.filter(box => box.type === 'ipma')) {
        const version = bytes[ipma.body];
        const flags = bytes[ipma.body + 3];
        let offset = ipma.body + 4;
        const count = u32(bytes, offset);
        offset += 4;
        for (let entry = 0; entry < count && offset < ipma.end; entry += 1) {
          const id = version < 1 ? u16(bytes, offset) : u32(bytes, offset);
          offset += version < 1 ? 2 : 4;
          const associationCount = bytes[offset];
          offset += 1;
          const list = result.associations.get(id) || [];
          for (let association = 0; association < associationCount; association += 1) {
            if (flags & 1) {
              const value = u16(bytes, offset);
              list.push({ index: value & 0x7fff, essential: (value & 0x8000) !== 0 });
              offset += 2;
            } else {
              const value = bytes[offset];
              list.push({ index: value & 0x7f, essential: (value & 0x80) !== 0 });
              offset += 1;
            }
          }
          result.associations.set(id, list);
        }
      }
    }

    const grpl = find('grpl');
    if (grpl) {
      for (const group of listBoxes(bytes, grpl.body, grpl.end)) {
        const groupId = u32(bytes, group.body + 4);
        const count = u32(bytes, group.body + 8);
        const entityIds = [];
        for (let index = 0; index < count && group.body + 12 + index * 4 + 4 <= group.end; index += 1) {
          entityIds.push(u32(bytes, group.body + 12 + index * 4));
        }
        result.groups.push({ type: group.type, groupId, entityIds, box: bytes.subarray(group.start, group.end) });
      }
    }

    const idat = find('idat');
    if (idat) result.idat = bytes.subarray(idat.body, idat.end);

    const iloc = find('iloc');
    if (iloc) {
      const version = bytes[iloc.body];
      let offset = iloc.body + 4;
      const offsetSize = bytes[offset] >> 4;
      const lengthSize = bytes[offset] & 15;
      const baseOffsetSize = bytes[offset + 1] >> 4;
      const indexSize = version === 1 || version === 2 ? bytes[offset + 1] & 15 : 0;
      offset += 2;
      const count = version < 2 ? u16(bytes, offset) : u32(bytes, offset);
      offset += version < 2 ? 2 : 4;
      for (let entry = 0; entry < count && offset < iloc.end; entry += 1) {
        const id = version < 2 ? u16(bytes, offset) : u32(bytes, offset);
        offset += version < 2 ? 2 : 4;
        let constructionMethod = 0;
        if (version === 1 || version === 2) {
          constructionMethod = u16(bytes, offset) & 15;
          offset += 2;
        }
        offset += 2; // data_reference_index
        const baseOffset = readUint(bytes, offset, baseOffsetSize);
        offset += baseOffsetSize;
        const extentCount = u16(bytes, offset);
        offset += 2;
        const extents = [];
        for (let extent = 0; extent < extentCount; extent += 1) {
          offset += indexSize;
          const extentOffset = readUint(bytes, offset, offsetSize);
          offset += offsetSize;
          const extentLength = readUint(bytes, offset, lengthSize);
          offset += lengthSize;
          extents.push({ offset: baseOffset + extentOffset, length: extentLength });
        }
        result.locations.set(id, { constructionMethod, extents });
      }
    }
    return result;
  }

  /** Bytes of one item, joined across its extents. */
  function readItemData(parsed, id) {
    const location = parsed.locations.get(id);
    if (!location) return null;
    const source = location.constructionMethod === 1 ? parsed.idat : parsed.bytes;
    if (!source || location.constructionMethod > 1) return null;
    const total = location.extents.reduce((sum, extent) => sum + extent.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const extent of location.extents) {
      const length = extent.length || source.length - extent.offset;
      out.set(source.subarray(extent.offset, extent.offset + length), cursor);
      cursor += length;
    }
    return out;
  }

  /** Properties associated with an item, in association order. */
  function itemProperties(parsed, id) {
    return (parsed.associations.get(id) || [])
      .map(association => {
        const property = parsed.properties[association.index - 1];
        return property ? { ...property, essential: association.essential } : null;
      })
      .filter(Boolean);
  }

  function itemProperty(parsed, id, type) {
    return itemProperties(parsed, id).find(property => property.type === type) || null;
  }

  /** Width/height from the item's 'ispe' property. */
  function itemSize(parsed, id) {
    const ispe = itemProperty(parsed, id, 'ispe');
    if (!ispe || ispe.body.length < 12) return null;
    return { width: u32(ispe.body, 4), height: u32(ispe.body, 8) };
  }

  /** {left, right} item IDs of the first stereo pair group, if any. */
  function stereoPair(parsed) {
    const group = parsed?.groups.find(candidate => candidate.type === 'ster' && candidate.entityIds.length >= 2);
    if (!group) return null;
    const [left, right] = group.entityIds;
    if (!parsed.items.has(left) || !parsed.items.has(right)) return null;
    return { left, right, groupId: group.groupId };
  }

  /** 'display-p3' when the item's colour information names P3 primaries. */
  function itemColorSpace(parsed, id) {
    const colr = itemProperty(parsed, id, 'colr');
    if (!colr || colr.body.length < 4) return 'srgb';
    const kind = text(colr.body, 0, 4);
    if (kind === 'nclx' && colr.body.length >= 6) {
      return u16(colr.body, 4) === 12 ? 'display-p3' : 'srgb';
    }
    if (kind === 'prof' || kind === 'rICC') {
      const icc = colr.body.subarray(4);
      const ascii = text(icc, 0, icc.length);
      if (ascii.includes('Display P3')) return 'display-p3';
      // 'mluc' descriptions are UTF-16BE.
      const utf16 = 'Display P3'.split('').map(char => `\0${char}`).join('');
      return ascii.includes(utf16) ? 'display-p3' : 'srgb';
    }
    return 'srgb';
  }

  /**
   * Camera intrinsics from a 'cmin' property, as fractions of the image size
   * (focal length / width, principal point / width or height).
   */
  function parseCameraIntrinsics(property) {
    const body = property?.body;
    if (!body || body.length < 16 || body[0] !== 0) return null;
    const flags = (body[1] << 16) | (body[2] << 8) | body[3];
    const denominator = 2 ** ((flags & 0x1f00) >> 8);
    const matrix = {
      focalLengthX: i32(body, 4) / denominator,
      principalPointX: i32(body, 8) / denominator,
      principalPointY: i32(body, 12) / denominator,
      focalLengthY: null,
      skew: 0,
      anisotropic: (flags & 1) === 1,
    };
    if (matrix.anisotropic && body.length >= 24) {
      matrix.focalLengthY = i32(body, 16) / denominator;
      matrix.skew = i32(body, 20) / 2 ** ((flags & 0x1f0000) >> 16);
    }
    return matrix;
  }

  function fixedPointShift(value) {
    if (value === 0) return 31;
    let magnitude = Math.abs(value);
    let shift = 0;
    while (magnitude < 2 ** 30 && shift < 31) {
      magnitude *= 2;
      shift += 1;
    }
    return shift;
  }

  /** Serialise intrinsics as a 'cmin' box, matching libheif's encoding. */
  function cameraIntrinsicsBox(matrix) {
    let shift = Math.min(
      fixedPointShift(matrix.focalLengthX),
      fixedPointShift(matrix.principalPointX),
      fixedPointShift(matrix.principalPointY)
    );
    let skewShift = 0;
    if (matrix.anisotropic) {
      shift = Math.min(shift, fixedPointShift(matrix.focalLengthY));
      skewShift = fixedPointShift(matrix.skew);
    }
    const flags = (matrix.anisotropic ? 1 : 0) | (shift << 8) | (skewShift << 16);
    const values = [matrix.focalLengthX, matrix.principalPointX, matrix.principalPointY];
    if (matrix.anisotropic) values.push(matrix.focalLengthY);
    const fields = values.map(value => int32(Math.trunc(value * 2 ** shift)));
    if (matrix.anisotropic) fields.push(int32(Math.trunc(matrix.skew * 2 ** skewShift)));
    return fullBox('cmin', 0, flags, ...fields);
  }

  /**
   * Re-express intrinsics after the image (innerWidth × innerHeight) was
   * scaled by `scale` and placed at (offsetX, offsetY) inside a larger canvas
   * of outerWidth × outerHeight.
   */
  function reframeCameraIntrinsics(matrix, innerWidth, innerHeight, offsetX, offsetY, outerWidth, outerHeight, scale = 1) {
    const focalX = matrix.focalLengthX * innerWidth * scale;
    const focalY = (matrix.anisotropic ? matrix.focalLengthY * innerHeight : matrix.focalLengthX * innerWidth) * scale;
    return {
      focalLengthX: focalX / outerWidth,
      principalPointX: (matrix.principalPointX * innerWidth * scale + offsetX) / outerWidth,
      principalPointY: (matrix.principalPointY * innerHeight * scale + offsetY) / outerHeight,
      anisotropic: true,
      focalLengthY: focalY / outerHeight,
      skew: matrix.skew || 0,
    };
  }

  // ─── Writing ───────────────────────────────────────────────────────────────
  const ascii = value => Uint8Array.from(value, char => char.charCodeAt(0));
  const int8 = value => Uint8Array.of(value & 0xff);
  const int16 = value => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
  const int32 = value => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function box(type, ...payload) {
    const body = concat(payload);
    return concat([int32(body.length + 8), ascii(type), body]);
  }

  function fullBox(type, version, flags, ...payload) {
    return box(type, int8(version), Uint8Array.of((flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
  }

  /** 'ispe' image size property. */
  function imageSizeBox(width, height) {
    return fullBox('ispe', 0, 0, int32(width), int32(height));
  }

  /** 'colr' nclx property for sRGB or Display P3 (full range, BT.601 matrix). */
  function colourBox(colorSpace) {
    const primaries = colorSpace === 'display-p3' ? 12 : 1;
    return box('colr', ascii('nclx'), int16(primaries), int16(13), int16(6), int8(0x80));
  }

  /**
   * Assemble a still-image HEIF.
   * items: [{id, type, data, properties: [boxBytes], essential: [bool], hidden}]
   * properties shared across items are written once (compared by content).
   */
  function buildHeif({ majorBrand = 'heic', compatibleBrands = ['mif1', 'heic'], primaryId, items, references = [], groups = [] }) {
    const propertyBoxes = [];
    const propertyIndex = boxBytes => {
      const key = Array.from(boxBytes).join(',');
      let index = propertyBoxes.findIndex(existing => existing.key === key);
      if (index < 0) {
        propertyBoxes.push({ key, bytes: boxBytes });
        index = propertyBoxes.length - 1;
      }
      return index + 1;
    };
    const associations = items.map(item => ({
      id: item.id,
      list: (item.properties || []).map((property, index) => ({
        index: propertyIndex(property),
        essential: !!item.essential?.[index],
      })),
    }));
    const wideProperties = propertyBoxes.length > 127;

    const ftyp = box('ftyp', ascii(majorBrand), int32(0), ...compatibleBrands.map(ascii));
    const hdlr = fullBox('hdlr', 0, 0, int32(0), ascii('pict'), new Uint8Array(12), Uint8Array.of(0));
    const pitm = fullBox('pitm', 0, 0, int16(primaryId));
    const iinf = fullBox('iinf', 0, 0, int16(items.length), ...items.map(item => (
      fullBox('infe', 2, item.hidden ? 1 : 0, int16(item.id), int16(0), ascii(item.type), Uint8Array.of(0))
    )));
    const iref = references.length
      ? fullBox('iref', 0, 0, ...references.map(reference => box(
        reference.type,
        int16(reference.from),
        int16(reference.to.length),
        ...reference.to.map(int16)
      )))
      : new Uint8Array(0);
    const ipco = box('ipco', ...propertyBoxes.map(property => property.bytes));
    const ipma = fullBox('ipma', 0, wideProperties ? 1 : 0, int32(associations.length), ...associations.map(entry => concat([
      int16(entry.id),
      int8(entry.list.length),
      ...entry.list.map(association => (wideProperties
        ? int16((association.essential ? 0x8000 : 0) | association.index)
        : int8((association.essential ? 0x80 : 0) | association.index))),
    ])));
    const iprp = box('iprp', ipco, ipma);
    const grpl = groups.length
      ? box('grpl', ...groups.map(group => fullBox(
        group.type, 0, 0, int32(group.groupId), int32(group.entityIds.length), ...group.entityIds.map(int32)
      )))
      : new Uint8Array(0);

    // iloc offsets are absolute, so size the meta box first, then fill them in.
    const ilocFor = offsets => fullBox('iloc', 0, 0, Uint8Array.of(0x44, 0x00), int16(items.length), ...items.map((item, index) => concat([
      int16(item.id), int16(0), int16(1), int32(offsets[index]), int32(item.data.length),
    ])));
    const metaFor = iloc => fullBox('meta', 0, 0, hdlr, pitm, iloc, iinf, iref, iprp, grpl);
    const placeholderMeta = metaFor(ilocFor(items.map(() => 0)));
    const mdatHeader = 8;
    let cursor = ftyp.length + placeholderMeta.length + mdatHeader;
    const offsets = items.map(item => {
      const offset = cursor;
      cursor += item.data.length;
      return offset;
    });
    const meta = metaFor(ilocFor(offsets));
    const mdat = box('mdat', ...items.map(item => item.data));
    return concat([ftyp, meta, mdat]);
  }

  return Object.freeze({
    isHeif,
    listBoxes,
    parseHeif,
    readItemData,
    itemProperties,
    itemProperty,
    itemSize,
    stereoPair,
    itemColorSpace,
    parseCameraIntrinsics,
    cameraIntrinsicsBox,
    reframeCameraIntrinsics,
    imageSizeBox,
    colourBox,
    box,
    fullBox,
    buildHeif,
  });
});
