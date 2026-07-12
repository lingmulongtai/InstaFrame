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
- EXIF・ZIP・動画処理・地図UI用JavaScriptと16種類のフレーム書体は、バージョン固定したnpmパッケージから生成し、サイト自身から配信します。地図タイルと位置情報APIは同意後にだけ外部へ接続します。
- 公開ページには、自己ホストスクリプト・スタイル・フォントだけを許可するContent-Security-Policyを設定しています。外部接続先は、同意後に使うNominatim・ipapi・OpenStreetMapタイル・Mapboxだけに限定し、画像ファイル自体の送信先はありません。

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
| JPEG | 標準対応 | ChromiumフルE2Eに加え、Firefox・WebKit・Microsoft Edgeで読込、プレビュー、実JPEG署名の出力を自動検証 |
| PNG | 標準対応 | Chromium・Firefox・WebKit・Microsoft Edgeで実PNG入力のデコード、プレビュー、PNG署名の出力を自動検証 |
| WebP | 標準対応 | Chromium・Firefox・WebKit・Microsoft Edgeで実WebP入力のデコード、プレビュー、RIFF/WebP署名の出力を自動検証 |
| HEIC / HEIF | 条件付き | Safariなどネイティブ対応ブラウザのみ。未対応時は明示エラー |
| WebM (VP8 / VP9) | 標準候補 | Chromium E2Eで写真とのプレビュー切り替えを検証。Linux CIでデコード可能なフレーム動画出力と音声トラック保持を自動検証 |
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

リポジトリにはトークンを同梱していません。通常の利用者は **カスタマイズ → プライバシー** へ自分のMapbox公開トークンを入力できます。値はそのブラウザの`localStorage`だけに保存されます。未設定時はマップオーバーレイを有効化できません。

サイト管理者が共通トークンを提供する場合は、次の手順が必要です。

1. Mapboxでデフォルトトークンではない専用の公開トークンを作成します。
2. Static Images APIに必要な公開 `styles:tiles` スコープだけを付与します。秘密スコープは付与しません。
3. MapboxのAccess Tokens画面でAllowed URLを `https://lingmulongtai.github.io/InstaFrame/` に制限します。
4. [js/config.js](js/config.js) の空の `publicToken` を、制限確認済みの専用トークンへ置き換えます。
5. MapboxのStatistics画面と請求書を定期的に監視します。Statisticsの反映には最大24時間かかる場合があります。

共通トークンにはアプリ側でも同じオリジンだけを許可し、共通・利用者トークンの両方に端末ごと1日100回・1か月1000回のソフト上限を設けています。ただし、クライアント側の上限は改変できるため、Mapbox側のURL制限やアカウント監視の代替にはなりません。Mapboxは設定可能な支出アラートや月額上限を現在提供していません。free tierを初めて超えた際の通知はありますが、確実な遮断が必要ならStatistics・請求書を監視し、専用トークンを削除またはローテーションしてください。URL制限はMapboxの[公式トークン管理ガイド](https://docs.mapbox.com/accounts/guides/tokens/#url-restrictions)、課金上限の制約は[公式請求ガイド](https://docs.mapbox.com/accounts/guides/invoices/#feature-requests)を確認してください。

## ローカル実行

初回に `npm.cmd install` を実行してください。`index.html`を直接開くこともできますが、依存ライブラリの準備とブラウザのセキュリティ制限回避を兼ねた、同梱のローカルHTTPサーバーを推奨します。

```powershell
npm.cmd run serve
```

その後 `http://127.0.0.1:4173` を開きます。サイト管理者が設定する共通Mapboxトークンは本番オリジンだけで利用できます。ローカル環境でも、利用者自身の公開トークンを設定して位置情報通信へ同意すればマップオーバーレイを利用できます。

## 開発とテスト

```powershell
npm.cmd install
npm.cmd run prepare:vendor
npx.cmd playwright install chromium
npm.cmd test
```

クロスブラウザ契約をローカルで再現する場合はFirefoxとWebKitも導入し、`PLAYWRIGHT_BROWSER`と`PLAYWRIGHT_SUITE=cross-browser`を設定します。Microsoft Edge契約は、Windowsにインストールされた実際の`msedge`チャンネルを使用します。

`npm test`は次を実行します。

- JavaScript構文検査
- ESLint
- 純粋関数のユニットテスト
- axeによるCritical / Seriousアクセシビリティ検査
- 初期画面、動的設定、位置情報同意、地図、エクスポート中UIの全axe違反検査
- JPEG読込 → プレビュー → 書き出し
- PNG / WebPの実ファイル読込 → プレビュー → 各形式での書き出しとファイル署名
- EXIF編集と設定保存
- 複数JPEGのZIP出力
- 大量バッチのメモリ警告と書き出しキャンセル
- 処理中エンコーダーへのAbortSignal伝播、動画プレビューとカードBlob URLの解放
- 日本語画質UIと固定レイアウト
- GPS読込時に同意前の位置情報通信がないこと
- 外部ネットワークを遮断した状態での写真プレビュー・書き出し
- 同意後の地図UIが自己ホストLeafletを読み、Leaflet CDNへ接続しないこと
- モバイル表示とEXIF編集パネル
- 写真 / WebM動画のプレビュー切り替え
- 音声付きWebMのフレーム合成 → 動画・音声トラックを保持した書き出し

## デプロイ

GitHub Pagesワークフローは構文・Lint・ユニットテスト後に `dist/` を生成し、次のWeb公開物だけをデプロイします。

- `index.html`
- `css/`
- `js/`
- `vendor/`（固定バージョンのブラウザライブラリとライセンス）
- `assets/`（存在する場合）
- ファビコンSVG

IDE設定、テスト、Node.js依存関係、READMEなどは公開アーティファクトに含めません。Pull Requestと`main`へのpushでは、CIが構文・Lint・ユニット検査を1回実行し、ChromiumのフルE2Eと、Firefox・WebKit・Microsoft Edgeの写真/UI/axe/プライバシー契約をマトリクス実行します。動画エンコード、HEIC/HEIF、MP4/MOVはブラウザ・OSコーデック依存のため、対応を一律には保証しません。

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

InstaFrame is a browser-only EXIF frame generator for photos and videos. Media processing stays on the device. Location services are opt-in and clearly disclose coordinate transfers to Nominatim, OpenStreetMap/ipapi, and Mapbox. No unrestricted Mapbox token is shipped; users may store their own public token locally. Frame fonts and browser libraries are self-hosted. Preview quality changes raster density without recalculating layout, so typography and composition remain stable.

Run `npm install`, `npx playwright install chromium`, and `npm test` for syntax, lint, unit, privacy, mobile, export, and photo/video browser tests. CI also runs Firefox, WebKit, and the installed Microsoft Edge channel against the portable photo/UI/accessibility contract. GitHub Pages deploys an allowlisted `dist/` artifact only.
