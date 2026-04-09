# InstaFrame

EXIF Photo Frame Generator — Web App & Android App

---

## Web App

A browser-based batch photo frame generator inspired by [calmtempo.com/soft/makeframe.html](https://calmtempo.com/soft/makeframe.html).  
All processing runs locally in the browser — no uploads, no server.

### Features

- **EXIF Frame** — Automatically reads camera make/model, lens, focal length, f-number, shutter speed, ISO and renders them in a clean "Shot on" style frame
- **Inter font** — Matching the reference site's clean typographic style
- **Live Preview** — First loaded photo is shown as a real-time preview at the top of the settings panel; updates instantly as you adjust any setting
- **Click-to-Preview Modal** — Click any photo in the grid to open a full-screen preview; navigate with arrow keys or on-screen buttons
- **Granular Frame Controls**
  - Frame color: White / Light Gray / Black / Custom (color picker)
  - Frame thickness (0.4× – 2.0×)
  - "Shot on" font size (0.5× – 2.0×)
  - EXIF font size (0.5× – 2.0×)
  - Text vertical offset (fine-tune text position)
  - Toggle: Show/hide "Shot on" label, decorative line, EXIF info
- **Instagram Aspect Ratio** — Pad the output to 1:1 (Square), 4:5 (Portrait), or 16:9 (Landscape)
- **Outer Padding** — Add extra frame color padding around the entire result (0–15%)
- **Batch Processing** — Generate and download all frames as a ZIP in one click
- **EXIF Editor** — Override any EXIF field per photo before generating
- **Responsive Grid** — Feed adapts to screen width; cards grow on large displays
- **English / Japanese** — Full i18n support

### Usage

Open `docs/index.html` in any modern browser, or deploy the `docs/` folder to GitHub Pages / Netlify.

1. Drag & drop photos (JPEG, PNG, HEIC, WebP) onto the upload area
2. Adjust frame settings — the live preview updates in real-time
3. Click **Generate All** to process all photos
4. Click any photo thumbnail to preview it full-screen
5. Download individual photos or all as a ZIP

### Files

```
docs/
├── index.html          # Main page
├── css/style.css       # Styling
└── js/
    ├── i18n.js         # EN/JA translations
    ├── frame-engine.js # Canvas rendering (font, EXIF text, aspect ratio)
    └── app.js          # App logic (state, settings, modal, live preview)
```

---

## Android App

**フィルム風写真編集アプリ for Android**

iPhoneアプリ「Liit」のような機能性・デザイン性を備えつつ、Androidの最新トレンドとユーザー体験を追求した写真編集アプリです。

### ✨ 主な機能

#### 📷 リアルタイムカメラ
- CameraXを使用した高性能カメラ
- リアルタイムフィルタープレビュー
- フラッシュ制御、前後カメラ切替
- ピンチズーム、タップフォーカス

#### 🎨 フィルム風フィルター
- **Kodak Portra 400** - ポートレートに最適な柔らかいトーン
- **Kodak Gold 200** - 暖かみのあるゴールドトーン
- **Fuji Superia** - クールなブルートーン
- **Fuji Velvia** - 鮮やかな発色
- **CineStill 800T** - シネマティックなタングステンルック
- **ヴィンテージ** - フェード＆グレイン効果
- **モノクロ各種** - クラシックからハイコントラストまで
- **インスタント** - ポラロイド/チェキ風

#### 🖼️ フレーム＆ウォーターマーク
- シンプルな白/黒フレーム
- **ポラロイド風** - 下部に余白のあるクラシックスタイル
- **チェキ風** - Instax Mini/Square風
- **フィルムストリップ** - 35mmフィルム風
- **Shot on ◯◯** - 撮影機器情報の自動表示
- **日付スタンプ** - フィルムカメラ風オレンジ日付
- **EXIFフレーム** - ISO/シャッター速度/F値表示

#### 🎚️ プロレベル編集
- 明るさ・コントラスト・露出
- 彩度・バイブランス
- 色温度・ティント
- ハイライト・シャドウ
- クラリティ・デヘイズ
- シャープネス
- HSL個別調整

### 🛠️ 技術スタック

- **Kotlin** - 100% Kotlin
- **Jetpack Compose** - モダンUI
- **Material 3** - 最新デザインシステム
- **CameraX** - カメラ機能
- **Navigation Compose** - 画面遷移
- **Coil** - 画像読み込み
- **Coroutines** - 非同期処理
- **ExifInterface** - メタデータ処理

### 📱 動作要件

- Android 8.0 (API 26) 以上
- カメラ搭載デバイス

### 🚀 ビルド方法

```bash
# リポジトリをクローン
git clone https://github.com/lingmulongtai/InstaFrame.git

# Android Studioで開く
# Gradleが自動的に同期されます

# デバイスまたはエミュレーターで実行
```

### 📂 プロジェクト構成

```
app/src/main/java/com/example/photoframe/
├── MainActivity.kt
├── camera/
│   ├── CameraManager.kt
│   └── CameraScreen.kt
├── data/
│   ├── FilterPreset.kt
│   └── FrameStyle.kt
├── processing/
│   ├── FilterEngine.kt
│   ├── FrameEngine.kt
│   └── EditEngine.kt
├── ui/
│   ├── screens/
│   │   ├── EditScreen.kt
│   │   └── GalleryScreen.kt
│   └── theme/
│       ├── Theme.kt
│       └── Type.kt
└── utils/
    ├── ImageUtils.kt
    └── PermissionUtils.kt
```

### 🗺️ 開発ロードマップ

- [x] フェーズ1: アーキテクチャ設計
- [x] フェーズ2: カメラ機能
- [x] フェーズ3: フィルター/エフェクトエンジン
- [x] フェーズ4: フレーム＆ウォーターマーク機能
- [x] フェーズ5: 本格編集機能
- [x] フェーズ6: UI/UX仕上げ
- [ ] フェーズ7: テスト・最適化・ベータリリース

---

## License

MIT License
