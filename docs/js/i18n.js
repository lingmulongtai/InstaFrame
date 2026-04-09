/**
 * i18n.js — English / Japanese translations for InstaFrame Web
 */
const I18N = {
  en: {
    appTitle: 'InstaFrame',
    appSubtitle: 'EXIF Photo Frame Generator',
    dropZoneText: 'Drag & drop photos here, or click to select',
    dropZoneSubtext: 'Supports JPEG, PNG, HEIC — multiple files at once',
    settingsTitle: 'Frame Settings',
    frameColor: 'Frame Color',
    colorWhite: 'White',
    colorLightGray: 'Light Gray',
    colorBlack: 'Black',
    frameThickness: 'Frame Thickness',
    shotOnFontSize: '"Shot on" Font Size',
    exifFontSize: 'EXIF Font Size',
    imagesTitle: 'Images',
    noImages: 'No images added yet.',
    generateAll: 'Generate All',
    downloadAll: 'Download All (ZIP)',
    downloadSingle: 'Download',
    regenerate: 'Regenerate',
    remove: 'Remove',
    editExif: 'Edit EXIF',
    cameraMake: 'Camera Make',
    cameraModel: 'Camera Model',
    lensModel: 'Lens Model',
    focalLength: 'Focal Length (mm)',
    fNumber: 'Aperture (f/)',
    exposureTime: 'Shutter Speed',
    iso: 'ISO',
    applyExif: 'Apply',
    statusPending: 'Pending',
    statusProcessing: 'Processing…',
    statusDone: 'Done',
    statusError: 'Error',
    msgGenerating: 'Generating frames…',
    msgDone: 'All frames generated!',
    msgDownloading: 'Creating ZIP…',
    msgNoImages: 'Please add at least one image first.',
    msgNoPending: 'All images already processed. Add new images or regenerate.',
    localProcessing: 'All processing is done locally. Your photos are never uploaded.',
    shotOn: 'Shot on',
    langToggle: '日本語',
  },
  ja: {
    appTitle: 'InstaFrame',
    appSubtitle: 'EXIFフォトフレームジェネレーター',
    dropZoneText: 'ここに写真をドラッグ＆ドロップ、またはクリックして選択',
    dropZoneSubtext: 'JPEG、PNG、HEIC対応 — 複数ファイル同時選択可',
    settingsTitle: 'フレーム設定',
    frameColor: 'フレームカラー',
    colorWhite: 'ホワイト',
    colorLightGray: 'ライトグレー',
    colorBlack: 'ブラック',
    frameThickness: 'フレームの太さ',
    shotOnFontSize: '「Shot on」フォントサイズ',
    exifFontSize: 'EXIFフォントサイズ',
    imagesTitle: '画像',
    noImages: 'まだ画像が追加されていません。',
    generateAll: 'すべて生成',
    downloadAll: 'まとめてダウンロード (ZIP)',
    downloadSingle: 'ダウンロード',
    regenerate: '再生成',
    remove: '削除',
    editExif: 'EXIF編集',
    cameraMake: 'カメラメーカー',
    cameraModel: 'カメラモデル',
    lensModel: 'レンズモデル',
    focalLength: '焦点距離 (mm)',
    fNumber: '絞り値 (f/)',
    exposureTime: 'シャッタースピード',
    iso: 'ISO',
    applyExif: '適用',
    statusPending: '待機中',
    statusProcessing: '処理中…',
    statusDone: '完了',
    statusError: 'エラー',
    msgGenerating: 'フレームを生成中…',
    msgDone: 'すべてのフレームが生成されました！',
    msgDownloading: 'ZIPを作成中…',
    msgNoImages: '先に画像を追加してください。',
    msgNoPending: 'すべての画像が処理済みです。新しい画像を追加するか再生成してください。',
    localProcessing: 'すべての処理はローカルで行われます。写真がアップロードされることはありません。',
    shotOn: 'Shot on',
    langToggle: 'English',
  },
};

let currentLang = localStorage.getItem('instaframe_lang') || 'en';

function t(key) {
  return I18N[currentLang][key] || I18N['en'][key] || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('instaframe_lang', lang);
  applyTranslations();
}

function toggleLang() {
  setLang(currentLang === 'en' ? 'ja' : 'en');
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    if (attr) {
      el.setAttribute(attr, t(key));
    } else {
      el.textContent = t(key);
    }
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  // Update lang toggle button label
  const btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = t('langToggle');
}
