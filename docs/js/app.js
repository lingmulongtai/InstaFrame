/**
 * app.js — InstaFrame Web App
 * Batch photo frame generator with EXIF support
 */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  items: [],       // Array of ImageItem objects
  settings: {
    frameColor:       '#F0F0F0',
    thicknessScale:   1.0,
    fontFamily:       'Inter',
    shotOnFontScale:  1.0,
    exifFontScale:    1.0,
    lineGapScale:     1.0,
    textOffsetY:      0,
    cameraNameBold:   false,
    cameraNameItalic: false,
    exifItalic:       false,
    showShotOn:       true,
    showDecoLine:     true,
    showExifInfo:     true,
    cameraNameOnly:   false,
    outerPadding:     0,
    aspectRatio:      'original',
  },
};

// ImageItem extra fields for video:
//   isVideo:   boolean
//   videoBlob: Blob | null   (filled after generation)
//   progress:  number 0..1   (encoding progress)

let itemIdCounter = 0;

// ImageItem schema:
// {
//   id: number,
//   file: File,
//   exif: { make, model, lensModel, focalLength, fNumber, exposureTime, iso },
//   canvas: HTMLCanvasElement | null,
//   status: 'pending' | 'processing' | 'done' | 'error',
//   errorMsg: string | null,
// }

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
      };
    }
  } catch (_) {}
  return emptyExif();
}

async function readExif(file) {
  try {
    const raw = await exifr.parse(file, {
      pick: ['Make', 'Model', 'LensModel', 'FocalLength',
             'FNumber', 'ExposureTime', 'ISO', 'ISOSpeedRatings'],
    });
    if (!raw) return emptyExif();
    return {
      make:         cleanStr(raw.Make || ''),
      model:        cleanStr(raw.Model || ''),
      lensModel:    cleanStr(raw.LensModel || ''),
      focalLength:  raw.FocalLength ? String(Math.round(raw.FocalLength)) : '',
      fNumber:      raw.FNumber     ? formatFNumber(raw.FNumber) : '',
      exposureTime: raw.ExposureTime ? String(raw.ExposureTime) : '',
      iso:          raw.ISO || raw.ISOSpeedRatings || '',
    };
  } catch (e) {
    return emptyExif();
  }
}

function emptyExif() {
  return { make:'', model:'', lensModel:'', focalLength:'', fNumber:'', exposureTime:'', iso:'' };
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
  updateUI();
  scheduleLivePreview();
}

// ─── Frame Generation ─────────────────────────────────────────────────────────
async function generateItem(item) {
  item.status   = 'processing';
  item.progress = 0;
  updateItemStatus(item);

  try {
    if (item.isVideo) {
      item.videoBlob = await FrameEngine.renderVideoFrameWhenReady(
        item.file, item.exif, state.settings,
        {
          onProgress: p => {
            item.progress = p;
            updateItemStatus(item);
          },
        }
      );
    } else {
      const img  = await FrameEngine.loadImage(item.file);
      item.canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings);
    }
    item.status   = 'done';
    item.errorMsg = null;
  } catch (e) {
    item.status   = 'error';
    item.errorMsg = e.message;
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

  showToast(t('msgGenerating'), 'info');
  setGlobalBusy(true);

  for (const item of pending) {
    await generateItem(item);
  }

  setGlobalBusy(false);
  showToast(t('msgDone'), 'success');
}

async function regenerateItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item.status = 'pending';
  await generateItem(item);
}

// ─── Download ─────────────────────────────────────────────────────────────────
async function downloadSingle(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  if (item.isVideo && item.videoBlob) {
    const ext  = item.videoBlob.type.includes('webm') ? 'webm' : 'mp4';
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + ext;
    triggerDownload(item.videoBlob, name);
  } else if (item.canvas) {
    const blob = await FrameEngine.canvasToBlob(item.canvas);
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.jpg';
    triggerDownload(blob, name);
  }
}

async function downloadAll() {
  const done = state.items.filter(i => i.status === 'done' && i.canvas);
  if (!done.length) {
    showToast(t('msgNoImages'), 'warn');
    return;
  }

  showToast(t('msgDownloading'), 'info');
  setGlobalBusy(true);

  const zip = new JSZip();
  for (const item of done) {
    const blob = await FrameEngine.canvasToBlob(item.canvas);
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.jpg';
    zip.file(name, blob);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(zipBlob, 'instaframe_export.zip');
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
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) {}
}

function restoreSettings() {
  let saved;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (e) { return; }

  // Frame color
  if (saved.frameColor != null) {
    const standardColors = ['#ffffff', '#F0F0F0', '#1a1a1a'];
    if (standardColors.includes(saved.frameColor)) {
      const r = document.querySelector(`input[name="frameColor"][value="${saved.frameColor}"]`);
      if (r) r.checked = true;
    } else {
      const r = document.querySelector('input[name="frameColor"][value="custom"]');
      if (r) r.checked = true;
      const picker = document.getElementById('customColorPicker');
      if (picker) picker.value = saved.frameColor;
      const swatch = document.getElementById('customColorSwatch');
      if (swatch) swatch.style.background = saved.frameColor;
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
    ['cameraNameOnly',   saved.cameraNameOnly],
  ].forEach(([id, val]) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.checked = val;
  });

  // Aspect ratio
  if (saved.aspectRatio) {
    const r = document.querySelector(`input[name="aspectRatio"][value="${saved.aspectRatio}"]`);
    if (r) r.checked = true;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function applySettings() {
  // Frame color (support custom color picker)
  const colorRadio = document.querySelector('input[name="frameColor"]:checked');
  if (colorRadio && colorRadio.value === 'custom') {
    state.settings.frameColor = document.getElementById('customColorPicker').value;
  } else {
    state.settings.frameColor = colorRadio ? colorRadio.value : '#F0F0F0';
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
  state.settings.cameraNameOnly   = document.getElementById('cameraNameOnly').checked;
  state.settings.outerPadding     = parseInt(document.getElementById('outerPaddingRange').value, 10);

  const ratioRadio = document.querySelector('input[name="aspectRatio"]:checked');
  state.settings.aspectRatio = ratioRadio ? ratioRadio.value : 'original';

  // Mark all done items as pending (need re-render)
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

async function renderLivePreview() {
  const pane         = document.getElementById('livePreviewPane');
  const previewCanvas = document.getElementById('livePreviewCanvas');
  const emptyEl      = document.getElementById('previewEmpty');
  if (!pane || !previewCanvas) return;

  if (state.items.length === 0) {
    previewCanvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }

  const item = state.items[0];
  try {
    // For video items, capture a frame first
    const img = item.isVideo
      ? await FrameEngine.captureVideoFrame(item.file)
      : await FrameEngine.loadImage(item.file);
    // maxPreviewPx:1200 scales down huge originals so font-load + render is fast
    const canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings, { maxPreviewPx: 1200 });

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
    previewCanvas.getContext('2d').drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

    previewCanvas.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
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
  const filename  = document.getElementById('modalFilename');
  const dlBtn     = document.getElementById('modalDownload');
  const prevBtn   = document.getElementById('modalPrev');
  const nextBtn   = document.getElementById('modalNext');

  filename.textContent   = item.file.name;
  prevBtn.disabled       = _modalIndex === 0;
  nextBtn.disabled       = _modalIndex === state.items.length - 1;

  if (item.canvas) {
    // Show full-resolution framed canvas
    canvasEl.width  = item.canvas.width;
    canvasEl.height = item.canvas.height;
    canvasEl.getContext('2d').drawImage(item.canvas, 0, 0);
    canvasEl.style.display = 'block';
    imgEl.style.display    = 'none';
    dlBtn.disabled         = false;
  } else {
    // Show original image
    if (_lastModalObjUrl) URL.revokeObjectURL(_lastModalObjUrl);
    _lastModalObjUrl    = URL.createObjectURL(item.file);
    imgEl.src           = _lastModalObjUrl;
    imgEl.style.display = 'block';
    canvasEl.style.display = 'none';
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
        <button class="btn btn-sm btn-secondary" onclick="regenerateItem(${item.id})">
          <span data-i18n="regenerate">${t('regenerate')}</span>
        </button>
        <button class="btn btn-sm btn-primary" id="dl-btn-${item.id}" onclick="downloadSingle(${item.id})" disabled>
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
      </div>
      <button class="btn btn-primary btn-full" onclick="applyExifEdit(${item.id})">
        <span data-i18n="applyExif">${t('applyExif')}</span>
      </button>
    </div>
  `;

  // Click preview to open modal
  card.querySelector('.card-preview').addEventListener('click', () => openModal(item.id));

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
    if (dlBtn) dlBtn.disabled = true;
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

  const imageSection = document.getElementById('imageSection');
  if (imageSection) imageSection.style.display = hasItems ? '' : 'none';
}

function setGlobalBusy(busy) {
  document.getElementById('generateAllBtn').disabled = busy;
  document.getElementById('downloadAllBtn').disabled = busy;
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
  const zone   = document.getElementById('dropZone');
  const input  = document.getElementById('fileInput');

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
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

  // Frame color radios
  document.querySelectorAll('input[name="frameColor"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
  });

  // Custom color picker
  const picker      = document.getElementById('customColorPicker');
  const customSwatch = document.getElementById('customColorSwatch');
  const customRadio = document.querySelector('input[name="frameColor"][value="custom"]');
  if (picker) {
    picker.addEventListener('input', () => {
      if (customSwatch) customSwatch.style.background = picker.value;
      if (customRadio) customRadio.checked = true;
      applySettings();
    });
    picker.addEventListener('click', () => {
      if (customRadio) customRadio.checked = true;
    });
  }

  // Font family selector
  const fontFamilyEl = document.getElementById('fontFamily');
  if (fontFamilyEl) fontFamilyEl.addEventListener('change', applySettings);

  // Font style checkboxes (camera name + EXIF)
  ['cameraNameBold', 'cameraNameItalic', 'exifItalic', 'showShotOn', 'showDecoLine', 'showExifInfo', 'cameraNameOnly'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applySettings);
  });

  // Aspect ratio radios
  document.querySelectorAll('input[name="aspectRatio"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
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

// ─── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  restoreSettings();   // ← restore saved settings before wiring listeners
  applySettings();     // ← sync state.settings from restored DOM values
  setupDropZone();
  setupSettingsListeners();
  setupModal();
  updateUI();

  document.getElementById('generateAllBtn').addEventListener('click', generateAll);
  document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);
  document.getElementById('langToggleBtn').addEventListener('click', () => {
    toggleLang();
    // Re-render all item cards with new language
    const grid = document.getElementById('imageGrid');
    grid.innerHTML = '';
    const savedItems = [...state.items];
    state.items = [];
    itemIdCounter = 0;
    savedItems.forEach(item => {
      const newItem = { ...item, id: ++itemIdCounter };
      state.items.push(newItem);
      renderItem(newItem);
      if (newItem.status === 'done') {
        updateItemStatus(newItem);
        updateItemPreview(newItem);
      }
    });
    updateUI();
  });

  // Hide image section by default
  document.getElementById('imageSection').style.display = 'none';
});
