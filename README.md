# ✨ InstaFrame

> Add cinematic EXIF frames to photos & videos — entirely in your browser.  
> **100% local · no upload · no account · no tracking**

[![Live Demo](https://img.shields.io/badge/Live-Demo-0891b2?style=for-the-badge)](https://lingmulongtai.github.io/InstaFrame/)

---

## Why InstaFrame?

InstaFrame reads metadata (camera, lens, focal length, aperture, shutter speed, ISO) and renders a clean typographic frame in a modern "Shot on" style. You can also set a location with an interactive map and optionally overlay a Passage-style line-art map on the photo.

- 📸 Photo + 🎬 Video support
- ⚡ Live preview with full-area drag-to-pan & pinch-zoom
- 🗺️ Interactive map location picker (Leaflet.js)
- 🖼️ Passage-style map overlay on exported images (Mapbox)
- 🧩 Always-open EXIF editor panel with collapse toggle
- 📦 Batch generate + ZIP download
- 🌐 English / 日本語 UI

---

## Feature Highlights

### Core workflow
- Drag & drop JPEG / PNG / HEIC / WebP / MP4 / MOV / WebM
- Tune frame + typography settings in the left panel
- Preview instantly in the live view — drag anywhere in the preview (canvas or background) to pan; scroll to zoom
- Export one-by-one or all at once

### Live EXIF Editor Panel
- The EXIF editor panel is open by default on the left side of the preview
- Collapse it by clicking the header; click again to expand
- Pick a GPS location from an interactive map with the 📍 button
- Use the 🎯 button to get your current device location

### Map Location Picker
- Opens a Leaflet.js map in a modal
- Automatically centers on your current position (browser geolocation → IP-based fallback)
- Click anywhere on the map to drop a pin; confirm to reverse-geocode and set the location

### Map Overlay (Passage style)
- Enable **Map Overlay** in Elements settings alongside **Location**
- Enter your [Mapbox](https://mapbox.com/) public access token (`pk.eyJ1…`)
- A minimal light-style map tile is fetched and composited onto the bottom-right corner of the photo
- Adjust overlay **Opacity** (10–100%) to taste

### Frame & typography controls
- Frame color / thickness / aspect ratio / outer padding
- Font family + camera name style + EXIF style
- Shot-on / EXIF / decorative line visibility
- Line spacing + text vertical offset + location display

### Export controls
- Photo: JPEG / WebP / PNG + quality slider
- Video: browser-supported formats (VP9 / VP8 / MP4) + bitrate

### UX touches
- Drag to pan from anywhere in the preview area (not just the image itself)
- Progress bar during generation/ZIP
- Full-screen preview modal with keyboard navigation
- Preferences persisted via `localStorage`
- Desktop + mobile responsive layout

---

## Quick Start

1. Open `index.html` in a modern browser, or use the live demo.
2. Drop photos/videos into the preview area.
3. Adjust settings in the left panel.
4. *(Optional)* Click the map button (📍) in the EXIF panel to pick a location.
5. *(Optional)* Enable **Location** + **Map Overlay** for line-art map compositing.
6. Click **Apply to All**.
7. Click **Download All** to export a ZIP.

---

## Map Overlay Setup

The map overlay feature uses the [Mapbox Static Images API](https://docs.mapbox.com/api/maps/static-images/).

1. In InstaFrame → **Elements** → enable **Location** and **Map Overlay**
2. Map tiles are fetched automatically when location coordinates are available

---

## Project Structure

```text
InstaFrame/
├── index.html          # Main app UI
├── css/
│   └── style.css       # Layout + component styling
└── js/
    ├── i18n.js         # EN/JA translations
    ├── frame-engine.js # Frame rendering + video pipeline + map overlay drawing
    └── app.js          # App state, preview, export, map picker, interactions
```

---

## Tech Stack

| Library | Purpose |
|---|---|
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF/metadata extraction |
| [JSZip](https://stuk.github.io/jszip/) | ZIP export in browser |
| [Leaflet.js](https://leafletjs.com/) | Interactive map location picker |
| [Mapbox Static Images API](https://docs.mapbox.com/api/maps/static-images/) | Map overlay tile (requires free token) |
| Canvas 2D API + MediaRecorder API | Frame rendering + video encoding |
| Google Fonts | Typography set |

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
マップ上での場所選択や、Passageアプリ風の線画マップオーバーレイにも対応しています。

- 📸 写真 + 🎬 動画に対応
- ⚡ プレビューエリア全体をドラッグ＆パン・ピンチズーム
- 🗺️ Leaflet.jsによるインタラクティブなマップ位置選択
- 🖼️ Passage風のラインマップオーバーレイ（Mapbox）
- 🧩 常時展開のEXIF編集パネル（折りたたみ機能つき）
- 📦 一括生成 + ZIPダウンロード
- 🌐 日本語 / English UI

---

## 主な機能

### 基本フロー
- JPEG / PNG / HEIC / WebP / MP4 / MOV / WebM をドラッグ＆ドロップ
- フレーム・文字設定を調整
- ライブビューで即時確認（キャンバス外の余白部分もドラッグしてパン可能）
- 個別または一括でエクスポート

### ライブEXIF編集パネル
- デフォルトで開いた状態で左側に表示
- ヘッダーをクリックで折りたたみ/展開
- 📍 ボタンでマップから位置を選択
- 🎯 ボタンでデバイスのGPSから現在地を取得

### マップ位置選択
- モーダルでLeaflet.jsのインタラクティブマップを表示
- ブラウザのGeolocation API → IPアドレスベースの順で自動的に現在地付近を表示
- マップをクリックしてピンを設置、確認すると逆ジオコードで地名をセット

### マップオーバーレイ（Passage風）
- 設定の「要素」→「位置情報」+「マップオーバーレイ」をオン
- 位置情報がある場合に、Passage風マップを自動取得して合成
- ミニマルなライトスタイルのマップタイルを取得し、写真の右下にオーバーレイ合成
- 不透明度（10〜100%）を調整可能

### フレーム・文字設定
- フレーム色 / 太さ / アスペクト比 / 外側余白
- フォント / カメラ名スタイル / EXIFスタイル
- Shot on・EXIF・装飾ラインの表示切替
- 行間 / テキスト縦位置 / 位置情報表示

### エクスポート設定
- 写真: JPEG / WebP / PNG + 画質
- 動画: ブラウザ対応形式（VP9 / VP8 / MP4）+ ビットレート

### UX
- プレビューエリアの余白部分からでもドラッグでパン可能
- 生成・ZIP作成時の進捗表示
- キーボード対応フルスクリーンプレビュー
- `localStorage` への設定保存
- デスクトップ / モバイル対応

---

## 使い方

1. `index.html` をブラウザで開く（またはLive Demo）。
2. 画像・動画をプレビュー領域へドロップ。
3. 左側パネルで設定を調整。
4. *(任意)* EXIFパネルのマップボタン（📍）で位置を選択。
5. *(任意)* 「位置情報」+「マップオーバーレイ」を有効化。
6. **すべてに適用** を実行。
7. **まとめてダウンロード** でZIP保存。

---

## マップオーバーレイのセットアップ

マップオーバーレイ機能は [Mapbox Static Images API](https://docs.mapbox.com/api/maps/static-images/) を使用します。

1. InstaFrame の **要素** 設定 → **位置情報** と **マップオーバーレイ** を有効化
2. 位置座標がある場合にマップ画像を自動取得して合成

---

## ファイル構成

```text
InstaFrame/
├── index.html          # メインUI
├── css/
│   └── style.css       # レイアウト・UIスタイル
└── js/
    ├── i18n.js         # 日英翻訳
    ├── frame-engine.js # フレーム描画・動画処理・マップオーバーレイ描画
    └── app.js          # 状態管理・プレビュー・マップ選択・書き出し
```

---

## 使用技術

| ライブラリ | 用途 |
|---|---|
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF / メタデータ取得 |
| [JSZip](https://stuk.github.io/jszip/) | ブラウザ内ZIP生成 |
| [Leaflet.js](https://leafletjs.com/) | インタラクティブマップ位置選択 |
| [Mapbox Static Images API](https://docs.mapbox.com/api/maps/static-images/) | マップオーバーレイ（位置座標が必要） |
| Canvas 2D API + MediaRecorder API | 描画と動画エンコード |
| Google Fonts | タイポグラフィ |

✅ ビルド不要  
✅ バックエンド不要  
✅ `index.html` を開くだけで動作

---

## ライセンス

MIT
