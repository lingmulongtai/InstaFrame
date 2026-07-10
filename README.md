# ✨ InstaFrame

写真・動画へEXIF情報付きのフレームを合成する、Web専用のブラウザアプリです。

[![Live Demo](https://img.shields.io/badge/Live-Demo-0891b2?style=for-the-badge)](https://lingmulongtai.github.io/InstaFrame/)
[![Web quality checks](https://github.com/lingmulongtai/InstaFrame/actions/workflows/ci.yml/badge.svg)](https://github.com/lingmulongtai/InstaFrame/actions/workflows/ci.yml)

## プライバシー

写真・動画のデコード、EXIF読み取り、フレーム描画、エンコード、ZIP生成はブラウザ内で行われます。メディアファイルそのものをInstaFrameのサーバーへアップロードする処理はありません。

位置情報機能だけは、ユーザーが確認画面で明示的に許可した場合に外部通信します。

| 操作 | 送信先 | 送信される情報 |
|---|---|---|
| 地名をオンライン検索 | Nominatim | 緯度・経度、表示言語 |
| マップを表示 | OpenStreetMap | 表示範囲に対応するタイル番号 |
| 端末位置を取得できない場合の地図初期位置 | ipapi | 接続元IPアドレス |
| マップオーバーレイ生成 | Mapbox Static Images API | 緯度・経度、ズーム、公開アクセストークン |

- GPS付き写真を追加しただけでは外部通信しません。座標は端末内で文字列化されます。
- 許可は「今回だけ」または「この端末で常に許可」から選択できます。
- 許可は **カスタマイズ → プライバシー** から取り消せます。
- Google FontsとJavaScriptライブラリはCDNから取得するため、アプリの読み込み自体には通常のWeb通信があります。

## 主な機能

- 写真・動画のライブプレビューと一括処理
- メーカー、機種、レンズ、焦点距離、絞り、シャッター速度、ISO、位置情報の編集
- フレーム色、ぼかし背景、文字色（自動・明るい・暗い・カスタム）
- プレビュー画質を変えても構図や文字位置が変わらない固定レイアウトレンダー
- 4:5 Instagram投稿、3:4プロフィールグリッド、9:16ストーリーの用途付きプリセット
- EXIF編集パネルのコンパクト・標準・大サイズ切り替え
- JPEG / WebP / PNG出力、動画出力、複数ファイルのZIP保存
- 日本語 / English、デスクトップ / モバイル対応

## 対応形式

形式名だけではなく、実際のブラウザデコーダーがファイル内のコーデックへ対応している必要があります。

| 入力 | 対応方針 | 検証 |
|---|---|---|
| JPEG | 標準対応 | Chromium E2EでEXIF読込、プレビュー、JPEG出力、ZIP出力を自動検証 |
| PNG | 標準対応 | Canvas/Imageのブラウザ標準デコーダーを使用 |
| WebP | 標準対応 | 対応ブラウザの標準デコーダーを使用 |
| HEIC / HEIF | 条件付き | Safariなどネイティブ対応ブラウザのみ。未対応時は明示エラー |
| WebM (VP8 / VP9) | 標準候補 | Chromium E2Eで写真とのプレビュー切り替えを自動検証 |
| MP4 / MOV | 条件付き | H.264/AAC等のブラウザ・OSコーデック対応状況に依存 |
| AVI / MKV / 3GP | 条件付き | コンテナと内部コーデックの両方をブラウザが再生できる場合のみ |

未対応ファイルを選択した場合は、処理を黙って失敗させず、デコードできないことを画面に表示します。

## プレビュー画質の設計

以前は画質ごとに元画像を600〜2400pxへ縮小してからフレームを再計算していたため、丸め誤差で文字位置が変化していました。現在は次の二層構造です。

1. 構図、枠、文字座標を固定された2400pxの論理解像度で一度だけ計算
2. 下書き・標準・高画質・最高画質は、表示キャンバスのピクセル密度だけを変更

そのため画質変更はシャープさだけに影響し、アスペクト比、余白、文字位置には影響しません。

## Mapboxトークン管理

ブラウザ用の公開トークンはソースから見えることが前提です。秘密トークンは絶対に配置しないでください。

1. Mapboxでデフォルトトークンではない専用の公開トークンを作成します。
2. 必要最小限の読み取りスコープだけを付与します。
3. MapboxのAccess Tokens画面でAllowed URLを `https://lingmulongtai.github.io` に制限します。
4. [js/config.js](js/config.js) の `publicToken` を専用トークンへ置き換えます。
5. MapboxのStatistics画面でアカウント全体の使用量を監視します。

アプリ側でも同じオリジンだけを許可し、端末ごとに1日100回・1か月1000回のソフト上限を設けています。ただし、クライアント側の上限は改変できるため、Mapbox側のURL制限と請求上限の代替にはなりません。URL制限はMapboxの[公式トークン管理ガイド](https://docs.mapbox.com/accounts/guides/tokens/#url-restrictions)に従って設定してください。

## ローカル実行

`index.html`を直接開くこともできますが、ブラウザのセキュリティ制限を避けるためローカルHTTPサーバーを推奨します。

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

その後 `http://127.0.0.1:4173` を開きます。Mapboxオーバーレイは本番ドメインに制限しているため、ローカルでは無効です。

## 開発とテスト

```powershell
npm.cmd install
npx.cmd playwright install chromium
npm.cmd test
```

`npm test`は次を実行します。

- JavaScript構文検査
- ESLint
- 純粋関数のユニットテスト
- JPEG読込 → プレビュー → 書き出し
- EXIF編集と設定保存
- 複数JPEGのZIP出力
- 日本語画質UIと固定レイアウト
- GPS読込時に同意前の位置情報通信がないこと
- モバイル表示とEXIF編集パネル
- 写真 / WebM動画のプレビュー切り替え

## デプロイ

GitHub Pagesワークフローは構文・Lint・ユニットテスト後に `dist/` を生成し、次のWeb公開物だけをデプロイします。

- `index.html`
- `css/`
- `js/`
- `assets/`（存在する場合）
- ファビコンSVG

IDE設定、テスト、Node.js依存関係、READMEなどは公開アーティファクトに含めません。Pull Requestと`main`へのpushでは、別のCIがChromium E2Eまで実行します。

## 構成

```text
InstaFrame/
├── index.html
├── css/style.css
├── js/
│   ├── core-utils.js
│   ├── config.js
│   ├── i18n.js
│   ├── frame-engine.js
│   └── app.js
├── tests/
│   ├── unit/
│   └── e2e/
├── scripts/prepare-site.mjs
├── playwright.config.cjs
├── eslint.config.mjs
└── .github/workflows/
    ├── ci.yml
    └── pages.yml
```

## License

[MIT](LICENSE)

---

## English summary

InstaFrame is a browser-only EXIF frame generator for photos and videos. Media processing stays on the device. Location services are opt-in and clearly disclose coordinate transfers to Nominatim, OpenStreetMap/ipapi, and Mapbox. Preview quality changes raster density without recalculating layout, so typography and composition remain stable.

Run `npm install`, `npx playwright install chromium`, and `npm test` for syntax, lint, unit, privacy, mobile, export, and photo/video browser tests. GitHub Pages deploys an allowlisted `dist/` artifact only.
