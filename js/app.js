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
    thicknessScale:      1.0,
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
    outerPadding:        0,
    aspectRatio:         'original',
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
    let location = '';
    if (raw.GPSLatitude && raw.GPSLongitude) {
      const lat = gpsToDecimal(raw.GPSLatitude, raw.GPSLatitudeRef);
      const lon = gpsToDecimal(raw.GPSLongitude, raw.GPSLongitudeRef);
      if (lat != null && lon != null) {
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
    };
  } catch (e) {
    return emptyExif();
  }
}

function emptyExif() {
  return { make:'', model:'', lensModel:'', focalLength:'', fNumber:'', exposureTime:'', iso:'', location:'' };
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

function removeItem(id) {
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
      const img   = await FrameEngine.loadImage(item.file);
      item.canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings);
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
async function getDeviceLocation(id) {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported', 'warn');
    return;
  }
  const input = document.getElementById(`exif-location-${id}`);
  if (!input) return;
  const original = input.value;
  input.value = 'Getting location…';
  input.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude);
      input.value = name || `${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
      input.disabled = false;
    },
    () => {
      input.value = original;
      input.disabled = false;
      showToast('Could not get location', 'warn');
    },
    { timeout: 10000 }
  );
}

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
  // Show/hide location position row
  const locPosRow = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.style.display = (saved.showLocation) ? '' : 'none';

  // Aspect ratio
  if (saved.aspectRatio) {
    const r = document.querySelector(`input[name="aspectRatio"][value="${saved.aspectRatio}"]`);
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
function applySettings() {
  // Frame color (custom color button or radio swatches)
  if (state.isCustomColor) {
    state.settings.frameColor = state.customColorValue;
  } else {
    const colorRadio = document.querySelector('input[name="frameColor"]:checked');
    state.settings.frameColor = colorRadio ? colorRadio.value : '#F0F0F0';
  }

  // Update dark-frame outline on preview canvas
  const previewCanvas = document.getElementById('livePreviewCanvas');
  if (previewCanvas) {
    const isDark = FrameEngine.isColorDark(state.settings.frameColor);
    previewCanvas.classList.toggle('frame-dark', isDark);
  }

  state.settings.thicknessScale   = parseFloat(document.getElementById('thicknessRange').value);
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

  const locPosRadio = document.querySelector('input[name="locationPos"]:checked');
  state.settings.locationPosition = locPosRadio ? locPosRadio.value : 'below-exif';

  // Show/hide location position row
  const locPosRow = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.style.display = state.settings.showLocation ? '' : 'none';

  const ratioRadio = document.querySelector('input[name="aspectRatio"]:checked');
  state.settings.aspectRatio = ratioRadio ? ratioRadio.value : 'original';

  // Export settings (photo only — video is handled separately)
  const pFmt = document.querySelector('input[name="exportPhotoFormat"]:checked');
  state.settings.exportPhotoFormat  = pFmt ? pFmt.value : 'jpeg';
  state.settings.exportPhotoQuality = parseInt(document.getElementById('photoQualityRange')?.value || '92', 10);
  // (video export settings read via onVideoExportSettingChange)

  // Mark all done items as pending (frame settings changed → need re-render)
  state.items.forEach(i => {
    if (i.status === 'done') {
      i.status = 'pending';
      i.canvas = null;
      updateItemStatus(i);
      updateItemPreview(i);
    }
  });

  saveSettings();
  updateUI();
  scheduleLivePreview();
}

// ─── EXIF Editor ──────────────────────────────────────────────────────────────
function toggleExifEditor(id) {
  const panel = document.getElementById(`exif-panel-${id}`);
  if (panel) panel.classList.toggle('hidden');
}

function applyExifEdit(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  item.exif.make         = document.getElementById(`exif-make-${id}`).value.trim();
  item.exif.model        = document.getElementById(`exif-model-${id}`).value.trim();
  item.exif.lensModel    = document.getElementById(`exif-lens-${id}`).value.trim();
  item.exif.focalLength  = document.getElementById(`exif-fl-${id}`).value.trim();
  item.exif.fNumber      = document.getElementById(`exif-fn-${id}`).value.trim();
  item.exif.exposureTime = document.getElementById(`exif-et-${id}`).value.trim();
  item.exif.iso          = document.getElementById(`exif-iso-${id}`).value.trim();
  item.exif.location     = document.getElementById(`exif-location-${id}`)?.value.trim() || '';

  item.status = 'pending';
  item.canvas = null;
  updateItemStatus(item);
  updateItemPreview(item);
  toggleExifEditor(id);
  updateUI();
  scheduleLivePreview();
}

// ─── Live Preview ─────────────────────────────────────────────────────────────
let _livePreviewTimer = null;

function scheduleLivePreview() {
  clearTimeout(_livePreviewTimer);
  _livePreviewTimer = setTimeout(renderLivePreview, 300);
}

// ─── Preview Zoom & Pan ───────────────────────────────────────────────────────
function applyPreviewTransform() {
  const canvas = document.getElementById('livePreviewCanvas');
  if (!canvas) return;
  canvas.style.transform = `scale(${previewZoom}) translate(${previewPan.x / previewZoom}px, ${previewPan.y / previewZoom}px)`;
  // Dark frame outline
  const isDark = FrameEngine.isColorDark(state.settings.frameColor);
  canvas.classList.toggle('frame-dark', isDark);
}

function setPreviewZoom(zoom) {
  previewZoom = Math.min(Math.max(zoom, 0.5), 3.0);
  applyPreviewTransform();
  const range = document.getElementById('zoomRange');
  if (range) range.value = Math.round(previewZoom * 100);
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = Math.round(previewZoom * 100) + '%';
}

function resetPreviewPan() {
  previewPan = { x: 0, y: 0 };
  applyPreviewTransform();
}

// ─── Item Selection for Preview ───────────────────────────────────────────────
function selectItem(id) {
  state.selectedItemId = id;
  document.querySelectorAll('.image-card').forEach(c => c.classList.remove('selected-preview'));
  const el = document.getElementById(`item-${id}`);
  if (el) el.classList.add('selected-preview');
  scheduleLivePreview();
}

async function renderLivePreview() {
  const pane         = document.getElementById('dropZone');
  const previewCanvas = document.getElementById('livePreviewCanvas');
  const emptyEl      = document.getElementById('previewEmpty');
  if (!pane || !previewCanvas) return;

  if (state.items.length === 0) {
    previewCanvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    pane.classList.remove('has-preview');
    return;
  }

  // Use selected item (set by card click) or fall back to first
  const item = (state.selectedItemId && state.items.find(i => i.id === state.selectedItemId))
    || state.items[0];

  // For video items, show native video element instead of canvas
  const liveVideo = document.getElementById('livePreviewVideo');
  if (item.isVideo && liveVideo) {
    previewCanvas.style.display = 'none';
    if (!liveVideo._srcId || liveVideo._srcId !== item.id) {
      if (liveVideo._objUrl) URL.revokeObjectURL(liveVideo._objUrl);
      liveVideo._objUrl = URL.createObjectURL(item.file);
      liveVideo._srcId  = item.id;
      liveVideo.src     = liveVideo._objUrl;
    }
    liveVideo.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    pane.classList.add('has-preview');
    applyPreviewTransform();
    return;
  }
  if (liveVideo) liveVideo.style.display = 'none';

  // Compute maxPreviewPx from quality preference
  const pq = loadPrefs().previewQuality || 'auto';
  const maxPreviewPx = pq === 'draft'  ? 600
    : pq === 'normal' ? 1200
    : pq === 'high'   ? 1800
    : pq === 'max'    ? 2400
    : Math.min(2400, Math.round(1200 * previewZoom)); // 'auto': zoom-adaptive

  try {
    const img = await FrameEngine.loadImage(item.file);
    const canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings, { maxPreviewPx });

    const dpr      = window.devicePixelRatio || 1;
    const areaW    = Math.max(pane.clientWidth  - 40, 80);
    const areaH    = Math.max(pane.clientHeight - 40, 60);
    const srcRatio = canvas.height / canvas.width;

    // Fit canvas inside the available area, maintain aspect ratio
    let displayW = Math.min(areaW, Math.round(areaH / srcRatio));
    let displayH = Math.round(displayW * srcRatio);
    if (displayH > areaH) { displayH = areaH; displayW = Math.round(areaH / srcRatio); }
    displayW = Math.max(displayW, 80);
    displayH = Math.max(displayH, 60);

    // Physical pixels = CSS pixels × DPR → sharp on HiDPI / Retina
    previewCanvas.width  = Math.round(displayW * dpr);
    previewCanvas.height = Math.round(displayH * dpr);
    previewCanvas.style.width  = displayW + 'px';
    previewCanvas.style.height = displayH + 'px';

    // Draw with high-quality downscaling so larger render canvases look sharper
    function drawToPreview() {
      const ctx2 = previewCanvas.getContext('2d');
      ctx2.imageSmoothingEnabled = true;
      ctx2.imageSmoothingQuality = 'high';
      ctx2.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    }

    // Fade in: start transparent, draw, then reveal
    const isFirstRender = previewCanvas.style.display === 'none' || previewCanvas.style.display === '';
    if (isFirstRender) previewCanvas.style.opacity = '0';
    previewCanvas.style.display = 'block';
    drawToPreview();
    if (isFirstRender) {
      void previewCanvas.offsetWidth;
      previewCanvas.style.opacity = '1';
    }
    if (emptyEl) emptyEl.style.display = 'none';
    pane.classList.add('has-preview');
  } catch (e) {
    // Non-critical — silently ignore preview failures
  }
}

// ─── Photo Preview Modal ──────────────────────────────────────────────────────
let _modalIndex = 0;
let _lastModalObjUrl = null;

function openModal(itemId) {
  const idx = state.items.findIndex(i => i.id === itemId);
  if (idx === -1) return;
  _modalIndex = idx;
  _renderModal();
  document.getElementById('photoModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('photoModal').classList.remove('open');
  document.body.style.overflow = '';
  // Stop modal video if playing
  const v = document.getElementById('modalVideo');
  if (v) { v.pause(); v.src = ''; }
  // Revoke any object URL we created
  if (_lastModalObjUrl) {
    URL.revokeObjectURL(_lastModalObjUrl);
    _lastModalObjUrl = null;
  }
}

function _renderModal() {
  const item      = state.items[_modalIndex];
  if (!item) return;

  const canvasEl  = document.getElementById('modalCanvas');
  const imgEl     = document.getElementById('modalImg');
  const vidEl     = document.getElementById('modalVideo');
  const filename  = document.getElementById('modalFilename');
  const dlBtn     = document.getElementById('modalDownload');
  const prevBtn   = document.getElementById('modalPrev');
  const nextBtn   = document.getElementById('modalNext');

  filename.textContent   = item.file.name;
  prevBtn.disabled       = _modalIndex === 0;
  nextBtn.disabled       = _modalIndex === state.items.length - 1;

  // Stop any previous video
  if (vidEl) { vidEl.pause(); }

  if (item.isVideo) {
    // Show framed video if available, otherwise the original
    if (_lastModalObjUrl) URL.revokeObjectURL(_lastModalObjUrl);
    _lastModalObjUrl = URL.createObjectURL(item.videoBlob || item.file);
    if (vidEl) {
      vidEl.src           = _lastModalObjUrl;
      vidEl.style.display = 'block';
    }
    canvasEl.style.display = 'none';
    imgEl.style.display    = 'none';
    dlBtn.disabled         = !item.videoBlob;
  } else if (item.canvas) {
    // Show full-resolution framed canvas
    canvasEl.width  = item.canvas.width;
    canvasEl.height = item.canvas.height;
    canvasEl.getContext('2d').drawImage(item.canvas, 0, 0);
    canvasEl.style.display = 'block';
    imgEl.style.display    = 'none';
    if (vidEl) vidEl.style.display = 'none';
    dlBtn.disabled         = false;
  } else {
    // Show original image
    if (_lastModalObjUrl) URL.revokeObjectURL(_lastModalObjUrl);
    _lastModalObjUrl    = URL.createObjectURL(item.file);
    imgEl.src           = _lastModalObjUrl;
    imgEl.style.display = 'block';
    canvasEl.style.display = 'none';
    if (vidEl) vidEl.style.display = 'none';
    dlBtn.disabled         = true;
  }
}

function setupModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);

  // Close on backdrop click
  document.getElementById('photoModal').addEventListener('click', e => {
    if (e.target === document.getElementById('photoModal')) closeModal();
  });

  document.getElementById('modalPrev').addEventListener('click', () => {
    if (_modalIndex > 0) { _modalIndex--; _renderModal(); }
  });
  document.getElementById('modalNext').addEventListener('click', () => {
    if (_modalIndex < state.items.length - 1) { _modalIndex++; _renderModal(); }
  });
  document.getElementById('modalDownload').addEventListener('click', () => {
    const item = state.items[_modalIndex];
    if (item) downloadSingle(item.id);
  });

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    const modal = document.getElementById('photoModal');
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'ArrowLeft'  && _modalIndex > 0) {
      _modalIndex--; _renderModal();
    }
    if (e.key === 'ArrowRight' && _modalIndex < state.items.length - 1) {
      _modalIndex++; _renderModal();
    }
  });
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
        <button class="btn btn-sm btn-secondary" onclick="toggleExifEditor(${item.id})">
          <span data-i18n="editExif">${t('editExif')}</span>
        </button>
        <button class="btn btn-sm btn-primary" id="dl-btn-${item.id}" onclick="applyAndDownloadSingle(${item.id})">
          <span data-i18n="downloadSingle">${t('downloadSingle')}</span>
        </button>
        <button class="btn btn-sm btn-danger" onclick="removeItem(${item.id})">
          <span data-i18n="remove">${t('remove')}</span>
        </button>
      </div>
    </div>
    <div class="exif-panel hidden" id="exif-panel-${item.id}">
      <div class="exif-grid">
        <label>${t('cameraMake')}</label>
        <input id="exif-make-${item.id}"  value="${escHtml(item.exif.make || '')}" placeholder="e.g. FUJIFILM">
        <label>${t('cameraModel')}</label>
        <input id="exif-model-${item.id}" value="${escHtml(item.exif.model || '')}" placeholder="e.g. X-T5">
        <label>${t('lensModel')}</label>
        <input id="exif-lens-${item.id}"  value="${escHtml(item.exif.lensModel || '')}" placeholder="e.g. XF35mmF1.4 R">
        <label>${t('focalLength')}</label>
        <input id="exif-fl-${item.id}"    value="${escHtml(item.exif.focalLength || '')}" placeholder="35">
        <label>${t('fNumber')}</label>
        <input id="exif-fn-${item.id}"    value="${escHtml(item.exif.fNumber || '')}" placeholder="1.4">
        <label>${t('exposureTime')}</label>
        <input id="exif-et-${item.id}"    value="${escHtml(item.exif.exposureTime || '')}" placeholder="1/250">
        <label>${t('iso')}</label>
        <input id="exif-iso-${item.id}"   value="${escHtml(item.exif.iso || '')}" placeholder="400">
        <label>${t('location')}</label>
        <div class="exif-location-row">
          <input id="exif-location-${item.id}" value="${escHtml(item.exif.location || '')}" placeholder="e.g. Tokyo, Japan" style="flex:1;">
          <button class="btn btn-sm btn-secondary exif-geolocate-btn" onclick="getDeviceLocation(${item.id})" title="${t('getLocation')}">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="3"/><path d="M8 1v2M8 12v3M1 7h2M13 7h2"/><path d="M8 13c0 0-5-4-5-6a5 5 0 0 1 10 0c0 2-5 6-5 6z" stroke="none" fill="currentColor" opacity=".18"/></svg>
          </button>
        </div>
      </div>
      <button class="btn btn-primary btn-full" onclick="applyExifEdit(${item.id})">
        <span data-i18n="applyExif">${t('applyExif')}</span>
      </button>
    </div>
  `;

  // Click preview image/video → open modal AND select for live preview
  card.querySelector('.card-preview').addEventListener('click', () => {
    selectItem(item.id);
    openModal(item.id);
  });

  // Click card body (not buttons/EXIF panel) → select for live preview
  card.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('.exif-panel') || e.target.closest('.card-preview')) return;
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
  const counter = document.getElementById('imageCounter');

  if (genBtn)  genBtn.disabled  = !hasItems;
  if (dlBtn)   dlBtn.disabled   = !hasDone;
  if (counter) counter.textContent = hasItems ? `(${state.items.length})` : '';

  setVisible(document.getElementById('imageSection'), hasItems, 'flex');
  setVisible(document.getElementById('emptyHint'),    !hasItems);

  // If no items, reset the drop zone to its empty/clickable state
  if (!hasItems) {
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('has-preview');
    const previewCanvas = document.getElementById('livePreviewCanvas');
    if (previewCanvas) { previewCanvas.style.display = 'none'; previewCanvas.style.opacity = ''; previewCanvas.style.transform = ''; }
    const emptyEl = document.getElementById('previewEmpty');
    if (emptyEl) emptyEl.style.display = '';
    previewZoom = 1.0;
    previewPan  = { x: 0, y: 0 };
    setPreviewZoom(1.0);
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
    { label: 'VP9',  value: 'vp9',  mime: 'video/webm;codecs=vp9,opus' },
    { label: 'VP8',  value: 'vp8',  mime: 'video/webm;codecs=vp8,opus' },
    { label: 'MP4',  value: 'mp4',  mime: 'video/mp4' },
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
    setPreviewZoom(1.0);
    resetPreviewPan();
  });

  // ── Drag-to-pan on preview canvas ──────────────────────────────────────────
  const previewCanvas = document.getElementById('livePreviewCanvas');
  let _panDragging = false;
  let _panStart    = { x: 0, y: 0 };
  let _panOrigin   = { x: 0, y: 0 };

  previewCanvas.addEventListener('mousedown', e => {
    if (!zone.classList.contains('has-preview')) return;
    _panDragging = true;
    _panStart    = { x: e.clientX, y: e.clientY };
    _panOrigin   = { x: previewPan.x, y: previewPan.y };
    previewCanvas.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!_panDragging) return;
    previewPan.x = _panOrigin.x + (e.clientX - _panStart.x);
    previewPan.y = _panOrigin.y + (e.clientY - _panStart.y);
    applyPreviewTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!_panDragging) return;
    _panDragging = false;
    previewCanvas.classList.remove('dragging');
  });

  // Touch support for pan
  previewCanvas.addEventListener('touchstart', e => {
    if (!zone.classList.contains('has-preview') || e.touches.length !== 1) return;
    _panDragging = true;
    _panStart    = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    _panOrigin   = { x: previewPan.x, y: previewPan.y };
    e.preventDefault();
  }, { passive: false });

  previewCanvas.addEventListener('touchmove', e => {
    if (!_panDragging || e.touches.length !== 1) return;
    previewPan.x = _panOrigin.x + (e.touches[0].clientX - _panStart.x);
    previewPan.y = _panOrigin.y + (e.touches[0].clientY - _panStart.y);
    applyPreviewTransform();
    e.preventDefault();
  }, { passive: false });

  previewCanvas.addEventListener('touchend', () => { _panDragging = false; });

  // "Add more files" button (visible in section header when files are loaded)
  const addMoreBtn = document.getElementById('addMoreBtn');
  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => input.click());
  }
}

// ─── Settings Listeners ───────────────────────────────────────────────────────
function setupSettingsListeners() {
  // Range sliders
  [
    ['thicknessRange',    'thicknessRangeVal',    v => parseFloat(v).toFixed(1) + '×'],
    ['shotOnFontRange',   'shotOnFontRangeVal',   v => parseFloat(v).toFixed(1) + '×'],
    ['exifFontRange',     'exifFontRangeVal',     v => parseFloat(v).toFixed(1) + '×'],
    ['lineGapRange',      'lineGapRangeVal',      v => parseFloat(v).toFixed(1) + '×'],
    ['textOffsetRange',   'textOffsetRangeVal',   v => parseFloat(v).toFixed(1)],
    ['outerPaddingRange', 'outerPaddingRangeVal', v => v + '%'],
  ].forEach(([id, valId, fmt]) => {
    const el    = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!el) return;
    el.addEventListener('input', () => {
      if (valEl) valEl.textContent = fmt(el.value);
      applySettings();
    });
  });

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

  // Font style checkboxes (camera name + EXIF)
  ['cameraNameBold', 'cameraNameItalic', 'exifItalic', 'showShotOn', 'showDecoLine', 'showExifInfo', 'showLocation'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applySettings);
  });

  // Location position radios
  document.querySelectorAll('input[name="locationPos"]').forEach(r => {
    r.addEventListener('change', applySettings);
  });

  // Aspect ratio radios
  document.querySelectorAll('input[name="aspectRatio"]').forEach(radio => {
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

  const pqEl = document.getElementById('photoQualityRange');
  if (pqEl) {
    pqEl.addEventListener('input', () => {
      const valEl = document.getElementById('photoQualityRangeVal');
      if (valEl) valEl.textContent = pqEl.value + '%';
      state.settings.exportPhotoQuality = parseInt(pqEl.value, 10);
      saveSettings();
    });
  }

  // ── Export: video bitrate (format wired in initVideoFormatOptions) ────────
  document.querySelectorAll('input[name="exportVideoBitrate"]').forEach(r => {
    r.addEventListener('change', onVideoExportSettingChange);
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
  _applyQualitySelection(saved, popup, label);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    popup.classList.toggle('open');
  });

  popup.querySelectorAll('.pq-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const q = opt.dataset.q;
      const prefs = loadPrefs();
      prefs.previewQuality = q;
      savePrefs(prefs);
      _applyQualitySelection(q, popup, label);
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
  const savedTheme = prefs.theme || 'light';
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

  // ── Language ───────────────────────────────────────────────────────────────
  document.querySelectorAll('input[name="langChoice"]').forEach(r => {
    if (r.value === currentLang) r.checked = true;
    r.addEventListener('change', () => {
      if (r.value === currentLang) return;
      setLang(r.value);
      rerenderCards();
    });
  });

  // ── Accent color ───────────────────────────────────────────────────────────
  const accentPicker = document.getElementById('accentColorPicker');
  if (accentPicker) {
    // Restore saved accent (not when a theme override is active — themes set their own accent)
    const savedAccent = prefs.accentColor;
    if (savedAccent) {
      accentPicker.value = savedAccent;
      _applyAccentColor(savedAccent);
    }
    accentPicker.addEventListener('input', () => {
      _applyAccentColor(accentPicker.value);
      const p = loadPrefs(); p.accentColor = accentPicker.value; savePrefs(p);
    });
  }

}

// ─── Mobile Sidebar ───────────────────────────────────────────────────────────
function setupMobileSidebar() {
  const toggleBtn = document.getElementById('mobileSidebarToggle');
  const overlay   = document.getElementById('mobileSidebarOverlay');
  const sidebar   = document.querySelector('.sidebar');
  if (!toggleBtn || !overlay || !sidebar) return;

  function openSidebar() {
    sidebar.classList.add('mobile-open');
    overlay.classList.add('visible');
    toggleBtn.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeSidebar() {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('visible');
    toggleBtn.classList.remove('active');
    document.body.style.overflow = '';
  }
  function isMobile() { return window.innerWidth <= 768; }

  toggleBtn.addEventListener('click', () => {
    if (sidebar.classList.contains('mobile-open')) closeSidebar();
    else openSidebar();
  });

  // Close on backdrop click
  overlay.addEventListener('click', closeSidebar);

  // Swipe-down to close (touch)
  let touchStartY = 0;
  sidebar.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  sidebar.addEventListener('touchmove', e => {
    const delta = e.touches[0].clientY - touchStartY;
    if (delta > 60) closeSidebar();
  }, { passive: true });

  // Auto-close when resizing above mobile breakpoint
  window.addEventListener('resize', () => {
    if (!isMobile()) closeSidebar();
  });
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

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Apply theme & layout immediately (before paint) to avoid flash
;(function() {
  const p = loadPrefs();
  applyTheme(p.theme || 'light');
  applyLayout(p.layout || 'left');
  if (p.accentColor) _applyAccentColor(p.accentColor);
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

  applySettings();           // sync state.settings from restored DOM values
  setupDropZone();
  setupSettingsListeners();
  setupSidebarResize();
  setupModal();
  setupCustomizePanel();
  setupPreviewQuality();
  setupMobileSidebar();
  updateUI();

  document.getElementById('generateAllBtn').addEventListener('click', generateAll);
  document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);

  // Hide image section by default
  document.getElementById('imageSection').style.display = 'none';
});
