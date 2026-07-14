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
    textColorMode:       'auto',    // 'auto' | 'light' | 'dark' | 'custom'
    textColor:           '#FFFFFF',
    showShotOn:          true,
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
    mapOverlayPosition:  'bottom-right',
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
let _pendingLoadedMediaFocus = false;
let _loadedMediaFocusRetryId = null;
let _loadedMediaFocusRetryCount = 0;
const LOADED_MEDIA_FOCUS_RETRY_LIMIT = 4;
const SETTINGS_HISTORY_LIMIT = 80;
const _settingsUndoStack = [];
const _settingsRedoStack = [];
let _historyLocked = false;
let _updateMobileEmptyOverlay = null; // set by setupMobileTabs, called from updateUI
const MAX_EDITABLE_RANGE_INPUT_LENGTH = 64;
const MAX_SOURCE_ITEMS = 50;
const MAX_SINGLE_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_IMAGE_PIXELS = 60_000_000;
const MAX_PREVIEW_CACHE_PIXELS = 32_000_000;
const MAX_FRAME_CACHE_PIXELS = 32_000_000;
const MAX_RETAINED_OUTPUT_BYTES = 384 * 1024 * 1024;
const MAX_ZIP_PEAK_BYTES = 512 * 1024 * 1024;
const MAX_LIVE_PREVIEW_PIXELS_DESKTOP = 24_000_000;
const MAX_LIVE_PREVIEW_PIXELS_MOBILE = 12_000_000;
const MAX_ACTIVE_PHOTO_THUMBNAILS = 2;
const MAX_ACTIVE_VIDEO_THUMBNAILS = 2;
const PHOTO_THUMBNAIL_GUARD_MS = 15_000;
const VIDEO_THUMBNAIL_GUARD_MS = 15_000;
const LIVE_VIDEO_PREVIEW_GUARD_MS = 15_000;
const METADATA_READ_GUARD_MS = 15_000;
const VENDOR_SCRIPT_GUARD_MS = 12_000;
const LOCATION_FETCH_GUARD_MS = 10_000;
const MAP_IMAGE_LOAD_GUARD_MS = 15_000;
const PREVIEW_IMAGE_DECODE_GUARD_MS = 20_000;
const _vendorScriptLoads = new Map();
const _locationFetchControllers = new Set();
let _importQueueTail = Promise.resolve();
let _importGeneration = 0;
let _reservedImportItems = 0;
let _reservedImportBytes = 0;
const _activeImportReservations = new Set();
let _pageResourcesReleased = false;
const _pageRestoreWaiters = new Set();
const APP_ASSET_VERSION = (() => {
  try {
    return new URL(document.currentScript?.src || '', document.baseURI).searchParams.get('v') || '';
  } catch (_) {
    return '';
  }
})();

function _versionedAssetUrl(src) {
  const url = new URL(src, document.baseURI);
  if (APP_ASSET_VERSION) url.searchParams.set('v', APP_ASSET_VERSION);
  return url.href;
}

function _getLivePreviewBackingScale(cssWidth, cssHeight) {
  const quality = InstaFrameCore.normalizePreviewQuality(loadPrefs().previewQuality);
  const requested = InstaFrameCore.getPreviewBackingScale(
    quality,
    window.devicePixelRatio,
    previewZoom
  );
  const pixelBudget = window.matchMedia('(max-width: 768px)').matches
    ? MAX_LIVE_PREVIEW_PIXELS_MOBILE
    : MAX_LIVE_PREVIEW_PIXELS_DESKTOP;
  return {
    quality,
    requested,
    scale: InstaFrameCore.getBudgetedPreviewBackingScale(
      requested,
      cssWidth,
      cssHeight,
      pixelBudget
    ),
    pixelBudget,
  };
}

function loadVendorScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  const assetUrl = _versionedAssetUrl(src);
  if (_vendorScriptLoads.has(assetUrl)) return _vendorScriptLoads.get(assetUrl);

  const pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = assetUrl;
    script.async = true;
    let settled = false;
    let timeoutId = null;
    const cleanup = () => {
      clearTimeout(timeoutId);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
    };
    const finish = (callback, value, removeScript = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (removeScript) script.remove();
      callback(value);
    };
    const loaded = () => {
      if (window[globalName]) finish(resolve, window[globalName]);
      else finish(reject, new Error(`Vendor script did not expose ${globalName}`), true);
    };
    const failed = () => finish(reject, new Error(`Could not load ${src}`), true);
    script.addEventListener('load', loaded);
    script.addEventListener('error', failed);
    timeoutId = setTimeout(() => {
      finish(reject, new Error(`Timed out loading ${src}`), true);
    }, VENDOR_SCRIPT_GUARD_MS);
    document.head.appendChild(script);
  }).catch(error => {
    _vendorScriptLoads.delete(assetUrl);
    throw error;
  });

  _vendorScriptLoads.set(assetUrl, pending);
  return pending;
}

function _waitForAbortablePromise(promise, signal, message = 'Operation cancelled') {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new DOMException(message, 'AbortError'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const succeed = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException(message, 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(succeed, fail);
  });
}

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
  _syncPreviewControlAvailability();
}

function _syncPreviewControlAvailability() {
  const zone = document.getElementById('dropZone');
  if (!zone) return;
  const hasPreview = zone.classList.contains('has-preview');
  const hasVideo = hasPreview && zone.classList.contains('has-video');
  const viewModified = hasPreview && zone.classList.contains('view-modified');
  const mobileExifOpen = window.matchMedia('(max-width: 768px)').matches
    && document.getElementById('previewExifWrap')?.classList.contains('exif-open');
  const availability = [
    ['previewHistoryWrap', hasPreview],
    ['previewQualityWrap', hasPreview && !hasVideo],
    ['previewExifWrap', hasPreview],
    ['previewZoomBar', hasPreview && !mobileExifOpen],
    ['previewResetViewBtn', viewModified],
    ['previewVideoBar', hasVideo],
  ];
  const active = document.activeElement;
  let moveFocus = false;
  for (const [id, available] of availability) {
    const element = document.getElementById(id);
    if (!element) continue;
    if (!available && (element === active || element.contains(active))) moveFocus = true;
    element.inert = !available;
    element.setAttribute('aria-hidden', String(!available));
  }
  if (!moveFocus) return;
  const fallback = hasVideo
    ? document.getElementById('videoPlayPauseBtn')
    : hasPreview
      ? document.getElementById('previewQualityBtn')
      : document.querySelector('.image-card.selected-preview .card-preview, .image-card .card-preview')
        || _getEmptyImportFocusTarget();
  fallback?.focus();
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undoEditBtn');
  const redoBtn = document.getElementById('redoEditBtn');
  const active = document.activeElement;
  if (undoBtn) undoBtn.disabled = _settingsUndoStack.length === 0;
  if (redoBtn) redoBtn.disabled = _settingsRedoStack.length === 0;
  if (active === undoBtn && undoBtn.disabled && redoBtn && !redoBtn.disabled) redoBtn.focus();
  if (active === redoBtn && redoBtn.disabled && undoBtn && !undoBtn.disabled) undoBtn.focus();
}

// ─── Preview caches ───────────────────────────────────────────────────────────
const _imgCache      = new Map(); // item.id → { img: HTMLImageElement, objUrl: string }
const _imgLoadEntries = new Map(); // item.id → { promise, controller }
const _transientPreviewImages = new Map(); // one-shot decoded images too large for the LRU
const _frameCache    = new Map(); // "${item.id}|${hash}" → HTMLCanvasElement
const _mapImgCache   = new Map(); // "lat,lon,zoom" → HTMLImageElement (Mapbox static tiles)
const _mapImgLoadCancels = new Set(); // cancellation callbacks for active Mapbox images
const _imgFailed     = new Set(); // item IDs that failed image load — skip retry
const _downloadUrlTimers = new Map(); // active download Blob URL → delayed cleanup timer
let   _renderSeq     = 0;         // increments on each render to cancel stale ones
let   _previewRenderController = null;
let   _activeExportController = null;
let   _globalExportBusy = false;
let   _activePhotoThumbnails = 0;
const _photoThumbnailQueue = [];
let   _activeVideoThumbnails = 0;
const _videoThumbnailQueue = [];
let   _exportProgressPreviousFocus = null;
let   _lastProgressAnnouncement = -1;

// ─── Video canvas preview loop ────────────────────────────────────────────────
let _videoPreviewFrameHandle = null;
let _videoPreviewFrameMode = null; // 'video', 'animation', or 'timeout'
let _videoPreviewFrameGeneration = 0;
let _videoPreviewItemId = null;   // ID of item currently being rendered in the loop
let _videoPreviewBaseCanvas = null;

// ─── Location privacy consent ─────────────────────────────────────────────────
let _sessionLocationNetworkConsent = false;
let _locationConsentResolver = null;
let _locationPrivacyPreviousFocus = null;
let _liveDeviceLocationRequestId = 0;
let _liveDeviceLocationItemId = null;
let _liveDeviceLocationTargetId = null;
let _liveDeviceLocationController = null;
let _resolveLiveLocationOperation = null;
let _destructiveConfirmResolver = null;
let _destructiveConfirmPreviousFocus = null;

function _syncModalBackgroundInert() {
  const modalOpen = !!document.querySelector('.map-modal.open');
  const appShell = document.querySelector('.app-shell');
  const mobileTabBar = document.getElementById('mobileTabBar');
  if (appShell) appShell.inert = modalOpen;
  if (mobileTabBar) mobileTabBar.inert = modalOpen;
}

function _setModalOpen(modal, open) {
  if (!modal) return;
  modal.classList.toggle('open', open);
  _syncModalBackgroundInert();
}

function _restoreModalTriggerFocus(target) {
  if (!target?.isConnected || typeof target.focus !== 'function') return;
  const restore = () => {
    if (!target.isConnected || document.querySelector('.map-modal.open')) return;
    let fallbackTab = null;
    const panel = target.closest?.('.mobile-tab-panel');
    if (window.innerWidth <= 768 && panel && (panel.hidden || panel.inert)) {
      const tabBar = document.getElementById('mobileTabBar');
      fallbackTab = [...(tabBar?.querySelectorAll('.tab-btn') || [])]
        .find(button => button.getAttribute('aria-controls') === panel.id) || null;
      if (fallbackTab?.dataset.tab) _setMobileTabState(tabBar, fallbackTab.dataset.tab);
    }
    target.focus();
    if (document.activeElement !== target && fallbackTab?.getClientRects().length) fallbackTab.focus();
  };
  restore();
  if (document.activeElement !== target) requestAnimationFrame(restore);
}

function _openLocationPrivacyModal() {
  _locationPrivacyPreviousFocus = document.activeElement;
  _setModalOpen(document.getElementById('locationPrivacyModal'), true);
  document.getElementById('locationPrivacyOnceBtn')?.focus();
}

function _closeLocationPrivacyModal() {
  _setModalOpen(document.getElementById('locationPrivacyModal'), false);
  const previousFocus = _locationPrivacyPreviousFocus;
  _locationPrivacyPreviousFocus = null;
  _restoreModalTriggerFocus(previousFocus);
}

function setupModalAccessibility() {
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const modal = [...document.querySelectorAll('.map-modal.open')].at(-1);
    if (!modal) return;
    const focusable = [...modal.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => (
      element.getClientRects().length > 0 && !element.inert && !element.closest('[inert]')
    ));
    if (!focusable.length) {
      event.preventDefault();
      modal.tabIndex = -1;
      modal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function _finishDestructiveConfirmation(confirmed) {
  const modal = document.getElementById('destructiveConfirmModal');
  _setModalOpen(modal, false);
  const resolve = _destructiveConfirmResolver;
  const previousFocus = _destructiveConfirmPreviousFocus;
  _destructiveConfirmResolver = null;
  _destructiveConfirmPreviousFocus = null;
  if (!confirmed) _restoreModalTriggerFocus(previousFocus);
  if (resolve) resolve(confirmed);
}

function requestDestructiveConfirmation({ clearAll = false, filename = '' } = {}) {
  const modal = document.getElementById('destructiveConfirmModal');
  if (!modal || _destructiveConfirmResolver) return Promise.resolve(false);
  const title = document.getElementById('destructiveConfirmTitle');
  const message = document.getElementById('destructiveConfirmMessage');
  const accept = document.getElementById('destructiveConfirmAcceptBtn');
  if (title) title.textContent = t(clearAll ? 'clearConfirmTitle' : 'deleteConfirmTitle');
  if (message) {
    message.textContent = clearAll
      ? t('confirmClearAll')
      : tf('confirmDeleteItemNamed', { name: filename || t('imagesTitle') });
  }
  if (accept) accept.textContent = t(clearAll ? 'clearConfirmAction' : 'deleteConfirmAction');
  _destructiveConfirmPreviousFocus = document.activeElement;
  _setModalOpen(modal, true);
  document.getElementById('destructiveConfirmCancelBtn')?.focus();
  return new Promise(resolve => { _destructiveConfirmResolver = resolve; });
}

function setupDestructiveConfirmation() {
  const modal = document.getElementById('destructiveConfirmModal');
  document.getElementById('destructiveConfirmCancelBtn')?.addEventListener('click', () => _finishDestructiveConfirmation(false));
  document.getElementById('destructiveConfirmAcceptBtn')?.addEventListener('click', () => _finishDestructiveConfirmation(true));
  modal?.addEventListener('click', event => {
    if (event.target === modal) _finishDestructiveConfirmation(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal?.classList.contains('open')) {
      event.preventDefault();
      _finishDestructiveConfirmation(false);
    }
  });
}

function setupMapModalActions() {
  document.getElementById('getDeviceLocationBtn')?.addEventListener('click', getLiveDeviceLocation);
  document.getElementById('openMapPickerBtn')?.addEventListener('click', openMapPicker);
  document.getElementById('mapPickerCloseBtn')?.addEventListener('click', closeMapPicker);
  document.getElementById('confirmMapLocationBtn')?.addEventListener('click', confirmMapLocation);
  document.getElementById('selectMapCenterBtn')?.addEventListener('click', () => {
    if (_mapPickerMap) _selectMapCoordinates(_mapPickerMap.getCenter());
  });
  document.getElementById('mapPickerModal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeMapPicker();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('mapPickerModal')?.classList.contains('open')) {
      event.preventDefault();
      closeMapPicker();
    }
  });
}

function setupAccessibleFormNames() {
  document.querySelectorAll('input, select, textarea').forEach(control => {
    const generatedName = control.dataset.generatedAccessibleName === 'true';
    if (control.getAttribute('aria-labelledby') || (control.getAttribute('aria-label') && !generatedName)) return;
    const wrappingLabel = control.closest('label');
    if (wrappingLabel) {
      const wrappingText = wrappingLabel.textContent?.trim();
      if (wrappingText) return;
      if (wrappingLabel.title) {
        control.setAttribute('aria-label', wrappingLabel.title);
        control.dataset.generatedAccessibleName = 'true';
        return;
      }
    }
    if (control.id && document.querySelector(`label[for="${control.id}"]`)) return;
    const scope = control.closest('.setting-row, .customize-row, .preview-exif-grid, .video-volume-wrap, .preview-video-bar');
    const visibleLabel = scope?.querySelector('.setting-label, .customize-row-label, label[data-i18n]');
    const text = visibleLabel?.textContent?.trim();
    control.setAttribute('aria-label', text || control.title || control.id || t('appTitleMain'));
    control.dataset.generatedAccessibleName = 'true';
  });
}

function _cancelLocationNetworkRequests() {
  for (const controller of _locationFetchControllers) controller.abort();
  _locationFetchControllers.clear();
  _cancelLocationOperations();
}

async function _fetchLocationJson(url, options = {}, controller = new AbortController()) {
  if (!hasLocationNetworkConsent() || controller.signal.aborted) return null;
  _locationFetchControllers.add(controller);
  const timeoutId = setTimeout(() => controller.abort(), LOCATION_FETCH_GUARD_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok || controller.signal.aborted || !hasLocationNetworkConsent()) return null;
    const data = await response.json();
    if (controller.signal.aborted || !hasLocationNetworkConsent()) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    _locationFetchControllers.delete(controller);
  }
}

function hasLocationNetworkConsent() {
  return _sessionLocationNetworkConsent || loadPrefs().locationNetworkConsent === 'always';
}

function updateLocationPrivacyStatus() {
  const status = document.getElementById('locationPrivacyStatus');
  if (!status) return;
  const always = loadPrefs().locationNetworkConsent === 'always';
  status.textContent = t(always ? 'privacyAccessAlways' : (_sessionLocationNetworkConsent ? 'privacyAccessSession' : 'privacyAccessOff'));
  const usageStatus = document.getElementById('mapboxUsageStatus');
  const config = window.INSTAFRAME_CONFIG?.mapbox;
  if (usageStatus && config) {
    const usage = _getMapboxUsage();
    usageStatus.textContent = tf('mapboxUsageStatus', {
      day: usage.dayCount,
      dayLimit: config.dailyRequestLimitPerDevice,
      month: usage.monthCount,
      monthLimit: config.monthlyRequestLimitPerDevice,
    });
  }
  const tokenStatus = document.getElementById('mapboxTokenStatus');
  if (tokenStatus) {
    tokenStatus.textContent = t(_isValidMapboxPublicToken(loadPrefs().mapboxPublicToken)
      ? 'mapboxTokenConfigured'
      : 'mapboxTokenNotConfigured');
  }
}

function _finishLocationConsent(allowed, persist = false) {
  _sessionLocationNetworkConsent = !!allowed;
  const prefs = loadPrefs();
  if (allowed && persist) prefs.locationNetworkConsent = 'always';
  else if (!allowed) {
    delete prefs.locationNetworkConsent;
    const mapToggle = document.getElementById('showMapOverlay');
    if (mapToggle) mapToggle.checked = false;
    state.settings.showMapOverlay = false;
    _cancelLocationNetworkRequests();
    _releaseMapPickerResources();
    _cancelMapImageLoads();
    _clearMapImageCache();
    saveSettings();
    scheduleLivePreview();
  }
  savePrefs(prefs);
  _closeLocationPrivacyModal();
  updateLocationPrivacyStatus();
  if (_locationConsentResolver) {
    const resolve = _locationConsentResolver;
    _locationConsentResolver = null;
    resolve(!!allowed);
  }
}

function _cancelLocationConsent() {
  _closeLocationPrivacyModal();
  if (_locationConsentResolver) {
    const resolve = _locationConsentResolver;
    _locationConsentResolver = null;
    resolve(false);
  }
}

function requestLocationNetworkConsent() {
  if (hasLocationNetworkConsent()) return Promise.resolve(true);
  const modal = document.getElementById('locationPrivacyModal');
  if (!modal) return Promise.resolve(false);
  _openLocationPrivacyModal();
  return new Promise(resolve => { _locationConsentResolver = resolve; });
}

function openLocationPrivacyManager() {
  _openLocationPrivacyModal();
  updateLocationPrivacyStatus();
}

function setupLocationPrivacy() {
  document.getElementById('manageLocationPrivacyBtn')?.addEventListener('click', openLocationPrivacyManager);
  document.getElementById('locationPrivacyOnceBtn')?.addEventListener('click', () => _finishLocationConsent(true, false));
  document.getElementById('locationPrivacyAlwaysBtn')?.addEventListener('click', () => _finishLocationConsent(true, true));
  document.getElementById('locationPrivacyRevokeBtn')?.addEventListener('click', () => _finishLocationConsent(false));
  document.getElementById('locationPrivacyCancelBtn')?.addEventListener('click', _cancelLocationConsent);
  document.getElementById('locationPrivacyCloseBtn')?.addEventListener('click', _cancelLocationConsent);
  const modal = document.getElementById('locationPrivacyModal');
  modal?.addEventListener('click', event => {
    if (event.target === modal) _cancelLocationConsent();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal?.classList.contains('open')) _cancelLocationConsent();
  });
  document.addEventListener('instaframe:languagechange', updateLocationPrivacyStatus);

  const tokenInput = document.getElementById('mapboxTokenInput');
  if (tokenInput) tokenInput.value = loadPrefs().mapboxPublicToken || '';
  tokenInput?.addEventListener('change', () => {
    const value = tokenInput.value.trim();
    if (value && !_isValidMapboxPublicToken(value)) {
      showToast(t('msgMapboxTokenInvalid'), 'warn');
      tokenInput.value = loadPrefs().mapboxPublicToken || '';
      return;
    }
    const prefs = loadPrefs();
    if (value) prefs.mapboxPublicToken = value;
    else {
      delete prefs.mapboxPublicToken;
      const mapToggle = document.getElementById('showMapOverlay');
      if (mapToggle) mapToggle.checked = false;
      state.settings.showMapOverlay = false;
      saveSettings();
      scheduleLivePreview();
    }
    savePrefs(prefs);
    _mapboxUnavailableNotified = false;
    _cancelMapImageLoads();
    _clearMapImageCache();
    updateLocationPrivacyStatus();
    showToast(t(value ? 'msgMapboxTokenSaved' : 'msgMapboxTokenCleared'), 'success');
  });
  document.getElementById('clearMapboxTokenBtn')?.addEventListener('click', () => {
    if (tokenInput) {
      tokenInput.value = '';
      tokenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  updateLocationPrivacyStatus();
}

// ─── Mapbox token & client-side usage guard ───────────────────────────────────
const MAPBOX_USAGE_KEY = 'instaframe_mb_usage_v2';
let _mapboxUnavailableNotified = false;

function _isValidMapboxPublicToken(token) {
  return /^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(token || '').trim());
}

function _getMapboxUsage() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  try {
    const saved = JSON.parse(localStorage.getItem(MAPBOX_USAGE_KEY) || '{}');
    return {
      day,
      month,
      dayCount: saved.day === day ? Number(saved.dayCount) || 0 : 0,
      monthCount: saved.month === month ? Number(saved.monthCount) || 0 : 0,
    };
  } catch {
    return { day, month, dayCount: 0, monthCount: 0 };
  }
}

function _trackMapboxRequest() {
  try {
    const usage = _getMapboxUsage();
    usage.dayCount += 1;
    usage.monthCount += 1;
    localStorage.setItem(MAPBOX_USAGE_KEY, JSON.stringify(usage));
    updateLocationPrivacyStatus();
  } catch {}
}

function getMapboxToken() {
  if (!hasLocationNetworkConsent()) return null;
  const config = window.INSTAFRAME_CONFIG?.mapbox;
  const userToken = loadPrefs().mapboxPublicToken;
  const hasUserToken = _isValidMapboxPublicToken(userToken);
  const siteToken = config?.publicToken;
  if (!hasUserToken && !_isValidMapboxPublicToken(siteToken)) return null;
  if (!hasUserToken) {
    const origin = window.location.protocol === 'file:' ? 'file://' : window.location.origin;
    if (!InstaFrameCore.isAllowedOrigin(origin, config.allowedOrigins)) return null;
  }
  const usage = _getMapboxUsage();
  if (usage.dayCount >= config.dailyRequestLimitPerDevice || usage.monthCount >= config.monthlyRequestLimitPerDevice) return null;
  return hasUserToken ? userToken.trim() : siteToken;
}

function _cancelMapImageLoads() {
  for (const cancel of [..._mapImgLoadCancels]) cancel();
  _mapImgLoadCancels.clear();
}

function _releaseMapImageSource(img) {
  if (!img) return;
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');
}

function _deleteMapImageCacheEntry(key) {
  const img = _mapImgCache.get(key);
  _releaseMapImageSource(img);
  _mapImgCache.delete(key);
}

function _clearMapImageCache() {
  for (const img of _mapImgCache.values()) _releaseMapImageSource(img);
  _mapImgCache.clear();
}

/** Fetch a Mapbox static map image and return it as a loaded HTMLImageElement, with caching. */
async function _fetchMapOverlayImage(lat, lon, zoom = 13, signal = null) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${zoom}`;
  if (_mapImgCache.has(key)) return _mapImgCache.get(key);
  const token = getMapboxToken();
  if (!token) {
    if (!_mapboxUnavailableNotified && hasLocationNetworkConsent()) {
      _mapboxUnavailableNotified = true;
      showToast(t('msgMapboxUnavailable'), 'warn');
    }
    return null;
  }
  const url = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/${lon.toFixed(5)},${lat.toFixed(5)},${zoom}/400x280@2x?access_token=${token}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    let timeoutId = null;
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abort);
      _mapImgLoadCancels.delete(abort);
      img.onload = null;
      img.onerror = null;
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      img.removeAttribute('src');
      cleanup();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    _mapImgLoadCancels.add(abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timeoutId = setTimeout(() => {
      img.removeAttribute('src');
      finish(null);
    }, MAP_IMAGE_LOAD_GUARD_MS);
    img.crossOrigin = 'anonymous';
    img.onload  = () => {
      const cached = _mapImgCache.get(key);
      if (cached) {
        _releaseMapImageSource(img);
        finish(cached);
        return;
      }
      if (_mapImgCache.size >= 12) _deleteMapImageCacheEntry(_mapImgCache.keys().next().value);
      _mapImgCache.set(key, img);
      finish(img);
    };
    img.onerror = () => {
      img.removeAttribute('src');
      finish(null);
    };
    try {
      img.src = url;
      // Count started requests, including failures and timeouts. A success-only
      // counter would let repeated billable failures bypass the local guard.
      _trackMapboxRequest();
    }
    catch {
      img.removeAttribute('src');
      finish(null);
    }
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
//   errorKey: string | null,
//   errorValues: object | null,
// }

function _setLocalizedItemError(item, key, values = {}) {
  item.errorKey = key;
  item.errorValues = { ...values };
  item.errorMsg = tf(key, values);
  return item.errorMsg;
}

function _setRawItemError(item, message) {
  item.errorKey = null;
  item.errorValues = null;
  item.errorMsg = message || '';
  return item.errorMsg;
}

function _clearItemError(item) {
  item.errorKey = null;
  item.errorValues = null;
  item.errorMsg = null;
}

function _getItemErrorMessage(item) {
  return item?.errorKey ? tf(item.errorKey, item.errorValues || {}) : (item?.errorMsg || '');
}

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
    g1.label = t('fontGroupPopular');
    popular.forEach(f => g1.appendChild(makeOpt(f)));
    sel.appendChild(g1);
  }
  if (rest.length) {
    const g2 = document.createElement('optgroup');
    g2.label = t('fontGroupMore');
    rest.forEach(f => g2.appendChild(makeOpt(f)));
    sel.appendChild(g2);
  }
}

// ─── EXIF / Metadata Reading ──────────────────────────────────────────────────
function _withMetadataReadGuard(promise) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Metadata read timed out')), METADATA_READ_GUARD_MS);
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => clearTimeout(timeoutId));
}

function isVideoFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  if (type.startsWith('image/')) return false;
  return /\.(mp4|mov|webm|avi|mkv|m4v|3gp)$/i.test(String(file?.name || ''));
}

async function readVideoMetadata(file) {
  // exifr can read some QuickTime/XMP metadata from MP4/MOV
  try {
    const exifrApi = await loadVendorScript('vendor/exifr.js', 'exifr');
    const raw = await _withMetadataReadGuard(exifrApi.parse(file, {
      pick: ['Make', 'Model', 'Software', 'Author'],
    }));
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
    const exifrApi = await loadVendorScript('vendor/exifr.js', 'exifr');
    const raw = await _withMetadataReadGuard(exifrApi.parse(file, {
      pick: ['Make', 'Model', 'LensModel', 'FocalLength',
             'FNumber', 'ExposureTime', 'ISO', 'ISOSpeedRatings',
             'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'],
    }));
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
        // Keep GPS extraction fully local. Place-name lookup is opt-in from the
        // EXIF editor and never starts automatically when a file is imported.
        location = InstaFrameCore.formatCoordinateLabel(lat, lon);
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

function _drainPhotoThumbnailQueue() {
  while (_activePhotoThumbnails < MAX_ACTIVE_PHOTO_THUMBNAILS && _photoThumbnailQueue.length) {
    const entry = _photoThumbnailQueue.shift();
    if (entry.item.photoThumbnailController?.signal.aborted) {
      entry.reject(new DOMException('Thumbnail cancelled', 'AbortError'));
      continue;
    }
    _activePhotoThumbnails += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        _activePhotoThumbnails -= 1;
        _drainPhotoThumbnailQueue();
      });
  }
}

function _queuePhotoThumbnail(item, task) {
  return new Promise((resolve, reject) => {
    _photoThumbnailQueue.push({ item, task, resolve, reject });
    _drainPhotoThumbnailQueue();
  });
}

function _cancelQueuedPhotoThumbnail(item) {
  for (let index = _photoThumbnailQueue.length - 1; index >= 0; index -= 1) {
    const entry = _photoThumbnailQueue[index];
    if (entry.item !== item) continue;
    _photoThumbnailQueue.splice(index, 1);
    entry.reject(new DOMException('Thumbnail cancelled', 'AbortError'));
  }
}

function _cancelPhotoThumbnail(item) {
  if (!item) return;
  item.photoThumbnailController?.abort();
  _cancelQueuedPhotoThumbnail(item);
  item.photoThumbnailController = null;
}

function _drainVideoThumbnailQueue() {
  while (_activeVideoThumbnails < MAX_ACTIVE_VIDEO_THUMBNAILS && _videoThumbnailQueue.length) {
    const entry = _videoThumbnailQueue.shift();
    if (entry.item.thumbnailController?.signal.aborted) {
      entry.reject(new DOMException('Thumbnail cancelled', 'AbortError'));
      continue;
    }
    _activeVideoThumbnails += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        _activeVideoThumbnails -= 1;
        _drainVideoThumbnailQueue();
      });
  }
}

function _queueVideoThumbnail(item, task) {
  return new Promise((resolve, reject) => {
    _videoThumbnailQueue.push({ item, task, resolve, reject });
    _drainVideoThumbnailQueue();
  });
}

function _cancelQueuedVideoThumbnail(item) {
  for (let index = _videoThumbnailQueue.length - 1; index >= 0; index -= 1) {
    const entry = _videoThumbnailQueue[index];
    if (entry.item !== item) continue;
    _videoThumbnailQueue.splice(index, 1);
    entry.reject(new DOMException('Thumbnail cancelled', 'AbortError'));
  }
}

function _startVideoThumbnail(item) {
  if (!item?.isVideo || !state.items.includes(item) || item.thumbnailPromise) return item?.thumbnailPromise || null;
  const previewDiv = document.getElementById(`preview-${item.id}`);
  if (previewDiv?.querySelector('canvas.thumb-framed')) {
    item.thumbnailNeedsRestart = false;
    return null;
  }

  const thumbnailController = new AbortController();
  const thumbnailSignal = thumbnailController.signal;
  item.thumbnailController = thumbnailController;
  item.thumbnailNeedsRestart = false;
  let thumbnailGuard = null;

  const thumbnailPromise = _queueVideoThumbnail(item, async () => {
    // Queue wait time is not decoder time. Start the guard only after this item
    // receives one of the bounded active-thumbnail slots.
    thumbnailGuard = setTimeout(() => {
      if (!state.items.includes(item) || item.thumbnailController !== thumbnailController) return;
      item.status = 'error';
      _setLocalizedItemError(item, 'msgUnsupportedMedia', { name: item.file.name });
      updateItemStatus(item);
      showToast(item.errorMsg, 'error');
      thumbnailController.abort();
    }, VIDEO_THUMBNAIL_GUARD_MS);
    let img = null;
    let framed = null;
    let thumbnailCanvas = null;
    let thumbnailCommitted = false;
    try {
      img = await FrameEngine.captureVideoFrame(item.file, 0, { signal: thumbnailSignal });
      let thumbnailSource = img;
      try {
        // Render a framed preview at thumbnail resolution
        framed = await FrameEngine.renderFrameWhenReady(
          img, item.exif, state.settings, { maxPreviewPx: 400, signal: thumbnailSignal });
        thumbnailSource = framed;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // The video decoded successfully; only framing failed. Draw the
        // already-decoded image instead of starting the same decode again.
      }
      const currentPreview = document.getElementById(`preview-${item.id}`);
      if (!currentPreview) return;
      const sourceW = thumbnailSource.naturalWidth || thumbnailSource.width;
      const sourceH = thumbnailSource.naturalHeight || thumbnailSource.height;
      if (!(sourceW > 0 && sourceH > 0)) throw new Error('Video thumbnail has no decoded dimensions');
      const maxW = 200, maxH = 200;
      const scale = Math.min(maxW / sourceW, maxH / sourceH);
      thumbnailCanvas = currentPreview.querySelector('canvas.thumb-framed');
      if (!thumbnailCanvas) {
        thumbnailCanvas = document.createElement('canvas');
        thumbnailCanvas.className = 'thumb-framed';
        currentPreview.insertBefore(thumbnailCanvas, currentPreview.firstChild);
      }
      thumbnailCanvas.width = Math.round(sourceW * scale);
      thumbnailCanvas.height = Math.round(sourceH * scale);
      thumbnailCanvas.getContext('2d').drawImage(
        thumbnailSource, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
      thumbnailCommitted = true;
      const origThumb = currentPreview.querySelector('img.thumb-orig');
      if (origThumb) origThumb.style.display = 'none';
    } finally {
      if (!thumbnailCommitted && thumbnailCanvas) {
        thumbnailCanvas.width = 0;
        thumbnailCanvas.height = 0;
        thumbnailCanvas.remove();
      }
      if (framed) { framed.width = 0; framed.height = 0; }
      img?.removeAttribute('src');
    }
  })
    .catch(error => {
      if (error?.name === 'AbortError') return;
      if (item.status === 'error' && item.errorMsg) return;
      item.status = 'error';
      _setLocalizedItemError(item, 'msgUnsupportedMedia', { name: item.file.name });
      updateItemStatus(item);
      showToast(item.errorMsg, 'error');
    })
    .finally(() => {
      clearTimeout(thumbnailGuard);
      if (item.thumbnailController === thumbnailController) item.thumbnailController = null;
      if (item.thumbnailPromise === thumbnailPromise) item.thumbnailPromise = null;
    });
  item.thumbnailPromise = thumbnailPromise;
  return thumbnailPromise;
}

function _restartInterruptedVideoThumbnail(item) {
  if (!item?.thumbnailNeedsRestart || !state.items.includes(item)) return;
  const restart = () => {
    if (!item.thumbnailNeedsRestart || !state.items.includes(item)) return;
    const previewDiv = document.getElementById(`preview-${item.id}`);
    item.thumbnailNeedsRestart = false;
    if (!previewDiv?.querySelector('canvas.thumb-framed')) _startVideoThumbnail(item);
  };
  if (item.thumbnailPromise) void item.thumbnailPromise.then(restart, restart);
  else restart();
}

function gpsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [d, m, s] = dms;
  const decimal = d + m / 60 + s / 3600;
  return (ref === 'S' || ref === 'W') ? -decimal : decimal;
}

const _geocodeCache = {};
async function reverseGeocode(lat, lon, { signal = null } = {}) {
  if (!hasLocationNetworkConsent() || signal?.aborted) return null;
  const language = currentLang === 'ja' ? 'ja' : 'en';
  const key = `${language}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (_geocodeCache[key]) return _geocodeCache[key];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let data = null;
  try {
    data = await _fetchLocationJson(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'Accept-Language': language } },
      controller
    );
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (!data) return null;
  const a = data.address || {};
  const city    = a.city || a.town || a.village || a.county || '';
  const country = a.country || '';
  const name    = [city, country].filter(Boolean).join(', ');
  if (name) _geocodeCache[key] = name;
  return name || null;
}

function cleanStr(s) {
  return s.replace(/\0/g, '').trim();
}

function formatFNumber(v) {
  if (typeof v === 'number') return v % 1 === 0 ? String(v) : v.toFixed(1);
  return String(v);
}

// ─── Item Management ──────────────────────────────────────────────────────────
function _isSupportedImportCandidate(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '');
  return type.startsWith('image/') || type.startsWith('video/') ||
    /\.(jpe?g|png|heic|heif|webp|mp4|mov|webm|avi|mkv|m4v|3gp)$/i.test(name);
}

function _showImportRejections({ unsupportedCount = 0, rejectedCount = 0 } = {}) {
  if (!unsupportedCount && !rejectedCount) return;
  const messages = [];
  if (unsupportedCount) messages.push(tf('msgMediaTypeUnsupported', { count: unsupportedCount }));
  if (rejectedCount) messages.push(tf('msgMediaInputLimit', { count: rejectedCount }));
  showToast(messages.join(' '), 'error');
}

function _reserveImportFiles(files) {
  const submitted = Array.from(files || []);
  const candidates = submitted.filter(_isSupportedImportCandidate);
  const accepted = [];
  let rejectedCount = 0;
  let reservedBytes = 0;
  const stateBytes = state.items.reduce((sum, item) => sum + (item.file?.size || 0), 0);
  for (const file of candidates) {
    const size = file.size || 0;
    if (
      state.items.length + _reservedImportItems + accepted.length >= MAX_SOURCE_ITEMS ||
      size > MAX_SINGLE_SOURCE_BYTES ||
      stateBytes + _reservedImportBytes + reservedBytes + size > MAX_TOTAL_SOURCE_BYTES
    ) {
      rejectedCount += 1;
      continue;
    }
    accepted.push(file);
    reservedBytes += size;
  }
  _reservedImportItems += accepted.length;
  _reservedImportBytes += reservedBytes;
  const reservation = {
    files: accepted,
    unsupportedCount: submitted.length - candidates.length,
    rejectedCount,
    generation: _importGeneration,
    remainingItems: accepted.length,
    remainingBytes: reservedBytes,
    released: false,
  };
  if (accepted.length) _activeImportReservations.add(reservation);
  return reservation;
}

function _consumeImportReservation(reservation, file) {
  if (reservation.released) return;
  const size = file.size || 0;
  reservation.remainingItems -= 1;
  reservation.remainingBytes -= size;
  _reservedImportItems -= 1;
  _reservedImportBytes -= size;
}

function _releaseImportReservation(reservation) {
  if (reservation.released) return;
  _reservedImportItems -= reservation.remainingItems;
  _reservedImportBytes -= reservation.remainingBytes;
  reservation.remainingItems = 0;
  reservation.remainingBytes = 0;
  reservation.files.length = 0;
  reservation.released = true;
  _activeImportReservations.delete(reservation);
}

function _cancelPendingImports() {
  _importGeneration += 1;
  for (const reservation of [..._activeImportReservations]) {
    _releaseImportReservation(reservation);
  }
}

async function _waitForPageResourcesRestore() {
  while (_pageResourcesReleased) {
    await new Promise(resolve => _pageRestoreWaiters.add(resolve));
  }
}

function addFiles(files) {
  // Reserve aggregate capacity before queueing so repeated drops cannot retain
  // batches that are already known to exceed the browser-safe limits.
  const reservation = _reserveImportFiles(files);
  if (!reservation.files.length) {
    _showImportRejections(reservation);
    return Promise.resolve();
  }
  updateUI();
  const run = _importQueueTail
    .then(() => _addFiles(reservation.files, reservation))
    .finally(() => {
      _releaseImportReservation(reservation);
      updateUI();
    });
  _importQueueTail = run.catch(() => {});
  return run;
}

async function _addFiles(accepted, reservation) {
  const { rejectedCount, unsupportedCount } = reservation;
  const isCurrentImport = () => reservation.generation === _importGeneration;

  const incomingBytes = accepted.reduce((sum, file) => sum + (file.size || 0), 0);
  const existingBytes = state.items.reduce((sum, item) => sum + (item.file?.size || 0), 0);
  if (accepted.length + state.items.length > 30 || incomingBytes + existingBytes > 512 * 1024 * 1024) {
    showToast(t('msgLargeBatch'), 'warn');
  }
  // Rejection is the actionable result when a partial batch exceeds a hard
  // limit, so keep it visible instead of letting the advisory warning replace it.
  _showImportRejections({ rejectedCount, unsupportedCount });

  for (const file of accepted) {
    if (!isCurrentImport()) break;
    const video = isVideoFile(file);
    const exif  = video ? await readVideoMetadata(file) : await readExif(file);
    // Metadata decoders are not uniformly abortable. If they finish after
    // pagehide, retain the queued File but do not create DOM, Blob URLs, or
    // Canvas resources until pageshow restores the workspace.
    await _waitForPageResourcesRestore();
    if (!isCurrentImport()) break;
    const item  = {
      id: ++itemIdCounter,
      file,
      exif,
      canvas:    null,
      videoBlob: null,
      photoThumbnailController: null,
      photoThumbnailPromise: null,
      photoThumbnailNeedsRestart: false,
      thumbnailController: null,
      thumbnailPromise: null,
      thumbnailNeedsRestart: false,
      exportController: null,
      exportRunToken: null,
      progress:  0,
      status:    'pending',
      errorMsg:  null,
      errorKey:  null,
      errorValues: null,
      isVideo:   video,
    };
    _consumeImportReservation(reservation, file);
    state.items.push(item);
    renderItem(item);
    // Keep completed entries actionable while a later metadata decoder in the
    // same batch is still pending, so Clear All can cancel the pending batch.
    updateUI();

    // Only the selected first photo benefits from pre-warming. Decoding every
    // batch item eagerly can retain many full-resolution browser decoders.
    if (!video && state.items.length === 1) {
      try {
        await _loadPreviewImage(item, { retainUncached: true });
      } catch (error) {
        if (!isCurrentImport()) break;
        if (!state.items.includes(item)) continue;
        if (error?.name === 'AbortError' && _pageResourcesReleased) {
          item.status = 'pending';
          _clearItemError(item);
          updateItemStatus(item);
        } else {
          item.status = 'error';
          if (error?.code === 'MEDIA_RESOURCE_LIMIT') {
            _setLocalizedItemError(item, 'msgMediaResourceLimit');
          } else {
            _setLocalizedItemError(item, 'msgUnsupportedMedia', { name: file.name });
          }
          updateItemStatus(item);
          showToast(item.errorMsg, 'error', { announce: false });
        }
      }
    }
    if (!isCurrentImport()) break;
    if (!state.items.includes(item)) continue;

    // Auto-select first item added for live preview
    if (state.items.length === 1) selectItem(item.id);

    // Generate framed thumbnail for video cards asynchronously
    if (video) _startVideoThumbnail(item);
  }

  updateUI();
  scheduleLivePreview();
}

async function removeItem(id, options = {}) {
  const { skipConfirm = false } = options;
  const item = state.items.find(candidate => candidate.id === id);
  if (!item) return false;
  if (!skipConfirm && !await requestDestructiveConfirmation({ filename: item.file?.name })) return false;
  _activeExportController?.abort();
  _cancelLocationOperations(id);
  _invalidateItemCache(id);
  const idx = state.items.findIndex(i => i.id === id);
  if (idx !== -1) {
    _cancelPhotoThumbnail(state.items[idx]);
    _releaseItemOutput(state.items[idx]);
    state.items.splice(idx, 1);
  }
  const el = document.getElementById(`item-${id}`);
  if (el) {
    _releaseCardPreviewResources(el);
    el.remove();
  }
  // If removed item was selected, select the new first item
  if (state.selectedItemId === id) {
    state.selectedItemId = null;
    if (state.items.length > 0) selectItem(state.items[0].id);
  }
  updateUI();
  scheduleLivePreview();
  if (state.items.length) _requestLoadedMediaFocus();
  else _getEmptyImportFocusTarget()?.focus();
  return true;
}

function _syncLocationIconPicker(value, { focus = false } = {}) {
  const selected = value || 'pin';
  document.querySelectorAll('.icon-pick-btn').forEach(button => {
    const active = button.dataset.icon === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
}

async function clearAllItems(skipConfirm = false) {
  const hasPendingImports = _reservedImportItems > 0;
  if (state.items.length === 0 && !hasPendingImports) return false;
  if (!skipConfirm && !await requestDestructiveConfirmation({ clearAll: true })) return false;
  _cancelPendingImports();
  _activeExportController?.abort();
  _cancelLocationOperations();
  const ids = state.items.map(i => i.id);
  ids.forEach(id => _invalidateItemCache(id));
  state.items.forEach(item => {
    _cancelPhotoThumbnail(item);
    _releaseItemOutput(item);
  });
  state.items = [];
  state.selectedItemId = null;
  const grid = document.getElementById('imageGrid');
  if (grid) {
    grid.querySelectorAll('.image-card').forEach(_releaseCardPreviewResources);
    grid.innerHTML = '';
  }
  updateUI();
  scheduleLivePreview();
  showToast(t('msgClearedAll'), 'info');
  _getEmptyImportFocusTarget()?.focus();
  return true;
}

function _getEmptyImportFocusTarget() {
  const mobilePhotosTab = window.innerWidth <= 768
    && document.body.getAttribute('data-mobile-tab') === 'photos';
  return mobilePhotosTab
    ? document.getElementById('mobileAddBtn')
    : document.getElementById('fileInput');
}

function _getLoadedMediaFocusTarget() {
  const mobilePreviewTab = window.innerWidth <= 768
    && document.body.getAttribute('data-mobile-tab') === 'preview';
  if (mobilePreviewTab) {
    const hasVideo = document.getElementById('dropZone')?.classList.contains('has-video');
    return document.getElementById(hasVideo ? 'videoPlayPauseBtn' : 'previewQualityBtn');
  }
  return document.querySelector('.image-card.selected-preview .card-preview, .image-card .card-preview');
}

function _tryFocusLoadedMediaTarget() {
  const target = _getLoadedMediaFocusTarget();
  if (!target || target.inert || target.closest('[inert]') || target.getClientRects().length === 0) return false;
  target.focus();
  return document.activeElement === target;
}

function _clearLoadedMediaFocusRequest() {
  _pendingLoadedMediaFocus = false;
  if (_loadedMediaFocusRetryId !== null) clearTimeout(_loadedMediaFocusRetryId);
  _loadedMediaFocusRetryId = null;
  _loadedMediaFocusRetryCount = 0;
}

function _requestLoadedMediaFocus() {
  _clearLoadedMediaFocusRequest();
  _pendingLoadedMediaFocus = true;
  if (_tryFocusLoadedMediaTarget()) _clearLoadedMediaFocusRequest();
}

function _queueLoadedMediaFocus() {
  _clearLoadedMediaFocusRequest();
  _pendingLoadedMediaFocus = true;
}

function _settleLoadedMediaFocus() {
  if (!_pendingLoadedMediaFocus || _loadedMediaFocusRetryId !== null) return;
  if (_tryFocusLoadedMediaTarget()) {
    _clearLoadedMediaFocusRequest();
    return;
  }
  if (_loadedMediaFocusRetryCount >= LOADED_MEDIA_FOCUS_RETRY_LIMIT) {
    _clearLoadedMediaFocusRequest();
    return;
  }
  _loadedMediaFocusRetryCount += 1;
  _loadedMediaFocusRetryId = setTimeout(() => {
    _loadedMediaFocusRetryId = null;
    _settleLoadedMediaFocus();
  }, 16);
}

// ─── Frame Generation ─────────────────────────────────────────────────────────
// onExternalProgress: optional (pct: 0..1) => void — for batch progress tracking
function _isCurrentItemExport(item, runToken, signal) {
  return !signal.aborted && item.exportRunToken === runToken && state.items.includes(item);
}

async function _releaseItemThumbnailBeforeExport(item, signal) {
  const thumbnailPromise = item.thumbnailPromise;
  if (!thumbnailPromise) return;
  item.thumbnailNeedsRestart = true;
  item.thumbnailController?.abort();
  _cancelQueuedVideoThumbnail(item);
  await thumbnailPromise;
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

async function generateItem(item, onExternalProgress = null, parentSignal = null) {
  if (item.exportController || !state.items.includes(item)) return false;
  const controller = new AbortController();
  const runToken = {};
  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  if (parentSignal?.aborted) controller.abort();
  item.exportController = controller;
  item.exportRunToken = runToken;
  const signal = controller.signal;
  let shouldUpdate = true;
  let recoveredPreviewDecode = false;
  let decodedPhoto = null;
  item.status   = 'processing';
  item.progress = 0;
  updateItemStatus(item);

  try {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    await _releaseItemThumbnailBeforeExport(item, signal);
    if (item.isVideo) {
      const mime    = resolveVideoMime(state.settings.exportVideoFormat);
      if (!mime) {
        const error = new Error(t('msgVideoExportUnavailable'));
        error.code = 'VIDEO_EXPORT_UNAVAILABLE';
        throw error;
      }
      const bitrate = (state.settings.exportVideoBitrate || 8) * 1_000_000;
      const maxOutputBytes = MAX_RETAINED_OUTPUT_BYTES - _retainedOutputBytes(item);
      if (maxOutputBytes <= 0) throw _mediaResourceLimitError();
      const videoBlob = await FrameEngine.renderVideoFrameWhenReady(
        item.file, item.exif, state.settings,
        {
          preferredMime:     mime,
          videoBitsPerSecond: bitrate,
          maxOutputBytes,
          onProgress: p => {
            item.progress = p;
            updateItemStatus(item);
            if (onExternalProgress) onExternalProgress(p);
          },
          signal,
        }
      );
      if (_retainedOutputBytes(item) + videoBlob.size > MAX_RETAINED_OUTPUT_BYTES) {
        throw _mediaResourceLimitError();
      }
      if (!_isCurrentItemExport(item, runToken, signal)) {
        throw new DOMException('Export cancelled', 'AbortError');
      }
      item.videoBlob = videoBlob;
    } else {
      decodedPhoto = await FrameEngine.loadImage(item.file, { signal });
      // A full export decode proves that a prior live-preview failure was
      // transient. Let the selected item retry instead of remaining blacklisted.
      recoveredPreviewDecode = _imgFailed.delete(item.id);
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      // Pre-fetch map overlay image if enabled and coordinates are available
      let mapOverlayImg = null;
      if (state.settings.showMapOverlay && state.settings.showLocation &&
          item.exif && item.exif.latitude != null && item.exif.longitude != null) {
        mapOverlayImg = await _fetchMapOverlayImage(item.exif.latitude, item.exif.longitude, 13, signal);
      }
      const rendered = await FrameEngine.renderFrameWhenReady(decodedPhoto, item.exif, state.settings, { mapOverlayImg, signal });
      if (_retainedOutputBytes(item) + rendered.width * rendered.height * 4 > MAX_RETAINED_OUTPUT_BYTES) {
        rendered.width = 0;
        rendered.height = 0;
        throw _mediaResourceLimitError();
      }
      if (!_isCurrentItemExport(item, runToken, signal)) {
        rendered.width = 0;
        rendered.height = 0;
        throw new DOMException('Export cancelled', 'AbortError');
      }
      item.canvas = rendered;
      if (signal?.aborted) {
        item.canvas = null;
        rendered.width = 0;
        rendered.height = 0;
        throw new DOMException('Export cancelled', 'AbortError');
      }
      if (onExternalProgress) onExternalProgress(1);
    }
    item.status   = 'done';
    _clearItemError(item);
  } catch (e) {
    const isCurrent = item.exportRunToken === runToken && state.items.includes(item);
    if (!isCurrent) shouldUpdate = false;
    const cancelled = e?.name === 'AbortError';
    if (isCurrent) {
      item.status = cancelled ? 'pending' : 'error';
      if (cancelled) _clearItemError(item);
      else if (e?.code === 'MEDIA_RESOURCE_LIMIT') _setLocalizedItemError(item, 'msgMediaResourceLimit');
      else if (e?.code === 'IMAGE_DECODE_TIMEOUT') _setLocalizedItemError(item, 'msgImageDecodeTimeout');
      else if (e?.code === 'VIDEO_EXPORT_UNAVAILABLE') _setLocalizedItemError(item, 'msgVideoExportUnavailable');
      else _setRawItemError(item, e.message);
      if (!cancelled && e?.code === 'MEDIA_RESOURCE_LIMIT') showToast(item.errorMsg, 'error');
      if (onExternalProgress) onExternalProgress(1);
    }
  } finally {
    decodedPhoto?.removeAttribute?.('src');
    parentSignal?.removeEventListener('abort', abortFromParent);
    if (item.exportRunToken === runToken) {
      item.exportController = null;
      item.exportRunToken = null;
    }
  }

  if (shouldUpdate && state.items.includes(item)) {
    updateItemStatus(item);
    updateItemPreview(item);
    updateUI();
    if (recoveredPreviewDecode && item.status === 'done' && state.selectedItemId === item.id) {
      scheduleLivePreview();
    }
    if (item.isVideo && !_pageResourcesReleased) _restartInterruptedVideoThumbnail(item);
  }
  return shouldUpdate && item.status === 'done';
}

function _ownsGlobalExport(controller) {
  return _activeExportController === controller;
}

function _showOwnedExportProgress(controller, label, progress) {
  if (_ownsGlobalExport(controller)) showProgress(label, progress);
}

function _finishOwnedGlobalExport(controller) {
  if (!_ownsGlobalExport(controller)) return false;
  _activeExportController = null;
  setGlobalBusy(false);
  hideProgress();
  return true;
}

async function generateAll() {
  if (_globalExportBusy) return;
  const pending = state.items.filter(i => i.status === 'pending');
  if (!pending.length && state.items.length === 0) {
    showToast(t('msgNoImages'), 'warn');
    return;
  }
  if (!pending.length) {
    showToast(t('msgNoPending'), 'info');
    return;
  }

  const controller = new AbortController();
  _activeExportController = controller;
  setGlobalBusy(true);
  const total = pending.length;

  for (let idx = 0; idx < total; idx++) {
    if (controller.signal.aborted || !_ownsGlobalExport(controller)) break;
    const item     = pending[idx];
    const basePct  = idx / total;
    const itemSlot = 1 / total;
    const prefix   = `${idx + 1} / ${total}`;

    _showOwnedExportProgress(controller,
      `${prefix}  —  ${item.isVideo ? '▶ ' : ''}${item.file.name}`,
      basePct
    );

    await generateItem(item, p => {
      const pctStr = item.isVideo ? `  ${Math.round(p * 100)}%` : '';
      _showOwnedExportProgress(controller, `${prefix}${pctStr}  —  ${item.file.name}`, basePct + itemSlot * p);
    }, controller.signal);
  }

  if (!_ownsGlobalExport(controller)) return;
  const cancelled = controller.signal.aborted;
  const failedCount = pending.filter(item => item.status === 'error').length;
  if (!_finishOwnedGlobalExport(controller)) return;
  if (cancelled) showToast(t('msgExportCancelled'), 'warn');
  else if (failedCount) showToast(tf('msgBatchFailed', { count: failedCount }), 'error');
  else showToast(t('msgDone'), 'success');
}

async function regenerateItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item || item.status === 'processing' || item.exportController || _globalExportBusy) return;
  setGlobalBusy(true);
  item.status    = 'pending';
  _releaseItemOutput(item);
  const controller = new AbortController();
  _activeExportController = controller;
  _showOwnedExportProgress(controller, `${item.isVideo ? '▶ ' : ''}${item.file.name}`, 0);
  await generateItem(
    item,
    p => _showOwnedExportProgress(controller, `${item.file.name}  ${item.isVideo ? Math.round(p * 100) + '%' : ''}`, p),
    controller.signal
  );
  if (!_ownsGlobalExport(controller)) return;
  const cancelled = controller.signal.aborted;
  if (!_finishOwnedGlobalExport(controller)) return;
  if (cancelled) showToast(t('msgExportCancelled'), 'warn');
}

// Apply frame (if needed) then download — used by per-item Download button
async function applyAndDownloadSingle(id) {
  const item = state.items.find(i => i.id === id);
  if (!item || item.status === 'processing' || item.exportController || _globalExportBusy) return;

  const controller = new AbortController();
  const downloadRunToken = {};
  _activeExportController = controller;
  setGlobalBusy(true);
  _showOwnedExportProgress(controller, `${item.isVideo ? '▶ ' : ''}${item.file.name}`, 0);

  try {
    if (item.status !== 'done') {
      // Generate first
      item.status = 'pending';
      _releaseItemOutput(item);
      await generateItem(
        item,
        p => _showOwnedExportProgress(controller, `${item.file.name}  ${item.isVideo ? Math.round(p * 100) + '%' : ''}`, p),
        controller.signal
      );
    }

    if (_ownsGlobalExport(controller) && !controller.signal.aborted && item.status === 'done') {
      item.exportController = controller;
      item.exportRunToken = downloadRunToken;
      _showOwnedExportProgress(controller, t('progressPreparing'), 1);
      await downloadSingle(id, { signal: controller.signal, runToken: downloadRunToken });
    }
  } catch (error) {
    if (error?.name !== 'AbortError' && _ownsGlobalExport(controller)) showToast(t('msgExportFailed'), 'error');
  } finally {
    const cancelled = controller.signal.aborted;
    if (item.exportRunToken === downloadRunToken) {
      item.exportController = null;
      item.exportRunToken = null;
    }
    if (!_finishOwnedGlobalExport(controller)) return;
    if (cancelled) showToast(t('msgExportCancelled'), 'warn');
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

function _uniqueZipEntryName(name, usedNames) {
  const normalize = value => value.toLowerCase();
  if (!usedNames.has(normalize(name))) {
    usedNames.add(normalize(name));
    return name;
  }

  const extensionIndex = name.lastIndexOf('.');
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : '';
  let copy = 2;
  let candidate;
  do {
    candidate = `${stem} (${copy})${extension}`;
    copy += 1;
  } while (usedNames.has(normalize(candidate)));
  usedNames.add(normalize(candidate));
  return candidate;
}

async function downloadSingle(id, { signal = null, runToken = null } = {}) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const isCurrent = () => !signal?.aborted && state.items.includes(item) &&
    (!runToken || item.exportRunToken === runToken);

  if (!isCurrent()) throw new DOMException('Export cancelled', 'AbortError');
  if (item.isVideo && item.videoBlob) {
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _videoExt(item.videoBlob);
    triggerDownload(item.videoBlob, name);
  } else if (item.canvas) {
    const opts = _photoExportOpts();
    const blob = await FrameEngine.canvasToBlob(item.canvas, { ...opts, signal });
    if (!isCurrent()) throw new DOMException('Export cancelled', 'AbortError');
    const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _photoExt(opts.format);
    triggerDownload(blob, name);
  }
}

function _generateZipBlob(zip, signal, onUpdate) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let settled = false;
    const stream = zip.generateInternalStream({
      type: 'uint8array',
      compression: 'STORE',
      streamFiles: true,
    });

    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (settled) return;
      settled = true;
      chunks = [];
      try { stream.pause(); } catch (_) { /* best-effort JSZip stream teardown */ }
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));

    stream
      .on('data', (data, meta) => {
        if (settled) return;
        if (signal?.aborted) {
          abort();
          return;
        }
        chunks.push(data);
        try { onUpdate?.(meta); }
        catch (error) { fail(error); }
      })
      .on('error', fail)
      .on('end', () => {
        if (settled) return;
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          const blob = new Blob(chunks, { type: 'application/zip' });
          chunks = [];
          settled = true;
          cleanup();
          resolve(blob);
        } catch (error) {
          fail(error);
        }
      });

    if (signal?.aborted) abort();
    else {
      signal?.addEventListener('abort', abort, { once: true });
      try { stream.resume(); }
      catch (error) { fail(error); }
    }
  });
}

async function downloadAll() {
  if (_globalExportBusy) return;
  if (!state.items.length) {
    showToast(t('msgNoImages'), 'warn');
    return;
  }

  const controller = new AbortController();
  _activeExportController = controller;
  setGlobalBusy(true);

  // Auto-generate any pending items first
  const pending = state.items.filter(i => i.status === 'pending');
  const generationWeight = pending.length ? 0.55 : 0;
  const packingWeight = pending.length ? 0.25 : 0.7;
  const packingStart = generationWeight;
  const zipStart = packingStart + packingWeight;
  if (pending.length) {
    const total = pending.length;
    for (let idx = 0; idx < total; idx++) {
      if (controller.signal.aborted || !_ownsGlobalExport(controller)) break;
      const item    = pending[idx];
      const basePct = generationWeight * (idx / total);
      const slot    = generationWeight / total;
      const prefix  = `${idx + 1} / ${total}`;
      _showOwnedExportProgress(controller, `${prefix}  —  ${item.file.name}`, basePct);
      await generateItem(item, p => {
        const pctStr = item.isVideo ? `  ${Math.round(p * 100)}%` : '';
        _showOwnedExportProgress(controller, `${prefix}${pctStr}  —  ${item.file.name}`, basePct + slot * p);
      }, controller.signal);
    }
  }

  if (!_ownsGlobalExport(controller)) return;
  if (controller.signal.aborted) {
    _finishOwnedGlobalExport(controller);
    showToast(t('msgExportCancelled'), 'warn');
    return;
  }

  const done = state.items.filter(i => i.status === 'done' && (i.canvas || i.videoBlob));
  if (!done.length) {
    _finishOwnedGlobalExport(controller);
    showToast(t('msgNoImages'), 'warn');
    return;
  }

  _showOwnedExportProgress(controller, t('progressPreparing'), packingStart);

  let JSZipCtor;
  try {
    JSZipCtor = await _waitForAbortablePromise(
      loadVendorScript('vendor/jszip.min.js', 'JSZip'),
      controller.signal,
      'Export cancelled'
    );
  } catch (error) {
    if (!_ownsGlobalExport(controller)) return;
    const cancelled = controller.signal.aborted || error?.name === 'AbortError';
    _finishOwnedGlobalExport(controller);
    showToast(t(cancelled ? 'msgExportCancelled' : 'msgDependencyLoadFailed'), cancelled ? 'warn' : 'error');
    return;
  }

  const zip   = new JSZipCtor();
  const opts  = _photoExportOpts();
  const total = done.length;
  const retainedBytes = _retainedOutputBytes();
  let encodedPhotoBytes = 0;
  let archiveInputBytes = 0;
  let packedEntries = 0;
  const usedZipEntryNames = new Set();

  function addZipEntry(name, blob, encodedPhoto = false) {
    const nextPhotoBytes = encodedPhotoBytes + (encodedPhoto ? (blob.size || 0) : 0);
    const nextArchiveBytes = archiveInputBytes + (blob.size || 0);
    const nextEntries = packedEntries + 1;
    const estimatedPeak = InstaFrameCore.estimateZipPeakBytes(
      retainedBytes,
      nextPhotoBytes,
      nextArchiveBytes,
      nextEntries
    );
    if (estimatedPeak > MAX_ZIP_PEAK_BYTES) throw _mediaResourceLimitError();
    zip.file(_uniqueZipEntryName(name, usedZipEntryNames), blob);
    encodedPhotoBytes = nextPhotoBytes;
    archiveInputBytes = nextArchiveBytes;
    packedEntries = nextEntries;
  }

  try {
    for (let i = 0; i < total; i++) {
      if (controller.signal.aborted || !_ownsGlobalExport(controller)) break;
      const item = done[i];
      _showOwnedExportProgress(
        controller,
        tf('progressPacking', { current: i + 1, total, name: item.file.name }),
        packingStart + (i / total) * packingWeight
      );

      if (item.isVideo && item.videoBlob) {
        const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _videoExt(item.videoBlob);
        addZipEntry(name, item.videoBlob);
      } else if (item.canvas) {
        const blob = await FrameEngine.canvasToBlob(item.canvas, { ...opts, signal: controller.signal });
        const name = item.file.name.replace(/\.[^.]+$/, '') + '_frame.' + _photoExt(opts.format);
        addZipEntry(name, blob, true);
      }
    }
  } catch (error) {
    if (!_ownsGlobalExport(controller)) return;
    const cancelled = controller.signal.aborted || error?.name === 'AbortError';
    _finishOwnedGlobalExport(controller);
    const messageKey = cancelled
      ? 'msgExportCancelled'
      : error?.code === 'MEDIA_RESOURCE_LIMIT' ? 'msgMediaResourceLimit' : 'msgExportFailed';
    showToast(t(messageKey), cancelled ? 'warn' : 'error');
    return;
  }

  if (!_ownsGlobalExport(controller)) return;
  if (controller.signal.aborted) {
    _finishOwnedGlobalExport(controller);
    showToast(t('msgExportCancelled'), 'warn');
    return;
  }

  let zipBlob;
  try {
    zipBlob = await _generateZipBlob(zip, controller.signal, meta => {
      _showOwnedExportProgress(controller, t('progressZip'), zipStart + (1 - zipStart) * (meta.percent / 100));
    });
    const actualPeak = InstaFrameCore.estimateZipPeakBytes(
      retainedBytes,
      encodedPhotoBytes,
      zipBlob.size,
      packedEntries
    );
    if (actualPeak > MAX_ZIP_PEAK_BYTES) throw _mediaResourceLimitError();
  } catch (error) {
    if (!_ownsGlobalExport(controller)) return;
    const cancelled = controller.signal.aborted || error?.name === 'AbortError';
    _finishOwnedGlobalExport(controller);
    const messageKey = cancelled
      ? 'msgExportCancelled'
      : error?.code === 'MEDIA_RESOURCE_LIMIT' ? 'msgMediaResourceLimit' : 'msgExportFailed';
    showToast(t(messageKey), cancelled ? 'warn' : 'error');
    return;
  }

  if (!_ownsGlobalExport(controller)) return;
  if (controller.signal.aborted) {
    _finishOwnedGlobalExport(controller);
    showToast(t('msgExportCancelled'), 'warn');
    return;
  }
  _showOwnedExportProgress(controller, t('progressZip'), 1);
  try {
    triggerDownload(zipBlob, 'instaframe_export.zip');
  } catch (_) {
    _finishOwnedGlobalExport(controller);
    showToast(t('msgExportFailed'), 'error');
    return;
  }
  _finishOwnedGlobalExport(controller);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  let downloadStarted = false;
  try {
    document.body.appendChild(a);
    a.click();
    downloadStarted = true;
  } finally {
    a.remove();
    if (downloadStarted) {
      const timer = setTimeout(() => _releaseDownloadUrl(url), 5000);
      _downloadUrlTimers.set(url, timer);
    } else {
      URL.revokeObjectURL(url);
    }
  }
}

function _releaseDownloadUrl(url) {
  const timer = _downloadUrlTimers.get(url);
  if (timer == null) return;
  clearTimeout(timer);
  _downloadUrlTimers.delete(url);
  URL.revokeObjectURL(url);
}

function _releasePendingDownloadUrls() {
  for (const url of [..._downloadUrlTimers.keys()]) _releaseDownloadUrl(url);
}

function _mediaResourceLimitError() {
  const error = new Error(t('msgMediaResourceLimit'));
  error.code = 'MEDIA_RESOURCE_LIMIT';
  return error;
}

function _retainedOutputBytes(excludeItem = null) {
  return state.items.reduce((sum, item) => {
    if (item === excludeItem) return sum;
    if (item.canvas) sum += item.canvas.width * item.canvas.height * 4;
    if (item.videoBlob) sum += item.videoBlob.size || 0;
    return sum;
  }, 0);
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

function _syncPhotoQualityAvailability(format) {
  const qualityRow = document.getElementById('photoQualityRow');
  if (!qualityRow) return;
  const hidden = format === 'png';
  qualityRow.classList.toggle('row-hidden', hidden);
  qualityRow.hidden = hidden;
  qualityRow.querySelectorAll('input, select, button').forEach(control => {
    control.disabled = hidden;
  });
}

function _findRadioByValue(name, value) {
  return Array.from(document.getElementsByName(name)).find(control => (
    control instanceof HTMLInputElement &&
    control.type === 'radio' &&
    control.value === String(value)
  )) || null;
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
        const r = _findRadioByValue('frameColor', saved.frameColor);
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

  if (saved.textColorMode) {
    const mode = _findRadioByValue('textColorMode', saved.textColorMode);
    if (mode) mode.checked = true;
  }
  if (saved.textColor) {
    const picker = document.getElementById('textColorPicker');
    if (picker) picker.value = InstaFrameCore.normalizeHexColor(saved.textColor, '#FFFFFF');
  }
  const textPicker = document.getElementById('textColorPicker');
  if (textPicker) textPicker.disabled = (saved.textColorMode || 'auto') !== 'custom';

  // Checkboxes
  [
    ['cameraNameBold',   saved.cameraNameBold],
    ['cameraNameItalic', saved.cameraNameItalic],
    ['exifItalic',       saved.exifItalic],
    ['showShotOn',       saved.showShotOn],
    ['showExifInfo',     saved.showExifInfo],
    ['showLocation',     saved.showLocation],
    ['showMapOverlay',   saved.showMapOverlay && hasLocationNetworkConsent()],
  ].forEach(([id, val]) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.checked = val;
  });

  // Location position
  if (saved.locationPosition) {
    const r = _findRadioByValue('locationPos', saved.locationPosition);
    if (r) r.checked = true;
  }
  if (saved.mapOverlayPosition) {
    const r = _findRadioByValue('mapOverlayPos', saved.mapOverlayPosition);
    if (r) r.checked = true;
  }
  // Show/hide location position row and map overlay rows
  const locPosRow   = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.classList.toggle('is-hidden', !saved.showLocation);
  const mapOvRow    = document.getElementById('mapOverlayRow');
  if (mapOvRow) mapOvRow.classList.toggle('is-hidden', !saved.showLocation);
  const mapOvOpRow  = document.getElementById('mapOverlayOpacityRow');
  if (mapOvOpRow) mapOvOpRow.classList.toggle('is-hidden', !(saved.showLocation && saved.showMapOverlay));
  const mapOvPosRow = document.getElementById('mapOverlayPositionRow');
  if (mapOvPosRow) mapOvPosRow.classList.toggle('is-hidden', !(saved.showLocation && saved.showMapOverlay));
  const locIconRow  = document.getElementById('locationIconRow');
  if (locIconRow) locIconRow.classList.toggle('is-hidden', !saved.showLocation);

  // Frame background mode
  if (saved.frameBackground) {
    const r = _findRadioByValue('frameBackground', saved.frameBackground);
    if (r) r.checked = true;
  }
  const isBlurBg = saved.frameBackground === 'blur';
  const frameColorRow = document.getElementById('frameColorRow');
  const blurOptionsRow = document.getElementById('blurOptionsRow');
  if (frameColorRow) frameColorRow.classList.toggle('is-hidden', isBlurBg);
  if (blurOptionsRow) blurOptionsRow.classList.toggle('is-hidden', !isBlurBg);
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
    _syncLocationIconPicker(saved.locationIconStyle);
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
    const r = _findRadioByValue('aspectRatio', saved.aspectRatio);
    if (r) r.checked = true;
  }
  if (saved.aspectOrientation) {
    const r = _findRadioByValue('aspectOrientation', saved.aspectOrientation);
    if (r) r.checked = true;
  }

  // ── Export settings ──────────────────────────────────────────────────────
  // Photo format
  if (saved.exportPhotoFormat) {
    const r = _findRadioByValue('exportPhotoFormat', saved.exportPhotoFormat);
    if (r) {
      r.checked = true;
      _syncPhotoQualityAvailability(saved.exportPhotoFormat);
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
    const r = _findRadioByValue('exportVideoBitrate', saved.exportVideoBitrate);
    if (r) r.checked = true;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function markItemsPending(predicate = () => true) {
  const affected = state.items.filter(item =>
    predicate(item) && (item.status === 'done' || item.status === 'processing')
  );
  if (affected.length && _globalExportBusy && _activeExportController && !_activeExportController.signal.aborted) {
    _activeExportController.abort();
  }
  affected.forEach(item => {
    item.status = 'pending';
    item.progress = 0;
    _clearItemError(item);
    _releaseItemOutput(item);
    updateItemStatus(item);
    updateItemPreview(item);
  });
}

function markDoneItemsPending() {
  markItemsPending();
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
  if (frameColorRow) frameColorRow.classList.toggle('is-hidden', isBlurBg);
  if (blurOptionsRow) blurOptionsRow.classList.toggle('is-hidden', !isBlurBg);

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
  const textColorMode = document.querySelector('input[name="textColorMode"]:checked');
  state.settings.textColorMode = textColorMode ? textColorMode.value : 'auto';
  state.settings.textColor = InstaFrameCore.normalizeHexColor(document.getElementById('textColorPicker')?.value, '#FFFFFF');
  const textColorPicker = document.getElementById('textColorPicker');
  if (textColorPicker) textColorPicker.disabled = state.settings.textColorMode !== 'custom';
  state.settings.shotOnFontScale  = parseFloat(document.getElementById('shotOnFontRange').value);
  state.settings.exifFontScale    = parseFloat(document.getElementById('exifFontRange').value);
  state.settings.lineGapScale     = parseFloat(document.getElementById('lineGapRange').value);
  state.settings.textOffsetY      = parseFloat(document.getElementById('textOffsetRange').value);
  state.settings.cameraNameBold   = document.getElementById('cameraNameBold').checked;
  state.settings.cameraNameItalic = document.getElementById('cameraNameItalic').checked;
  state.settings.exifItalic       = document.getElementById('exifItalic').checked;
  state.settings.showShotOn       = document.getElementById('showShotOn').checked;
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
  const mapOverlayPosRadio = document.querySelector('input[name="mapOverlayPos"]:checked');
  state.settings.mapOverlayPosition = mapOverlayPosRadio ? mapOverlayPosRadio.value : 'bottom-right';
  // Show/hide location position row, map overlay rows, and location icon row
  const locPosRow      = document.getElementById('locationPositionRow');
  const mapOvRow       = document.getElementById('mapOverlayRow');
  const mapOvOpRow     = document.getElementById('mapOverlayOpacityRow');
  const mapOvPosRow    = document.getElementById('mapOverlayPositionRow');
  const locIconRow     = document.getElementById('locationIconRow');
  if (locPosRow) locPosRow.classList.toggle('is-hidden', !state.settings.showLocation);
  if (mapOvRow) mapOvRow.classList.toggle('is-hidden', !state.settings.showLocation);
  if (locIconRow) locIconRow.classList.toggle('is-hidden', !state.settings.showLocation);
  if (mapOvOpRow) mapOvOpRow.classList.toggle('is-hidden', !(state.settings.showLocation && state.settings.showMapOverlay));
  if (mapOvPosRow) mapOvPosRow.classList.toggle('is-hidden', !(state.settings.showLocation && state.settings.showMapOverlay));

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
  setVal('textColorPicker', s.textColor || '#FFFFFF');
  setVal('photoQualityRange', s.exportPhotoQuality);

  setChecked('cameraNameBold', s.cameraNameBold);
  setChecked('cameraNameItalic', s.cameraNameItalic);
  setChecked('exifItalic', s.exifItalic);
  setChecked('showShotOn', s.showShotOn);
  setChecked('showExifInfo', s.showExifInfo);
  setChecked('showLocation', s.showLocation);
  setChecked('showMapOverlay', s.showMapOverlay);

  const textColorMode = document.querySelector(`input[name="textColorMode"][value="${s.textColorMode || 'auto'}"]`);
  if (textColorMode) textColorMode.checked = true;
  const textColorPicker = document.getElementById('textColorPicker');
  if (textColorPicker) textColorPicker.disabled = (s.textColorMode || 'auto') !== 'custom';

  const locPos = document.querySelector(`input[name="locationPos"][value="${s.locationPosition}"]`);
  if (locPos) locPos.checked = true;
  const mapOvPos = document.querySelector(`input[name="mapOverlayPos"][value="${s.mapOverlayPosition || 'bottom-right'}"]`);
  if (mapOvPos) mapOvPos.checked = true;
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

  _syncPhotoQualityAvailability(s.exportPhotoFormat);

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
  if (fcRow) fcRow.classList.toggle('is-hidden', isBlur);
  if (boRow) boRow.classList.toggle('is-hidden', !isBlur);
  setVal('blurRadiusRange', s.blurRadius ?? 20);
  setText('blurRadiusVal', (s.blurRadius ?? 20) + 'px');
  setVal('blurBrightnessRange', s.blurBrightness ?? 80);
  setText('blurBrightnessVal', (s.blurBrightness ?? 80) + '%');
  const blurStyleEl = document.getElementById('blurStyleSelect');
  if (blurStyleEl) blurStyleEl.value = s.blurStyle || 'normal';

  // Location icon
  _syncLocationIconPicker(s.locationIconStyle);

  const locPosRow = document.getElementById('locationPositionRow');
  if (locPosRow) locPosRow.classList.toggle('is-hidden', !s.showLocation);
  const mapOvRow = document.getElementById('mapOverlayRow');
  if (mapOvRow) mapOvRow.classList.toggle('is-hidden', !s.showLocation);
  const mapOvOpRow = document.getElementById('mapOverlayOpacityRow');
  if (mapOvOpRow) mapOvOpRow.classList.toggle('is-hidden', !(s.showLocation && s.showMapOverlay));
  const mapOvPosRow = document.getElementById('mapOverlayPositionRow');
  if (mapOvPosRow) mapOvPosRow.classList.toggle('is-hidden', !(s.showLocation && s.showMapOverlay));
  const locIconRow = document.getElementById('locationIconRow');
  if (locIconRow) locIconRow.classList.toggle('is-hidden', !s.showLocation);
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

function _syncLiveLocationInput() {
  const input = document.getElementById('live-exif-location');
  if (!input) return;
  const item = getSelectedPreviewItem();
  const resolving = !!item && item.id === _liveDeviceLocationItemId;
  input.disabled = resolving;
  input.value = resolving ? '…' : (item?.exif?.location || '');
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
    _syncLiveLocationInput();
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
  _syncLiveLocationInput();
}

function toggleLiveExifPanel() {
  const wrap = document.getElementById('previewExifWrap');
  if (!wrap) return;
  const open = wrap.classList.toggle('exif-open');
  document.querySelector('.preview-exif-drawer-header')?.setAttribute('aria-expanded', String(open));
  const content = document.getElementById('previewExifContent');
  if (content) {
    content.inert = !open;
    content.setAttribute('aria-hidden', String(!open));
  }
  if (open) updateLiveExifPanel();
  _syncPreviewControlAvailability();
}

let _liveExifApplyTimer = null;
let _liveExifPendingEdit = null;

function _readLiveExifEdit() {
  const getVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  return {
    make:         getVal('live-exif-make'),
    model:        getVal('live-exif-model'),
    lensModel:    getVal('live-exif-lens'),
    focalLength:  getVal('live-exif-fl'),
    fNumber:      getVal('live-exif-fn'),
    exposureTime: getVal('live-exif-et'),
    iso:          getVal('live-exif-iso'),
    location:     getVal('live-exif-location'),
  };
}

function _flushLiveExifEdit() {
  clearTimeout(_liveExifApplyTimer);
  _liveExifApplyTimer = null;
  const pending = _liveExifPendingEdit;
  _liveExifPendingEdit = null;
  if (pending && state.items.includes(pending.item)) {
    applyLiveExifEdit(pending.item, pending.nextExif);
  }
}

function scheduleLiveExifEditApply() {
  const item = getSelectedPreviewItem();
  if (!item) return;
  if (_liveExifPendingEdit?.item !== item) _flushLiveExifEdit();
  clearTimeout(_liveExifApplyTimer);
  _liveExifPendingEdit = { item, nextExif: _readLiveExifEdit() };
  _liveExifApplyTimer = setTimeout(_flushLiveExifEdit, 100);
}

function applyLiveExifEdit(item, nextExif) {
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
  _clearItemError(item);
  _releaseItemOutput(item);
  _invalidateItemCache(item.id);
  updateItemStatus(item);
  updateItemPreview(item);
  updateUI();
  scheduleLivePreview();
}

function _cancelLocationOperations(itemId = null) {
  if (!itemId || _resolveLiveLocationOperation?.itemId === itemId) {
    _resolveLiveLocationOperation?.controller.abort();
    _resolveLiveLocationOperation = null;
  }
  if (!itemId || _liveDeviceLocationTargetId === itemId) {
    _liveDeviceLocationController?.abort();
    _liveDeviceLocationController = null;
    _liveDeviceLocationTargetId = null;
    _liveDeviceLocationItemId = null;
    _liveDeviceLocationRequestId += 1;
    _syncLiveLocationInput();
  }
}

function _applyResolvedLocation(item, latitude, longitude, label) {
  if (!item) return;
  if (!item.exif) item.exif = {};
  item.exif.latitude = latitude;
  item.exif.longitude = longitude;
  item.exif.location = label || InstaFrameCore.formatCoordinateLabel(latitude, longitude);
  const input = document.getElementById('live-exif-location');
  if (input && getSelectedPreviewItem()?.id === item.id) input.value = item.exif.location;
  const cardInput = document.getElementById(`exif-location-${item.id}`);
  if (cardInput) cardInput.value = item.exif.location;
  item.status = 'pending';
  _clearItemError(item);
  _releaseItemOutput(item);
  _invalidateItemCache(item.id);
  updateItemStatus(item);
  updateItemPreview(item);
  updateUI();
  scheduleLivePreview();
}

async function resolveLiveExifLocation() {
  const target = (() => {
    const item = getSelectedPreviewItem();
    return item ? {
      itemId: item.id,
      latitude: item.exif?.latitude,
      longitude: item.exif?.longitude,
    } : null;
  })();
  const { itemId, latitude, longitude } = target || {};
  if (latitude == null || longitude == null) {
    showToast(t('msgNoLocationCoordinates'), 'warn');
    return;
  }
  _resolveLiveLocationOperation?.controller.abort();
  const operation = { itemId, latitude, longitude, controller: new AbortController() };
  _resolveLiveLocationOperation = operation;
  const currentItem = () => {
    if (_resolveLiveLocationOperation !== operation || operation.controller.signal.aborted) return null;
    const item = state.items.find(candidate => candidate.id === itemId);
    return item?.exif?.latitude === latitude && item?.exif?.longitude === longitude ? item : null;
  };
  try {
    if (!await requestLocationNetworkConsent() || !currentItem()) return;
    const name = await reverseGeocode(latitude, longitude, { signal: operation.controller.signal });
    const item = currentItem();
    if (!item) return;
    if (!name) {
      showToast(t('msgLocationLookupFailed'), 'warn');
      return;
    }
    _applyResolvedLocation(item, latitude, longitude, name);
    showToast(t('msgLocationResolved'), 'success');
  } finally {
    if (_resolveLiveLocationOperation === operation) _resolveLiveLocationOperation = null;
  }
}

async function getLiveDeviceLocation() {
  if (!navigator.geolocation) { showToast(t('msgGeolocationUnsupported'), 'warn'); return; }
  const itemId = getSelectedPreviewItem()?.id;
  if (!itemId) return;
  _liveDeviceLocationController?.abort();
  const controller = new AbortController();
  _liveDeviceLocationController = controller;
  _liveDeviceLocationTargetId = itemId;
  const requestId = ++_liveDeviceLocationRequestId;
  _liveDeviceLocationItemId = null;
  _syncLiveLocationInput();
  if (!await requestLocationNetworkConsent()) {
    if (_liveDeviceLocationController === controller) _cancelLocationOperations(itemId);
    return;
  }
  if (requestId !== _liveDeviceLocationRequestId || controller.signal.aborted
    || !state.items.some(item => item.id === itemId)) return;
  _liveDeviceLocationItemId = itemId;
  _syncLiveLocationInput();

  const finish = () => {
    if (requestId !== _liveDeviceLocationRequestId || _liveDeviceLocationController !== controller
      || controller.signal.aborted) return null;
    const item = state.items.find(candidate => candidate.id === itemId) || null;
    _liveDeviceLocationController = null;
    _liveDeviceLocationTargetId = null;
    _liveDeviceLocationItemId = null;
    _syncLiveLocationInput();
    return item;
  };
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      if (requestId !== _liveDeviceLocationRequestId || controller.signal.aborted
        || !state.items.some(item => item.id === itemId)) return;
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude, { signal: controller.signal });
      const item = finish();
      if (!item) return;
      _applyResolvedLocation(item, latitude, longitude, name || InstaFrameCore.formatCoordinateLabel(latitude, longitude));
    },
    () => {
      if (!finish()) return;
      showToast(t('msgGeolocationFailed'), 'warn');
    },
    { timeout: 10000 }
  );
}

// ─── Map Location Picker ──────────────────────────────────────────────────────
let _mapPickerMap    = null;
let _mapPickerMarker = null;
let _mapPickerLat    = null;
let _mapPickerLon    = null;
let _leafletLoadPromise = null;
let _mapPickerLocationRequestId = 0;
let _ipLocationController = null;
let _mapPickerConfirmController = null;

function _setMapPickerBusy(busy, statusKey = null) {
  const modal = document.getElementById('mapPickerModal');
  const container = document.getElementById('mapPickerContainer');
  const selectCenter = document.getElementById('selectMapCenterBtn');
  const confirm = document.getElementById('confirmMapLocationBtn');
  modal?.setAttribute('aria-busy', String(busy));
  if (container) {
    container.inert = busy;
    container.setAttribute('aria-disabled', String(busy));
  }
  if (selectCenter) selectCenter.disabled = busy;
  if (confirm) confirm.disabled = busy;
  if (statusKey) {
    const status = document.getElementById('mapPickerCoords');
    if (status) status.textContent = t(statusKey);
  }
}

function _ensureLeafletStylesheet() {
  const hasLeafletCss = !!document.querySelector('link[href*="leaflet.css"]');
  if (hasLeafletCss) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = _versionedAssetUrl('vendor/leaflet/leaflet.css');
  link.setAttribute('data-leaflet-runtime', '1');
  document.head.appendChild(link);
}

function _loadLeafletScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = _versionedAssetUrl(src);
    script.async = true;
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error('Leaflet script load timed out'));
    }, 8_000);
    script.onload = () => { clearTimeout(timeout); resolve(true); };
    script.onerror = () => { clearTimeout(timeout); reject(new Error('Leaflet script load failed')); };
    document.head.appendChild(script);
  });
}

async function ensureLeafletLoaded() {
  if (typeof L !== 'undefined') return true;
  if (_leafletLoadPromise) return _leafletLoadPromise;

  _leafletLoadPromise = (async () => {
    _ensureLeafletStylesheet();
    try {
      await _loadLeafletScript('vendor/leaflet/leaflet.js');
      return typeof L !== 'undefined';
    } catch (_) {
      return false;
    }
  })();

  const loaded = await _leafletLoadPromise;
  if (!loaded) _leafletLoadPromise = null;
  return loaded;
}

async function openMapPicker() {
  const modal = document.getElementById('mapPickerModal');
  if (!modal) return;
  const activeElement = document.activeElement;
  const previousFocus = activeElement && activeElement !== document.body
    ? activeElement
    : document.getElementById('openMapPickerBtn');
  if (!await requestLocationNetworkConsent()) return;
  _setModalOpen(modal, true);
  _setMapPickerBusy(true, 'mapLoading');
  modal._previousFocus = previousFocus;
  const locationRequestId = ++_mapPickerLocationRequestId;
  _mapPickerLat = null;
  _mapPickerLon = null;
  const coordsEl = document.getElementById('mapPickerCoords');
  document.getElementById('mapPickerCloseBtn')?.focus();
  const leafletReady = await ensureLeafletLoaded();
  if (locationRequestId !== _mapPickerLocationRequestId || !modal.classList.contains('open')) return;
  if (!leafletReady || typeof L === 'undefined') {
    closeMapPicker();
    showToast(t('msgMapLoadFailed'), 'error');
    return;
  }
  // Initialize Leaflet map in the next animation frame so the container
  // has a layout (width/height) before Leaflet tries to measure it.
  await new Promise(r => requestAnimationFrame(r));
  if (locationRequestId !== _mapPickerLocationRequestId || !modal.classList.contains('open')) return;

  // Initialize Leaflet map if not yet created
  if (!_mapPickerMap) {
    _mapPickerMap = L.map('mapPickerContainer').setView([35.6762, 139.6503], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_mapPickerMap);

    _mapPickerMap.on('click', e => _selectMapCoordinates(e.latlng));
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
    if (coordsEl) coordsEl.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    _setMapPickerBusy(false);
    return;
  }

  if (coordsEl) coordsEl.textContent = t('mapClickHint');
  _setMapPickerBusy(false);

  // Try browser geolocation first, then IP-based fallback. The browser API has
  // no cancellation primitive, so a generation id prevents late callbacks
  // from restarting network work after the modal has closed.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (locationRequestId !== _mapPickerLocationRequestId || !modal.classList.contains('open') || !_mapPickerMap) return;
        const { latitude, longitude } = pos.coords;
        _mapPickerMap.setView([latitude, longitude], 12);
      },
      () => {
        if (locationRequestId === _mapPickerLocationRequestId && modal.classList.contains('open')) {
          void _fetchIpLocation(locationRequestId);
        }
      },
      { timeout: 5000 }
    );
  } else {
    void _fetchIpLocation(locationRequestId);
  }
}

async function _fetchIpLocation(locationRequestId = _mapPickerLocationRequestId) {
  if (!hasLocationNetworkConsent() || locationRequestId !== _mapPickerLocationRequestId) return;
  _ipLocationController?.abort();
  const controller = new AbortController();
  _ipLocationController = controller;
  try {
    const data = await _fetchLocationJson('https://ipapi.co/json/', {}, controller);
    if (data?.latitude && data?.longitude && !controller.signal.aborted &&
        locationRequestId === _mapPickerLocationRequestId && _mapPickerMap) {
      _mapPickerMap.setView([data.latitude, data.longitude], 10);
    }
  } finally {
    if (_ipLocationController === controller) _ipLocationController = null;
  }
}

function _selectMapCoordinates({ lat, lng }) {
  _mapPickerLat = lat;
  _mapPickerLon = lng;
  if (_mapPickerMarker) _mapPickerMarker.setLatLng([lat, lng]);
  else if (_mapPickerMap) _mapPickerMarker = L.marker([lat, lng]).addTo(_mapPickerMap);
  const coordsEl = document.getElementById('mapPickerCoords');
  if (coordsEl) coordsEl.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
}

function _releaseMapPickerResources() {
  _mapPickerLocationRequestId += 1;
  _ipLocationController?.abort();
  _ipLocationController = null;
  _mapPickerConfirmController?.abort();
  _mapPickerConfirmController = null;
  if (_mapPickerMap) _mapPickerMap.remove();
  _mapPickerMap = null;
  _mapPickerMarker = null;
}

function closeMapPicker({ restoreFocus = true } = {}) {
  _releaseMapPickerResources();
  const modal = document.getElementById('mapPickerModal');
  if (modal) {
    _setModalOpen(modal, false);
    _setMapPickerBusy(false);
    const previousFocus = modal._previousFocus;
    modal._previousFocus = null;
    if (restoreFocus) _restoreModalTriggerFocus(previousFocus);
  }
}

async function confirmMapLocation() {
  if (_mapPickerConfirmController) return;
  if (_mapPickerLat == null || _mapPickerLon == null) {
    const coords = document.getElementById('mapPickerCoords');
    if (coords) {
      coords.textContent = '';
      void coords.offsetWidth;
      coords.textContent = t('msgMapSelectLocation');
    }
    return;
  }
  const lat = _mapPickerLat, lon = _mapPickerLon;
  const modal = document.getElementById('mapPickerModal');
  const locationRequestId = _mapPickerLocationRequestId;
  const controller = new AbortController();
  _mapPickerConfirmController = controller;
  _setMapPickerBusy(true, 'mapLocationLookup');
  try {
    // Resolve location name via reverse geocoding. Closing the modal aborts the
    // request and the generation check prevents a late response from updating
    // a different item or a newly opened picker.
    const name = await reverseGeocode(lat, lon, { signal: controller.signal });
    if (controller.signal.aborted || locationRequestId !== _mapPickerLocationRequestId || !modal?.classList.contains('open')) return;
    const locStr = name || InstaFrameCore.formatCoordinateLabel(lat, lon);

    // Update live EXIF panel input
    const locInput = document.getElementById('live-exif-location');
    if (locInput) locInput.value = locStr;

    // Store lat/lon on the current item's exif and apply
    const item = getSelectedPreviewItem();
    if (item) _applyResolvedLocation(item, lat, lon, locStr);

    _mapPickerConfirmController = null;
    closeMapPicker();
  } finally {
    if (_mapPickerConfirmController === controller) {
      _mapPickerConfirmController = null;
      if (modal?.classList.contains('open')) _setMapPickerBusy(false);
    }
  }
}

// ─── Share Modal ───────────────────────────────────────────────────────────────
let _shareModalGeneration = 0;
let _shareCopyRequestId = 0;

function _buildSharePayload() {
  const url = window.location.href;
  const text = `InstaFrame — ${t('appSubtitle')}`;
  return { url, text };
}

function _refreshShareLinks() {
  const { url, text } = _buildSharePayload();
  const encUrl  = encodeURIComponent(url);
  const encText = encodeURIComponent(text);
  const links = {
    shareXBtn:        `https://twitter.com/intent/tweet?text=${encText}&url=${encUrl}`,
    shareFacebookBtn: `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`,
    shareLineBtn:     `https://social-plugins.line.me/lineit/share?url=${encUrl}`,
    shareLinkedInBtn: `https://www.linkedin.com/sharing/share-offsite/?url=${encUrl}`,
  };
  Object.entries(links).forEach(([id, href]) => {
    const a = document.getElementById(id);
    if (a) a.href = href;
  });
  const input = document.getElementById('shareUrlInput');
  if (input) input.value = url;
}

function openShareAppModal() {
  const modal = document.getElementById('shareAppModal');
  if (!modal) return;
  _shareModalGeneration += 1;
  _refreshShareLinks();
  const status = document.getElementById('shareModalStatus');
  if (status) status.textContent = '';
  modal._previousFocus = document.activeElement;
  _setModalOpen(modal, true);
  document.getElementById('shareAppCloseBtn')?.focus();
}

function closeShareAppModal() {
  const modal = document.getElementById('shareAppModal');
  if (modal) {
    _shareModalGeneration += 1;
    _setModalOpen(modal, false);
    const previousFocus = modal._previousFocus;
    modal._previousFocus = null;
    _restoreModalTriggerFocus(previousFocus);
  }
}

function setupShareAppModal() {
  document.getElementById('shareAppBtn')?.addEventListener('click', openShareAppModal);
  document.getElementById('shareAppCloseBtn')?.addEventListener('click', closeShareAppModal);
  document.getElementById('shareAppModal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeShareAppModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !document.getElementById('shareAppModal')?.classList.contains('open')) return;
    event.preventDefault();
    closeShareAppModal();
  });
  document.getElementById('copyShareUrlBtn')?.addEventListener('click', async () => {
    const modal = document.getElementById('shareAppModal');
    const input = document.getElementById('shareUrlInput');
    const status = document.getElementById('shareModalStatus');
    const url = input?.value || window.location.href;
    const generation = _shareModalGeneration;
    const requestId = ++_shareCopyRequestId;
    const ownsResult = () => modal?.classList.contains('open')
      && generation === _shareModalGeneration
      && requestId === _shareCopyRequestId;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const tmp = document.createElement('textarea');
        tmp.value = url;
        tmp.style.position = 'fixed';
        tmp.style.opacity = '0';
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand('copy');
        document.body.removeChild(tmp);
      }
      if (!ownsResult()) return;
      const message = t('msgLinkCopied');
      if (status) {
        status.textContent = '';
        void status.offsetWidth;
        status.textContent = message;
      }
      showToast(message, 'ok', { announce: false });
    } catch (_) {
      if (!ownsResult()) return;
      const message = t('msgCopyFailed');
      if (status) {
        status.textContent = '';
        void status.offsetWidth;
        status.textContent = message;
      }
      showToast(message, 'warn', { announce: false });
    }
  });
}


let _livePreviewTimer = null;

function _waitForPreviewResource(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Preview cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const succeed = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('Preview cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(succeed, fail);
  });
}

function scheduleLivePreview() {
  if (_pageResourcesReleased) {
    clearTimeout(_livePreviewTimer);
    _livePreviewTimer = null;
    _previewRenderController?.abort();
    _previewRenderController = null;
    _renderSeq += 1;
    return;
  }
  clearTimeout(_livePreviewTimer);
  if (_videoPreviewItemId !== null) _cancelVideoCanvasPreviewFrame();
  _previewRenderController?.abort();
  _previewRenderController = null;
  // Invalidate work immediately, rather than waiting for the debounced render
  // to begin. A removed item must not be able to finish during this window and
  // reinsert a large canvas into the preview cache.
  _renderSeq += 1;
  // HTML preview updates are near-instant; canvas still needs debounce
  _livePreviewTimer = setTimeout(renderLivePreview, 80);
}

// ─── Video Preview Bar ────────────────────────────────────────────────────────
function _formatVideoTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function setupVideoPreviewBar() {
  const video        = document.getElementById('livePreviewVideo');
  const playPauseBtn = document.getElementById('videoPlayPauseBtn');
  const playIcon     = document.getElementById('videoPlayIcon');
  const pauseIcon    = document.getElementById('videoPauseIcon');
  const seekRange    = document.getElementById('videoSeekRange');
  const currentEl    = document.getElementById('videoCurrentTime');
  const durationEl   = document.getElementById('videoDuration');
  const muteBtn      = document.getElementById('videoMuteBtn');
  const volIcon      = document.getElementById('videoVolIcon');
  const muteIcon     = document.getElementById('videoMuteIcon');
  const volumeRange  = document.getElementById('videoVolumeRange');
  const speedSelect  = document.getElementById('videoSpeedSelect');
  if (!video || !playPauseBtn || !seekRange) return;
  let lastAudibleVolume = video.volume > 0 ? video.volume : 1;

  function syncControlLabel(button, key) {
    if (!button) return;
    const label = t(key);
    button.dataset.i18n = key;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function syncPlayPauseIcon() {
    const paused = video.paused || video.ended;
    if (playIcon)  playIcon.style.display  = paused ? '' : 'none';
    if (pauseIcon) pauseIcon.style.display = paused ? 'none' : '';
    syncControlLabel(playPauseBtn, paused ? 'videoPlay' : 'videoPause');
  }

  function syncMuteIcon() {
    const muted = video.muted || video.volume === 0;
    if (!muted && video.volume > 0) lastAudibleVolume = video.volume;
    if (volIcon)  volIcon.style.display  = muted ? 'none' : '';
    if (muteIcon) muteIcon.style.display = muted ? '' : 'none';
    if (volumeRange) volumeRange.value = video.muted ? '0' : String(video.volume);
    syncControlLabel(muteBtn, muted ? 'videoUnmute' : 'videoMute');
  }

  playPauseBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (video.paused || video.ended) {
      if (video.ended) video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });

  // Volume: slider adjusts level, mute button toggles
  if (muteBtn) {
    muteBtn.addEventListener('click', e => {
      e.stopPropagation();
      const muted = video.muted || video.volume === 0;
      if (muted) {
        if (video.volume === 0) video.volume = lastAudibleVolume || 1;
        video.muted = false;
      } else {
        lastAudibleVolume = video.volume;
        video.muted = true;
      }
      syncMuteIcon();
    });
  }
  if (volumeRange) {
    volumeRange.addEventListener('mousedown', e => e.stopPropagation());
    volumeRange.addEventListener('touchstart', e => e.stopPropagation());
    volumeRange.addEventListener('input', () => {
      const volume = parseFloat(volumeRange.value);
      if (volume > 0) lastAudibleVolume = volume;
      video.volume = volume;
      video.muted  = video.volume === 0;
      syncMuteIcon();
    });
  }

  // Playback speed: preview only (not applied to export)
  if (speedSelect) {
    speedSelect.addEventListener('mousedown', e => e.stopPropagation());
    speedSelect.addEventListener('change', () => {
      video.playbackRate = parseFloat(speedSelect.value);
    });
  }

  video.addEventListener('play', () => {
    syncPlayPauseIcon();
    const item = getSelectedPreviewItem();
    if (item?.isVideo) _startVideoCanvasPreview(item);
  });
  video.addEventListener('pause', () => {
    syncPlayPauseIcon();
    _cancelVideoCanvasPreviewFrame();
  });
  video.addEventListener('ended', () => {
    syncPlayPauseIcon();
    _cancelVideoCanvasPreviewFrame();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      _cancelVideoCanvasPreviewFrame();
      return;
    }
    const item = getSelectedPreviewItem();
    if (item?.isVideo && !video.paused && !video.ended) _startVideoCanvasPreview(item);
  });
  video.addEventListener('volumechange', syncMuteIcon);

  video.addEventListener('loadedmetadata', () => {
    if (durationEl) durationEl.textContent = _formatVideoTime(video.duration);
    seekRange.max   = String(video.duration || 100);
    seekRange.value = '0';
    if (currentEl) currentEl.textContent = _formatVideoTime(0);
    // Reset speed to 1× on new video
    if (speedSelect) { speedSelect.value = '1'; video.playbackRate = 1; }
    syncPlayPauseIcon();
    syncMuteIcon();
  });

  let _seeking = false;

  video.addEventListener('timeupdate', () => {
    if (!_seeking) seekRange.value = String(video.currentTime);
    if (currentEl) currentEl.textContent = _formatVideoTime(video.currentTime);
    const item = getSelectedPreviewItem();
    if (item?.isVideo && !video.paused && !video.ended && _videoPreviewFrameHandle === null) {
      _startVideoCanvasPreview(item);
    }
  });

  // Redraw after the browser has decoded the requested frame (even when paused).
  video.addEventListener('seeked', () => {
    const item = getSelectedPreviewItem();
    if (item && item.isVideo && _videoPreviewItemId === item.id) {
      _cancelVideoCanvasPreviewFrame();
      // Cancel a callback queued for the pre-seek frame before drawing the
      // newly selected current frame. A paused video may not emit another
      // decoded-frame callback until playback resumes.
      _startVideoCanvasPreview(item);
    }
  });

  seekRange.addEventListener('mousedown', e => {
    e.stopPropagation();
    _seeking = true;
  });
  seekRange.addEventListener('touchstart', e => {
    e.stopPropagation();
    _seeking = true;
  });
  seekRange.addEventListener('input', () => {
    const t = parseFloat(seekRange.value);
    video.currentTime = t;
    if (currentEl) currentEl.textContent = _formatVideoTime(t);
  });
  seekRange.addEventListener('change', () => { _seeking = false; });
  seekRange.addEventListener('mouseup',  () => { _seeking = false; });
  syncPlayPauseIcon();
  syncMuteIcon();
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

function _syncPreviewZoomControl() {
  const percent = Math.round(previewZoom * 100);
  const minZoom = InstaFrameCore.MIN_PREVIEW_ZOOM || 0.5;
  const maxZoom = InstaFrameCore.MAX_PREVIEW_ZOOM || 12;
  const range = document.getElementById('zoomRange');
  if (range) {
    range.value = Math.round(InstaFrameCore.getPreviewSliderValueForZoom(previewZoom));
    range.setAttribute('aria-valuetext', `${percent}%`);
  }
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = `${percent}%`;
  const zoomOut = document.getElementById('zoomOutBtn');
  const zoomIn = document.getElementById('zoomInBtn');
  if (zoomOut) zoomOut.disabled = previewZoom <= minZoom;
  if (zoomIn) zoomIn.disabled = previewZoom >= maxZoom;
}

function setPreviewZoom(zoom) {
  previewZoom = Math.min(
    Math.max(zoom, InstaFrameCore.MIN_PREVIEW_ZOOM || 0.5),
    InstaFrameCore.MAX_PREVIEW_ZOOM || 12
  );
  applyPreviewTransform();
  _syncPreviewZoomControl();
  updatePreviewViewModifiedState();
  // Every quality mode derives its backing density from zoom. Re-rendering is
  // required here; otherwise High/Max merely stretch their old bitmap in CSS.
  scheduleLivePreview();
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
  _flushLiveExifEdit();
  state.selectedItemId = id;
  for (const [itemId, entry] of _imgLoadEntries) {
    if (itemId === id) continue;
    entry.controller.abort();
    _imgLoadEntries.delete(itemId);
  }
  document.querySelectorAll('.image-card').forEach(c => c.classList.remove('selected-preview'));
  document.querySelectorAll('.card-preview').forEach(preview => preview.setAttribute('aria-pressed', 'false'));
  const el = document.getElementById(`item-${id}`);
  if (el) {
    el.classList.add('selected-preview');
    el.querySelector('.card-preview')?.setAttribute('aria-pressed', 'true');
  }
  // On mobile: auto-switch to preview tab so user can see the result
  if (window.innerWidth <= 768) {
    document.body.setAttribute('data-mobile-tab', 'preview');
    _setMobileTabState(document.getElementById('mobileTabBar'), 'preview');
    // The Photos panel becomes inert immediately. Wait for the newly selected
    // photo/video preview to expose the matching visible control before moving
    // focus, rather than leaving focus on the now-hidden card.
    _queueLoadedMediaFocus();
  }
  updateLiveExifPanel();
  scheduleLivePreview();
}

// ─── Preview Helpers ──────────────────────────────────────────────────────────
const PREVIEW_LAYOUT_LONG_EDGE = 6144;

/**
 * Stable hash of settings that affect composition. Preview quality is excluded:
 * it changes backing-store density only, never layout geometry.
 */
function _previewSettingsHash() {
  const s = state.settings;
  return ['stable-layout-v2',
    s.frameColor, s.frameBackground, s.blurRadius, s.blurStyle, s.blurBrightness,
    s.thicknessScale, s.imageOffsetY, s.fontFamily,
    s.shotOnFontScale, s.exifFontScale, s.lineGapScale, s.textOffsetY,
    s.cameraNameBold, s.cameraNameItalic, s.exifItalic, s.textColorMode, s.textColor,
    s.showShotOn, s.showExifInfo, s.cameraNameOnly,
    s.showLocation, s.locationPosition, s.locationIconStyle, s.outerPadding, s.aspectRatio, s.aspectOrientation,
    s.showMapOverlay, s.mapOverlayOpacity, s.mapOverlayPosition,
  ].join('|');
}

function _releaseDecodedImageSource(image, objectUrl = null) {
  image?.removeAttribute?.('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}

/** Drop all cached data for one item (call on remove + EXIF edit). */
function _invalidateItemCache(itemId) {
  _imgLoadEntries.get(itemId)?.controller.abort();
  _imgLoadEntries.delete(itemId);
  _releaseDecodedImageSource(_transientPreviewImages.get(itemId));
  _transientPreviewImages.delete(itemId);
  const e = _imgCache.get(itemId);
  if (e) { _releaseDecodedImageSource(e.img, e.objUrl); _imgCache.delete(itemId); }
  _imgFailed.delete(itemId);
  for (const k of [..._frameCache.keys()]) {
    if (k.startsWith(`${itemId}|`)) {
      const canvas = _frameCache.get(k);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      _frameCache.delete(k);
    }
  }
}

function _releaseItemOutput(item) {
  if (!item) return;
  item.exportController?.abort();
  item.exportController = null;
  item.exportRunToken = null;
  item.thumbnailController?.abort();
  _cancelQueuedVideoThumbnail(item);
  item.thumbnailController = null;
  if (item.canvas) { item.canvas.width = 0; item.canvas.height = 0; }
  item.canvas = null;
  item.videoBlob = null;
}

/** Load image for an item, sharing in-flight decodes and keeping safe results for re-use. */
async function _loadPreviewImage(item, { retainUncached = false } = {}) {
  if (_imgFailed.has(item.id)) throw new Error('Image load previously failed');
  const cached = _imgCache.get(item.id);
  if (cached) return cached.img;
  const transient = _transientPreviewImages.get(item.id);
  if (transient) {
    _transientPreviewImages.delete(item.id);
    return transient;
  }
  const existingLoad = _imgLoadEntries.get(item.id);
  if (existingLoad) return existingLoad.promise;

  const controller = new AbortController();
  const promise = _decodePreviewImage(item, controller.signal, retainUncached)
    .finally(() => {
      if (_imgLoadEntries.get(item.id)?.promise === promise) _imgLoadEntries.delete(item.id);
    });
  _imgLoadEntries.set(item.id, { promise, controller });
  return promise;
}

async function _decodePreviewImage(item, signal, retainUncached) {
  const objUrl = URL.createObjectURL(item.file);
  const img    = new Image();
  await new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abort);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      URL.revokeObjectURL(objUrl);
      fail(new DOMException('Image load cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    img.onload  = succeed;
    img.onerror = () => fail(new Error('Image load error'));
    timeoutId = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      URL.revokeObjectURL(objUrl);
      fail(new Error('Image load timed out'));
    }, PREVIEW_IMAGE_DECODE_GUARD_MS);
    img.src = objUrl;
    if (img.complete && img.naturalWidth) succeed();
  }).catch(e => {
    _releaseDecodedImageSource(img, objUrl);
    if (e?.name !== 'AbortError') _imgFailed.add(item.id);
    throw e;
  });

  const imagePixels = img.naturalWidth * img.naturalHeight;
  if (imagePixels > MAX_SOURCE_IMAGE_PIXELS) {
    _releaseDecodedImageSource(img, objUrl);
    _imgFailed.add(item.id);
    throw _mediaResourceLimitError();
  }

  let cachedPixels = [..._imgCache.values()].reduce(
    (sum, entry) => sum + entry.img.naturalWidth * entry.img.naturalHeight,
    0
  );
  while (_imgCache.size && cachedPixels + imagePixels > MAX_PREVIEW_CACHE_PIXELS) {
    const firstKey = _imgCache.keys().next().value;
    const first = _imgCache.get(firstKey);
    cachedPixels -= first.img.naturalWidth * first.img.naturalHeight;
    _releaseDecodedImageSource(first.img, first.objUrl);
    _imgCache.delete(firstKey);
  }
  if (imagePixels > MAX_PREVIEW_CACHE_PIXELS) {
    URL.revokeObjectURL(objUrl);
    if (retainUncached) _transientPreviewImages.set(item.id, img);
    return img;
  }
  _imgCache.set(item.id, { img, objUrl });
  return img;
}

/** Draw a rendered frame canvas into the live-preview canvas, DPR-aware. */
function _drawFrameToCanvas(canvas, pane, emptyEl, src) {
  const areaW = Math.max(pane.clientWidth  - 40, 80);
  const areaH = Math.max(pane.clientHeight - 40, 60);
  const ratio = src.height / src.width;

  let dispW = Math.min(areaW, Math.round(areaH / ratio));
  let dispH = Math.round(dispW * ratio);
  if (dispH > areaH) { dispH = areaH; dispW = Math.round(areaH / ratio); }
  dispW = Math.max(dispW, 80);
  dispH = Math.max(dispH, 60);

  const backing = _getLivePreviewBackingScale(dispW, dispH);
  const backingScale = backing.scale;

  canvas.width        = Math.round(dispW * backingScale);
  canvas.height       = Math.round(dispH * backingScale);
  canvas.style.width  = dispW + 'px';
  canvas.style.height = dispH + 'px';
  canvas.dataset.previewQuality = backing.quality;
  canvas.dataset.previewBackingScale = backingScale.toFixed(3);
  canvas.dataset.previewPixelBudget = String(backing.pixelBudget);
  canvas.dataset.compositionWidth = String(src.width);
  canvas.dataset.compositionHeight = String(src.height);
  canvas.dataset.previewSourceLimit = src.dataset.previewSourceLimit || '';

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
  _syncPreviewControlAvailability();
  _settleLoadedMediaFocus();
}

// ─── Canvas-based Video Preview ──────────────────────────────────────────────

function _cancelVideoCanvasPreviewFrame() {
  _videoPreviewFrameGeneration += 1;
  if (_videoPreviewFrameHandle === null) return;
  const handle = _videoPreviewFrameHandle;
  const mode = _videoPreviewFrameMode;
  _videoPreviewFrameHandle = null;
  _videoPreviewFrameMode = null;
  const video = document.getElementById('livePreviewVideo');
  try {
    if (mode === 'video' && typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(handle);
    } else if (mode === 'timeout') {
      clearTimeout(handle);
    } else {
      cancelAnimationFrame(handle);
    }
  } catch (_) { /* best-effort cancellation; generation invalidates late callbacks */ }
}

function _scheduleVideoCanvasPreviewFrame(video, callback, waitingForData = false) {
  const generation = ++_videoPreviewFrameGeneration;
  const guardedCallback = (...args) => {
    if (generation !== _videoPreviewFrameGeneration) return;
    _videoPreviewFrameHandle = null;
    _videoPreviewFrameMode = null;
    callback(...args);
  };
  // requestVideoFrameCallback is tied to frame presentation and is not
  // guaranteed to fire for a newly loaded video that remains paused. Poll only
  // the readiness phase so the first decoded frame appears deterministically;
  // subsequent playback frames still use the decoded-frame callback below.
  if (waitingForData) {
    _videoPreviewFrameMode = 'timeout';
    _videoPreviewFrameHandle = setTimeout(guardedCallback, 100);
    return;
  }
  if (!video._previewVideoFrameCallbacksUnavailable &&
      typeof video.requestVideoFrameCallback === 'function') {
    try {
      _videoPreviewFrameMode = 'video';
      _videoPreviewFrameHandle = video.requestVideoFrameCallback(guardedCallback);
      return;
    } catch (_) {
      video._previewVideoFrameCallbacksUnavailable = true;
    }
  }
  _videoPreviewFrameMode = 'animation';
  _videoPreviewFrameHandle = requestAnimationFrame(guardedCallback);
}

function _stopVideoCanvasPreview() {
  _cancelVideoCanvasPreviewFrame();
  if (_videoPreviewBaseCanvas) {
    _videoPreviewBaseCanvas.width = 0;
    _videoPreviewBaseCanvas.height = 0;
    _videoPreviewBaseCanvas = null;
  }
  _videoPreviewItemId = null;
}

function _clearLiveVideoReadinessGuard(video) {
  if (!video) return;
  clearTimeout(video._previewReadinessGuard);
  video._previewReadinessGuard = null;
}

function _clearLiveVideoSourceHandlers(video) {
  if (!video) return;
  _clearLiveVideoReadinessGuard(video);
  if (video._previewErrorHandler) {
    video.removeEventListener('error', video._previewErrorHandler);
    video._previewErrorHandler = null;
  }
}

function _setLivePreviewError(message = '') {
  const error = document.getElementById('livePreviewError');
  if (!error) return;
  if (message) {
    error.hidden = false;
    error.textContent = message;
    const toast = document.getElementById('toast');
    if (toast?.textContent === message && toast.getAttribute('role') === 'alert') {
      toast.removeAttribute('role');
      toast.removeAttribute('aria-live');
    }
    return;
  }
  error.hidden = true;
  error.textContent = '';
}

function _disposeLiveVideoSource() {
  _stopVideoCanvasPreview();
  const video = document.getElementById('livePreviewVideo');
  if (!video) return;
  _clearLiveVideoSourceHandlers(video);
  video._previewSourceGeneration = (video._previewSourceGeneration || 0) + 1;
  const objUrl = video._objUrl;
  video._objUrl = null;
  video._srcId = null;
  try { video.pause(); } catch (_) { /* best-effort media teardown */ }
  try { video.removeAttribute('src'); } catch (_) { /* best-effort media teardown */ }
  try { video.load(); } catch (_) { /* best-effort media teardown */ }
  if (objUrl) URL.revokeObjectURL(objUrl);
}

function _failLiveVideoPreview(itemId, generation) {
  const video = document.getElementById('livePreviewVideo');
  if (!video || video._srcId !== itemId || video._previewSourceGeneration !== generation) return;
  const item = state.items.find(candidate => candidate.id === itemId);
  _disposeLiveVideoSource();

  const canvas = document.getElementById('livePreviewCanvas');
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.display = 'none';
    canvas.style.opacity = '';
    canvas.style.transform = '';
  }
  const dropZone = document.getElementById('dropZone');
  dropZone?.classList.remove('has-video');
  dropZone?.classList.remove('has-preview');
  _syncPreviewControlAvailability();

  if (!item) return;
  item.status = 'error';
  const message = _setLocalizedItemError(item, 'msgUnsupportedMedia', { name: item.file.name });
  updateItemStatus(item);
  _setLivePreviewError(message);
}

function _armLiveVideoSourceHandlers(video, item) {
  _clearLiveVideoSourceHandlers(video);
  const generation = (video._previewSourceGeneration || 0) + 1;
  video._previewSourceGeneration = generation;
  video._previewErrorHandler = () => _failLiveVideoPreview(item.id, generation);
  video.addEventListener('error', video._previewErrorHandler);
  video._previewReadinessGuard = setTimeout(
    () => _failLiveVideoPreview(item.id, generation),
    LIVE_VIDEO_PREVIEW_GUARD_MS
  );
  return generation;
}

/**
 * Render decoded video frames (with EXIF text overlay) onto livePreviewCanvas.
 * Modern browsers schedule one draw per decoded frame; older browsers use a
 * bounded requestAnimationFrame fallback.
 * The hidden <video> element is used purely as a data/audio source.
 */
function _startVideoCanvasPreview(item) {
  if (_videoPreviewItemId === item.id && _videoPreviewFrameHandle !== null) return;
  if (_videoPreviewItemId !== item.id) {
    _stopVideoCanvasPreview();
    _videoPreviewItemId = item.id;
  }

  const video  = document.getElementById('livePreviewVideo');
  const canvas = document.getElementById('livePreviewCanvas');
  const pane   = document.getElementById('dropZone');
  if (!video || !canvas || !pane) return;
  let fallbackLastMediaTime = -1;
  let fallbackUnchangedFrames = 0;

  function drawFrame() {
    if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // A decoded video frame is not ready yet — draw loading placeholder
      const areaW = Math.max(pane.clientWidth  - 40, 80);
      const areaH = Math.max(pane.clientHeight - 40, 60);
      if (canvas.style.display === 'none' || canvas.style.display === '') {
        const backingScale = _getLivePreviewBackingScale(areaW, areaH).scale;
        canvas.width  = Math.round(areaW * backingScale);
        canvas.height = Math.round(areaH * backingScale);
        canvas.style.width  = areaW + 'px';
        canvas.style.height = areaH + 'px';
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        const fc  = state.settings.frameColor || '#F0F0F0';
        ctx.fillStyle = fc;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Subtle "loading" pulse text
        const isDark = FrameEngine.isColorDark(fc);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
        ctx.font = `${Math.round(14 * backingScale)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t('previewLoading'), canvas.width / 2, canvas.height / 2);
      }
      _scheduleVideoCanvasPreviewFrame(video, draw, true);
      return;
    }

    const layout = FrameEngine.computeVideoFrameLayout(
      video.videoWidth, video.videoHeight, state.settings, item.exif || {}
    );

    const areaW = Math.max(pane.clientWidth  - 40, 80);
    const areaH = Math.max(pane.clientHeight - 40, 60);
    const ratio = layout.canvasH / layout.canvasW;

    let dispW = Math.min(areaW, Math.round(areaH / ratio));
    let dispH = Math.round(dispW * ratio);
    if (dispH > areaH) { dispH = areaH; dispW = Math.round(areaH / ratio); }
    dispW = Math.max(dispW, 80);
    dispH = Math.max(dispH, 60);

    const backingScale = _getLivePreviewBackingScale(dispW, dispH).scale;

    const targetW = Math.round(dispW * backingScale);
    const targetH = Math.round(dispH * backingScale);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width        = targetW;
      canvas.height       = targetH;
      canvas.style.width  = dispW + 'px';
      canvas.style.height = dispH + 'px';
    }

    const firstShow = canvas.style.display === 'none' || canvas.style.display === '';
    if (firstShow) canvas.style.opacity = '0';
    canvas.style.display = 'block';
    if (firstShow) { void canvas.offsetWidth; canvas.style.opacity = '1'; }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(targetW / layout.canvasW, targetH / layout.canvasH);
    _videoPreviewBaseCanvas = FrameEngine.drawVideoFrameSync(
      ctx, video, item.exif || {}, state.settings, layout,
      _videoPreviewBaseCanvas, Math.min(targetW / layout.canvasW, targetH / layout.canvasH)
    );
    ctx.restore();
    _clearLiveVideoReadinessGuard(video);

    applyPreviewTransform();
    if (video.paused || video.ended || document.hidden) return;
    if (video._previewVideoFrameCallbacksUnavailable ||
        typeof video.requestVideoFrameCallback !== 'function') {
      const mediaTime = Number(video.currentTime) || 0;
      if (mediaTime > fallbackLastMediaTime) {
        fallbackLastMediaTime = mediaTime;
        fallbackUnchangedFrames = 0;
      } else {
        fallbackUnchangedFrames += 1;
        if (fallbackUnchangedFrames >= 30) return;
      }
    }
    _scheduleVideoCanvasPreviewFrame(video, draw);
  }

  function draw() {
    if (_videoPreviewItemId !== item.id) return; // stopped or superseded
    try { drawFrame(); }
    catch { _failLiveVideoPreview(item.id, video._previewSourceGeneration); }
  }

  draw();
}

async function renderLivePreview() {
  const pane    = document.getElementById('dropZone');
  const canvas  = document.getElementById('livePreviewCanvas');
  const emptyEl = document.getElementById('previewEmpty');
  if (!pane || !canvas) return;
  _setLivePreviewError();

  // ── Empty state ────────────────────────────────────────────────────────────
  if (state.items.length === 0) {
    _disposeLiveVideoSource();
    canvas.style.display = 'none';
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = '';
    canvas.style.height = '';
    if (emptyEl) emptyEl.style.display = '';
    pane.classList.remove('has-preview');
    pane.classList.remove('has-video');
    _syncPreviewControlAvailability();
    return;
  }

  const item = (state.selectedItemId && state.items.find(i => i.id === state.selectedItemId))
             || state.items[0];

  // ── Video: canvas-based framed preview ────────────────────────────────────
  const liveVideo = document.getElementById('livePreviewVideo');
  if (item.isVideo && liveVideo) {
    // Load video source if it changed (video element stays hidden — audio source only)
    if (!liveVideo._srcId || liveVideo._srcId !== item.id) {
      _disposeLiveVideoSource();
      liveVideo._objUrl = URL.createObjectURL(item.file);
      liveVideo._srcId  = item.id;
      const generation = _armLiveVideoSourceHandlers(liveVideo, item);
      try {
        liveVideo.src = liveVideo._objUrl;
        liveVideo.load();
      } catch {
        _failLiveVideoPreview(item.id, generation);
        return;
      }
    }
    // Video element stays hidden; canvas shows the framed video
    liveVideo.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    pane.classList.add('has-preview');
    pane.classList.add('has-video');
    _syncPreviewControlAvailability();
    _settleLoadedMediaFocus();
    _startVideoCanvasPreview(item);
    return;
  }
  // Switching away from video — stop the canvas loop
  _disposeLiveVideoSource();
  if (liveVideo) liveVideo.style.display = 'none';
  pane.classList.remove('has-video');
  _syncPreviewControlAvailability();

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
  const controller = new AbortController();
  const signal = controller.signal;
  _previewRenderController = controller;
  let previewImage = null;
  let releasePreviewImage = false;
  try {
    previewImage = await _waitForPreviewResource(_loadPreviewImage(item), signal);
    releasePreviewImage = _imgCache.get(item.id)?.img !== previewImage;

    // Pre-fetch map overlay image if enabled and coordinates are available
    let mapOverlayImg = null;
    if (state.settings.showMapOverlay && state.settings.showLocation &&
        item.exif && item.exif.latitude != null && item.exif.longitude != null) {
      mapOverlayImg = await _fetchMapOverlayImage(item.exif.latitude, item.exif.longitude, 13, signal);
    }

    const rendered = await FrameEngine.renderFrameWhenReady(
      previewImage, item.exif, state.settings,
      { maxPreviewPx: PREVIEW_LAYOUT_LONG_EDGE, mapOverlayImg, signal });

    rendered.dataset.previewSourceLimit = String(PREVIEW_LAYOUT_LONG_EDGE);

    if (signal.aborted || seq !== _renderSeq) {
      rendered.width = 0;
      rendered.height = 0;
      return;
    }

    const renderedPixels = rendered.width * rendered.height;
    let cachedPixels = [..._frameCache.values()].reduce(
      (sum, cachedCanvas) => sum + cachedCanvas.width * cachedCanvas.height,
      0
    );
    while (_frameCache.size && cachedPixels + renderedPixels > MAX_FRAME_CACHE_PIXELS) {
      const oldest = _frameCache.keys().next().value;
      const oldCanvas = _frameCache.get(oldest);
      if (oldCanvas) {
        cachedPixels -= oldCanvas.width * oldCanvas.height;
        oldCanvas.width = 0;
        oldCanvas.height = 0;
      }
      _frameCache.delete(oldest);
    }
    _drawFrameToCanvas(canvas, pane, emptyEl, rendered);
    if (renderedPixels <= MAX_FRAME_CACHE_PIXELS) _frameCache.set(hash, rendered);
    else { rendered.width = 0; rendered.height = 0; }
    applyPreviewTransform();
  } catch (error) {
    if (error?.name === 'AbortError' || signal.aborted || seq !== _renderSeq) return;
    // Framing, optional map, and isolated live-decoder failures remain
    // non-critical because a fresh export decode may recover. Surface only a
    // failure already confirmed by the independent card decoder, or a hard
    // resource limit that cannot recover on retry.
    if (_imgFailed.has(item.id) && (item.status === 'error' || error?.code === 'MEDIA_RESOURCE_LIMIT')) {
      if (error?.code === 'MEDIA_RESOURCE_LIMIT') {
        item.status = 'error';
        _setLocalizedItemError(item, 'msgMediaResourceLimit');
      }
      updateItemStatus(item);
      _setLivePreviewError(_getItemErrorMessage(item));
    }
  } finally {
    if (releasePreviewImage) _releaseDecodedImageSource(previewImage);
    if (_previewRenderController === controller) _previewRenderController = null;
  }
}

// ─── DOM Rendering ────────────────────────────────────────────────────────────
function _releaseCardThumbnailUrl(card) {
  const thumbnail = card?.querySelector?.('img.thumb-orig');
  if (!thumbnail) return;
  if (thumbnail._objectUrl) {
    URL.revokeObjectURL(thumbnail._objectUrl);
    thumbnail._objectUrl = null;
  }
  thumbnail.removeAttribute('src');
}

function _releaseCardPreviewResources(card) {
  _releaseCardThumbnailUrl(card);
  card?.querySelectorAll?.('canvas.thumb-source, canvas.thumb-framed').forEach(canvas => {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  });
  card?.querySelector?.('.card-preview')?.classList.remove('thumbnail-unavailable');
}

function _discardCardPhotoThumbnail(card, thumbnail, canvas = null) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  _releaseCardThumbnailUrl(card);
  if (thumbnail) {
    thumbnail.style.display = 'none';
    thumbnail.removeAttribute('src');
  }
  card?.querySelector?.('.card-preview')?.classList.add('thumbnail-unavailable');
}

function _compactCardPhotoThumbnail(card, thumbnail) {
  if (!card || !thumbnail?.naturalWidth || !thumbnail?.naturalHeight) {
    _discardCardPhotoThumbnail(card, thumbnail);
    return;
  }
  let canvas = null;
  try {
    const maxWidth = 400;
    const maxHeight = 400;
    const scale = Math.min(1, maxWidth / thumbnail.naturalWidth, maxHeight / thumbnail.naturalHeight);
    canvas = document.createElement('canvas');
    canvas.className = 'thumb-source';
    canvas.width = Math.max(1, Math.round(thumbnail.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(thumbnail.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable');
    context.drawImage(thumbnail, 0, 0, canvas.width, canvas.height);
    card.querySelector('.card-preview')?.insertBefore(canvas, thumbnail);
    thumbnail.style.display = 'none';
    _releaseCardThumbnailUrl(card);
    thumbnail.removeAttribute('src');
  } catch (_) {
    _discardCardPhotoThumbnail(card, thumbnail, canvas);
  }
}

function _startPhotoThumbnail(item) {
  if (!item || item.isVideo || !state.items.includes(item) || item.photoThumbnailPromise) {
    return item?.photoThumbnailPromise || null;
  }
  const card = document.getElementById(`item-${item.id}`);
  const thumbnail = card?.querySelector('img.thumb-orig');
  if (!card || !thumbnail || card.querySelector('canvas.thumb-source')) {
    item.photoThumbnailNeedsRestart = false;
    return null;
  }

  const controller = new AbortController();
  const { signal } = controller;
  item.photoThumbnailController = controller;
  item.photoThumbnailNeedsRestart = false;
  let thumbnailGuard = null;

  const thumbnailPromise = _queuePhotoThumbnail(item, () => new Promise((resolve, reject) => {
    if (signal.aborted || !state.items.includes(item) || !card.isConnected) {
      reject(new DOMException('Thumbnail cancelled', 'AbortError'));
      return;
    }
    thumbnailGuard = setTimeout(() => controller.abort(), PHOTO_THUMBNAIL_GUARD_MS);
    const objectUrl = URL.createObjectURL(item.file);
    thumbnail._objectUrl = objectUrl;
    let settled = false;
    const cleanup = () => {
      thumbnail.removeEventListener('load', loaded);
      thumbnail.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (callback, value, action) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (action === 'compact') _compactCardPhotoThumbnail(card, thumbnail);
      else if (action === 'discard') _discardCardPhotoThumbnail(card, thumbnail);
      callback(value);
    };
    const loaded = () => {
      if (!thumbnail.naturalWidth || !thumbnail.naturalHeight) {
        failed();
        return;
      }
      finish(resolve, undefined, 'compact');
    };
    const failed = () => {
      if (signal.aborted || _pageResourcesReleased || !state.items.includes(item)) {
        aborted();
        return;
      }
      const error = new Error('Photo thumbnail decode failed');
      error.code = 'IMAGE_DECODE_FAILED';
      finish(reject, error, 'discard');
    };
    const aborted = () => finish(
      reject,
      new DOMException('Thumbnail cancelled', 'AbortError'),
      'discard'
    );
    thumbnail.addEventListener('load', loaded);
    thumbnail.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    thumbnail.src = objectUrl;
    if (thumbnail.complete) queueMicrotask(thumbnail.naturalWidth ? loaded : failed);
  }))
    .catch(error => {
      if (error?.name === 'AbortError' || !state.items.includes(item)) return;
      _discardCardPhotoThumbnail(card, thumbnail);
      if (error?.code === 'IMAGE_DECODE_FAILED') {
        _imgFailed.add(item.id);
        item.status = 'error';
        const message = _setLocalizedItemError(item, 'msgUnsupportedMedia', { name: item.file.name });
        updateItemStatus(item);
        const selected = state.selectedItemId === item.id;
        if (selected) _setLivePreviewError(message);
        showToast(message, 'error', { announce: !selected });
      }
    })
    .finally(() => {
      clearTimeout(thumbnailGuard);
      if (item.photoThumbnailController === controller) item.photoThumbnailController = null;
      if (item.photoThumbnailPromise === thumbnailPromise) item.photoThumbnailPromise = null;
    });
  item.photoThumbnailPromise = thumbnailPromise;
  return thumbnailPromise;
}

function _restartInterruptedPhotoThumbnail(item) {
  if (!item?.photoThumbnailNeedsRestart || !state.items.includes(item)) return;
  const restart = () => {
    if (!item.photoThumbnailNeedsRestart || !state.items.includes(item)) return;
    const card = document.getElementById(`item-${item.id}`);
    item.photoThumbnailNeedsRestart = false;
    if (!card?.querySelector('canvas.thumb-source')) _startPhotoThumbnail(item);
  };
  if (item.photoThumbnailPromise) void item.photoThumbnailPromise.then(restart, restart);
  else restart();
}

function renderItem(item) {
  const grid = document.getElementById('imageGrid');
  const emptyMsg = document.getElementById('emptyMsg');
  if (emptyMsg) emptyMsg.remove();

  const card = document.createElement('div');
  card.className = 'image-card';
  card.id = `item-${item.id}`;

  card.innerHTML = `
    <button type="button" class="card-preview" id="preview-${item.id}" aria-pressed="false" aria-label="${escHtml(tf('selectPreview', { name: item.file.name }))}" aria-describedby="status-badge-${item.id}">
      ${item.isVideo ? '<div class="video-badge">▶</div>' : ''}
      <img class="thumb-orig" alt="">
      <div class="card-status" id="status-badge-${item.id}">
        <span class="status-dot pending"></span>
        <span class="status-text" data-i18n="statusPending">${t('statusPending')}</span>
      </div>
    </button>
    <div class="card-body">
      <div class="card-filename">${escHtml(item.file.name)}</div>
      <div class="card-actions">
        <button class="btn btn-sm btn-primary" id="dl-btn-${item.id}" data-action="download" aria-label="${escHtml(tf('downloadSingleNamed', { name: item.file.name }))}">
          <span data-i18n="downloadSingle">${t('downloadSingle')}</span>
        </button>
        <button class="btn btn-sm btn-danger" data-action="remove" aria-label="${escHtml(tf('removeNamed', { name: item.file.name }))}">
          <span data-i18n="remove">${t('remove')}</span>
        </button>
      </div>
    </div>
  `;

  // Click preview image/video → select for live preview
  card.querySelector('.card-preview').addEventListener('click', () => {
    selectItem(item.id);
  });
  card.querySelector('[data-action="download"]')?.addEventListener('click', () => applyAndDownloadSingle(item.id));
  card.querySelector('[data-action="remove"]')?.addEventListener('click', () => removeItem(item.id));

  // Click card body (not buttons) → select for live preview
  card.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('.card-preview')) return;
    selectItem(item.id);
  });

  grid.appendChild(card);
  if (!item.isVideo) _startPhotoThumbnail(item);
}

function updateItemStatus(item) {
  const badge = document.getElementById(`status-badge-${item.id}`);
  if (!badge) return;

  const dot  = badge.querySelector('.status-dot');
  const text = badge.querySelector('.status-text');

  dot.className = `status-dot ${item.status}`;
  const errorMessage = item.status === 'error' ? _getItemErrorMessage(item) : '';
  if (errorMessage) {
    item.errorMsg = errorMessage;
    badge.setAttribute('aria-label', errorMessage);
    badge.title = errorMessage;
  } else {
    badge.removeAttribute('aria-label');
    badge.removeAttribute('title');
  }

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
    const sourceCanvas = previewDiv.querySelector('canvas.thumb-source');
    if (sourceCanvas) sourceCanvas.style.display = 'none';
    if (item.isVideo) {
      // Video done: thumbnail stays, add a "ready" overlay on badge; enable download
      const framedCanvas = previewDiv.querySelector('canvas.thumb-framed');
      const origThumb = previewDiv.querySelector('img.thumb-orig');
      if (origThumb) origThumb.style.display = framedCanvas ? 'none' : '';
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
    const sourceCanvas = previewDiv.querySelector('canvas.thumb-source');
    const origThumb = previewDiv.querySelector('img.thumb-orig');
    if (item.isVideo && framedCanvas) {
      if (origThumb) origThumb.style.display = 'none';
    } else {
      if (framedCanvas) {
        framedCanvas.width = 0;
        framedCanvas.height = 0;
        framedCanvas.remove();
      }
      if (sourceCanvas) sourceCanvas.style.display = '';
      if (origThumb) origThumb.style.display = sourceCanvas ? 'none' : '';
    }
    // Download button stays enabled — clicking it will auto-generate then download
    if (dlBtn) dlBtn.disabled = (item.status === 'processing');
  }
}

function updateImageCounter() {
  const count = state.items.length;
  const visual = document.getElementById('imageCounterVisual');
  const status = document.getElementById('imageCounterStatus');
  if (visual) visual.textContent = count ? `(${count})` : '';
  if (status) status.textContent = count ? tf('imageCount', { count }) : '';
}

function updateUI() {
  const hasItems = state.items.length > 0;
  const hasPendingImports = _reservedImportItems > 0;
  const hasWorkspaceItems = hasItems || hasPendingImports;
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.tabIndex = hasItems ? -1 : 0;
    if (hasItems && document.activeElement === fileInput) {
      _requestLoadedMediaFocus();
    }
  }
  const exifWrap = document.getElementById('previewExifWrap');
  if (exifWrap) {
    exifWrap.inert = !hasItems;
    exifWrap.setAttribute('aria-hidden', String(!hasItems));
  }

  const genBtn  = document.getElementById('generateAllBtn');
  const dlBtn   = document.getElementById('downloadAllBtn');
  const clrBtn  = document.getElementById('clearAllBtn');

  if (genBtn)  genBtn.disabled  = _globalExportBusy || !hasItems;
  if (dlBtn)   dlBtn.disabled   = _globalExportBusy || !hasItems;
  if (clrBtn)  clrBtn.disabled  = _globalExportBusy || !hasWorkspaceItems;
  updateImageCounter();

  setVisible(document.getElementById('imageSection'), hasWorkspaceItems, 'flex');
  setVisible(document.getElementById('emptyHint'),    !hasWorkspaceItems);
  const resizeHandle = document.getElementById('mainResizeHandle');
  if (resizeHandle) {
    resizeHandle.style.display = hasItems ? 'block' : 'none';
    resizeHandle.tabIndex = hasItems && window.innerWidth > 768 ? 0 : -1;
  }

  // Update mobile tap-to-import overlay
  if (typeof _updateMobileEmptyOverlay === 'function') {
    _updateMobileEmptyOverlay();
  }

  // If no items, reset the drop zone to its empty/clickable state
  if (!hasItems) {
    _clearLoadedMediaFocusRequest();
    _disposeLiveVideoSource();
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
      dropZone.classList.remove('has-preview');
      dropZone.classList.remove('has-video');
    }
    _syncPreviewControlAvailability();
    const previewCanvas = document.getElementById('livePreviewCanvas');
    if (previewCanvas) { previewCanvas.style.display = 'none'; previewCanvas.style.opacity = ''; previewCanvas.style.transform = ''; }
    const liveVideo = document.getElementById('livePreviewVideo');
    if (liveVideo) { liveVideo.style.display = 'none'; liveVideo.pause(); }
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
    if (dlBtn) dlBtn.disabled = _globalExportBusy || item.status === 'processing';
  });
}

function setGlobalBusy(busy) {
  _globalExportBusy = busy;
  if (busy && !_exportProgressPreviousFocus) {
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body) _exportProgressPreviousFocus = activeElement;
  }
  document.getElementById('generateAllBtn').disabled = busy;
  document.getElementById('downloadAllBtn').disabled = busy;
  const clrBtn = document.getElementById('clearAllBtn');
  if (clrBtn) clrBtn.disabled = busy || state.items.length === 0;
  state.items.forEach(item => {
    const itemDownload = document.getElementById(`dl-btn-${item.id}`);
    if (itemDownload) itemDownload.disabled = busy || item.status === 'processing';
  });
}

// ─── Export progress bar ──────────────────────────────────────────────────────
function showProgress(label, pct) {
  const wrap  = document.getElementById('exportProgress');
  const fill  = document.getElementById('exportProgressFill');
  const lbl   = document.getElementById('exportProgressLabel');
  const pctEl = document.getElementById('exportProgressPct');
  if (!wrap) return;
  const wasHidden = wrap.classList.contains('is-hidden');
  if (wasHidden) {
    if (!_exportProgressPreviousFocus) _exportProgressPreviousFocus = document.activeElement;
    _lastProgressAnnouncement = -1;
  }
  setVisible(wrap, true);
  document.getElementById('imageSection')?.setAttribute('aria-busy', 'true');
  const cancelBtn = document.getElementById('cancelExportBtn');
  if (cancelBtn) cancelBtn.style.display = '';
  const p = Math.max(0, Math.min(1, pct));
  fill.style.width   = Math.round(p * 100) + '%';
  const meter = document.getElementById('exportProgressMeter');
  meter?.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  meter?.setAttribute('aria-valuetext', `${Math.round(p * 100)}% — ${label}`);
  lbl.textContent    = label;
  if (pctEl) pctEl.textContent = Math.round(p * 100) + '%';
  const decile = Math.floor(p * 10);
  if (decile !== _lastProgressAnnouncement) {
    _lastProgressAnnouncement = decile;
    const status = document.getElementById('exportProgressStatus');
    if (status) status.textContent = `${Math.round(p * 100)}% — ${label}`;
  }
  if (wasHidden) cancelBtn?.focus();
}

function hideProgress() {
  const wrap = document.getElementById('exportProgress');
  const cancelBtn = document.getElementById('cancelExportBtn');
  const activeElement = document.activeElement;
  const shouldRestoreFocus = activeElement === document.body
    || activeElement === cancelBtn
    || wrap?.contains(activeElement);
  setVisible(wrap, false);
  document.getElementById('imageSection')?.setAttribute('aria-busy', 'false');
  if (cancelBtn) cancelBtn.style.display = 'none';
  const previousFocus = _exportProgressPreviousFocus;
  _exportProgressPreviousFocus = null;
  if (shouldRestoreFocus) {
    queueMicrotask(() => previousFocus?.isConnected && previousFocus.focus?.());
  }
}

// ─── Video format helpers ─────────────────────────────────────────────────────
const VIDEO_FORMAT_MAP = {
  'vp9':  'video/webm;codecs=vp9,opus',
  'vp8':  'video/webm;codecs=vp8,opus',
  'mp4':  'video/mp4',
  'webm': 'video/webm',
};

function _supportsVideoExportMime(mime) {
  try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime); }
  catch { return false; }
}

function resolveVideoMime(formatKey) {
  if (!formatKey) {
    // Auto: pick best supported
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(_supportsVideoExportMime) || '';
  }
  const mime = VIDEO_FORMAT_MAP[formatKey] || formatKey;
  return _supportsVideoExportMime(mime) ? mime : resolveVideoMime('');
}

function initVideoFormatOptions() {
  const container = document.getElementById('videoFormatPills');
  if (!container) return;

  const candidates = [
    { label: 'MP4',  value: 'mp4',  mime: 'video/mp4' },
    { label: 'VP9',  value: 'vp9',  mime: 'video/webm;codecs=vp9,opus' },
    { label: 'VP8',  value: 'vp8',  mime: 'video/webm;codecs=vp8,opus' },
  ].filter(format => _supportsVideoExportMime(format.mime));

  document.querySelectorAll('input[name="exportVideoBitrate"]').forEach(control => {
    control.disabled = candidates.length === 0;
  });
  if (!candidates.length) {
    container.removeAttribute('role');
    container.removeAttribute('aria-labelledby');
    const message = document.createElement('p');
    message.className = 'export-format-unavailable';
    message.setAttribute('role', 'status');
    message.setAttribute('data-i18n', 'videoExportUnavailable');
    message.textContent = t('videoExportUnavailable');
    container.replaceChildren(message);
    state.settings.exportVideoFormat = '';
    return;
  }

  container.setAttribute('role', 'radiogroup');
  container.setAttribute('aria-labelledby', 'exportVideoFormatLabel');
  const selectedFormat = candidates.some(format => format.value === state.settings.exportVideoFormat)
    ? state.settings.exportVideoFormat
    : candidates[0].value;

  container.innerHTML = candidates.map(f => `
    <div class="ratio-pill">
      <input type="radio" name="exportVideoFormat" id="vfmt-${f.value}" value="${f.value}" ${f.value === selectedFormat ? 'checked' : ''}>
      <label for="vfmt-${f.value}">${f.label}</label>
    </div>`).join('');

  state.settings.exportVideoFormat = selectedFormat;

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
  markItemsPending(item => item.isVideo);
  updateUI();
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showToast(msg, type = 'info', { announce = true } = {}) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.removeAttribute('role');
  toast.removeAttribute('aria-live');
  toast.textContent = '';
  void toast.offsetWidth;
  if (announce) {
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  }
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
    toast.textContent = '';
    toast.removeAttribute('role');
    toast.removeAttribute('aria-live');
  }, 3500);
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
function setupDropZone() {
  const zone  = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  const mobileInput = document.getElementById('mobileFileInput');

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

  if (mobileInput) {
    mobileInput.accept = input.accept;
    mobileInput.multiple = input.multiple;
  }
  [input, mobileInput].filter(Boolean).forEach(fileInput => {
    fileInput.addEventListener('change', async () => {
      const previousCount = state.items.length;
      const selectedFiles = Array.from(fileInput.files || []);
      fileInput.value = '';
      const importPromise = addFiles(selectedFiles);
      selectedFiles.length = 0;
      await importPromise;
      if (fileInput === mobileInput && state.items.length > previousCount) {
        _requestLoadedMediaFocus();
      }
    });
  });

  // Scroll-wheel zoom (only when preview is active)
  zone.addEventListener('wheel', e => {
    if (!zone.classList.contains('has-preview')) return;
    if (e.deltaY === 0) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setPreviewZoom(previewZoom * factor);
  }, { passive: false });

  // Zoom slider
  const zoomRange = document.getElementById('zoomRange');
  if (zoomRange) {
    _syncPreviewZoomControl();
    zoomRange.addEventListener('input', () => {
      setPreviewZoom(InstaFrameCore.getPreviewZoomForSliderValue(zoomRange.value));
    });
  }

  // Zoom ± buttons
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => setPreviewZoom(previewZoom / 1.2));
  document.getElementById('zoomInBtn')?.addEventListener('click',  () => setPreviewZoom(previewZoom * 1.2));

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
  const normalized = String(text ?? '').replace(',', '.');
  // Guard against excessively long pasted strings in editable range labels.
  if (normalized.length > MAX_EDITABLE_RANGE_INPUT_LENGTH) return null;
  // Accept suffixes shown in UI labels so users can edit in-place without removing units.
  const m = normalized.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*(%|×|px)?\s*$/i);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  if (allowedUnits.length > 0 && unit && !allowedUnits.map(u => String(u).toLowerCase()).includes(unit)) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function _isDevHost() {
  if (typeof window === 'undefined' || !window.location) return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
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
        try { sel.selectAllChildren(valEl); } catch (err) {
          if (_isDevHost()) {
            console.debug('Text selection failed for editable range value (visual-only fallback):', err);
          }
        }
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

  // Font style and visibility controls
  ['cameraNameBold', 'cameraNameItalic', 'exifItalic', 'showShotOn', 'showExifInfo', 'showLocation'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applySettings);
  });

  document.querySelectorAll('input[name="textColorMode"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
  });
  const textColorPicker = document.getElementById('textColorPicker');
  textColorPicker?.addEventListener('input', () => {
    const custom = document.getElementById('text-color-custom');
    if (custom) custom.checked = true;
    applySettings();
  });

  const mapOverlayToggle = document.getElementById('showMapOverlay');
  mapOverlayToggle?.addEventListener('change', async () => {
    if (mapOverlayToggle.checked && !await requestLocationNetworkConsent()) {
      mapOverlayToggle.checked = false;
    }
    if (mapOverlayToggle.checked && !getMapboxToken()) {
      mapOverlayToggle.checked = false;
      showToast(t('msgMapboxUnavailable'), 'warn');
    }
    applySettings();
  });

  // Live EXIF panel inputs: apply immediately on each change
  ['live-exif-make', 'live-exif-model', 'live-exif-lens', 'live-exif-fl', 'live-exif-fn', 'live-exif-et', 'live-exif-iso', 'live-exif-location']
    .forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', scheduleLiveExifEditApply);
      el.addEventListener('change', scheduleLiveExifEditApply);
    });
  document.getElementById('resolveLocationNameBtn')?.addEventListener('click', resolveLiveExifLocation);

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
  const iconButtons = [...document.querySelectorAll('.icon-pick-btn')];
  iconButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      _syncLocationIconPicker(btn.dataset.icon);
      applySettings();
    });
    btn.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = iconButtons.length - 1;
      else {
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        nextIndex = (index + direction + iconButtons.length) % iconButtons.length;
      }
      const next = iconButtons[nextIndex];
      _syncLocationIconPicker(next.dataset.icon, { focus: true });
      applySettings();
    });
  });

  // Location position radios
  document.querySelectorAll('input[name="locationPos"]').forEach(r => {
    r.addEventListener('change', applySettings);
  });
  document.querySelectorAll('input[name="mapOverlayPos"]').forEach(r => {
    r.addEventListener('change', applySettings);
  });

  // Aspect ratio radios
  document.querySelectorAll('input[name="aspectRatio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked && ['4:5', '3:4', '9:16'].includes(radio.value)) {
        const portrait = document.getElementById('aspect-orientation-portrait');
        if (portrait) portrait.checked = true;
      }
      applySettings();
    });
  });
  document.querySelectorAll('input[name="aspectOrientation"]').forEach(radio => {
    radio.addEventListener('change', applySettings);
  });

  // ── Export: photo format + quality ───────────────────────────────────────
  document.querySelectorAll('input[name="exportPhotoFormat"]').forEach(r => {
    r.addEventListener('change', () => {
      _syncPhotoQualityAvailability(r.value);
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

function _isInteractiveShortcutTarget(target) {
  return !!target?.closest?.('button, a, [role="button"], [role="radio"], [role="tab"], [role="menuitem"]');
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if (_isTypingTarget(e.target)) return;
    if (document.querySelector('.map-modal.open')) return;

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
    if (_isInteractiveShortcutTarget(e.target)) return;
    if (key === 'delete' || key === 'backspace') {
      if (state.selectedItemId != null) {
        e.preventDefault();
        removeItem(state.selectedItemId);
      }
    }
    // Space: toggle video play/pause when a video is in preview
    if (key === ' ') {
      const item = getSelectedPreviewItem();
      if (item && item.isVideo) {
        e.preventDefault();
        const video = document.getElementById('livePreviewVideo');
        if (video) {
          if (video.paused || video.ended) {
            if (video.ended) video.currentTime = 0;
            video.play().catch(() => {});
          } else {
            video.pause();
          }
        }
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
    el.classList.remove('is-hidden');
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
      el.classList.add('is-hidden');
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
const QUALITY_I18N_KEYS = {
  auto: 'previewQualityAutoShort',
  draft: 'previewQualityDraftShort',
  normal: 'previewQualityNormalShort',
  high: 'previewQualityHighShort',
  max: 'previewQualityMaxShort',
};

function setupPreviewQuality() {
  const btn   = document.getElementById('previewQualityBtn');
  const popup = document.getElementById('previewQualityPopup');
  const label = document.getElementById('previewQualityLabel');
  if (!btn || !popup) return;

  // Restore saved quality
  const saved = loadPrefs().previewQuality || 'auto';
  setPreviewQuality(saved, { schedule: false });

  const options = [...popup.querySelectorAll('.pq-option')];
  const closePopup = ({ restoreFocus = false, allowFocusToLeave = false } = {}) => {
    const focusedInside = popup.contains(document.activeElement);
    popup.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus || (focusedInside && !allowFocusToLeave)) btn.focus();
  };
  const openPopup = () => {
    popup.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    (options.find(option => option.getAttribute('aria-checked') === 'true') || options[0])?.focus();
  };
  const chooseOption = opt => {
    const q = opt.dataset.q;
    setPreviewQuality(q, { schedule: false });
    closePopup({ restoreFocus: true });
    scheduleLivePreview();
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (popup.classList.contains('open')) closePopup();
    else openPopup();
  });

  options.forEach(opt => {
    opt.addEventListener('click', () => chooseOption(opt));
    opt.addEventListener('keydown', event => {
      const index = options.indexOf(opt);
      let nextIndex = null;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % options.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + options.length) % options.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = options.length - 1;
      if (nextIndex != null) {
        event.preventDefault();
        options[nextIndex].focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseOption(opt);
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        closePopup({
          restoreFocus: event.key === 'Escape',
          allowFocusToLeave: event.key === 'Tab',
        });
      }
    });
  });

  document.addEventListener('click', e => {
    if (!btn.contains(e.target) && !popup.contains(e.target)) {
      closePopup();
    }
  });
  document.addEventListener('instaframe:languagechange', refreshPreviewQualityTranslation);
}

function _applyQualitySelection(q, popup, label) {
  popup.querySelectorAll('.pq-option').forEach(o => {
    const selected = o.dataset.q === q;
    o.classList.toggle('active', selected);
    o.setAttribute('aria-checked', String(selected));
  });
  const translatedValue = t(QUALITY_I18N_KEYS[q] || QUALITY_I18N_KEYS.auto);
  if (label) label.textContent = translatedValue;
  document.getElementById('previewQualityBtn')?.setAttribute(
    'aria-label',
    tf('previewQualityControl', { value: translatedValue })
  );
  updatePreviewViewModifiedState();
}

function setPreviewQuality(q, options = {}) {
  const { schedule = false } = options;
  const quality = InstaFrameCore.normalizePreviewQuality(q);
  const prefs = loadPrefs();
  prefs.previewQuality = quality;
  savePrefs(prefs);
  const popup = document.getElementById('previewQualityPopup');
  const label = document.getElementById('previewQualityLabel');
  if (popup) _applyQualitySelection(quality, popup, label);
  else updatePreviewViewModifiedState();
  if (schedule) scheduleLivePreview();
}

function refreshPreviewQualityTranslation() {
  const quality = InstaFrameCore.normalizePreviewQuality(loadPrefs().previewQuality);
  const popup = document.getElementById('previewQualityPopup');
  const label = document.getElementById('previewQualityLabel');
  if (popup) _applyQualitySelection(quality, popup, label);
}

// ─── Sidebar Resize ───────────────────────────────────────────────────────────
function setupSidebarResize() {
  const handle  = document.getElementById('sidebarResizeHandle');
  const sidebar = document.querySelector('.sidebar');
  if (!handle || !sidebar) return;

  const minWidth = 220;
  const maxWidth = 480;
  const applyWidth = (value, persist = false) => {
    const width = Math.min(Math.max(Math.round(value), minWidth), maxWidth);
    document.documentElement.style.setProperty('--sidebar-w', width + 'px');
    handle.setAttribute('aria-valuenow', String(width));
    if (persist) {
      const nextPrefs = loadPrefs();
      nextPrefs.sidebarWidth = width;
      savePrefs(nextPrefs);
      scheduleLivePreview();
    }
    return width;
  };

  const prefs = loadPrefs();
  if (prefs.sidebarWidth) {
    applyWidth(prefs.sidebarWidth);
  } else applyWidth(sidebar.offsetWidth);

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
    applyWidth(_startW + delta);
  });

  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    applyWidth(sidebar.offsetWidth, true);
  });

  handle.addEventListener('keydown', event => {
    const current = sidebar.offsetWidth;
    let next = null;
    if (event.key === 'ArrowLeft') next = current + (isRight() ? 10 : -10);
    if (event.key === 'ArrowRight') next = current + (isRight() ? -10 : 10);
    if (event.key === 'Home') next = minWidth;
    if (event.key === 'End') next = maxWidth;
    if (next == null) return;
    event.preventDefault();
    applyWidth(next, true);
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
function savePrefs(p)  { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'light');
}
function applyLayout(layout) {
  document.documentElement.setAttribute('data-layout', layout || 'left');
}
function applyEditorSize(size) {
  const normalized = ['compact', 'comfortable', 'large'].includes(size) ? size : 'comfortable';
  document.documentElement.setAttribute('data-editor-size', normalized);
}

function rerenderCards() {
  state.items.forEach(item => {
    const card = document.getElementById(`item-${item.id}`);
    const preview = card?.querySelector('.card-preview');
    preview?.setAttribute('aria-label', tf('selectPreview', { name: item.file.name }));
    card?.querySelector('[data-action="download"]')?.setAttribute(
      'aria-label',
      tf('downloadSingleNamed', { name: item.file.name })
    );
    card?.querySelector('[data-action="remove"]')?.setAttribute(
      'aria-label',
      tf('removeNamed', { name: item.file.name })
    );
    updateItemStatus(item);
    if (item.status === 'done') updateItemPreview(item);
  });
  const livePreviewError = document.getElementById('livePreviewError');
  if (livePreviewError && !livePreviewError.hidden) {
    const selectedItem = getSelectedPreviewItem();
    if (selectedItem?.status === 'error') _setLivePreviewError(_getItemErrorMessage(selectedItem));
  }
  updateUI();
}

function setupCustomizePanel() {
  const btn    = document.getElementById('customizeBtn');
  const panel  = document.getElementById('customizePanel');
  const scroll = document.getElementById('sidebarScroll');
  if (!btn || !panel || !scroll) return;

  const setOpen = open => {
    panel.classList.toggle('panel-open', open);
    scroll.classList.toggle('panel-open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    scroll.inert = open;
    scroll.setAttribute('aria-hidden', String(open));
    if (open) panel.querySelector('input, button, select, a')?.focus();
  };

  // Toggle panel visibility — class-based so CSS transitions run
  btn.addEventListener('click', () => {
    const open = panel.classList.contains('panel-open');
    setOpen(!open);
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
    btn.focus();
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

  // ── EXIF editor size ───────────────────────────────────────────────────────
  const savedEditorSize = prefs.editorSize || 'comfortable';
  applyEditorSize(savedEditorSize);
  document.querySelectorAll('input[name="editorSizeChoice"]').forEach(r => {
    if (r.value === savedEditorSize) r.checked = true;
    r.addEventListener('change', () => {
      applyEditorSize(r.value);
      const p = loadPrefs(); p.editorSize = r.value; savePrefs(p);
    });
  });

  // ── Accent color presets ───────────────────────────────────────────────────
  const accentSwatches = document.getElementById('accentSwatches');
  const accentPicker   = document.getElementById('accentColorPicker');
  const savedAccent    = prefs.accentColor;

  function _activateSwatch(color, { custom = false } = {}) {
    document.querySelectorAll('.accent-swatch').forEach(s => {
      const active = !custom && s.dataset.color === color;
      s.classList.toggle('active', active);
      s.setAttribute('aria-pressed', String(active));
    });
    const customBtn = document.getElementById('accentCustomBtn');
    const isPreset  = !!document.querySelector(`.accent-swatch[data-color="${color}"]`);
    const customActive = custom || !isPreset;
    if (customBtn) {
      customBtn.classList.toggle('active', customActive);
      customBtn.setAttribute('aria-pressed', String(customActive));
    }
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
  document.getElementById('accentCustomBtn')?.addEventListener('click', () => accentPicker?.click());
  if (accentPicker) {
    accentPicker.addEventListener('input', () => {
      _applyAccentColor(accentPicker.value);
      _activateSwatch(accentPicker.value, { custom: true });
      const p = loadPrefs(); p.accentColor = accentPicker.value; savePrefs(p);
    });
  }
  // Restore saved accent (default to cyan)
  const effectiveAccent = savedAccent || '#08798f';
  _applyAccentColor(effectiveAccent);
  _activateSwatch(effectiveAccent);

}

// ─── Mobile Tab Bar ───────────────────────────────────────────────────────────
function _syncMobileTabPanels(tabBar, tab, mobile) {
  if (!tabBar) return;
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) return;
    const selected = btn.dataset.tab === tab;
    panel.hidden = mobile && !selected;
    panel.inert = mobile && !selected;
    if (mobile) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', btn.id);
      panel.setAttribute('aria-hidden', String(!selected));
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-labelledby');
      panel.removeAttribute('aria-hidden');
    }
  });
}

function _setMobileTabState(tabBar, tab) {
  if (!tabBar) return;
  document.body.setAttribute('data-mobile-tab', tab);
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    const selected = btn.dataset.tab === tab;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
  _syncMobileTabPanels(tabBar, tab, window.innerWidth <= 768);
}

function setupMobileTabs() {
  const tabBar = document.getElementById('mobileTabBar');
  if (!tabBar) return;

  function isMobile() { return window.innerWidth <= 768; }
  let mobileLayoutActive = isMobile();
  let lastFocusedMobileTab = null;
  let lastFocusedResizeHandleTab = null;
  let lastFocusedDesktopElement = null;

  document.addEventListener('focusin', event => {
    if (event.target?.id === 'sidebarResizeHandle') lastFocusedResizeHandleTab = 'settings';
    else if (event.target?.id === 'mainResizeHandle') lastFocusedResizeHandleTab = 'preview';
    else if (!isMobile()) lastFocusedResizeHandleTab = null;
    if (!isMobile() && event.target?.closest?.('.mobile-tab-panel')) {
      lastFocusedDesktopElement = event.target;
    }
  });

  function switchTab(tab) {
    if (!isMobile()) return;
    _setMobileTabState(tabBar, tab);

    // When switching to preview tab, fire a live preview update
    if (tab === 'preview') scheduleLivePreview();

    // Update tap-to-import overlay visibility for the new tab
    updateEmptyTapOverlay();
  }

  function tabForPanel(panel) {
    if (!panel?.id) return null;
    return tabBar.querySelector(`.tab-btn[aria-controls="${panel.id}"]`)?.dataset.tab || null;
  }

  function desktopFocusTarget(tab) {
    if (tab === 'settings') return document.getElementById('customizeBtn');
    if (tab === 'photos') {
      return document.querySelector('.image-card.selected-preview .card-preview, .image-card .card-preview')
        || document.getElementById('addMoreBtn');
    }
    return state.items.length
      ? document.getElementById('previewQualityBtn')
      : document.getElementById('fileInput');
  }

  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    btn.addEventListener('focus', () => { lastFocusedMobileTab = btn.dataset.tab; });
    btn.addEventListener('keydown', event => {
      const tabs = [...tabBar.querySelectorAll('.tab-btn')];
      const index = tabs.indexOf(btn);
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      switchTab(tabs[nextIndex].dataset.tab);
      tabs[nextIndex].focus();
    });
  });

  // Default to preview tab on mobile
  if (isMobile()) {
    _setMobileTabState(tabBar, 'preview');
  } else _syncMobileTabPanels(tabBar, '', false);

  // Reset to no tab attribute on desktop
  window.addEventListener('resize', () => {
    const activeElement = document.activeElement;
    const hiddenResizeHandleFocused = activeElement?.matches?.('#sidebarResizeHandle, #mainResizeHandle');
    const openModalContainsFocus = [...document.querySelectorAll('.map-modal.open')]
      .some(modal => modal.contains(activeElement));
    const mobileNow = isMobile();
    const layoutChanged = mobileNow !== mobileLayoutActive;
    const focusedResizeHandleTab = layoutChanged && mobileNow ? lastFocusedResizeHandleTab : null;
    if (!mobileNow) {
      const focusedTab = activeElement?.closest?.('.tab-btn')?.dataset.tab
        || (layoutChanged ? lastFocusedMobileTab : null);
      document.body.removeAttribute('data-mobile-tab');
      _syncMobileTabPanels(tabBar, '', false);
      if (focusedTab && !openModalContainsFocus) desktopFocusTarget(focusedTab)?.focus();
    }
    else {
      const activePanel = activeElement?.closest?.('.mobile-tab-panel');
      const focusedPanelTab = tabForPanel(activePanel);
      const rememberedPanel = lastFocusedDesktopElement?.isConnected
        ? lastFocusedDesktopElement.closest('.mobile-tab-panel')
        : null;
      const rememberedPanelTab = layoutChanged && !openModalContainsFocus
        ? tabForPanel(rememberedPanel)
        : null;
      const restoreRememberedFocus = rememberedPanelTab
        && !focusedPanelTab
        && !focusedResizeHandleTab
        && (!activeElement || activeElement === document.body || !activeElement.isConnected);
      const currentTab = document.body.getAttribute('data-mobile-tab');
      const activeTab = focusedPanelTab || focusedResizeHandleTab || rememberedPanelTab || currentTab || 'preview';
      if (layoutChanged || !currentTab || (focusedPanelTab && focusedPanelTab !== currentTab)) {
        _setMobileTabState(tabBar, activeTab);
        if (restoreRememberedFocus && !openModalContainsFocus) {
          lastFocusedDesktopElement.focus();
        } else if ((focusedResizeHandleTab || hiddenResizeHandleFocused || (!activePanel && activeElement !== document.body))
          && !openModalContainsFocus) {
          tabBar.querySelector(`.tab-btn[data-tab="${activeTab}"]`)?.focus();
        }
      }
    }
    if (layoutChanged) lastFocusedResizeHandleTab = null;
    mobileLayoutActive = mobileNow;
    updateUI();
    updateEmptyTapOverlay();
  });

  // Mobile "Add Photos" button (in empty hint on Photos tab)
  const mobileAddBtn = document.getElementById('mobileAddBtn');
  const fileInput = document.getElementById('fileInput');
  const mobileFileInput = document.getElementById('mobileFileInput');
  if (mobileAddBtn && mobileFileInput) {
    mobileAddBtn.addEventListener('click', () => mobileFileInput.click());
  }

  // ── Tap-to-import overlay for empty state ──────────────────────────────────
  // A transparent overlay over the empty preview opens the file picker when
  // tapped. The Photos tab keeps its visible import button unobstructed.

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
    const active  = empty && mobile && tab === 'preview';
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

function _getAccentForeground(hex) {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  ));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

function _applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const hover = _darkenHex(hex, 12);
  document.documentElement.style.setProperty('--accent',   hex);
  document.documentElement.style.setProperty('--accent-h', hover);
  document.documentElement.style.setProperty('--accent-fg', _getAccentForeground(hex));
  document.documentElement.style.setProperty('--accent-h-fg', _getAccentForeground(hover));
}

// ─── Main area vertical resize (preview ↕ image pool) ────────────────────────
function setupMainResize() {
  const handle  = document.getElementById('mainResizeHandle');
  const preview = document.querySelector('.preview-area');
  if (!handle || !preview) return;

  const getMinHeight = () => Math.max(120, parseFloat(getComputedStyle(preview).minHeight) || 0);
  const getMaxHeight = () => Math.max(getMinHeight(), window.innerHeight - 160);
  let preferredHeight = preview.offsetHeight;
  const applyHeight = (value, persist = false) => {
    const minHeight = getMinHeight();
    const maxHeight = getMaxHeight();
    const height = Math.min(Math.max(Math.round(value), minHeight), maxHeight);
    preview.style.height = height + 'px';
    handle.setAttribute('aria-valuemin', String(Math.round(minHeight)));
    handle.setAttribute('aria-valuemax', String(Math.round(maxHeight)));
    handle.setAttribute('aria-valuenow', String(height));
    if (persist) {
      preferredHeight = height;
      const nextPrefs = loadPrefs();
      nextPrefs.previewHeight = height + 'px';
      savePrefs(nextPrefs);
      scheduleLivePreview();
    }
    return height;
  };

  const prefs = loadPrefs();
  const savedHeight = parseFloat(prefs.previewHeight);
  if (Number.isFinite(savedHeight)) preferredHeight = savedHeight;
  applyHeight(preferredHeight);

  window.addEventListener('resize', () => applyHeight(preferredHeight));

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
    applyHeight(_startH + (e.clientY - _startY));
  });
  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    handle.classList.remove('resizing');
    applyHeight(preview.offsetHeight, true);
  });
  handle.addEventListener('keydown', event => {
    const current = preview.offsetHeight;
    let next = null;
    if (event.key === 'ArrowUp') next = current - 10;
    if (event.key === 'ArrowDown') next = current + 10;
    if (event.key === 'Home') next = getMinHeight();
    if (event.key === 'End') next = getMaxHeight();
    if (next == null) return;
    event.preventDefault();
    applyHeight(next, true);
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
function _releasePageResources() {
  _pageResourcesReleased = true;
  _clearLoadedMediaFocusRequest();
  // Commit the user's last debounced EXIF keystroke before freezing the page.
  // applyLiveExifEdit schedules a preview render, which is cancelled below so
  // released Canvas and Blob resources cannot be recreated while suspended.
  _flushLiveExifEdit();
  clearTimeout(_livePreviewTimer);
  _livePreviewTimer = null;
  _renderSeq += 1;
  const activeExportController = _activeExportController;
  _activeExportController = null;
  activeExportController?.abort();
  _previewRenderController?.abort();
  _previewRenderController = null;
  _disposeLiveVideoSource();
  _cancelLocationNetworkRequests();
  closeMapPicker({ restoreFocus: false });
  _releasePendingDownloadUrls();
  state.items.forEach(item => {
    const outputWasActive = item.status === 'done' || item.status === 'processing';
    const shouldRestoreThumbnail = item.status !== 'error';
    if (item.isVideo) item.thumbnailNeedsRestart = shouldRestoreThumbnail;
    else item.photoThumbnailNeedsRestart = shouldRestoreThumbnail;
    _cancelPhotoThumbnail(item);
    _releaseItemOutput(item);
    if (outputWasActive) {
      item.status = 'pending';
      item.progress = 0;
      _clearItemError(item);
      updateItemStatus(item);
    }
    updateItemPreview(item);
    _releaseCardPreviewResources(document.getElementById(`item-${item.id}`));
  });
  for (const entry of _imgLoadEntries.values()) entry.controller.abort();
  _imgLoadEntries.clear();
  for (const image of _transientPreviewImages.values()) _releaseDecodedImageSource(image);
  _transientPreviewImages.clear();
  for (const entry of _imgCache.values()) _releaseDecodedImageSource(entry.img, entry.objUrl);
  _imgCache.clear();
  for (const canvas of _frameCache.values()) { canvas.width = 0; canvas.height = 0; }
  _frameCache.clear();
  const liveCanvas = document.getElementById('livePreviewCanvas');
  if (liveCanvas) {
    liveCanvas.width = 0;
    liveCanvas.height = 0;
    liveCanvas.style.display = 'none';
  }
  _cancelMapImageLoads();
  _clearMapImageCache();
}

function _restorePageResources() {
  _pageResourcesReleased = false;
  const restoreWaiters = [..._pageRestoreWaiters];
  _pageRestoreWaiters.clear();
  restoreWaiters.forEach(resolve => resolve());
  _activeExportController = null;
  setGlobalBusy(false);
  hideProgress();
  state.items.forEach(item => {
    updateItemStatus(item);
    updateItemPreview(item);
    _restartInterruptedPhotoThumbnail(item);
    _restartInterruptedVideoThumbnail(item);
  });
  updateUI();
  updateLiveExifPanel();
  scheduleLivePreview();
}

// Apply theme & layout immediately (before paint) to avoid flash
;(function() {
  const p = loadPrefs();
  applyTheme(p.theme || 'soft-white');
  applyLayout(p.layout || 'left');
  applyEditorSize(p.editorSize || 'comfortable');
  _applyAccentColor(p.accentColor || '#08798f');
})();

document.addEventListener('DOMContentLoaded', () => {
  buildFontSelect();         // populate font select with popularity-ordered options
  applyTranslations();
  setupAccessibleFormNames();
  document.addEventListener('instaframe:languagechange', setupAccessibleFormNames);
  document.addEventListener('instaframe:languagechange', updateImageCounter);
  restoreSettings();         // restore saved settings to DOM
  initVideoFormatOptions();  // build video format pills (needs MediaRecorder)

  // Restore custom color button visual state
  if (state.isCustomColor) updateCustomColorBtn(state.customColorValue);

  _historyLocked = true;
  applySettings();           // sync state.settings from restored DOM values
  _historyLocked = false;

  setupDropZone();
  setupVideoPreviewBar();
  setupSettingsListeners();
  setupSidebarResize();
  setupMainResize();
  setupCardSize();
  setupCustomizePanel();
  setupLocationPrivacy();
  setupModalAccessibility();
  setupDestructiveConfirmation();
  setupMapModalActions();
  const exifHeader = document.querySelector('.preview-exif-drawer-header');
  exifHeader?.addEventListener('click', toggleLiveExifPanel);
  setupShareAppModal();
  setupPreviewQuality();
  setupHistoryControls();
  setupKeyboardShortcuts();
  setupMobileTabs();
  document.getElementById('langToggleBtn')?.addEventListener('click', () => {
    setLang(currentLang === 'en' ? 'ja' : 'en');
    rerenderCards();
    _refreshShareLinks();
  });
  updateUI();
  updatePreviewViewModifiedState();
  _refreshShareLinks();

  document.getElementById('generateAllBtn').addEventListener('click', generateAll);
  document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);
  document.getElementById('cancelExportBtn')?.addEventListener('click', () => {
    _activeExportController?.abort();
  });
  document.getElementById('clearAllBtn')?.addEventListener('click', () => clearAllItems());

  // Hide image section by default
  document.getElementById('imageSection').style.display = 'none';
  window.addEventListener('pagehide', _releasePageResources);
  window.addEventListener('pageshow', event => {
    if (event.persisted) _restorePageResources();
  });
});
