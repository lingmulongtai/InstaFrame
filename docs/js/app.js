/**
 * app.js — InstaFrame Web App
 * Batch photo frame generator with EXIF support
 */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  items: [],       // Array of ImageItem objects
  settings: {
    frameColor:      '#F0F0F0',
    thicknessScale:  1.0,
    shotOnFontScale: 1.0,
    exifFontScale:   1.0,
    textOffsetY:     0,
    showShotOn:      true,
    showDecoLine:    true,
    showExifInfo:    true,
    outerPadding:    0,
    aspectRatio:     'original',
  },
};

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

// ─── EXIF Reading ─────────────────────────────────────────────────────────────
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
  const imageFiles = Array.from(files).filter(f =>
    f.type.startsWith('image/') || f.name.match(/\.(jpe?g|png|heic|heif|webp)$/i)
  );
  if (!imageFiles.length) return;

  for (const file of imageFiles) {
    const exif = await readExif(file);
    const item = {
      id: ++itemIdCounter,
      file,
      exif,
      canvas: null,
      status: 'pending',
      errorMsg: null,
    };
    state.items.push(item);
    renderItem(item);
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
  item.status = 'processing';
  updateItemStatus(item);

  try {
    const img = await FrameEngine.loadImage(item.file);
    item.canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings);
    item.status = 'done';
    item.errorMsg = null;
  } catch (e) {
    item.status = 'error';
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
  if (!item || !item.canvas) return;

  const blob = await FrameEngine.canvasToBlob(item.canvas);
  const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.jpg';
  triggerDownload(blob, name);
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

// ─── Settings ─────────────────────────────────────────────────────────────────
function applySettings() {
  // Frame color (support custom color picker)
  const colorRadio = document.querySelector('input[name="frameColor"]:checked');
  if (colorRadio && colorRadio.value === 'custom') {
    state.settings.frameColor = document.getElementById('customColorPicker').value;
  } else {
    state.settings.frameColor = colorRadio ? colorRadio.value : '#F0F0F0';
  }

  state.settings.thicknessScale  = parseFloat(document.getElementById('thicknessRange').value);
  state.settings.shotOnFontScale = parseFloat(document.getElementById('shotOnFontRange').value);
  state.settings.exifFontScale   = parseFloat(document.getElementById('exifFontRange').value);
  state.settings.textOffsetY     = parseFloat(document.getElementById('textOffsetRange').value);
  state.settings.showShotOn      = document.getElementById('showShotOn').checked;
  state.settings.showDecoLine    = document.getElementById('showDecoLine').checked;
  state.settings.showExifInfo    = document.getElementById('showExifInfo').checked;
  state.settings.outerPadding    = parseInt(document.getElementById('outerPaddingRange').value, 10);

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
  const pane = document.getElementById('livePreviewPane');
  if (!pane) return;

  if (state.items.length === 0) {
    pane.style.display = 'none';
    return;
  }

  pane.style.display = '';

  const item = state.items[0];
  try {
    const img    = await FrameEngine.loadImage(item.file);
    const canvas = await FrameEngine.renderFrameWhenReady(img, item.exif, state.settings);

    const previewCanvas = document.getElementById('livePreviewCanvas');
    // Scale to fit preview pane (max 240px wide)
    const maxW  = 240;
    const scale = Math.min(maxW / canvas.width, 1);
    previewCanvas.width  = Math.round(canvas.width  * scale);
    previewCanvas.height = Math.round(canvas.height * scale);
    previewCanvas.getContext('2d').drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
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

  card.innerHTML = `
    <div class="card-preview" id="preview-${item.id}">
      <img class="thumb-orig" src="${URL.createObjectURL(item.file)}" alt="">
      <div class="card-status" id="status-badge-${item.id}">
        <span class="status-dot pending"></span>
        <span class="status-text" data-i18n="statusPending">${t('statusPending')}</span>
      </div>
    </div>
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

  dot.className  = `status-dot ${item.status}`;
  text.textContent = t(`status${capitalize(item.status)}`);
}

function updateItemPreview(item) {
  const previewDiv = document.getElementById(`preview-${item.id}`);
  const dlBtn      = document.getElementById(`dl-btn-${item.id}`);
  if (!previewDiv) return;

  if (item.status === 'done' && item.canvas) {
    // Replace original thumb with framed canvas preview
    let existing = previewDiv.querySelector('canvas.thumb-framed');
    if (!existing) {
      existing = document.createElement('canvas');
      existing.className = 'thumb-framed';
      previewDiv.insertBefore(existing, previewDiv.firstChild);
    }
    // Scale canvas to preview size
    const maxW = 400, maxH = 400;
    const scale = Math.min(maxW / item.canvas.width, maxH / item.canvas.height);
    existing.width  = Math.round(item.canvas.width  * scale);
    existing.height = Math.round(item.canvas.height * scale);
    existing.getContext('2d').drawImage(item.canvas, 0, 0, existing.width, existing.height);

    const origThumb = previewDiv.querySelector('img.thumb-orig');
    if (origThumb) origThumb.style.display = 'none';
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
  const hasItems   = state.items.length > 0;
  const hasDone    = state.items.some(i => i.status === 'done');
  const hasItems2  = state.items.length > 0;

  const genBtn  = document.getElementById('generateAllBtn');
  const dlBtn   = document.getElementById('downloadAllBtn');
  const counter = document.getElementById('imageCounter');

  if (genBtn)  genBtn.disabled  = !hasItems2;
  if (dlBtn)   dlBtn.disabled   = !hasDone;
  if (counter) counter.textContent = hasItems ? `(${state.items.length})` : '';

  const imageSection = document.getElementById('imageSection');
  if (imageSection) imageSection.style.display = hasItems ? '' : 'none';

  // Show/hide live preview pane
  const previewPane = document.getElementById('livePreviewPane');
  if (previewPane && state.items.length === 0) {
    previewPane.style.display = 'none';
  }
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

  // Visibility checkboxes
  ['showShotOn', 'showDecoLine', 'showExifInfo'].forEach(id => {
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
