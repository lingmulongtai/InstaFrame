/**
 * app.js — InstaFrame Web App
 * Batch photo frame generator with EXIF support
 */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  items: [],       // Array of ImageItem objects
  settings: {
    // ── Frame rendering ──────────────────────────────────────────
    frameColor:          '#F0F0F0',
    frameBackground:     'color',   // 'color' | 'blur'
    blurRadius:          20,
    blurStyle:           'normal',  // 'normal' | 'grayscale' | 'sepia' | 'saturate'
    blurBrightness:      80,
    thicknessScale:      1.0,
    imageOffsetY:        0,
    fontFamily:          'Inter',
    shotOnFontScale:     1.0,
    exifFontScale:       1.0,
    lineGapScale:        1.0,
    textOffsetY:         0,
    cameraNameBold:      false,
    cameraNameItalic:    false,
    exifItalic:          false,
    showShotOn:          true,
    showDecoLine:        true,
    showExifInfo:        true,
    cameraNameOnly:      false,
    showLocation:        false,
    locationPosition:    'below-exif',
    locationIconStyle:   'pin',     // 'pin' | 'dot' | 'compass' | 'globe'
    outerPadding:        0,
    aspectRatio:         'original',
    aspectOrientation:   'auto',
    // ── Map overlay ──────────────────────────────────────────────
    showMapOverlay:      false,
    mapOverlayOpacity:   0.7,
    // ── Export (applied at download time) ────────────────────────
    exportPhotoFormat:   'jpeg',   // 'jpeg' | 'webp' | 'png'
    exportPhotoQuality:  92,       // 60–100 (ignored for PNG)
    exportVideoFormat:   '',       // resolved dynamically from supported MIME types
    exportVideoBitrate:  8,        // Mbps
  },
  // Custom color state
  isCustomColor: false,
  customColorValue: '#e8c49a',
  // Which item is shown in live preview (null = always first)
  selectedItemId: null,
};

// ImageItem extra fields for video:
//   isVideo:   boolean
//   videoBlob: Blob | null   (filled after generation)
//   progress:  number 0..1   (encoding progress)

let itemIdCounter = 0;
let previewZoom   = 1.0;
let previewPan    = { x: 0, y: 0 };
const SETTINGS_HISTORY_LIMIT = 80;
const _settingsUndoStack = [];
const _settingsRedoStack = [];
let _historyLocked = false;
let _updateMobileEmptyOverlay = null; // set by setupMobileTabs, called from updateUI

function _createSettingsSnapshot() {
  return {
    settings: { ...state.settings },
    isCustomColor: !!state.isCustomColor,
    customColorValue: state.customColorValue,
  };
}

function _settingsSnapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function _isPreviewViewModified() {
  const q = loadPrefs().previewQuality || 'auto';
  return (
    Math.abs(previewZoom - 1) > 0.001 ||
    Math.abs(previewPan.x) > 0.5 ||
    Math.abs(previewPan.y) > 0.5 ||
    q !== 'auto'
  );
}

function updatePreviewViewModifiedState() {
  const zone = document.getElementById('dropZone');
  if (zone) zone.classList.toggle('view-modified', _isPreviewViewModified());
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undoEditBtn');
  const redoBtn = document.getElementById('redoEditBtn');
  if (undoBtn) undoBtn.disabled = _settingsUndoStack.length === 0;
  if (redoBtn) redoBtn.disabled = _settingsRedoStack.length === 0;
}

// ─── Preview caches ───────────────────────────────────────────────────────────
const _imgCache      = new Map(); // item.id → { img: HTMLImageElement, objUrl: string }
const _frameCache    = new Map(); // "${item.id}|${hash}" → HTMLCanvasElement
const _mapImgCache   = new Map(); // "lat,lon,zoom" → HTMLImageElement (Mapbox static tiles)
const _imgFailed     = new Set(); // item IDs that failed image load — skip retry
let   _renderSeq     = 0;         // increments on each render to cancel stale ones

// ─── Mapbox token & usage tracking ────────────────────────────────────────────
const DEFAULT_MAPBOX_TOKEN   = 'pk.eyJ1IjoibGluZ211bG9uZ3RhaSIsImEiOiJjbW53cHp3eHoxbDZhMnBtbzB3b3huemZwIn0.kX4B2BumC8txS9rZw41a-Q';
const MAPBOX_USAGE_KEY       = 'instaframe_mb_usage';
const MAPBOX_MONTHLY_LIMIT   = 50000;

function _getMapboxUsage() {
  try {
    const data = JSON.parse(localStorage.getItem(MAPBOX_USAGE_KEY) || '{}');
    const now  = new Date();
    const month = `${now.getFullYear()}-${now.getMonth()}`;
    if (data.month !== month) return { count: 0, month };
    return data;
  } catch { return { count: 0, month: '' }; }
}

function _trackMapboxLoad() {
  try {
    const usage = _getMapboxUsage();
    usage.count += 1;
    localStorage.setItem(MAPBOX_USAGE_KEY, JSON.stringify(usage));
  } catch {}
}

/** Return the effective Mapbox token to use: default (if within limit) → null. */
function getMapboxToken() {
  const usage = _getMapboxUsage();
  if (usage.count >= MAPBOX_MONTHLY_LIMIT) return null;
  return DEFAULT_MAPBOX_TOKEN;
}

/** Fetch a Mapbox static map image and return it as a loaded HTMLImageElement, with caching. */
async function _fetchMapOverlayImage(lat, lon, zoom = 13) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${zoom}`;
  if (_mapImgCache.has(key)) return _mapImgCache.get(key);
  const token = getMapboxToken();
  if (!token) return null;
  const url = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/${lon.toFixed(5)},${lat.toFixed(5)},${zoom}/400x280@2x?access_token=${token}`;
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { _trackMapboxLoad(); _mapImgCache.set(key, img); resolve(img); };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ImageItem schema:
// {
//   id: number,
//   file: File,
//   exif: { make, model, lensModel, focalLength, fNumber, exposureTime, iso },
//   canvas: HTMLCanvasElement | null,
//   status: 'pending' | 'processing' | 'done' | 'error',
//   errorMsg: string | null,
// }

// ─── Font popularity ──────────────────────────────────────────────────────────
const FONT_USAGE_KEY = 'instaframe_font_usage';
const ALL_FONTS = [
  'Inter', 'Montserrat', 'DM Sans', 'Lato', 'Poppins', 'Raleway', 'Nunito',
  'Josefin Sans', 'Oswald', 'Work Sans',
  'Playfair Display', 'Cormorant Garamond', 'EB Garamond',
  'Libre Baskerville', 'Cinzel', 'Source Serif 4',
];

function loadFontUsage() {
  try { return JSON.parse(localStorage.getItem(FONT_USAGE_KEY)) || {}; } catch { return {}; }
}
function saveFontUsage(usage) {
  try { localStorage.setItem(FONT_USAGE_KEY, JSON.stringify(usage)); } catch {}
}
function recordFontUsage(family) {
  const usage = loadFontUsage();
  usage[family] = (usage[family] || 0) + 1;
  saveFontUsage(usage);
}

function buildFontSelect() {
  const sel = document.getElementById('fontFamily');
  if (!sel) return;
  const usage   = loadFontUsage();
  const sorted  = [...ALL_FONTS].sort((a, b) => (usage[b] || 0) - (usage[a] || 0));
  const popular = sorted.slice(0, 5);
  const rest    = ALL_FONTS.filter(f => !popular.includes(f)).sort();
  // Preserve current selection (sel.value if already set, else fall back to state)
  const current = (sel.value && ALL_FONTS.includes(sel.value))
    ? sel.value
    : (state.settings.fontFamily || 'Inter');

  sel.innerHTML = '';

  const makeOpt = (f) => {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    if (f === current) o.selected = true;
    return o;
  };

  if (popular.length) {
    const g1 = document.createElement('optgroup');
    g1.label = '⭐ Popular';
    popular.forEach(f => g1.appendChild(makeOpt(f)));
    sel.appendChild(g1);
  }
  if (rest.length) {
    const g2 = document.createElement('optgroup');
    g2.label = 'More';
    rest.forEach(f => g2.appendChild(makeOpt(f)));
    sel.appendChild(g2);
  }
}

// ─── EXIF / Metadata Reading ──────────────────────────────────────────────────
function isVideoFile(file) {
  return file.type.startsWith('video/') ||
    /\.(mp4|mov|webm|avi|mkv|m4v|3gp)$/i.test(file.name);
}

async function readVideoMetadata(file) {
  // exifr can read some QuickTime/XMP metadata from MP4/MOV
  try {
    const raw = await exifr.parse(file, {
      pick: ['Make', 'Model', 'Software', 'Author'],
    });
    if (raw) {
      return {
        make:         cleanStr(raw.Make     || raw.Author   || ''),
        model:        cleanStr(raw.Model    || raw.Software || ''),
        lensModel:    '',
        focalLength:  '',
        fNumber:      '',
        exposureTime: '',
        iso:          '',
        location:     '',
      };
    }
  } catch (_) {}
  return emptyExif();
}

async function readExif(file) {
  try {
    const raw = await exifr.parse(file, {
      pick: ['Make', 'Model', 'LensModel', 'FocalLength',
             'FNumber', 'ExposureTime', 'ISO', 'ISOSpeedRatings',
             'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'],
    });
    if (!raw) return emptyExif();

    // Parse GPS coordinates if present
    let location  = '';
    let latitude  = null;
    let longitude = null;
    if (raw.GPSLatitude && raw.GPSLongitude) {
      const lat = gpsToDecimal(raw.GPSLatitude, raw.GPSLatitudeRef);
      const lon = gpsToDecimal(raw.GPSLongitude, raw.GPSLongitudeRef);
      if (lat != null && lon != null) {
        latitude  = lat;
        longitude = lon;
        // Kick off reverse geocoding asynchronously; returns raw coords initially
        location = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
        // Store coords for later reverse-geocoding
        reverseGeocode(lat, lon).then(name => { if (name) location = name; }).catch(() => {});
      }
    }

    return {
      make:         cleanStr(raw.Make || ''),
      model:        cleanStr(raw.Model || ''),
      lensModel:    cleanStr(raw.LensModel || ''),
      focalLength:  raw.FocalLength ? String(Math.round(raw.FocalLength)) : '',
      fNumber:      raw.FNumber     ? formatFNumber(raw.FNumber) : '',
      exposureTime: raw.ExposureTime ? String(raw.ExposureTime) : '',
      iso:          raw.ISO || raw.ISOSpeedRatings || '',
      location,
      latitude,
      longitude,
    };
  } catch (e) {
    return emptyExif();
  }
}

function emptyExif() {
  return { make:'', model:'', lensModel:'', focalLength:'', fNumber:'', exposureTime:'', iso:'', location:'', latitude: null, longitude: null };
}

function gpsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [d, m, s] = dms;
  const decimal = d + m / 60 + s / 3600;
  return (ref === 'S' || ref === 'W') ? -decimal : decimal;
}

const _geocodeCache = {};
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (_geocodeCache[key]) return _geocodeCache[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const a = data.address || {};
    const city    = a.city || a.town || a.village || a.county || '';
    const country = a.country || '';
    const name    = [city, country].filter(Boolean).join(', ');
    if (name) _geocodeCache[key] = name;
    return name || null;
  } catch {
    return null;
  }
}

function cleanStr(s) {
  return s.replace(/\0/g, '').trim();
}

function formatFNumber(v) {
  if (typeof v === 'number') return v % 1 === 0 ? String(v) : v.toFixed(1);
  return String(v);
}

// ─── Item Management ──────────────────────────────────────────────────────────
async function addFiles(files) {
  const accepted = Array.from(files).filter(f =>
    f.type.startsWith('image/') || f.type.startsWith('video/') ||
    /\.(jpe?g|png|heic|heif|webp|mp4|mov|webm|avi|mkv|m4v|3gp)$/i.test(f.name)
  );
  if (!accepted.length) return;

  for (const file of accepted) {
    const video = isVideoFile(file);
    const exif  = video ? await readVideoMetadata(file) : await readExif(file);
    const item  = {
      id: ++itemIdCounter,
      file,
      exif,
      canvas:    null,
      videoBlob: null,
      progress:  0,
      status:    'pending',
      errorMsg:  null,
      isVideo:   video,
    };
    state.items.push(item);
    renderItem(item);
    // Auto-select first item added for live preview
    if (state.items.length === 1) selectItem(item.id);

    // Pre-warm image cache so the first live preview is fast
    if (!video) _loadPreviewImage(item).catch(() => {});

    // Generate thumbnail for video cards asynchronously
    if (video) {
      FrameEngine.captureVideoFrame(file)
        .then(img => {
          const previewDiv = document.getElementById(`preview-${item.id}`);
          if (!previewDiv) return;
          const thumb = previewDiv.querySelector('img.thumb-orig');
          if (thumb && img) thumb.src = img.src;
        })
        .catch(() => {});
    }
  }

  updateUI();
  scheduleLivePreview();
}

function removeItem(id, options = {}) {
  const { skipConfirm = false } = options;
  if (!skipConfirm && !window.confirm(t('confirmDeleteItem'))) return;
  _invalidateItemCache(id);
  const idx = state.items.findIndex(i => i.id === id);
  if (idx !== -1) state.items.splice(idx, 1);
  const el = document.getElementById(`item-${id}`);
  if (el) el.remove();
  // If removed item was selected, select the new first item
  if (state.selectedItemId === id) {
    state.selectedItemId = null;
    if (state.items.length > 0) selectItem(state.items[0].id);
  }
  updateUI();
  scheduleLivePreview();
}

function clearAllItems(skipConfirm = false) {
  if (state.items.length === 0) return;
  if (!skipConfirm && !window.confirm(t('confirmClearAll'))) return;
  const ids = state.items.map(i => i.id);
  ids.forEach(id => _invalidateItemCache(id));
  state.items = [];
  state.selectedItemId = null;
  const grid = document.getElementById('imageGrid');
  if (grid) grid.innerHTML = '';
  updateUI();
  scheduleLivePreview();
  showToast(t('msgClearedAll'), 'info');
}

// ─── Frame Generation ─────────────────────────────────────────────────────────
// onExternalProgress: optional (pct: 0..1) => void — for batch progress tracking
async function generateItem(item, onExternalProgress = null) {
  item.status   = 'processing';
  item.progress = 0;
  updateItemStatus(item);

  try {
    if (item.isVideo) {
      const mime    = resolveVideoMime(state.settings.exportVideoFormat);
      const bitrate = (state.settings.exportVideoBitrate || 8) * 1_000_000;
      item.videoBlob = await FrameEngine.renderVideoFrameWhenReady(
        item.file, item.exif, state.settings,
        {
          preferredMime:     mime,
          videoBitsPerSecond: bitrate,
          onProgress: p => {
            item.progress = p;
            updateItemStatus(item);
            if (onExternalProgress) onExternalProgress(p);
          },
        }
      );
    } else {
      const img = await FrameEngine.loadImage(item.file);
      // Pre-fetch map overlay image if enabled and coordinates are available
      let mapOverlayImg = null;
      if (state.settings.showMapOverlay && state.settings.showLocation &&
          item.exif && item.exif.latitude != null && item.exif.longitude != null) {
        mapOverlayImg = await _fetchMapOverlayImage(item.exif.latitude, item.exif.longitude);
      }
      item.canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings, { mapOverlayImg });
      if (onExternalProgress) onExternalProgress(1);
    }
    item.status   = 'done';
    item.errorMsg = null;
  } catch (e) {
    item.status   = 'error';
    item.errorMsg = e.message;
    if (onExternalProgress) onExternalProgress(1);
  }

  updateItemStatus(item);
  updateItemPreview(item);
  updateUI();
}

async function generateAll() {
  const pending = state.items.filter(i => i.status === 'pending');
  if (!pending.length && state.items.length === 0) {
    showToast(t('msgNoImages'), 'warn');
    return;
  }
  if (!pending.length) {
    showToast(t('msgNoPending'), 'info');
    return;
  }

  setGlobalBusy(true);
  const total = pending.length;

  for (let idx = 0; idx < total; idx++) {
    const item     = pending[idx];
    const basePct  = idx / total;
    const itemSlot = 1 / total;
    const prefix   = `${idx + 1} / ${total}`;

    showProgress(
      `${prefix}  —  ${item.isVideo ? '▶ ' : ''}${item.file.name}`,
      basePct
    );

    await generateItem(item, p => {
      const pctStr = item.isVideo ? `  ${Math.round(p * 100)}%` : '';
      showProgress(`${prefix}${pctStr}  —  ${item.file.name}`, basePct + itemSlot * p);
    });
  }

  hideProgress();
  setGlobalBusy(false);
  showToast(t('msgDone'), 'success');
}

async function regenerateItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item.status    = 'pending';
  item.videoBlob = null;
  item.canvas    = null;
  showProgress(`${item.isVideo ? '▶ ' : ''}${item.file.name}`, 0);
  await generateItem(item, p => showProgress(`${item.file.name}  ${item.isVideo ? Math.round(p*100)+'%' : ''}`, p));
  hideProgress();
}

// Apply frame (if needed) then download — used by per-item Download button
async function applyAndDownloadSingle(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  if (item.status !== 'done') {
    // Generate first
    setGlobalBusy(true);
    item.status    = 'pending';
    item.videoBlob = null;
    item.canvas    = null;
    showProgress(`${item.isVideo ? '▶ ' : ''}${item.file.name}`, 0);
    await generateItem(item, p => showProgress(`${item.file.name}  ${item.isVideo ? Math.round(p*100)+'%' : ''}`, p));
    hideProgress();
    setGlobalBusy(false);
  }

  if (item.status === 'done') {
    await downloadSingle(id);
  }
}

// Get GPS location from the device and populate the location field
// ─── Download ─────────────────────────────────────────────────────────────────
function _photoExportOpts() {
  const fmt  = state.settings.exportPhotoFormat  || 'jpeg';
  const qual = (state.settings.exportPhotoQuality || 92) / 100;
  return { format: fmt, quality: qual };
}

function _photoExt(fmt) {
  return fmt === 'png' ? 'png' : fmt === 'webp' ? 'webp' : 'jpg';
}

function _videoExt(blob) {
  return blob.type.includes('mp4') ? 'mp4' : 'webm';
}

async function downloadSingle(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  if (item.isVideo && item.videoBlob) {
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _videoExt(item.videoBlob);
    triggerDownload(item.videoBlob, name);
  } else if (item.canvas) {
    const opts = _photoExportOpts();
    const blob = await FrameEngine.canvasToBlob(item.canvas, opts);
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _photoExt(opts.format);
    triggerDownload(blob, name);
  }
}

async function downloadAll() {
  if (!state.items.length) {
    showToast(t('msgNoImages'), 'warn');
    return;
  }

  setGlobalBusy(true);

  // Auto-generate any pending items first
  const pending = state.items.filter(i => i.status === 'pending');
  if (pending.length) {
    const total = pending.length;
    for (let idx = 0; idx < total; idx++) {
      const item    = pending[idx];
      const basePct = idx / total;
      const slot    = 1 / total;
      const prefix  = `${idx + 1} / ${total}`;
      showProgress(`${prefix}  —  ${item.file.name}`, basePct);
      await generateItem(item, p => {
        const pctStr = item.isVideo ? `  ${Math.round(p * 100)}%` : '';
        showProgress(`${prefix}${pctStr}  —  ${item.file.name}`, basePct + slot * p);
      });
    }
  }

  const done = state.items.filter(i => i.status === 'done' && (i.canvas || i.videoBlob));
  if (!done.length) {
    hideProgress();
    setGlobalBusy(false);
    showToast(t('msgNoImages'), 'warn');
    return;
  }

  showProgress('Preparing files…', 0);

  const zip   = new JSZip();
  const opts  = _photoExportOpts();
  const total = done.length;

  for (let i = 0; i < total; i++) {
    const item = done[i];
    showProgress(`Packing ${i + 1} / ${total}  —  ${item.file.name}`, (i / total) * 0.7);

    if (item.isVideo && item.videoBlob) {
      const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _videoExt(item.videoBlob);
      zip.file(name, item.videoBlob);
    } else if (item.canvas) {
      const blob = await FrameEngine.canvasToBlob(item.canvas, opts);
      const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _photoExt(opts.format);
      zip.file(name, blob);
    }
  }

  const zipBlob = await zip.generateAsync(
    { type: 'blob' },
    meta => showProgress(
      `Creating ZIP…`,
      0.7 + 0.3 * (meta.percent / 100)
    )
  );

  triggerDownload(zipBlob, 'instaframe_export.zip');
  hideProgress();
  setGlobalBusy(false);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Settings persistence ─────────────────────────────────────────────────────
const SETTINGS_KEY = 'instaframe_settings';

function saveSettings() {
  try {
    const toSave = Object.assign({}, state.settings, {
      isCustomColor:    state.isCustomColor,
      customColorValue: state.customColorValue,
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
  } catch (e) {}
}

function restoreSettings() {
  let saved;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (e) { return; }

  // Custom color state
  if (saved.isCustomColor != null) state.isCustomColor = saved.isCustomColor;
  if (saved.customColorValue) {
    state.customColorValue = saved.customColorValue;
    const picker = document.getElementById('customColorPicker');
    if (picker) picker.value = saved.customColorValue;
  }

  // Frame color
  if (saved.frameColor != null) {
    if (saved.isCustomColor) {
      // Restore custom color button state
      updateCustomColorBtn(saved.customColorValue || saved.frameColor);
    } else {
      const standardColors = ['#ffffff', '#F0F0F0', '#9E9E9E', '#1a1a1a'];
      if (standardColors.includes(saved.frameColor)) {
        const r = document.querySelector(`input[name="frameColor"][value="${saved.frameColor}"]`);
        if (r) r.checked = true;
      }
    }
  }

  // Range sliders
  [
    ['thicknessRange',    'thicknessRangeVal',    saved.thicknessScale,  v => parseFloat(v).toFixed(1) + '×'],
    ['imageOffsetRange',  'imageOffsetRangeVal',  saved.imageOffsetY,    v => parseFloat(v).toFixed(0) + '%'],
    ['shotOnFontRange',   'shotOnFontRangeVal',   saved.shotOnFontScale, v => parseFloat(v).toFixed(1) + '×'],
    ['exifFontRange',     'exifFontRangeVal',     saved.exifFontScale,   v => parseFloat(v).toFixed(1) + '×'],
    ['lineGapRange',      'lineGapRangeVal',      saved.lineGapScale,    v => parseFloat(v).toFixed(1) + '×'],
    ['textOffsetRange',   'textOffsetRangeVal',   saved.textOffsetY,     v => parseFloat(v).toFixed(1)],
    ['outerPaddingRange', 'outerPaddingRangeVal', saved.outerPadding,    v => v + '%'],
  ].forEach(([id, valId, val, fmt]) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.value = val;
    const valEl = document.getElementById(valId);
    if (valEl) valEl.textContent = fmt(val);
  });

  // Font family
  if (saved.fontFamily) {
    const el = document.getElementById('fontFamily');
    if (el) el.value = saved.fontFamily;
  }

  // Checkboxes
  [
    ['cameraNameBold',   saved.cameraNameBold],
    ['cameraNameItalic', saved.cameraNameItalic],
    ['exifItalic',       saved.exifItalic],
    ['showShotOn',       saved.showShotOn],
    ['showDecoLine',     saved.showDecoLine],
    ['showExifInfo',     saved.showExifInfo],
    ['showLocation',     saved.showLocation],
    ['showMapOverlay',   saved.showMapOverlay],
  ].forEach(([id, val]) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.checked = val;
  });

  // Location position
  if (saved.locationPosition) {
    const r = document.querySelector(`input[name="locationPos"][value="${saved.locationPosition}"]`);
    if (r) r.checked = true;
  }
  // Show/hide location position row and map overlay rows
  const locPosRow   = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.style.display = (saved.showLocation) ? '' : 'none';
  const mapOvRow    = document.getElementById('mapOverlayRow');
  if (mapOvRow) mapOvRow.style.display = (saved.showLocation) ? '' : 'none';
  const mapOvOpRow  = document.getElementById('mapOverlayOpacityRow');
  if (mapOvOpRow) mapOvOpRow.style.display = (saved.showLocation && saved.showMapOverlay) ? '' : 'none';
  const locIconRow  = document.getElementById('locationIconRow');
  if (locIconRow) locIconRow.style.display = (saved.showLocation) ? '' : 'none';

  // Frame background mode
  if (saved.frameBackground) {
    const r = document.querySelector(`input[name="frameBackground"][value="${saved.frameBackground}"]`);
    if (r) r.checked = true;
  }
  const isBlurBg = saved.frameBackground === 'blur';
  const frameColorRow = document.getElementById('frameColorRow');
  const blurOptionsRow = document.getElementById('blurOptionsRow');
  if (frameColorRow) frameColorRow.style.display = isBlurBg ? 'none' : '';
  if (blurOptionsRow) blurOptionsRow.style.display = isBlurBg ? '' : 'none';
  // Blur sliders
  if (saved.blurRadius != null) {
    const el = document.getElementById('blurRadiusRange');
    if (el) el.value = saved.blurRadius;
    const v = document.getElementById('blurRadiusVal');
    if (v) v.textContent = saved.blurRadius + 'px';
  }
  if (saved.blurStyle) {
    const el = document.getElementById('blurStyleSelect');
    if (el) el.value = saved.blurStyle;
  }
  if (saved.blurBrightness != null) {
    const el = document.getElementById('blurBrightnessRange');
    if (el) el.value = saved.blurBrightness;
    const v = document.getElementById('blurBrightnessVal');
    if (v) v.textContent = saved.blurBrightness + '%';
  }

  // Location icon style
  if (saved.locationIconStyle) {
    document.querySelectorAll('.icon-pick-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.icon === saved.locationIconStyle);
    });
  }

  // Map overlay opacity
  if (saved.mapOverlayOpacity != null) {
    const pct = Math.round(saved.mapOverlayOpacity * 100);
    const opEl = document.getElementById('mapOverlayOpacityRange');
    if (opEl) opEl.value = pct;
    const opVal = document.getElementById('mapOverlayOpacityVal');
    if (opVal) opVal.textContent = pct + '%';
  }
  // Aspect ratio
  if (saved.aspectRatio) {
    const r = document.querySelector(`input[name="aspectRatio"][value="${saved.aspectRatio}"]`);
    if (r) r.checked = true;
  }
  if (saved.aspectOrientation) {
    const r = document.querySelector(`input[name="aspectOrientation"][value="${saved.aspectOrientation}"]`);
    if (r) r.checked = true;
  }

  // ── Export settings ──────────────────────────────────────────────────────
  // Photo format
  if (saved.exportPhotoFormat) {
    const r = document.querySelector(`input[name="exportPhotoFormat"][value="${saved.exportPhotoFormat}"]`);
    if (r) {
      r.checked = true;
      // Show/hide quality row
      const qRow = document.getElementById('photoQualityRow');
      if (qRow) qRow.classList.toggle('row-hidden', saved.exportPhotoFormat === 'png');
    }
  }
  // Photo quality
  if (saved.exportPhotoQuality != null) {
    const el = document.getElementById('photoQualityRange');
    if (el) { el.value = saved.exportPhotoQuality; }
    const valEl = document.getElementById('photoQualityRangeVal');
    if (valEl) valEl.textContent = saved.exportPhotoQuality + '%';
  }
  // Video format: defer to after initVideoFormatOptions runs (handled there)
  state.settings.exportVideoFormat = saved.exportVideoFormat || '';
  // Video bitrate
  if (saved.exportVideoBitrate != null) {
    const r = document.querySelector(`input[name="exportVideoBitrate"][value="${saved.exportVideoBitrate}"]`);
    if (r) r.checked = true;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function markDoneItemsPending() {
  state.items.forEach(i => {
    if (i.status === 'done') {
      i.status = 'pending';
      i.canvas = null;
      updateItemStatus(i);
      updateItemPreview(i);
    }
  });
}

function applySettings() {
  const before = _createSettingsSnapshot();
  // Frame color (custom color button or radio swatches)
  if (state.isCustomColor) {
    state.settings.frameColor = state.customColorValue;
  } else {
    const colorRadio = document.querySelector('input[name="frameColor"]:checked');
    state.settings.frameColor = colorRadio ? colorRadio.value : '#F0F0F0';
  }

  // Frame background mode
  const bgRadio = document.querySelector('input[name="frameBackground"]:checked');
  state.settings.frameBackground = bgRadio ? bgRadio.value : 'color';
  const isBlurBg = state.settings.frameBackground === 'blur';
  const frameColorRow = document.getElementById('frameColorRow');
  const blurOptionsRow = document.getElementById('blurOptionsRow');
  if (frameColorRow) frameColorRow.style.display = isBlurBg ? 'none' : '';
  if (blurOptionsRow) blurOptionsRow.style.display = isBlurBg ? '' : 'none';

  if (isBlurBg) {
    state.settings.blurRadius     = parseInt(document.getElementById('blurRadiusRange')?.value || '20', 10);
    state.settings.blurStyle      = document.getElementById('blurStyleSelect')?.value || 'normal';
    state.settings.blurBrightness = parseInt(document.getElementById('blurBrightnessRange')?.value || '80', 10);
  }

  // Update dark-frame outline on preview canvas
  const previewCanvas = document.getElementById('livePreviewCanvas');
  if (previewCanvas) {
    const isDark = FrameEngine.isColorDark(state.settings.frameColor);
    previewCanvas.classList.toggle('frame-dark', isDark && !isBlurBg);
  }

  state.settings.thicknessScale   = parseFloat(document.getElementById('thicknessRange').value);
  state.settings.imageOffsetY     = parseFloat(document.getElementById('imageOffsetRange').value);
  state.settings.fontFamily       = document.getElementById('fontFamily').value;
  state.settings.shotOnFontScale  = parseFloat(document.getElementById('shotOnFontRange').value);
  state.settings.exifFontScale    = parseFloat(document.getElementById('exifFontRange').value);
  state.settings.lineGapScale     = parseFloat(document.getElementById('lineGapRange').value);
  state.settings.textOffsetY      = parseFloat(document.getElementById('textOffsetRange').value);
  state.settings.cameraNameBold   = document.getElementById('cameraNameBold').checked;
  state.settings.cameraNameItalic = document.getElementById('cameraNameItalic').checked;
  state.settings.exifItalic       = document.getElementById('exifItalic').checked;
  state.settings.showShotOn       = document.getElementById('showShotOn').checked;
  state.settings.showDecoLine     = document.getElementById('showDecoLine').checked;
  state.settings.showExifInfo     = document.getElementById('showExifInfo').checked;
  state.settings.cameraNameOnly   = false; // removed from UI; always false
  state.settings.showLocation     = document.getElementById('showLocation')?.checked ?? false;
  state.settings.outerPadding     = parseInt(document.getElementById('outerPaddingRange').value, 10);

  // Location icon style
  const activeIconBtn = document.querySelector('.icon-pick-btn.active');
  if (activeIconBtn) state.settings.locationIconStyle = activeIconBtn.dataset.icon || 'pin';

  const locPosRadio = document.querySelector('input[name="locationPos"]:checked');
  state.settings.locationPosition = locPosRadio ? locPosRadio.value : 'below-exif';

  // Map overlay settings
  state.settings.showMapOverlay    = document.getElementById('showMapOverlay')?.checked ?? false;
  state.settings.mapOverlayOpacity = parseInt(document.getElementById('mapOverlayOpacityRange')?.value || '70', 10) / 100;
  // Show/hide location position row, map overlay rows, and location icon row
  const locPosRow      = document.getElementById('locationPositionRow');
  const mapOvRow       = document.getElementById('mapOverlayRow');
  const mapOvOpRow     = document.getElementById('mapOverlayOpacityRow');
  const locIconRow     = document.getElementById('locationIconRow');
  if (locPosRow) locPosRow.style.display = state.settings.showLocation ? '' : 'none';
  if (mapOvRow) mapOvRow.style.display = state.settings.showLocation ? '' : 'none';
  if (locIconRow) locIconRow.style.display = state.settings.showLocation ? '' : 'none';
  if (mapOvOpRow) mapOvOpRow.style.display = (state.settings.showLocation && state.settings.showMapOverlay) ? '' : 'none';

  const ratioRadio = document.querySelector('input[name="aspectRatio"]:checked');
  state.settings.aspectRatio = ratioRadio ? ratioRadio.value : 'original';
  const orientationRadio = document.querySelector('input[name="aspectOrientation"]:checked');
  state.settings.aspectOrientation = orientationRadio ? orientationRadio.value : 'auto';

  // Export settings (photo only — video is handled separately)
  const pFmt = document.querySelector('input[name="exportPhotoFormat"]:checked');
  state.settings.exportPhotoFormat  = pFmt ? pFmt.value : 'jpeg';
  state.settings.exportPhotoQuality = parseInt(document.getElementById('photoQualityRange')?.value || '92', 10);
  // (video export settings read via onVideoExportSettingChange)

  // Mark all done items as pending (frame settings changed → need re-render)
  markDoneItemsPending();

  if (!_historyLocked) {
    const after = _createSettingsSnapshot();
    if (!_settingsSnapshotsEqual(before, after)) {
      _settingsUndoStack.push(before);
      if (_settingsUndoStack.length > SETTINGS_HISTORY_LIMIT) _settingsUndoStack.shift();
      _settingsRedoStack.length = 0;
      updateHistoryButtons();
    }
  }

  saveSettings();
  updateUI();
  scheduleLivePreview();
}

function _syncDomWithStateSettings() {
  const s = state.settings;

  if (state.isCustomColor) {
    document.querySelectorAll('input[name="frameColor"]').forEach(r => { r.checked = false; });
    const picker = document.getElementById('customColorPicker');
    if (picker) picker.value = state.customColorValue || '#e8c49a';
    updateCustomColorBtn(state.customColorValue || '#e8c49a');
  } else {
    const r = document.querySelector(`input[name="frameColor"][value="${s.frameColor}"]`);
    if (r) r.checked = true;
    const btn = document.getElementById('customColorBtn');
    if (btn) btn.classList.remove('active');
  }

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el != null && val != null) el.value = val;
  };
  const setChecked = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.checked = !!val;
  };

  setVal('thicknessRange', s.thicknessScale);
  setVal('imageOffsetRange', s.imageOffsetY);
  setVal('shotOnFontRange', s.shotOnFontScale);
  setVal('exifFontRange', s.exifFontScale);
  setVal('lineGapRange', s.lineGapScale);
  setVal('textOffsetRange', s.textOffsetY);
  setVal('outerPaddingRange', s.outerPadding);
  setVal('fontFamily', s.fontFamily);
  setVal('photoQualityRange', s.exportPhotoQuality);

  setChecked('cameraNameBold', s.cameraNameBold);
  setChecked('cameraNameItalic', s.cameraNameItalic);
  setChecked('exifItalic', s.exifItalic);
  setChecked('showShotOn', s.showShotOn);
  setChecked('showDecoLine', s.showDecoLine);
  setChecked('showExifInfo', s.showExifInfo);
  setChecked('showLocation', s.showLocation);
  setChecked('showMapOverlay', s.showMapOverlay);

  const locPos = document.querySelector(`input[name="locationPos"][value="${s.locationPosition}"]`);
  if (locPos) locPos.checked = true;
  const ratio = document.querySelector(`input[name="aspectRatio"][value="${s.aspectRatio}"]`);
  if (ratio) ratio.checked = true;
  const orientation = document.querySelector(`input[name="aspectOrientation"][value="${s.aspectOrientation || 'auto'}"]`);
  if (orientation) orientation.checked = true;
  const photoFmt = document.querySelector(`input[name="exportPhotoFormat"][value="${s.exportPhotoFormat}"]`);
  if (photoFmt) photoFmt.checked = true;
  const videoFmt = document.querySelector(`input[name="exportVideoFormat"][value="${s.exportVideoFormat}"]`);
  if (videoFmt) videoFmt.checked = true;
  const bitrate = document.querySelector(`input[name="exportVideoBitrate"][value="${s.exportVideoBitrate}"]`);
  if (bitrate) bitrate.checked = true;

  const qRow = document.getElementById('photoQualityRow');
  if (qRow) qRow.classList.toggle('row-hidden', s.exportPhotoFormat === 'png');

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('thicknessRangeVal', parseFloat(s.thicknessScale).toFixed(1) + '×');
  setText('imageOffsetRangeVal', parseFloat(s.imageOffsetY || 0).toFixed(0) + '%');
  setText('shotOnFontRangeVal', parseFloat(s.shotOnFontScale).toFixed(1) + '×');
  setText('exifFontRangeVal', parseFloat(s.exifFontScale).toFixed(1) + '×');
  setText('lineGapRangeVal', parseFloat(s.lineGapScale).toFixed(1) + '×');
  setText('textOffsetRangeVal', parseFloat(s.textOffsetY).toFixed(1));
  setText('outerPaddingRangeVal', parseInt(s.outerPadding, 10) + '%');
  setText('photoQualityRangeVal', parseInt(s.exportPhotoQuality, 10) + '%');

  // Frame background mode
  const bgR = document.querySelector(`input[name="frameBackground"][value="${s.frameBackground || 'color'}"]`);
  if (bgR) bgR.checked = true;
  const isBlur = s.frameBackground === 'blur';
  const fcRow = document.getElementById('frameColorRow');
  const boRow = document.getElementById('blurOptionsRow');
  if (fcRow) fcRow.style.display = isBlur ? 'none' : '';
  if (boRow) boRow.style.display = isBlur ? '' : 'none';
  setVal('blurRadiusRange', s.blurRadius ?? 20);
  setText('blurRadiusVal', (s.blurRadius ?? 20) + 'px');
  setVal('blurBrightnessRange', s.blurBrightness ?? 80);
  setText('blurBrightnessVal', (s.blurBrightness ?? 80) + '%');
  const blurStyleEl = document.getElementById('blurStyleSelect');
  if (blurStyleEl) blurStyleEl.value = s.blurStyle || 'normal';

  // Location icon
  document.querySelectorAll('.icon-pick-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.icon === (s.locationIconStyle || 'pin'));
  });

  const locPosRow = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.style.display = s.showLocation ? '' : 'none';
  const mapOvRow = document.getElementById('mapOverlayRow');
  if (mapOvRow) mapOvRow.style.display = s.showLocation ? '' : 'none';
  const mapOvOpRow = document.getElementById('mapOverlayOpacityRow');
  if (mapOvOpRow) mapOvOpRow.style.display = (s.showLocation && s.showMapOverlay) ? '' : 'none';
  const locIconRow = document.getElementById('locationIconRow');
  if (locIconRow) locIconRow.style.display = s.showLocation ? '' : 'none';
}

function applySettingsSnapshot(snapshot) {
  if (!snapshot) return;
  _historyLocked = true;
  state.settings = { ...snapshot.settings };
  state.isCustomColor = !!snapshot.isCustomColor;
  state.customColorValue = snapshot.customColorValue || state.customColorValue;
  _syncDomWithStateSettings();
  markDoneItemsPending();
  saveSettings();
  updateUI();
  applyPreviewTransform();
  scheduleLivePreview();
  _historyLocked = false;
}

function undoSettings() {
  if (_settingsUndoStack.length === 0) return;
  const prev = _settingsUndoStack.pop();
  _settingsRedoStack.push(_createSettingsSnapshot());
  if (_settingsRedoStack.length > SETTINGS_HISTORY_LIMIT) _settingsRedoStack.shift();
  applySettingsSnapshot(prev);
  updateHistoryButtons();
}

function redoSettings() {
  if (_settingsRedoStack.length === 0) return;
  const next = _settingsRedoStack.pop();
  _settingsUndoStack.push(_createSettingsSnapshot());
  if (_settingsUndoStack.length > SETTINGS_HISTORY_LIMIT) _settingsUndoStack.shift();
  applySettingsSnapshot(next);
  updateHistoryButtons();
}

// ─── Live EXIF Panel (left edge of preview, desktop only) ─────────────────────
function getSelectedPreviewItem() {
  return (state.selectedItemId && state.items.find(i => i.id === state.selectedItemId))
    || state.items[0]
    || null;
}

function updateLiveExifPanel() {
  const item = getSelectedPreviewItem();
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  if (!item) {
    setVal('live-exif-make', '');
    setVal('live-exif-model', '');
    setVal('live-exif-lens', '');
    setVal('live-exif-fl', '');
    setVal('live-exif-fn', '');
    setVal('live-exif-et', '');
    setVal('live-exif-iso', '');
    setVal('live-exif-location', '');
    return;
  }
  const ex = item.exif || {};
  setVal('live-exif-make',     ex.make);
  setVal('live-exif-model',    ex.model);
  setVal('live-exif-lens',     ex.lensModel);
  setVal('live-exif-fl',       ex.focalLength);
  setVal('live-exif-fn',       ex.fNumber);
  setVal('live-exif-et',       ex.exposureTime);
  setVal('live-exif-iso',      ex.iso);
  setVal('live-exif-location', ex.location);
}

function toggleLiveExifPanel() {
  const wrap = document.getElementById('previewExifWrap');
  if (!wrap) return;
  const open = wrap.classList.toggle('exif-open');
  if (open) updateLiveExifPanel();
}

let _liveExifApplyTimer = null;
function scheduleLiveExifEditApply() {
  clearTimeout(_liveExifApplyTimer);
  _liveExifApplyTimer = setTimeout(applyLiveExifEdit, 100);
}

function applyLiveExifEdit() {
  const item = getSelectedPreviewItem();
  if (!item) return;
  const getVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

  const nextExif = {
    make:         getVal('live-exif-make'),
    model:        getVal('live-exif-model'),
    lensModel:    getVal('live-exif-lens'),
    focalLength:  getVal('live-exif-fl'),
    fNumber:      getVal('live-exif-fn'),
    exposureTime: getVal('live-exif-et'),
    iso:          getVal('live-exif-iso'),
    location:     getVal('live-exif-location'),
  };

  const prevExif = item.exif || {};
  const changed =
    prevExif.make !== nextExif.make ||
    prevExif.model !== nextExif.model ||
    prevExif.lensModel !== nextExif.lensModel ||
    prevExif.focalLength !== nextExif.focalLength ||
    prevExif.fNumber !== nextExif.fNumber ||
    prevExif.exposureTime !== nextExif.exposureTime ||
    prevExif.iso !== nextExif.iso ||
    prevExif.location !== nextExif.location;
  if (!changed) return;

  if (!item.exif) item.exif = {};
  const locationChanged = prevExif.location !== nextExif.location;
  Object.assign(item.exif, nextExif);
  if (locationChanged) {
    item.exif.latitude = null;
    item.exif.longitude = null;
  }

  // Sync the per-card EXIF editor inputs if they exist
  const syncCard = (suffix, val) => { const el = document.getElementById(`${suffix}-${item.id}`); if (el) el.value = val; };
  syncCard('exif-make',     item.exif.make);
  syncCard('exif-model',    item.exif.model);
  syncCard('exif-lens',     item.exif.lensModel);
  syncCard('exif-fl',       item.exif.focalLength);
  syncCard('exif-fn',       item.exif.fNumber);
  syncCard('exif-et',       item.exif.exposureTime);
  syncCard('exif-iso',      item.exif.iso);
  syncCard('exif-location', item.exif.location);

  item.status = 'pending';
  item.canvas = null;
  _invalidateItemCache(item.id);
  updateItemStatus(item);
  updateItemPreview(item);
  updateUI();
  scheduleLivePreview();
}

async function getLiveDeviceLocation() {
  if (!navigator.geolocation) { showToast('Geolocation not supported', 'warn'); return; }
  const input = document.getElementById('live-exif-location');
  if (!input) return;
  const original = input.value;
  input.value = '…';
  input.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude);
      input.value = name || `${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
      input.disabled = false;
      applyLiveExifEdit();
    },
    () => { input.value = original; input.disabled = false; showToast('Could not get location', 'warn'); },
    { timeout: 10000 }
  );
}

// ─── Map Location Picker ──────────────────────────────────────────────────────
let _mapPickerMap    = null;
let _mapPickerMarker = null;
let _mapPickerLat    = null;
let _mapPickerLon    = null;
let _leafletLoadPromise = null;

function _ensureLeafletStylesheet() {
  const hasLeafletCss = !!document.querySelector('link[href*="leaflet.css"]');
  if (hasLeafletCss) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
  link.setAttribute('data-leaflet-runtime', '1');
  document.head.appendChild(link);
}

function _loadLeafletScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error('Leaflet script load failed'));
    document.head.appendChild(script);
  });
}

async function ensureLeafletLoaded() {
  if (typeof L !== 'undefined') return true;
  if (_leafletLoadPromise) return _leafletLoadPromise;

  _leafletLoadPromise = (async () => {
    _ensureLeafletStylesheet();
    const sources = [
      'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
      'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    ];
    for (const src of sources) {
      try {
        await _loadLeafletScript(src);
        if (typeof L !== 'undefined') return true;
      } catch (_) {}
    }
    return typeof L !== 'undefined';
  })();

  const loaded = await _leafletLoadPromise;
  if (!loaded) _leafletLoadPromise = null;
  return loaded;
}

async function openMapPicker() {
  const modal = document.getElementById('mapPickerModal');
  if (!modal) return;
  const leafletReady = await ensureLeafletLoaded();
  if (!leafletReady || typeof L === 'undefined') {
    showToast('Map library failed to load', 'error');
    return;
  }
  modal.classList.add('open');

  // Initialize Leaflet map in the next animation frame so the container
  // has a layout (width/height) before Leaflet tries to measure it.
  await new Promise(r => requestAnimationFrame(r));

  // Initialize Leaflet map if not yet created
  if (!_mapPickerMap) {
    _mapPickerMap = L.map('mapPickerContainer').setView([35.6762, 139.6503], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_mapPickerMap);

    _mapPickerMap.on('click', e => {
      const { lat, lng } = e.latlng;
      _mapPickerLat = lat;
      _mapPickerLon = lng;
      if (_mapPickerMarker) {
        _mapPickerMarker.setLatLng(e.latlng);
      } else {
        _mapPickerMarker = L.marker(e.latlng).addTo(_mapPickerMap);
      }
      const coordsEl = document.getElementById('mapPickerCoords');
      if (coordsEl) coordsEl.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
    });
  }

  // Force Leaflet to recalculate size after modal becomes visible
  _mapPickerMap.invalidateSize();
  setTimeout(() => { if (_mapPickerMap) _mapPickerMap.invalidateSize(); }, 120);

  // Pre-fill from current item's lat/lon if available
  const item = getSelectedPreviewItem();
  if (item && item.exif && item.exif.latitude != null && item.exif.longitude != null) {
    const lat = item.exif.latitude, lon = item.exif.longitude;
    _mapPickerLat = lat;
    _mapPickerLon = lon;
    _mapPickerMap.setView([lat, lon], 12);
    if (_mapPickerMarker) {
      _mapPickerMarker.setLatLng([lat, lon]);
    } else {
      _mapPickerMarker = L.marker([lat, lon]).addTo(_mapPickerMap);
    }
    const coordsEl = document.getElementById('mapPickerCoords');
    if (coordsEl) coordsEl.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    return;
  }

  // Try browser geolocation first, then IP-based fallback
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        _mapPickerMap.setView([latitude, longitude], 12);
      },
      () => _fetchIpLocation(),
      { timeout: 5000 }
    );
  } else {
    _fetchIpLocation();
  }
}

async function _fetchIpLocation() {
  try {
    const res  = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    if (data.latitude && data.longitude && _mapPickerMap) {
      _mapPickerMap.setView([data.latitude, data.longitude], 10);
    }
  } catch { /* silently ignore — stay at default view */ }
}

function closeMapPicker() {
  const modal = document.getElementById('mapPickerModal');
  if (modal) modal.classList.remove('open');
}

async function confirmMapLocation() {
  if (_mapPickerLat == null || _mapPickerLon == null) {
    showToast('Please click on the map to select a location', 'warn');
    return;
  }
  const lat = _mapPickerLat, lon = _mapPickerLon;

  // Resolve location name via reverse geocoding
  const name = await reverseGeocode(lat, lon);
  const locStr = name || `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;

  // Update live EXIF panel input
  const locInput = document.getElementById('live-exif-location');
  if (locInput) locInput.value = locStr;

  // Store lat/lon on the current item's exif and apply
  const item = getSelectedPreviewItem();
  if (item) {
    if (!item.exif) item.exif = {};
    item.exif.latitude  = lat;
    item.exif.longitude = lon;
    item.exif.location  = locStr;
    // Sync card EXIF editor if open
    const cardLocEl = document.getElementById(`exif-location-${item.id}`);
    if (cardLocEl) cardLocEl.value = locStr;
    item.status = 'pending';
    item.canvas = null;
    _invalidateItemCache(item.id);
    updateItemStatus(item);
    updateItemPreview(item);
    updateUI();
    scheduleLivePreview();
  }

  closeMapPicker();
}


let _livePreviewTimer = null;

function scheduleLivePreview() {
  clearTimeout(_livePreviewTimer);
  // HTML preview updates are near-instant; canvas still needs debounce
  _livePreviewTimer = setTimeout(renderLivePreview, 80);
}

// ─── Preview Zoom & Pan ───────────────────────────────────────────────────────
function applyPreviewTransform() {
  const transform = `scale(${previewZoom}) translate(${previewPan.x / previewZoom}px, ${previewPan.y / previewZoom}px)`;
  const isDark = FrameEngine.isColorDark(state.settings.frameColor);
  const canvas = document.getElementById('livePreviewCanvas');
  if (canvas) {
    canvas.style.transform = transform;
    canvas.classList.toggle('frame-dark', isDark);
  }
}

function setPreviewZoom(zoom) {
  previewZoom = Math.min(Math.max(zoom, 0.5), 3.0);
  applyPreviewTransform();
  const range = document.getElementById('zoomRange');
  if (range) range.value = Math.round(previewZoom * 100);
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = Math.round(previewZoom * 100) + '%';
  updatePreviewViewModifiedState();
}

function resetPreviewPan() {
  previewPan = { x: 0, y: 0 };
  applyPreviewTransform();
  updatePreviewViewModifiedState();
}

function resetPreviewView() {
  setPreviewZoom(1.0);
  resetPreviewPan();
  setPreviewQuality('auto');
  scheduleLivePreview();
}

// ─── Item Selection for Preview ───────────────────────────────────────────────
function selectItem(id) {
  state.selectedItemId = id;
  document.querySelectorAll('.image-card').forEach(c => c.classList.remove('selected-preview'));
  const el = document.getElementById(`item-${id}`);
  if (el) el.classList.add('selected-preview');
  // On mobile: auto-switch to preview tab so user can see the result
  if (window.innerWidth <= 768) {
    document.body.setAttribute('data-mobile-tab', 'preview');
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'preview');
    });
  }
  updateLiveExifPanel();
  scheduleLivePreview();
}

// ─── Preview Helpers ──────────────────────────────────────────────────────────

/**
 * Stable hash of all settings that affect the canvas output.
 * Also encodes a quantised maxPreviewPx so quality-tier changes invalidate the cache.
 */
function _previewSettingsHash() {
  const s  = state.settings;
  const pq = loadPrefs().previewQuality || 'auto';
  const maxPx = pq === 'draft'  ? 600
              : pq === 'normal' ? 1200
              : pq === 'high'   ? 1800
              : pq === 'max'    ? 2400
              : previewZoom <= 1.0 ? 900
              : previewZoom <= 1.5 ? 1200
              : previewZoom <= 2.0 ? 1800 : 2400;
  return [maxPx,
    s.frameColor, s.frameBackground, s.blurRadius, s.blurStyle, s.blurBrightness,
    s.thicknessScale, s.imageOffsetY, s.fontFamily,
    s.shotOnFontScale, s.exifFontScale, s.lineGapScale, s.textOffsetY,
    s.cameraNameBold, s.cameraNameItalic, s.exifItalic,
    s.showShotOn, s.showDecoLine, s.showExifInfo, s.cameraNameOnly,
    s.showLocation, s.locationPosition, s.locationIconStyle, s.outerPadding, s.aspectRatio, s.aspectOrientation,
    s.showMapOverlay, s.mapOverlayOpacity,
  ].join('|');
}

/** Drop all cached data for one item (call on remove + EXIF edit). */
function _invalidateItemCache(itemId) {
  const e = _imgCache.get(itemId);
  if (e) { URL.revokeObjectURL(e.objUrl); _imgCache.delete(itemId); }
  _imgFailed.delete(itemId);
  for (const k of [..._frameCache.keys()])
    if (k.startsWith(`${itemId}|`)) _frameCache.delete(k);
}

/** Load image for an item, keeping the Object URL alive for re-use. */
async function _loadPreviewImage(item) {
  if (_imgFailed.has(item.id)) throw new Error('Image load previously failed');
  const cached = _imgCache.get(item.id);
  if (cached) return cached.img;

  const objUrl = URL.createObjectURL(item.file);
  const img    = new Image();
  img.src      = objUrl;
  await new Promise((resolve, reject) => {
    img.onload  = resolve;
    img.onerror = () => reject(new Error('Image load error'));
    if (img.complete && img.naturalWidth) resolve();
  }).catch(e => {
    URL.revokeObjectURL(objUrl);
    _imgFailed.add(item.id);
    throw e;
  });

  if (_imgCache.size >= 50) {                         // LRU eviction
    const firstKey = _imgCache.keys().next().value;
    URL.revokeObjectURL(_imgCache.get(firstKey).objUrl);
    _imgCache.delete(firstKey);
  }
  _imgCache.set(item.id, { img, objUrl });
  return img;
}

/** Draw a rendered frame canvas into the live-preview canvas, DPR-aware. */
function _drawFrameToCanvas(canvas, pane, emptyEl, src) {
  const dpr   = window.devicePixelRatio || 1;
  const areaW = Math.max(pane.clientWidth  - 40, 80);
  const areaH = Math.max(pane.clientHeight - 40, 60);
  const ratio = src.height / src.width;

  let dispW = Math.min(areaW, Math.round(areaH / ratio));
  let dispH = Math.round(dispW * ratio);
  if (dispH > areaH) { dispH = areaH; dispW = Math.round(areaH / ratio); }
  dispW = Math.max(dispW, 80);
  dispH = Math.max(dispH, 60);

  canvas.width        = Math.round(dispW * dpr);
  canvas.height       = Math.round(dispH * dpr);
  canvas.style.width  = dispW + 'px';
  canvas.style.height = dispH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

  // Fade in only on first appearance
  const firstShow = canvas.style.display === 'none' || canvas.style.display === '';
  if (firstShow) canvas.style.opacity = '0';
  canvas.style.display = 'block';
  if (firstShow) { void canvas.offsetWidth; canvas.style.opacity = '1'; }

  if (emptyEl) emptyEl.style.display = 'none';
  pane.classList.add('has-preview');
}

async function renderLivePreview() {
  const pane    = document.getElementById('dropZone');
  const canvas  = document.getElementById('livePreviewCanvas');
  const emptyEl = document.getElementById('previewEmpty');
  if (!pane || !canvas) return;

  // ── Empty state ────────────────────────────────────────────────────────────
  if (state.items.length === 0) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    pane.classList.remove('has-preview');
    return;
  }

  const item = (state.selectedItemId && state.items.find(i => i.id === state.selectedItemId))
             || state.items[0];

  // ── Video: show native <video> element ─────────────────────────────────────
  const liveVideo = document.getElementById('livePreviewVideo');
  if (item.isVideo && liveVideo) {
    canvas.style.display = 'none';
    if (!liveVideo._srcId || liveVideo._srcId !== item.id) {
      if (liveVideo._objUrl) URL.revokeObjectURL(liveVideo._objUrl);
      liveVideo._objUrl = URL.createObjectURL(item.file);
      liveVideo._srcId  = item.id;
      liveVideo.src     = liveVideo._objUrl;
    }
    liveVideo.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    pane.classList.add('has-preview');
    return;
  }
  if (liveVideo) liveVideo.style.display = 'none';

  // ── Canvas preview with caching ────────────────────────────────────────────
  const hash   = `${item.id}|${_previewSettingsHash()}`;
  const cached = _frameCache.get(hash);

  // Cache hit: draw immediately and return
  if (cached) {
    _drawFrameToCanvas(canvas, pane, emptyEl, cached);
    applyPreviewTransform();
    return;
  }

  // Cache miss: show any stale frame for this item as a placeholder while re-rendering
  for (const [k, c] of _frameCache) {
    if (k.startsWith(`${item.id}|`)) {
      _drawFrameToCanvas(canvas, pane, emptyEl, c);
      applyPreviewTransform();
      break;
    }
  }

  // Kick off async render
  const seq = ++_renderSeq;
  try {
    const img = await _loadPreviewImage(item);

    const pq = loadPrefs().previewQuality || 'auto';
    const maxPreviewPx = pq === 'draft'  ? 600
      : pq === 'normal' ? 1200 : pq === 'high' ? 1800 : pq === 'max' ? 2400
      : Math.min(2400, Math.round(1200 * previewZoom));

    // Pre-fetch map overlay image if enabled and coordinates are available
    let mapOverlayImg = null;
    if (state.settings.showMapOverlay && state.settings.showLocation &&
        item.exif && item.exif.latitude != null && item.exif.longitude != null) {
      mapOverlayImg = await _fetchMapOverlayImage(item.exif.latitude, item.exif.longitude);
    }

    const rendered = await FrameEngine.renderFrameWhenReady(
      img, item.exif, state.settings, { maxPreviewPx, mapOverlayImg });

    if (seq !== _renderSeq) return;           // a newer render started; discard this one

    if (_frameCache.size >= 30) {             // evict oldest entry to cap memory
      _frameCache.delete(_frameCache.keys().next().value);
    }
    _frameCache.set(hash, rendered);
    _drawFrameToCanvas(canvas, pane, emptyEl, rendered);
    applyPreviewTransform();
  } catch (_e) {
    // Non-critical — silently ignore preview failures
  }
}

// ─── DOM Rendering ────────────────────────────────────────────────────────────
function renderItem(item) {
  const grid = document.getElementById('imageGrid');
  const emptyMsg = document.getElementById('emptyMsg');
  if (emptyMsg) emptyMsg.remove();

  const card = document.createElement('div');
  card.className = 'image-card';
  card.id = `item-${item.id}`;

  const thumbSrc = item.isVideo ? '' : URL.createObjectURL(item.file);

  card.innerHTML = `
    <div class="card-preview" id="preview-${item.id}">
      ${item.isVideo ? '<div class="video-badge">▶</div>' : ''}
      <img class="thumb-orig" src="${thumbSrc}" alt="">
      <div class="card-status" id="status-badge-${item.id}">
        <span class="status-dot pending"></span>
        <span class="status-text" data-i18n="statusPending">${t('statusPending')}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="card-filename">${escHtml(item.file.name)}</div>
      <div class="card-actions">
        <button class="btn btn-sm btn-primary" id="dl-btn-${item.id}" onclick="applyAndDownloadSingle(${item.id})">
          <span data-i18n="downloadSingle">${t('downloadSingle')}</span>
        </button>
        <button class="btn btn-sm btn-danger" onclick="removeItem(${item.id})">
          <span data-i18n="remove">${t('remove')}</span>
        </button>
      </div>
    </div>
  `;

  // Click preview image/video → select for live preview
  card.querySelector('.card-preview').addEventListener('click', () => {
    selectItem(item.id);
  });

  // Click card body (not buttons) → select for live preview
  card.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('.card-preview')) return;
    selectItem(item.id);
  });

  grid.appendChild(card);
}

function updateItemStatus(item) {
  const badge = document.getElementById(`status-badge-${item.id}`);
  if (!badge) return;

  const dot  = badge.querySelector('.status-dot');
  const text = badge.querySelector('.status-text');

  dot.className = `status-dot ${item.status}`;

  if (item.status === 'processing' && item.isVideo && item.progress > 0) {
    text.textContent = `${Math.round(item.progress * 100)}%`;
  } else {
    text.textContent = t(`status${capitalize(item.status)}`);
  }
}

function updateItemPreview(item) {
  const previewDiv = document.getElementById(`preview-${item.id}`);
  const dlBtn      = document.getElementById(`dl-btn-${item.id}`);
  if (!previewDiv) return;

  if (item.status === 'done' && (item.canvas || item.videoBlob)) {
    if (item.isVideo) {
      // Video done: thumbnail stays, add a "ready" overlay on badge; enable download
      const origThumb = previewDiv.querySelector('img.thumb-orig');
      if (origThumb) origThumb.style.display = '';
    } else {
      // Photo done: replace thumbnail with framed canvas preview
      let existing = previewDiv.querySelector('canvas.thumb-framed');
      if (!existing) {
        existing = document.createElement('canvas');
        existing.className = 'thumb-framed';
        previewDiv.insertBefore(existing, previewDiv.firstChild);
      }
      const maxW = 400, maxH = 400;
      const scale = Math.min(maxW / item.canvas.width, maxH / item.canvas.height);
      existing.width  = Math.round(item.canvas.width  * scale);
      existing.height = Math.round(item.canvas.height * scale);
      existing.getContext('2d').drawImage(item.canvas, 0, 0, existing.width, existing.height);

      const origThumb = previewDiv.querySelector('img.thumb-orig');
      if (origThumb) origThumb.style.display = 'none';
    }
    if (dlBtn) dlBtn.disabled = false;
  } else {
    const framedCanvas = previewDiv.querySelector('canvas.thumb-framed');
    if (framedCanvas) framedCanvas.remove();
    const origThumb = previewDiv.querySelector('img.thumb-orig');
    if (origThumb) origThumb.style.display = '';
    // Download button stays enabled — clicking it will auto-generate then download
    if (dlBtn) dlBtn.disabled = (item.status === 'processing');
  }
}

function updateUI() {
  const hasItems = state.items.length > 0;
  const hasDone  = state.items.some(i => i.status === 'done');

  const genBtn  = document.getElementById('generateAllBtn');
  const dlBtn   = document.getElementById('downloadAllBtn');
  const clrBtn  = document.getElementById('clearAllBtn');
  const counter = document.getElementById('imageCounter');

  if (genBtn)  genBtn.disabled  = !hasItems;
  if (dlBtn)   dlBtn.disabled   = !hasDone;
  if (clrBtn)  clrBtn.disabled  = !hasItems;
  if (counter) counter.textContent = hasItems ? `(${state.items.length})` : '';

  setVisible(document.getElementById('imageSection'), hasItems, 'flex');
  setVisible(document.getElementById('emptyHint'),    !hasItems);
  const resizeHandle = document.getElementById('mainResizeHandle');
  if (resizeHandle) resizeHandle.style.display = hasItems ? 'block' : 'none';

  // Update mobile tap-to-import overlay
  if (typeof _updateMobileEmptyOverlay === 'function') {
    _updateMobileEmptyOverlay();
  }

  // If no items, reset the drop zone to its empty/clickable state
  if (!hasItems) {
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('has-preview');
    const previewCanvas = document.getElementById('livePreviewCanvas');
    if (previewCanvas) { previewCanvas.style.display = 'none'; previewCanvas.style.opacity = ''; previewCanvas.style.transform = ''; }
    const htmlPreview = document.getElementById('htmlPreview');
    if (htmlPreview) htmlPreview.classList.remove('hp-visible');
    const emptyEl = document.getElementById('previewEmpty');
    if (emptyEl) emptyEl.style.display = '';
    previewZoom = 1.0;
    previewPan  = { x: 0, y: 0 };
    setPreviewZoom(1.0);
    updatePreviewViewModifiedState();
  }

  // Per-item download buttons: always enabled (auto-generate on click)
  state.items.forEach(item => {
    const dlBtn = document.getElementById(`dl-btn-${item.id}`);
    if (dlBtn) dlBtn.disabled = (item.status === 'processing');
  });
}

function setGlobalBusy(busy) {
  document.getElementById('generateAllBtn').disabled = busy;
  document.getElementById('downloadAllBtn').disabled = busy;
  const clrBtn = document.getElementById('clearAllBtn');
  if (clrBtn) clrBtn.disabled = busy || state.items.length === 0;
}

// ─── Export progress bar ──────────────────────────────────────────────────────
function showProgress(label, pct) {
  const wrap  = document.getElementById('exportProgress');
  const fill  = document.getElementById('exportProgressFill');
  const lbl   = document.getElementById('exportProgressLabel');
  const pctEl = document.getElementById('exportProgressPct');
  if (!wrap) return;
  setVisible(wrap, true);
  const p = Math.max(0, Math.min(1, pct));
  fill.style.width   = Math.round(p * 100) + '%';
  lbl.textContent    = label;
  if (pctEl) pctEl.textContent = Math.round(p * 100) + '%';
}

function hideProgress() {
  setVisible(document.getElementById('exportProgress'), false);
}

// ─── Video format helpers ─────────────────────────────────────────────────────
const VIDEO_FORMAT_MAP = {
  'vp9':  'video/webm;codecs=vp9,opus',
  'vp8':  'video/webm;codecs=vp8,opus',
  'mp4':  'video/mp4',
  'webm': 'video/webm',
};

function resolveVideoMime(formatKey) {
  if (!formatKey) {
    // Auto: pick best supported
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
  }
  const mime = VIDEO_FORMAT_MAP[formatKey] || formatKey;
  return MediaRecorder.isTypeSupported(mime) ? mime : resolveVideoMime('');
}

function initVideoFormatOptions() {
  const container = document.getElementById('videoFormatPills');
  if (!container) return;

  const candidates = [
    { label: 'MP4',  value: 'mp4',  mime: 'video/mp4' },
    { label: 'VP9',  value: 'vp9',  mime: 'video/webm;codecs=vp9,opus' },
    { label: 'VP8',  value: 'vp8',  mime: 'video/webm;codecs=vp8,opus' },
  ].filter(f => { try { return MediaRecorder.isTypeSupported(f.mime); } catch { return false; } });

  if (!candidates.length) candidates.push({ label: 'WebM', value: 'webm', mime: 'video/webm' });

  container.innerHTML = candidates.map((f, i) => `
    <div class="ratio-pill">
      <input type="radio" name="exportVideoFormat" id="vfmt-${f.value}" value="${f.value}" ${i === 0 ? 'checked' : ''}>
      <label for="vfmt-${f.value}">${f.label}</label>
    </div>`).join('');

  // Set default in state
  state.settings.exportVideoFormat = candidates[0].value;

  // Wire listeners (called after DOM is created)
  document.querySelectorAll('input[name="exportVideoFormat"]').forEach(r =>
    r.addEventListener('change', onVideoExportSettingChange)
  );
}

function onVideoExportSettingChange() {
  const r = document.querySelector('input[name="exportVideoFormat"]:checked');
  state.settings.exportVideoFormat = r ? r.value : '';
  const vbr = document.querySelector('input[name="exportVideoBitrate"]:checked');
  state.settings.exportVideoBitrate = vbr ? parseInt(vbr.value, 10) : 8;
  saveSettings();
  // Video format change requires re-encoding → mark video items as pending
  state.items.forEach(i => {
    if (i.isVideo && i.status === 'done') {
      i.status    = 'pending';
      i.videoBlob = null;
      updateItemStatus(i);
    }
  });
  updateUI();
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
function setupDropZone() {
  const zone  = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');

  // The file input is an invisible overlay (inset:0) covering the preview area
  // when no files are loaded. Clicking anywhere in the empty area opens the file
  // dialog directly. When files are present, `has-preview` disables the overlay
  // so canvas clicks work normally.

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  // Scroll-wheel zoom (only when preview is active)
  zone.addEventListener('wheel', e => {
    if (!zone.classList.contains('has-preview')) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setPreviewZoom(previewZoom + delta);
  }, { passive: false });

  // Zoom slider
  const zoomRange = document.getElementById('zoomRange');
  if (zoomRange) {
    zoomRange.addEventListener('input', () => setPreviewZoom(parseInt(zoomRange.value, 10) / 100));
  }

  // Zoom ± buttons
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => setPreviewZoom(previewZoom - 0.1));
  document.getElementById('zoomInBtn')?.addEventListener('click',  () => setPreviewZoom(previewZoom + 0.1));

  // Click zoom label to reset to 100% and reset pan
  document.getElementById('zoomLabel')?.addEventListener('click', () => {
    resetPreviewView();
  });
  document.getElementById('previewResetViewBtn')?.addEventListener('click', () => {
    resetPreviewView();
  });

  // ── Drag-to-pan on preview area (canvas + background) ──────────────────────
  const previewCanvas = document.getElementById('livePreviewCanvas');
  let _panDragging = false;
  let _panStart    = { x: 0, y: 0 };
  let _panOrigin   = { x: 0, y: 0 };

  // Allow dragging from anywhere in the preview area (canvas or background margin)
  zone.addEventListener('mousedown', e => {
    if (!zone.classList.contains('has-preview')) return;
    // Skip if the click landed on an interactive overlay element
    if (e.target.closest('button, input, select, a, label, .preview-exif-wrap, .preview-zoom-bar, .preview-quality-wrap, .preview-history-wrap, .preview-reset-view-btn')) return;
    _panDragging = true;
    _panStart    = { x: e.clientX, y: e.clientY };
    _panOrigin   = { x: previewPan.x, y: previewPan.y };
    zone.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!_panDragging) return;
    previewPan.x = _panOrigin.x + (e.clientX - _panStart.x);
    previewPan.y = _panOrigin.y + (e.clientY - _panStart.y);
    applyPreviewTransform();
    updatePreviewViewModifiedState();
  });

  window.addEventListener('mouseup', () => {
    if (!_panDragging) return;
    _panDragging = false;
    zone.classList.remove('dragging');
  });

  // Touch: single-finger pan + two-finger pinch-to-zoom (whole preview area)
  let _pinching  = false;
  let _pinchDist = 0;
  let _pinchZoom = 1.0;

  function _touchDist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }

  zone.addEventListener('touchstart', e => {
    if (!zone.classList.contains('has-preview')) return;
    // Skip if touch started on an interactive overlay element
    if (e.target.closest('button, input, select, a, label, .preview-exif-wrap, .preview-zoom-bar, .preview-quality-wrap, .preview-history-wrap, .preview-reset-view-btn')) return;
    if (e.touches.length === 2) {
      // Two fingers → start pinch; cancel any ongoing pan
      _panDragging = false;
      _pinching    = true;
      _pinchDist   = _touchDist(e.touches);
      _pinchZoom   = previewZoom;
      e.preventDefault();
    } else if (e.touches.length === 1 && !_pinching) {
      // One finger → pan
      _panDragging = true;
      _panStart    = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _panOrigin   = { x: previewPan.x, y: previewPan.y };
      e.preventDefault();
    }
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    if (!zone.classList.contains('has-preview')) return;
    if (e.touches.length === 2 && _pinching) {
      const dist  = _touchDist(e.touches);
      const scale = dist / _pinchDist;
      setPreviewZoom(_pinchZoom * scale);
      e.preventDefault();
    } else if (e.touches.length === 1 && _panDragging) {
      previewPan.x = _panOrigin.x + (e.touches[0].clientX - _panStart.x);
      previewPan.y = _panOrigin.y + (e.touches[0].clientY - _panStart.y);
      applyPreviewTransform();
      updatePreviewViewModifiedState();
      e.preventDefault();
    }
  }, { passive: false });

  zone.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      if (_pinching) scheduleLivePreview(); // re-render at new zoom level
      _panDragging = false;
      _pinching    = false;
    } else if (e.touches.length === 1 && _pinching) {
      // Lifted one finger mid-pinch → switch to pan
      _pinching  = false;
      _panDragging = true;
      _panStart  = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _panOrigin = { x: previewPan.x, y: previewPan.y };
    }
  });

  // "Add more files" button (visible in section header when files are loaded)
  const addMoreBtn = document.getElementById('addMoreBtn');
  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => input.click());
  }
}

// ─── Settings Listeners ───────────────────────────────────────────────────────
function _decimalPlaces(num) {
  if (!Number.isFinite(num)) return 0;
  const s = String(num);
  if (!s.includes('.')) return 0;
  return s.split('.')[1].length;
}

function _clampRangeInputValue(el, rawValue) {
  const minAttr  = parseFloat(el.min);
  const maxAttr  = parseFloat(el.max);
  const stepAttr = parseFloat(el.step);
  const min = Number.isFinite(minAttr) ? minAttr : -Infinity;
  const max = Number.isFinite(maxAttr) ? maxAttr : Infinity;
  let val = Number(rawValue);
  if (!Number.isFinite(val)) return null;
  val = Math.min(max, Math.max(min, val));

  if (Number.isFinite(stepAttr) && stepAttr > 0 && Number.isFinite(minAttr)) {
    const stepCount = Math.round((val - minAttr) / stepAttr);
    val = minAttr + stepCount * stepAttr;
    const precision = Math.max(_decimalPlaces(stepAttr), _decimalPlaces(minAttr), _decimalPlaces(maxAttr));
    val = Number(val.toFixed(precision));
    val = Math.min(max, Math.max(min, val));
  }
  return val;
}

function _extractNumericInputValue(text, allowedUnits = []) {
  // Accept suffixes shown in UI labels so users can edit in-place without removing units.
  const m = String(text ?? '').replace(',', '.').match(/^\s*([+-]?\d+(?:\.\d+)?)\s*(%|×|px)?\s*$/i);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  if (allowedUnits.length > 0 && unit && !allowedUnits.map(u => String(u).toLowerCase()).includes(unit)) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function setupSettingsListeners() {
  const bindRangeControl = (id, valId, fmt, onValueChange, expectedUnit = '') => {
    const el    = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!el) return;

    el.addEventListener('input', () => {
      if (valEl) valEl.textContent = fmt(el.value);
      onValueChange(el.value);
    });

    // Double click slider track/thumb to reset to its default value.
    el.addEventListener('dblclick', () => {
      const defaultRaw = el.defaultValue ?? el.getAttribute('value') ?? el.value;
      const clamped = _clampRangeInputValue(el, defaultRaw);
      if (clamped == null) return;
      el.value = String(clamped);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Make the numeric text on the right editable.
    if (!valEl) return;
    valEl.classList.add('range-val-editable');
    valEl.setAttribute('contenteditable', 'true');
    valEl.setAttribute('role', 'textbox');
    valEl.setAttribute('spellcheck', 'false');
    valEl.setAttribute('title', 'Edit value');

    const commit = () => {
      const parsed = _extractNumericInputValue(valEl.textContent, expectedUnit ? [expectedUnit] : []);
      if (parsed == null) {
        valEl.textContent = fmt(el.value);
        return;
      }
      const clamped = _clampRangeInputValue(el, parsed);
      if (clamped == null) {
        valEl.textContent = fmt(el.value);
        return;
      }
      el.value = String(clamped);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    valEl.addEventListener('focus', () => {
      valEl.textContent = el.value;
      const sel = document.getSelection();
      if (sel) {
        try { sel.selectAllChildren(valEl); } catch (_) { /* Safe fallback for edge-browser/contenteditable quirks. */ }
      }
    });
    valEl.addEventListener('blur', commit);
    valEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        valEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        valEl.textContent = fmt(el.value);
        valEl.blur();
      }
    });
  };

  [
    ['thicknessRange',          'thicknessRangeVal',          v => parseFloat(v).toFixed(1) + '×', '×'],
    ['imageOffsetRange',        'imageOffsetRangeVal',        v => parseFloat(v).toFixed(0) + '%', '%'],
    ['shotOnFontRange',         'shotOnFontRangeVal',         v => parseFloat(v).toFixed(1) + '×', '×'],
    ['exifFontRange',           'exifFontRangeVal',           v => parseFloat(v).toFixed(1) + '×', '×'],
    ['lineGapRange',            'lineGapRangeVal',            v => parseFloat(v).toFixed(1) + '×', '×'],
    ['textOffsetRange',         'textOffsetRangeVal',         v => parseFloat(v).toFixed(1),       ''],
    ['outerPaddingRange',       'outerPaddingRangeVal',       v => v + '%',                         '%'],
    ['mapOverlayOpacityRange',  'mapOverlayOpacityVal',       v => v + '%',                         '%'],
  ].forEach(([id, valId, fmt, unit]) => bindRangeControl(id, valId, fmt, () => applySettings(), unit));

  // Frame color radios (standard swatches)
  document.querySelectorAll('input[name="frameColor"]').forEach(radio => {
    radio.addEventListener('change', () => {
      // Standard color selected — deactivate custom
      state.isCustomColor = false;
      const btn = document.getElementById('customColorBtn');
      if (btn) btn.classList.remove('active');
      applySettings();
    });
  });

  // Custom color — single rainbow button
  const picker    = document.getElementById('customColorPicker');
  const customBtn = document.getElementById('customColorBtn');

  if (customBtn && picker) {
    picker.addEventListener('input', () => {
      state.isCustomColor    = true;
      state.customColorValue = picker.value;
      updateCustomColorBtn(picker.value);
      // Deselect standard radio
      document.querySelectorAll('input[name="frameColor"]').forEach(r => r.checked = false);
      applySettings();
    });
    picker.addEventListener('change', () => {
      state.isCustomColor    = true;
      state.customColorValue = picker.value;
      updateCustomColorBtn(picker.value);
      document.querySelectorAll('input[name="frameColor"]').forEach(r => r.checked = false);
      applySettings();
    });
  }

  // Font family selector — track popularity + rebuild select
  const fontFamilyEl = document.getElementById('fontFamily');
  if (fontFamilyEl) {
    fontFamilyEl.addEventListener('change', () => {
      recordFontUsage(fontFamilyEl.value);
      buildFontSelect(); // Rebuild with updated popularity
      applySettings();
    });
  }

  // Font style checkboxes (camera name + EXIF) and map overlay toggle
  ['cameraNameBold', 'cameraNameItalic', 'exifItalic', 'showShotOn', 'showDecoLine', 'showExifInfo', 'showLocation', 'showMapOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applySettings);
  });

  // Live EXIF panel inputs: apply immediately on each change
  ['live-exif-make', 'live-exif-model', 'live-exif-lens', 'live-exif-fl', 'live-exif-fn', 'live-exif-et', 'live-exif-iso', 'live-exif-location']
    .forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', scheduleLiveExifEditApply);
      el.addEventListener('change', scheduleLiveExifEditApply);
    });

  // Frame background mode radios
  document.querySelectorAll('input[name="frameBackground"]').forEach(r => {
    r.addEventListener('change', applySettings);
  });

  // Blur background sliders
  [
    ['blurRadiusRange',     'blurRadiusVal',     v => v + 'px', 'px'],
    ['blurBrightnessRange', 'blurBrightnessVal', v => v + '%',  '%'],
  ].forEach(([id, valId, fmt, unit]) => bindRangeControl(id, valId, fmt, () => applySettings(), unit));

  const blurStyleEl = document.getElementById('blurStyleSelect');
  if (blurStyleEl) blurStyleEl.addEventListener('change', applySettings);

  // Location icon picker
  document.querySelectorAll('.icon-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applySettings();
    });
  });

  // Location position radios
  document.querySelectorAll('input[name="locationPos"]').forEach(r => {
    r.addEventListener('change', applySettings);
  });

  // Aspect ratio radios
  document.querySelectorAll('input[name="aspectRatio"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
  });
  document.querySelectorAll('input[name="aspectOrientation"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
  });

  // ── Export: photo format + quality ───────────────────────────────────────
  document.querySelectorAll('input[name="exportPhotoFormat"]').forEach(r => {
    r.addEventListener('change', () => {
      const qRow = document.getElementById('photoQualityRow');
      if (qRow) qRow.classList.toggle('row-hidden', r.value === 'png');
      // Photo format doesn't need re-generation (applied at download time) — just save
      const pFmt = document.querySelector('input[name="exportPhotoFormat"]:checked');
      state.settings.exportPhotoFormat = pFmt ? pFmt.value : 'jpeg';
      saveSettings();
    });
  });

  bindRangeControl(
    'photoQualityRange',
    'photoQualityRangeVal',
    v => v + '%',
    v => {
      state.settings.exportPhotoQuality = parseInt(v, 10);
      saveSettings();
    },
    '%'
  );

  // ── Export: video bitrate (format wired in initVideoFormatOptions) ────────
  document.querySelectorAll('input[name="exportVideoBitrate"]').forEach(r => {
    r.addEventListener('change', onVideoExportSettingChange);
  });
}

function setupHistoryControls() {
  document.getElementById('undoEditBtn')?.addEventListener('click', undoSettings);
  document.getElementById('redoEditBtn')?.addEventListener('click', redoSettings);
  updateHistoryButtons();
}

function _isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if (_isTypingTarget(e.target)) return;

    const key = (e.key || '').toLowerCase();
    const withMod = e.metaKey || e.ctrlKey;

    if (withMod && !e.altKey && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoSettings();
      return;
    }
    if (withMod && !e.altKey && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoSettings();
      return;
    }
    if (withMod && !e.altKey && key === '0') {
      e.preventDefault();
      resetPreviewView();
      return;
    }
    if (withMod && e.shiftKey && key === 'backspace') {
      e.preventDefault();
      clearAllItems();
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      if (state.selectedItemId != null) {
        e.preventDefault();
        removeItem(state.selectedItemId);
      }
    }
  });
}

// ─── Animation helpers ────────────────────────────────────────────────────────
/**
 * Fade an element in or out without layout jank.
 * - show=true:  set display, force reflow, then fade opacity to 1
 * - show=false: fade opacity to 0, then set display:none after transition
 */
function setVisible(el, show, displayVal = '') {
  if (!el) return;
  if (el._fadeTimer) { clearTimeout(el._fadeTimer); el._fadeTimer = null; }

  if (show) {
    if (el.style.display === 'none') {
      el.style.opacity = '0';
      el.style.display = displayVal || '';
      void el.offsetWidth; // force reflow so transition fires
    }
    el.style.opacity = '1';
  } else {
    el.style.opacity = '0';
    el._fadeTimer = setTimeout(() => {
      el.style.display = 'none';
      el._fadeTimer = null;
    }, 190);
  }
}

// ─── Custom Color Button ──────────────────────────────────────────────────────
function updateCustomColorBtn(color) {
  const btn  = document.getElementById('customColorBtn');
  const icon = document.getElementById('customColorIcon');
  if (!btn || !icon) return;
  btn.classList.add('active');
  icon.style.background = color;
  icon.style.borderRadius = '50%';
}

// ─── Preview Quality Popup ────────────────────────────────────────────────────
const QUALITY_LABELS = { auto: 'Auto', draft: 'Draft', normal: 'Normal', high: 'High', max: 'Max' };

function setupPreviewQuality() {
  const btn   = document.getElementById('previewQualityBtn');
  const popup = document.getElementById('previewQualityPopup');
  const label = document.getElementById('previewQualityLabel');
  if (!btn || !popup) return;

  // Restore saved quality
  const saved = loadPrefs().previewQuality || 'auto';
  setPreviewQuality(saved, { schedule: false });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    popup.classList.toggle('open');
  });

  popup.querySelectorAll('.pq-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const q = opt.dataset.q;
      setPreviewQuality(q, { schedule: false });
      popup.classList.remove('open');
      scheduleLivePreview();
    });
  });

  document.addEventListener('click', e => {
    if (!btn.contains(e.target) && !popup.contains(e.target)) {
      popup.classList.remove('open');
    }
  });
}

function _applyQualitySelection(q, popup, label) {
  popup.querySelectorAll('.pq-option').forEach(o => o.classList.toggle('active', o.dataset.q === q));
  if (label) label.textContent = QUALITY_LABELS[q] || 'Auto';
  updatePreviewViewModifiedState();
}

function setPreviewQuality(q, options = {}) {
  const { schedule = false } = options;
  const quality = QUALITY_LABELS[q] ? q : 'auto';
  const prefs = loadPrefs();
  prefs.previewQuality = quality;
  savePrefs(prefs);
  const popup = document.getElementById('previewQualityPopup');
  const label = document.getElementById('previewQualityLabel');
  if (popup) _applyQualitySelection(quality, popup, label);
  else updatePreviewViewModifiedState();
  if (schedule) scheduleLivePreview();
}

// ─── Sidebar Resize ───────────────────────────────────────────────────────────
function setupSidebarResize() {
  const handle  = document.getElementById('sidebarResizeHandle');
  const sidebar = document.querySelector('.sidebar');
  if (!handle || !sidebar) return;

  const prefs = loadPrefs();
  if (prefs.sidebarWidth) {
    const w = Math.min(Math.max(prefs.sidebarWidth, 220), 480);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  }

  let _resizing = false;
  let _startX   = 0;
  let _startW   = 0;
  const isRight = () => document.documentElement.getAttribute('data-layout') === 'right';

  handle.addEventListener('mousedown', e => {
    _resizing = true;
    _startX   = e.clientX;
    _startW   = sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!_resizing) return;
    const delta = isRight() ? _startX - e.clientX : e.clientX - _startX;
    const w = Math.min(Math.max(_startW + delta, 220), 480);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  });

  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist width
    const p = loadPrefs();
    p.sidebarWidth = sidebar.offsetWidth;
    savePrefs(p);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Preferences (theme / layout) ────────────────────────────────────────────
const PREFS_KEY = 'instaframe_prefs';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } }
function savePrefs(p)  { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'light');
}
function applyLayout(layout) {
  document.documentElement.setAttribute('data-layout', layout || 'left');
}

function rerenderCards() {
  const grid = document.getElementById('imageGrid');
  grid.innerHTML = '';
  const saved = [...state.items];
  state.items = [];
  itemIdCounter = 0;
  saved.forEach(item => {
    const n = { ...item, id: ++itemIdCounter };
    state.items.push(n);
    renderItem(n);
    if (n.status === 'done') { updateItemStatus(n); updateItemPreview(n); }
  });
  updateUI();
}

function setupCustomizePanel() {
  const btn    = document.getElementById('customizeBtn');
  const panel  = document.getElementById('customizePanel');
  const scroll = document.getElementById('sidebarScroll');
  if (!btn || !panel || !scroll) return;

  // Toggle panel visibility — class-based so CSS transitions run
  btn.addEventListener('click', () => {
    const open = panel.classList.contains('panel-open');
    panel.classList.toggle('panel-open', !open);
    scroll.classList.toggle('panel-open', !open);
    btn.classList.toggle('active', !open);
  });

  const prefs = loadPrefs();

  // ── Theme ──────────────────────────────────────────────────────────────────
  const savedTheme = prefs.theme || 'soft-white';
  applyTheme(savedTheme);
  document.querySelectorAll('input[name="themeChoice"]').forEach(r => {
    if (r.value === savedTheme) r.checked = true;
    r.addEventListener('change', () => {
      applyTheme(r.value);
      const p = loadPrefs(); p.theme = r.value; savePrefs(p);
    });
  });

  // ── Layout ─────────────────────────────────────────────────────────────────
  const savedLayout = prefs.layout || 'left';
  applyLayout(savedLayout);
  document.querySelectorAll('input[name="layoutChoice"]').forEach(r => {
    if (r.value === savedLayout) r.checked = true;
    r.addEventListener('change', () => {
      applyLayout(r.value);
      const p = loadPrefs(); p.layout = r.value; savePrefs(p);
    });
  });

  // ── Accent color presets ───────────────────────────────────────────────────
  const accentSwatches = document.getElementById('accentSwatches');
  const accentPicker   = document.getElementById('accentColorPicker');
  const savedAccent    = prefs.accentColor;

  function _activateSwatch(color) {
    document.querySelectorAll('.accent-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });
    // Also activate custom btn when no preset matches
    const customBtn = document.getElementById('accentCustomBtn');
    const isPreset  = !!document.querySelector(`.accent-swatch[data-color="${color}"]`);
    if (customBtn) customBtn.classList.toggle('active', !isPreset);
    if (accentPicker) accentPicker.value = color;
  }

  if (accentSwatches) {
    accentSwatches.querySelectorAll('.accent-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        _applyAccentColor(color);
        _activateSwatch(color);
        const p = loadPrefs(); p.accentColor = color; savePrefs(p);
      });
    });
  }
  if (accentPicker) {
    accentPicker.addEventListener('input', () => {
      _applyAccentColor(accentPicker.value);
      _activateSwatch(accentPicker.value);
      const p = loadPrefs(); p.accentColor = accentPicker.value; savePrefs(p);
    });
  }
  // Restore saved accent (default to cyan)
  const effectiveAccent = savedAccent || '#0891b2';
  _applyAccentColor(effectiveAccent);
  _activateSwatch(effectiveAccent);

}

// ─── Mobile Tab Bar ───────────────────────────────────────────────────────────
function setupMobileTabs() {
  const tabBar = document.getElementById('mobileTabBar');
  if (!tabBar) return;

  function isMobile() { return window.innerWidth <= 768; }

  function switchTab(tab) {
    if (!isMobile()) return;
    document.body.setAttribute('data-mobile-tab', tab);
    tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // When switching to preview tab, fire a live preview update
    if (tab === 'preview') scheduleLivePreview();

    // Update tap-to-import overlay visibility for the new tab
    updateEmptyTapOverlay();
  }

  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Default to preview tab on mobile
  if (isMobile()) {
    document.body.setAttribute('data-mobile-tab', 'preview');
  }

  // Reset to no tab attribute on desktop
  window.addEventListener('resize', () => {
    if (!isMobile()) document.body.removeAttribute('data-mobile-tab');
    else if (!document.body.getAttribute('data-mobile-tab')) {
      document.body.setAttribute('data-mobile-tab', 'preview');
    }
    updateEmptyTapOverlay();
  });

  // Mobile "Add Photos" button (in empty hint on Photos tab)
  const mobileAddBtn = document.getElementById('mobileAddBtn');
  const fileInput    = document.getElementById('fileInput');
  if (mobileAddBtn && fileInput) {
    mobileAddBtn.addEventListener('click', () => fileInput.click());
  }

  // ── Tap-to-import overlay for empty state ──────────────────────────────────
  // A transparent overlay placed over preview-area and empty-hint that opens
  // the file picker when tapped, but only while no files are loaded on mobile.

  // Create overlay element once and reuse
  const tapOverlay = document.createElement('div');
  tapOverlay.className = 'mobile-empty-tap-overlay';
  tapOverlay.style.display = 'none';
  // Append to main so it covers whichever tab panel is visible
  const mainEl = document.querySelector('.main');
  if (mainEl) mainEl.appendChild(tapOverlay);

  if (tapOverlay && fileInput) {
    tapOverlay.addEventListener('click', (e) => {
      // Only trigger when no files loaded and on mobile
      if (!isMobile() || state.items.length > 0) return;
      // Prevent double-trigger if a child button was the target
      if (e.target !== tapOverlay) return;
      fileInput.click();
    });
  }

  function updateEmptyTapOverlay() {
    if (!tapOverlay) return;
    const empty   = state.items.length === 0;
    const mobile  = isMobile();
    const tab     = document.body.getAttribute('data-mobile-tab');
    const active  = empty && mobile && (tab === 'preview' || tab === 'photos');
    tapOverlay.style.display = active ? 'block' : 'none';
  }

  // Re-evaluate overlay whenever items change (hooked via updateUI calls)
  // Expose via module-level variable so updateUI() can call it after state changes
  _updateMobileEmptyOverlay = updateEmptyTapOverlay;

  // Initial evaluation
  updateEmptyTapOverlay();
}

// ─── Accent Color ─────────────────────────────────────────────────────────────
function _darkenHex(hex, pct) {
  // Convert hex to HSL, darken by pct%, return hex
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  l = Math.max(0, l - pct / 100);
  // HSL to RGB
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q-p)*6*t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q-p)*(2/3-t)*6;
    return p;
  }
  let rr, gg, bb;
  if (s === 0) { rr = gg = bb = l; } else {
    const q2 = l < 0.5 ? l*(1+s) : l+s-l*s;
    const p2  = 2*l - q2;
    rr = hue2rgb(p2,q2,h+1/3); gg = hue2rgb(p2,q2,h); bb = hue2rgb(p2,q2,h-1/3);
  }
  return '#' + [rr,gg,bb].map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('');
}

function _applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  document.documentElement.style.setProperty('--accent',   hex);
  document.documentElement.style.setProperty('--accent-h', _darkenHex(hex, 12));
}

// ─── Main area vertical resize (preview ↕ image pool) ────────────────────────
function setupMainResize() {
  const handle  = document.getElementById('mainResizeHandle');
  const preview = document.querySelector('.preview-area');
  if (!handle || !preview) return;

  const prefs = loadPrefs();
  if (prefs.previewHeight) preview.style.height = prefs.previewHeight;

  let _resizing = false, _startY = 0, _startH = 0;

  handle.addEventListener('mousedown', e => {
    _resizing = true;
    _startY   = e.clientY;
    _startH   = preview.offsetHeight;
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!_resizing) return;
    const h = Math.min(Math.max(_startH + (e.clientY - _startY), 120),
                       window.innerHeight - 160);
    preview.style.height = h + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    handle.classList.remove('resizing');
    const p = loadPrefs();
    p.previewHeight = preview.offsetHeight + 'px';
    savePrefs(p);
    scheduleLivePreview();
  });
}

// ─── Card size slider ─────────────────────────────────────────────────────────
function setupCardSize() {
  const range = document.getElementById('cardSizeRange');
  if (!range) return;
  const prefs = loadPrefs();
  if (prefs.cardSize) {
    range.value = prefs.cardSize;
    document.documentElement.style.setProperty('--card-min-w', prefs.cardSize + 'px');
  }
  range.addEventListener('input', () => {
    document.documentElement.style.setProperty('--card-min-w', range.value + 'px');
    const p = loadPrefs(); p.cardSize = parseInt(range.value, 10); savePrefs(p);
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Apply theme & layout immediately (before paint) to avoid flash
;(function() {
  const p = loadPrefs();
  applyTheme(p.theme || 'soft-white');
  applyLayout(p.layout || 'left');
  _applyAccentColor(p.accentColor || '#0891b2');
})();

document.addEventListener('DOMContentLoaded', () => {
  buildFontSelect();         // populate font select with popularity-ordered options
  applyTranslations();
  restoreSettings();         // restore saved settings to DOM
  initVideoFormatOptions();  // build video format pills (needs MediaRecorder)

  // After video pills exist, restore saved video format selection
  if (state.settings.exportVideoFormat) {
    const r = document.querySelector(`input[name="exportVideoFormat"][value="${state.settings.exportVideoFormat}"]`);
    if (r) r.checked = true;
  }

  // Restore custom color button visual state
  if (state.isCustomColor) updateCustomColorBtn(state.customColorValue);

  _historyLocked = true;
  applySettings();           // sync state.settings from restored DOM values
  _historyLocked = false;

  // Pre-load current font so the very first preview render skips the font-fetch delay
  if (document.fonts) {
    const fam = `'${state.settings.fontFamily || 'Inter'}'`;
    ['300 16px', '400 16px', '500 16px', '700 16px']
      .forEach(s => document.fonts.load(`${s} ${fam}`).catch(() => {}));
  }

  setupDropZone();
  setupSettingsListeners();
  setupSidebarResize();
  setupMainResize();
  setupCardSize();
  setupCustomizePanel();
  setupPreviewQuality();
  setupHistoryControls();
  setupKeyboardShortcuts();
  setupMobileTabs();
  document.getElementById('langToggleBtn')?.addEventListener('click', () => {
    setLang(currentLang === 'en' ? 'ja' : 'en');
    rerenderCards();
  });
  updateUI();
  updatePreviewViewModifiedState();

  document.getElementById('generateAllBtn').addEventListener('click', generateAll);
  document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);
  document.getElementById('clearAllBtn')?.addEventListener('click', () => clearAllItems());

  // Hide image section by default
  document.getElementById('imageSection').style.display = 'none';
});
