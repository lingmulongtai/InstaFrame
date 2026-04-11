# InstaFrame

**Add beautiful EXIF frames to your photos and videos — right in your browser.**  
100% client-side · No uploads · No accounts · No tracking

---

## Overview

InstaFrame renders a clean typographic frame around your photos and videos, pulling camera metadata (make, model, lens, focal length, aperture, shutter speed, ISO) directly from EXIF data and displaying it in a "Shot on" style caption — the same look used by many photography apps.

Everything runs locally. Your files never leave your device.

---

## Features

### Core
- **EXIF frame rendering** — reads camera make/model, lens, focal length, f-number, shutter speed and ISO; renders them in a clean "Shot on …" caption below the photo
- **Video support** — drag in MP4/MOV/WebM files; the frame is rendered via Canvas + MediaRecorder with the original audio preserved
- **Live preview** — the first loaded file is shown as a real-time preview; updates within ~300 ms as you change any setting
- **Batch processing** — Generate All → Download All as a ZIP in one click
- **EXIF editor** — override any metadata field per file before generating

### Frame settings
| Setting | Range |
|---|---|
| Frame color | White / Light Gray / Black / Custom (color picker) |
| Frame thickness | 0.4× – 2.0× |
| Aspect ratio | Original / 1:1 / 4:5 / 16:9 |
| Outer padding | 0 – 15% |

### Typography
| Setting | Options |
|---|---|
| Font family | Inter / Montserrat / DM Sans / Lato / Playfair Display / Cormorant Garamond / EB Garamond |
| Camera name style | Bold · Italic |
| EXIF line style | Italic |
| "Shot on" font size | 0.5× – 2.0× |
| EXIF font size | 0.5× – 2.0× |
| Line spacing | 0.5× – 3.0× |
| Text vertical offset | −2.0 – +2.0 |
| Camera name only | Hides EXIF/deco line (recommended for video) |

### Export
| Setting | Options |
|---|---|
| Photo format | JPEG / WebP / PNG |
| Photo quality | 60 – 100% |
| Video format | VP9 / VP8 / MP4 (browser-detected) |
| Video bitrate | 4 / 8 / 16 / 24 Mbps |

### UX
- Real-time export progress bar with filename and percentage
- Full-screen photo preview modal with keyboard navigation (←/→/Esc)
- English / Japanese UI
- All settings persisted in `localStorage`
- Responsive layout — works on desktop and mobile

---

## Usage

1. Open `docs/index.html` in any modern browser  
   *(or visit the [GitHub Pages](https://lingmulongtai.github.io/InstaFrame/) deployment)*
2. Drag & drop photos or videos onto the upload area, or click to select files  
   Supported: JPEG · PNG · HEIC · WebP · MP4 · MOV · WebM
3. Adjust frame and typography settings — the live preview updates instantly
4. Click **Generate All** to process all files (progress bar shows encoding status)
5. Click any thumbnail to preview full-screen
6. Download individual files or all as a ZIP

---

## Project structure

```
docs/
├── index.html          Main page
├── css/
│   └── style.css       Layout and component styles
└── js/
    ├── i18n.js         EN / JA translations
    ├── frame-engine.js Canvas rendering — EXIF text, fonts, aspect ratio, video pipeline
    └── app.js          App logic — state, settings, live preview, modal, export
```

---

## Technology

- [exifr](https://github.com/MikeKovarik/exifr) — EXIF / metadata extraction
- [JSZip](https://stuk.github.io/jszip/) — client-side ZIP creation
- [Google Fonts](https://fonts.google.com/) — Inter, Montserrat, DM Sans, Lato, Playfair Display, Cormorant Garamond, EB Garamond
- Canvas 2D API + MediaRecorder API — frame rendering and video encoding

No build step. No dependencies to install. Open `docs/index.html` and go.

---

## License

MIT

---
---

# InstaFrame — 日本語

**写真・動画にEXIFフレームを追加する、ブラウザだけで動くアプリです。**  
完全ローカル処理 · アップロード不要 · アカウント不要 · トラッキングなし

---

## 概要

InstaFrame は、写真や動画にカメラのメタデータ（メーカー・機種名・レンズ・焦点距離・絞り・シャッタースピード・ISO）を読み取り、"Shot on …" スタイルのキャプション付きフレームを合成するツールです。

すべての処理はブラウザ内で完結します。ファイルがサーバーに送信されることは一切ありません。

---

## 機能

### 基本機能
- **EXIFフレーム描画** — カメラ情報を自動取得し、写真の下部にクリーンなキャプションを合成
- **動画対応** — MP4 / MOV / WebM をドロップするだけで、Canvas + MediaRecorder でフレーム付き動画を出力（音声付き）
- **ライブプレビュー** — 最初のファイルをリアルタイムプレビューとして表示。設定変更から約300ms で更新
- **バッチ処理** — 「すべて生成」→「ZIP一括ダウンロード」のワンクリック操作
- **EXIFエディター** — ファイルごとに任意のメタデータを手動で上書き可能

### フレーム設定
| 設定 | 範囲 |
|---|---|
| フレームカラー | ホワイト / ライトグレー / ブラック / カスタム（カラーピッカー） |
| フレームの太さ | 0.4× – 2.0× |
| アスペクト比 | オリジナル / 1:1 / 4:5 / 16:9 |
| 外側の余白 | 0 – 15% |

### タイポグラフィ
| 設定 | 選択肢 |
|---|---|
| フォント | Inter / Montserrat / DM Sans / Lato / Playfair Display / Cormorant Garamond / EB Garamond |
| カメラ名スタイル | ボールド · イタリック |
| EXIF行スタイル | イタリック |
| 「Shot on」フォントサイズ | 0.5× – 2.0× |
| EXIFフォントサイズ | 0.5× – 2.0× |
| 行間 | 0.5× – 3.0× |
| テキスト縦位置 | −2.0 – +2.0 |
| カメラ名のみ | EXIF行・装飾ラインを非表示（動画推奨） |

### エクスポート
| 設定 | 選択肢 |
|---|---|
| 写真フォーマット | JPEG / WebP / PNG |
| 写真画質 | 60 – 100% |
| 動画フォーマット | VP9 / VP8 / MP4（ブラウザ対応を自動検出） |
| 動画ビットレート | 4 / 8 / 16 / 24 Mbps |

### UX
- ファイル名・エンコード率をリアルタイム表示するエクスポート進捗バー
- キーボード操作対応のフルスクリーンプレビューモーダル（←/→/Esc）
- 日本語 / 英語 UI 切替
- すべての設定を `localStorage` に自動保存
- レスポンシブ対応（デスクトップ・モバイル）

---

## 使い方

1. `docs/index.html` をブラウザで開く  
   *（または [GitHub Pages](https://lingmulongtai.github.io/InstaFrame/) からアクセス）*
2. 写真・動画をドロップエリアにドラッグ＆ドロップ、またはクリックして選択  
   対応形式: JPEG · PNG · HEIC · WebP · MP4 · MOV · WebM
3. フレーム設定・タイポグラフィを調整 — ライブプレビューがリアルタイムで更新されます
4. **すべて生成** をクリック（進捗バーにエンコード状況を表示）
5. サムネイルをクリックしてフルスクリーンプレビュー
6. 個別またはZIPでまとめてダウンロード

---

## ファイル構成

```
docs/
├── index.html          メインページ
├── css/
│   └── style.css       レイアウト・コンポーネントスタイル
└── js/
    ├── i18n.js         日英翻訳
    ├── frame-engine.js Canvas描画 — EXIFテキスト、フォント、アスペクト比、動画パイプライン
    └── app.js          アプリロジック — 状態管理、設定、プレビュー、モーダル、エクスポート
```

---

## 使用ライブラリ

- [exifr](https://github.com/MikeKovarik/exifr) — EXIF / メタデータ抽出
- [JSZip](https://stuk.github.io/jszip/) — クライアントサイド ZIP 生成
- [Google Fonts](https://fonts.google.com/) — Inter, Montserrat, DM Sans, Lato, Playfair Display, Cormorant Garamond, EB Garamond
- Canvas 2D API + MediaRecorder API — フレーム描画・動画エンコード

ビルドステップなし。インストール不要。`docs/index.html` を開くだけで動作します。

---

## ライセンス

MIT
