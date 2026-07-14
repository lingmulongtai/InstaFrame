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

  function normalizeHexColor(value, fallback = '#111111') {
    const raw = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return (`#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`).toUpperCase();
    }
    return fallback;
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
    estimateZipPeakBytes,
    formatCoordinateLabel,
    normalizeHexColor,
    isAllowedOrigin,
  });
});
