# InstaFrame 📸

**フィルム風写真編集アプリ for Android**

iPhoneアプリ「Liit」のような機能性・デザイン性を備えつつ、Androidの最新トレンドとユーザー体験を追求した写真編集アプリです。

## ✨ 主な機能

### 📷 リアルタイムカメラ
- CameraXを使用した高性能カメラ
- リアルタイムフィルタープレビュー
- フラッシュ制御、前後カメラ切替
- ピンチズーム、タップフォーカス

### 🎨 フィルム風フィルター
- **Kodak Portra 400** - ポートレートに最適な柔らかいトーン
- **Kodak Gold 200** - 暖かみのあるゴールドトーン
- **Fuji Superia** - クールなブルートーン
- **Fuji Velvia** - 鮮やかな発色
- **CineStill 800T** - シネマティックなタングステンルック
- **ヴィンテージ** - フェード＆グレイン効果
- **モノクロ各種** - クラシックからハイコントラストまで
- **インスタント** - ポラロイド/チェキ風

### 🖼️ フレーム＆ウォーターマーク
- シンプルな白/黒フレーム
- **ポラロイド風** - 下部に余白のあるクラシックスタイル
- **チェキ風** - Instax Mini/Square風
- **フィルムストリップ** - 35mmフィルム風
- **Shot on ◯◯** - 撮影機器情報の自動表示
- **日付スタンプ** - フィルムカメラ風オレンジ日付
- **EXIFフレーム** - ISO/シャッター速度/F値表示

### 🎚️ プロレベル編集
- 明るさ・コントラスト・露出
- 彩度・バイブランス
- 色温度・ティント
- ハイライト・シャドウ
- クラリティ・デヘイズ
- シャープネス
- HSL個別調整

### 🎯 Nothing風UI/UX
- モノクロミニマルデザイン
- Material 3対応
- エッジ・トゥ・エッジ表示
- スムーズなアニメーション
- ダークモード最適化

## 🛠️ 技術スタック

- **Kotlin** - 100% Kotlin
- **Jetpack Compose** - モダンUI
- **Material 3** - 最新デザインシステム
- **CameraX** - カメラ機能
- **Navigation Compose** - 画面遷移
- **Coil** - 画像読み込み
- **Coroutines** - 非同期処理
- **ExifInterface** - メタデータ処理

## 📱 動作要件

- Android 8.0 (API 26) 以上
- カメラ搭載デバイス

## 🚀 ビルド方法

```bash
# リポジトリをクローン
git clone https://github.com/lingmulongtai/InstaFrame.git

# Android Studioで開く
# Gradleが自動的に同期されます

# デバイスまたはエミュレーターで実行
```

## 📂 プロジェクト構成

```
app/src/main/java/com/example/photoframe/
├── MainActivity.kt              # メインActivity
├── ImageProcessor.kt            # レガシー画像処理
├── camera/
│   ├── CameraManager.kt         # CameraX管理
│   └── CameraScreen.kt          # カメラUI
├── data/
│   ├── FilterPreset.kt          # フィルタープリセット定義
│   └── FrameStyle.kt            # フレームスタイル定義
├── navigation/
│   └── Navigation.kt            # ナビゲーション定義
├── processing/
│   ├── FilterEngine.kt          # フィルター適用エンジン
│   ├── FrameEngine.kt           # フレーム＆ウォーターマークエンジン
│   └── EditEngine.kt            # 編集処理エンジン
├── ui/
│   ├── screens/
│   │   ├── EditScreen.kt        # 編集画面
│   │   └── GalleryScreen.kt     # ギャラリー画面
│   └── theme/
│       ├── Theme.kt             # テーマ定義
│       └── Type.kt              # タイポグラフィ定義
└── utils/
    ├── ImageUtils.kt            # 画像保存ユーティリティ
    └── PermissionUtils.kt       # 権限ユーティリティ
```

## 🗺️ 開発ロードマップ

- [x] フェーズ1: アーキテクチャ設計とNothing風デザインの策定
- [x] フェーズ2: カメラ機能 (CameraX + リアルタイムフィルター)
- [x] フェーズ3: フィルター/エフェクトエンジンの開発
- [x] フェーズ4: フレーム＆ウォーターマーク機能
- [x] フェーズ5: 本格編集機能の実装
- [x] フェーズ6: UI/UX仕上げ (ミニマル＆アニメーション)
- [ ] フェーズ7: テスト・最適化・ベータリリース

## 📄 ライセンス

MIT License

## 🤝 コントリビューション

Issue・PRお待ちしています！
