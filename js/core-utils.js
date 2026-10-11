/**
 * Pure, environment-independent helpers shared by the app and automated tests.
 */
(function initInstaFrameCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InstaFrameCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const PREVIEW_QUALITIES = Object.freeze(['auto', 'draft', 'normal', 'high', 'max']);
  const MIN_PREVIEW_ZOOM = 0.5;
  const MAX_PREVIEW_ZOOM = 12;
  const PREVIEW_ZOOM_SLIDER_MIN = 50;
  const PREVIEW_ZOOM_SLIDER_MAX = 1200;
  const MAX_SAFE_CANVAS_SIDE = 16_384;

  function normalizePreviewQuality(value) {
    return PREVIEW_QUALITIES.includes(value) ? value : 'auto';
  }

  function getPreviewZoomForSliderValue(value) {
    const sliderValue = Math.max(
      PREVIEW_ZOOM_SLIDER_MIN,
      Math.min(PREVIEW_ZOOM_SLIDER_MAX, Number(value) || PREVIEW_ZOOM_SLIDER_MIN)
    );
    const progress = (sliderValue - PREVIEW_ZOOM_SLIDER_MIN) /
      (PREVIEW_ZOOM_SLIDER_MAX - PREVIEW_ZOOM_SLIDER_MIN);
    return MIN_PREVIEW_ZOOM * Math.pow(MAX_PREVIEW_ZOOM / MIN_PREVIEW_ZOOM, progress);
  }

  function getPreviewSliderValueForZoom(zoom) {
    const safeZoom = Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, Number(zoom) || 1));
    const progress = Math.log(safeZoom / MIN_PREVIEW_ZOOM) /
      Math.log(MAX_PREVIEW_ZOOM / MIN_PREVIEW_ZOOM);
    return PREVIEW_ZOOM_SLIDER_MIN +
      progress * (PREVIEW_ZOOM_SLIDER_MAX - PREVIEW_ZOOM_SLIDER_MIN);
  }

  function getPreviewWheelZoomFactor(deltaY, deltaMode = 0) {
    const rawDelta = Number(deltaY) || 0;
    const mode = Number(deltaMode) || 0;
    const pixelDelta = rawDelta * (mode === 1 ? 100 / 3 : mode === 2 ? 240 : 1);
    const boundedDelta = Math.max(-240, Math.min(240, pixelDelta));
    return Math.pow(1.12, -boundedDelta / 100);
  }

  function getPreviewPanForZoomFocus(
    panX,
    panY,
    currentZoom,
    nextZoom,
    sourceFocalX,
    sourceFocalY,
    targetFocalX,
    targetFocalY,
    centerX,
    centerY
  ) {
    const fromZoom = Math.max(0.0001, Number(currentZoom) || 1);
    const toZoom = Math.max(0.0001, Number(nextZoom) || fromZoom);
    const originX = Number(centerX) || 0;
    const originY = Number(centerY) || 0;
    const localX = ((Number(sourceFocalX) || 0) - originX - (Number(panX) || 0)) / fromZoom;
    const localY = ((Number(sourceFocalY) || 0) - originY - (Number(panY) || 0)) / fromZoom;
    return {
      x: (Number(targetFocalX) || 0) - originX - toZoom * localX,
      y: (Number(targetFocalY) || 0) - originY - toZoom * localY,
    };
  }

  /**
   * Return backing-store pixels per CSS pixel. Composition is rendered once at
   * a stable logical size; only this density changes between quality choices.
   */
  function getPreviewBackingScale(quality, devicePixelRatio = 1, zoom = 1) {
    const q = normalizePreviewQuality(quality);
    const dpr = Math.max(1, Number(devicePixelRatio) || 1);
    const safeZoom = Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, Number(zoom) || 1));
    const zoomDetail = Math.sqrt(Math.max(1, safeZoom));
    if (q === 'draft') return Math.min(2.5, Math.max(1, zoomDetail));
    if (q === 'normal') return Math.min(4, Math.max(1.5, Math.min(2, dpr)) * zoomDetail);
    if (q === 'high') return Math.min(6, Math.max(2, Math.min(3, dpr * 1.5)) * zoomDetail);
    if (q === 'max') {
      return Math.min(MAX_PREVIEW_ZOOM, Math.max(safeZoom, Math.max(3, Math.min(4, dpr * 2)) * zoomDetail));
    }
    // Auto should still look crisp on 1× desktop displays. Increase density
    // gradually while zooming instead of stretching the same backing bitmap.
    return Math.min(MAX_PREVIEW_ZOOM, Math.max(2, dpr * safeZoom));
  }

  /** Keep the requested detail unless its backing canvas would exceed a safe pixel budget. */
  function getBudgetedPreviewBackingScale(requestedScale, cssWidth, cssHeight, maxPixels) {
    const requested = Math.max(0.25, Number(requestedScale) || 1);
    const width = Math.max(1, Number(cssWidth) || 1);
    const height = Math.max(1, Number(cssHeight) || 1);
    const budget = Math.max(1, Number(maxPixels) || 1);
    const pixelBudgetScale = Math.sqrt(budget / (width * height));
    const sideBudgetScale = Math.min(
      MAX_SAFE_CANVAS_SIDE / width,
      MAX_SAFE_CANVAS_SIDE / height
    );
    return Math.min(requested, pixelBudgetScale, sideBudgetScale);
  }

  /**
   * Plan a source crop that restores visible detail when the full preview hits
   * its backing-store budget. The returned overlay is viewport-sized, so its
   * memory use does not grow with zoom or with the off-screen frame area.
   */
  function getVisiblePreviewDetailPlan({
    sourceWidth,
    sourceHeight,
    canvasRect,
    viewportRect,
    baseBackingWidth,
    baseBackingHeight,
    devicePixelRatio = 1,
    maxPixels,
  }) {
    const sourceW = Number(sourceWidth) || 0;
    const sourceH = Number(sourceHeight) || 0;
    const canvas = canvasRect || {};
    const viewport = viewportRect || {};
    const canvasW = Number(canvas.width) || 0;
    const canvasH = Number(canvas.height) || 0;
    const viewportW = Number(viewport.width) || 0;
    const viewportH = Number(viewport.height) || 0;
    if (sourceW <= 0 || sourceH <= 0 || canvasW <= 0 || canvasH <= 0 ||
        viewportW <= 0 || viewportH <= 0) return null;

    const canvasLeft = Number(canvas.left) || 0;
    const canvasTop = Number(canvas.top) || 0;
    const viewportLeft = Number(viewport.left) || 0;
    const viewportTop = Number(viewport.top) || 0;
    const left = Math.max(canvasLeft, viewportLeft);
    const top = Math.max(canvasTop, viewportTop);
    const right = Math.min(canvasLeft + canvasW, viewportLeft + viewportW);
    const bottom = Math.min(canvasTop + canvasH, viewportTop + viewportH);
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) return null;

    const baseDensity = Math.min(
      (Number(baseBackingWidth) || 0) / canvasW,
      (Number(baseBackingHeight) || 0) / canvasH
    );
    const sourceDensity = Math.min(sourceW / canvasW, sourceH / canvasH);
    const requestedDensity = Math.min(
      Math.max(1, Number(devicePixelRatio) || 1),
      sourceDensity
    );
    const density = getBudgetedPreviewBackingScale(
      requestedDensity,
      width,
      height,
      maxPixels
    );
    if (!Number.isFinite(baseDensity) || density <= baseDensity * 1.05) return null;

    const sourceX = (left - canvasLeft) / canvasW * sourceW;
    const sourceY = (top - canvasTop) / canvasH * sourceH;
    const sourceCropWidth = width / canvasW * sourceW;
    const sourceCropHeight = height / canvasH * sourceH;
    return {
      left,
      top,
      width,
      height,
      sourceX,
      sourceY,
      sourceWidth: sourceCropWidth,
      sourceHeight: sourceCropHeight,
      density,
      pixelWidth: Math.max(1, Math.floor(width * density)),
      pixelHeight: Math.max(1, Math.floor(height * density)),
      baseDensity,
    };
  }

  /** Conservative ZIP peak: retained outputs + photo entry blobs + archive blob. */
  function estimateZipPeakBytes(retainedBytes, encodedPhotoBytes, archiveInputBytes, entryCount = 0) {
    const safe = value => Math.max(0, Number(value) || 0);
    return safe(retainedBytes) + safe(encodedPhotoBytes) + safe(archiveInputBytes) +
      Math.floor(safe(entryCount)) * 2048;
  }

  function formatCoordinateLabel(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
  }

  /** Parse exposure text such as "1/250", "1/250s", "0.004" or "2s" into seconds. */
  function parseExposureSeconds(value) {
    const raw = String(value ?? '').trim().replace(/\s*(?:s|sec|秒)$/i, '');
    if (!raw) return null;
    const fraction = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    const seconds = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  /** Format exposure seconds the way cameras label them: "1/250", "0.3" or "2". */
  function formatExposureTime(value) {
    const seconds = parseExposureSeconds(value);
    if (seconds == null) return String(value ?? '').trim();
    const trimDecimal = number => String(Math.round(number * 10) / 10);
    if (seconds >= 1) return trimDecimal(seconds);
    const denominator = 1 / seconds;
    const rounded = Math.round(denominator);
    if (rounded >= 2 && Math.abs(denominator - rounded) / rounded <= 0.02) return `1/${rounded}`;
    return trimDecimal(seconds);
  }

  function normalizeHexColor(value, fallback = '#111111') {
    const raw = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return (`#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`).toUpperCase();
    }
    return fallback;
  }

  const VIDEO_CODECS = {
    avc1: 'h264', avc3: 'h264',
    hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
    av01: 'av1', vp08: 'vp8', vp09: 'vp9',
    apcn: 'prores', apch: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores', ap4x: 'prores',
    mp4v: 'mpeg4', jpeg: 'mjpeg', mjpa: 'mjpeg',
  };

  function fourcc(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  /** Walk ISO BMFF boxes in bytes[start, end) and return {type, start, end, body}. */
  function listMp4Boxes(bytes, start = 0, end = bytes.length) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
      const type = fourcc(bytes, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = Number(new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getBigUint64(0));
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

  /**
   * Describe the first video track of an MP4/MOV `moov` box: codec family,
   * sample entry fourcc, HEVC profile (2 = Main 10) and Dolby Vision signalling.
   */
  function parseMp4VideoCodec(moov) {
    const bytes = moov instanceof Uint8Array ? moov : new Uint8Array(moov);
    const child = (box, type) => listMp4Boxes(bytes, box.body, box.end).find(item => item.type === type);
    const root = listMp4Boxes(bytes).find(box => box.type === 'moov');
    if (!root) return null;
    for (const trak of listMp4Boxes(bytes, root.body, root.end).filter(box => box.type === 'trak')) {
      const mdia = child(trak, 'mdia');
      const hdlr = mdia && child(mdia, 'hdlr');
      if (!hdlr || fourcc(bytes, hdlr.body + 8) !== 'vide') continue;
      const stbl = mdia && child(mdia, 'minf') && child(child(mdia, 'minf'), 'stbl');
      const stsd = stbl && child(stbl, 'stsd');
      if (!stsd) continue;
      const [entry] = listMp4Boxes(bytes, stsd.body + 8, stsd.end);
      if (!entry) continue;
      const info = {
        fourcc: entry.type,
        codec: VIDEO_CODECS[entry.type] || 'other',
        width: entry.body + 26 <= entry.end ? (bytes[entry.body + 24] << 8) + bytes[entry.body + 25] : 0,
        height: entry.body + 28 <= entry.end ? (bytes[entry.body + 26] << 8) + bytes[entry.body + 27] : 0,
        profile: null,
        dolbyVision: entry.type === 'dvh1' || entry.type === 'dvhe',
      };
      // VisualSampleEntry fields take 78 bytes before the codec's child boxes.
      for (const config of listMp4Boxes(bytes, entry.body + 78, entry.end)) {
        if (config.type === 'hvcC' && config.body + 2 <= config.end) info.profile = bytes[config.body + 1] & 0x1f;
        if (config.type === 'avcC' && config.body + 2 <= config.end) info.profile = bytes[config.body + 1];
        if (config.type === 'dvcC' || config.type === 'dvvC') info.dolbyVision = true;
      }
      return info;
    }
    return null;
  }

  /** Find the video CodecID in the head of a Matroska/WebM file. */
  function parseMatroskaVideoCodec(head) {
    const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);
    const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
    const ids = [
      ['V_MPEGH/ISO/HEVC', 'hevc'], ['V_MPEG4/ISO/AVC', 'h264'], ['V_AV1', 'av1'],
      ['V_VP9', 'vp9'], ['V_VP8', 'vp8'], ['V_PRORES', 'prores'],
    ];
    const match = ids.find(([id]) => text.includes(id));
    return match ? { fourcc: match[0], codec: match[1], profile: null, dolbyVision: false } : null;
  }

  function isAllowedOrigin(origin, allowedOrigins) {
    const value = String(origin || '');
    return (allowedOrigins || []).some(pattern => {
      const candidate = String(pattern || '');
      if (candidate.endsWith(':*')) return value.startsWith(candidate.slice(0, -1));
      return value === candidate;
    });
  }

  return Object.freeze({
    PREVIEW_QUALITIES,
    MIN_PREVIEW_ZOOM,
    MAX_PREVIEW_ZOOM,
    PREVIEW_ZOOM_SLIDER_MIN,
    PREVIEW_ZOOM_SLIDER_MAX,
    MAX_SAFE_CANVAS_SIDE,
    normalizePreviewQuality,
    getPreviewZoomForSliderValue,
    getPreviewSliderValueForZoom,
    getPreviewWheelZoomFactor,
    getPreviewPanForZoomFocus,
    getPreviewBackingScale,
    getBudgetedPreviewBackingScale,
    getVisiblePreviewDetailPlan,
    estimateZipPeakBytes,
    formatCoordinateLabel,
    parseExposureSeconds,
    formatExposureTime,
    normalizeHexColor,
    isAllowedOrigin,
    listMp4Boxes,
    parseMp4VideoCodec,
    parseMatroskaVideoCodec,
  });
});
