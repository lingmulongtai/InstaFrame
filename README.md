# ✨ InstaFrame

> Add cinematic EXIF frames to photos & videos — entirely in your browser.  
> **100% local · no upload · no account · no tracking**

[![Live Demo](https://img.shields.io/badge/Live-Demo-0891b2?style=for-the-badge)](https://lingmulongtai.github.io/InstaFrame/)

---

## Why InstaFrame?

InstaFrame reads metadata (camera, lens, focal length, aperture, shutter speed, ISO) and renders a clean typographic frame in a modern "Shot on" style.

- 📸 Photo + 🎬 Video support
- ⚡ Live preview with zoom & pan
- 🧩 EXIF editor per file
- 📦 Batch generate + ZIP download
- 🌐 English / 日本語 UI

---

## Feature Highlights

### Core workflow
- Drag & drop JPEG / PNG / HEIC / WebP / MP4 / MOV / WebM
- Tune frame + typography settings
- Preview instantly in live view
- Export one-by-one or all at once

### Frame & typography controls
- Frame color / thickness / aspect ratio / outer padding
- Font family + camera name style + EXIF style
- Shot-on / EXIF / decorative line visibility
- Line spacing + text vertical offset + location display

### Export controls
- Photo: JPEG / WebP / PNG + quality slider
- Video: browser-supported formats (VP9 / VP8 / MP4) + bitrate

### UX touches
- Progress bar during generation/ZIP
- Full-screen preview modal with keyboard navigation
- Preferences persisted via `localStorage`
- Desktop + mobile responsive layout

---

## Quick Start

1. Open `index.html` in a modern browser, or use the live demo.
2. Drop files into the preview area.
3. Adjust settings in the left panel.
4. Click **Apply to All**.
5. Click **Download All** to export ZIP.

---

## Project Structure

```text
InstaFrame/
├── index.html          # Main app UI
├── css/
│   └── style.css       # Layout + component styling
└── js/
    ├── i18n.js         # EN/JA translations
    ├── frame-engine.js # Frame rendering + video pipeline
    └── app.js          # App state, preview, export, interactions
```

---

## Tech Stack

- [exifr](https://github.com/MikeKovarik/exifr) — EXIF/metadata extraction
- [JSZip](https://stuk.github.io/jszip/) — ZIP export in browser
- Canvas 2D API + MediaRecorder API — rendering + video encoding
- Google Fonts — typography set

✅ No build step.  
✅ No backend.  
✅ Works by opening `index.html`.

---

## License

MIT

---

# ✨ InstaFrame（日本語）

> 写真・動画にEXIFフレームを追加する、ブラウザ完結アプリ。  
> **完全ローカル処理 / アップロード不要 / アカウント不要 / トラッキングなし**

[![Live Demo](https://img.shields.io/badge/Live-Demo-0891b2?style=for-the-badge)](https://lingmulongtai.github.io/InstaFrame/)

---

## InstaFrame でできること

写真・動画のメタデータ（メーカー / 機種 / レンズ / 焦点距離 / 絞り / SS / ISO）を読み取り、
「Shot on」風のタイポグラフィ付きフレームを合成します。

- 📸 写真 + 🎬 動画に対応
- ⚡ ズーム・パン対応のライブビュー
- 🧩 ファイル単位のEXIF編集
- 📦 一括生成 + ZIPダウンロード
- 🌐 日本語 / English UI

---

## 主な機能

### 基本フロー
- JPEG / PNG / HEIC / WebP / MP4 / MOV / WebM をドラッグ＆ドロップ
- フレーム・文字設定を調整
- ライブビューで即時確認
- 個別または一括でエクスポート

### フレーム・文字設定
- フレーム色 / 太さ / アスペクト比 / 外側余白
- フォント / カメラ名スタイル / EXIFスタイル
- Shot on・EXIF・装飾ラインの表示切替
- 行間 / テキスト縦位置 / 位置情報表示

### エクスポート設定
- 写真: JPEG / WebP / PNG + 画質
- 動画: ブラウザ対応形式（VP9 / VP8 / MP4）+ ビットレート

### UX
- 生成・ZIP作成時の進捗表示
- キーボード対応フルスクリーンプレビュー
- `localStorage` への設定保存
- デスクトップ / モバイル対応

---

## 使い方

1. `index.html` をブラウザで開く（またはLive Demo）。
2. 画像・動画をプレビュー領域へドロップ。
3. 左側パネルで設定を調整。
4. **すべてに適用** を実行。
5. **まとめてダウンロード** でZIP保存。

---

## ファイル構成

```text
InstaFrame/
├── index.html          # メインUI
├── css/
│   └── style.css       # レイアウト・UIスタイル
└── js/
    ├── i18n.js         # 日英翻訳
    ├── frame-engine.js # フレーム描画・動画処理
    └── app.js          # 状態管理・プレビュー・書き出し
```

---

## 使用技術

- [exifr](https://github.com/MikeKovarik/exifr) — EXIF / メタデータ取得
- [JSZip](https://stuk.github.io/jszip/) — ブラウザ内ZIP生成
- Canvas 2D API + MediaRecorder API — 描画と動画エンコード
- Google Fonts — タイポグラフィ

✅ ビルド不要  
✅ バックエンド不要  
✅ `index.html` を開くだけで動作

---

## ライセンス

MIT
