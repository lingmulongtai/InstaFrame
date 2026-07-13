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
- EXIF・ZIP・動画処理・地図UI用JavaScriptと16種類のフレーム書体は、バージョン固定したnpmパッケージから生成し、サイト自身から配信します。EXIF解析器・ZIP生成器・フレーム書体は必要になるまで読み込みません。地図タイルと位置情報APIは同意後にだけ外部へ接続します。
- 公開ページには、自己ホストスクリプト・スタイル・フォントだけを許可するContent-Security-Policyを設定しています。外部接続先は、同意後に使うNominatim・ipapi・OpenStreetMapタイル・Mapboxだけに限定し、画像ファイル自体の送信先はありません。

## 主な機能

- 写真・動画のライブプレビューと一括処理
- メーカー、機種、レンズ、焦点距離、絞り、シャッター速度、ISO、位置情報の編集
- フレーム色、ぼかし背景、文字色（自動・明るい・暗い・カスタム）
- 6144px固定レイアウト、最大1200%ズーム、ズーム追従の高密度ライブプレビュー
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
| HEIC / HEIF | 条件付き | Safariなどネイティブ対応ブラウザのみ。未対応・破損時の明示エラーは検証済みだが、有効なHEICの成功経路はCI対象外 |
| WebM (VP8 / VP9) | 条件付き | VP8入力はChromium・Firefox・Microsoft Edgeでプレビュー成功を検証。Playwright WebKitは実行環境のコーデック差を許容し、実寸のあるデコード済みフレームまたは明示的な非対応エラーのどちらかを検証します。Linux Chromiumでは動画出力と音声トラック保持も検証。VP9入力はブラウザのコーデック対応に依存し、CI対象外 |
| MP4 (H.264 / AAC) | 条件付き | H.264 Baseline映像とAAC-LC音声を含む有効なMP4 fixtureを4ブラウザCIへ入力。Chromium・Firefox・Microsoft Edgeでは映像フレームのデコード済みプレビューを必須とし、Playwright WebKitでは明示的なコーデックエラーを許容。入力AAC音声のデコード・保持はこの契約の検証対象外 |
| MOV (H.264 / AAC) | 条件付き | 同じ映像・音声をQuickTimeコンテナへ再格納した有効fixtureを4ブラウザCIへ入力。映像プレビューの要件と入力AAC音声の未検証範囲はMP4と同じ |
| M4V (H.264 / AAC) | 条件付き | 検証済みMP4 fixtureを`.m4v`・`video/x-m4v`として4ブラウザCIへ入力。映像プレビューの要件と入力AAC音声の未検証範囲はMP4と同じ |
| AVI / MKV / 3GP | 条件付き | コンテナと内部コーデックの両方をブラウザが再生できる場合のみ |

表はファイル選択画面で案内する主要形式です。ドラッグ＆ドロップでは、このほかの`image/*`・`video/*`もブラウザがネイティブデコードできる場合に利用できます。画像・動画ではない未対応形式は追加せず拒否件数を表示し、候補形式をブラウザがデコードできない場合も項目ごとのエラーを画面に表示します。

写真の出力はJPEG・PNG・WebPです。要求したMIME形式とブラウザが返したBlob形式が一致する場合だけ、その拡張子で保存します。動画出力は`MediaRecorder.isTypeSupported()`で実際に利用可能と判定されたMP4またはWebM（VP8 / VP9）だけを表示し、対応形式がないブラウザでは動画出力を無効化します。入力音声はブラウザが取得できる場合に出力へ再エンコードして保持します。MOV・M4V・AVI・MKV・3GPは入力候補であり、同じコンテナでの出力を意味しません。

## ブラウザ資源の安全上限

すべてを端末内で処理するため、入力ファイルより大きいデコード済み画素・Canvas・動画チャンク・ZIP Blobがメモリに存在します。ブラウザやタブ全体が停止する前に失敗を画面へ返すため、次の安全上限を設けています。

- 1回の作業領域は最大50項目、単一ファイル256 MiB、入力合計512 MiB
- 写真は最大60メガピクセル
- 単一Canvasは一辺16,384pxかつ64メガピクセル以下
- 保持する生成済み出力の推定合計は384 MiB以下
- ZIP作成中の保持済み出力・写真Blob・完成ZIPの推定ピークは512 MiB以下
- 動画は選択ビットレートから見積もった出力が512 MiB以下
- 写真・動画カードのサムネイル同時デコードは種類ごと最大2件、同一項目の生成処理は最大1件
- MediaRecorderの実チャンクとWebCodecsの圧縮済みchunkが512 MiBを超える前に生成を中断。WebCodecsの未処理エンコード待ち行列は最大4フレーム
- 動画書き出しはメタデータを15秒、デコードフレーム進行を60秒待っても進まない場合に終了し、一時リソースを解放

30項目を超える場合は上限内でも先に警告します。上限を超えたファイルは追加または生成せず、既に追加した項目は保持します。書き出しはキャンセルでき、削除・再編集・ページ離脱時にはCanvas、Blob URL、MediaStream、AudioContextを解放します。戻る/進むキャッシュから復帰した場合は、解放済みの生成結果を未処理へ戻してライブプレビューを再構築します。

## プレビュー画質の設計

以前は画質ごとに元画像を600〜2400pxへ縮小してからフレームを再計算していたため、丸め誤差で文字位置が変化していました。現在は次の二層構造です。

1. 構図、枠、文字座標を固定された6144pxの論理解像度で一度だけ計算
2. 下書き・標準・高画質・最高画質は、表示キャンバスのピクセル密度だけを変更
3. Autoは通常表示でも最低2倍、ズーム時は倍率に合わせて最大12倍のバックバッファへ再描画
4. プレビュー用の縮小画素はJPEGへ再圧縮せず、ロスレスなCanvasのままフレームへ渡す

そのため画質変更や最大1200%までのズームはシャープさと表示範囲だけに影響し、アスペクト比、余白、文字位置には影響しません。ライブCanvasはデスクトップ24メガピクセル、モバイル12メガピクセルを上限として、端末メモリを使い切らない範囲で倍率へ追従します。

## Mapboxトークン管理

ブラウザ用の公開トークンはソースから見えることが前提です。秘密トークンは絶対に配置しないでください。

リポジトリにはトークンを同梱していません。通常の利用者は **カスタマイズ → プライバシー** へ自分のMapbox公開トークンを入力できます。値はそのブラウザの`localStorage`だけに保存されます。未設定時はマップオーバーレイを有効化できません。

サイト管理者が共通トークンを提供する場合は、次の手順が必要です。

1. Mapboxでデフォルトトークンではない専用の公開トークンを作成します。
2. Static Images APIに必要な公開 `styles:tiles` スコープだけを付与します。秘密スコープは付与しません。
3. MapboxのAccess Tokens画面でAllowed URLを `https://lingmulongtai.github.io/InstaFrame/` に制限します。
4. [js/config.js](js/config.js) の空の `publicToken` を、制限確認済みの専用トークンへ置き換えます。
5. MapboxのStatistics画面と請求書を定期的に監視します。Statisticsの反映には最大24時間かかる場合があります。

共通トークンにはアプリ側でも同じオリジンだけを許可し、共通・利用者トークンの両方に端末ごと1日100回・1か月1000回のソフト上限を設けています。成功、失敗、タイムアウトを問わず、ブラウザが開始したStatic Images要求を1回として数えます。ただし、クライアント側の上限は改変できるため、Mapbox側のURL制限やアカウント監視の代替にはなりません。Mapboxは設定可能な支出アラートや月額上限を現在提供していません。free tierを初めて超えた際の通知はありますが、確実な遮断が必要ならStatistics・請求書を監視し、専用トークンを削除またはローテーションしてください。URL制限はMapboxの[公式トークン管理ガイド](https://docs.mapbox.com/accounts/guides/tokens/#url-restrictions)、課金上限の制約は[公式請求ガイド](https://docs.mapbox.com/accounts/guides/invoices/#feature-requests)を確認してください。

## 外部環境での残検証

コードとCIだけでは代替できない検証は、完了扱いにせず次のIssueで追跡しています。

- [Issue #40](https://github.com/lingmulongtai/InstaFrame/issues/40): Mapbox管理画面での専用公開トークン、Allowed URL、実Refererの許可/拒否、監視・ローテーション運用
- [Issue #41](https://github.com/lingmulongtai/InstaFrame/issues/41): 実Safari / iOSと有効なHEIC / HEIF / MOV / MP4 / VP9 fixtureによる成功経路
- [Issue #42](https://github.com/lingmulongtai/InstaFrame/issues/42): 実VoiceOver / NVDAと全テーマの手動コントラスト確認
- [Issue #43](https://github.com/lingmulongtai/InstaFrame/issues/43): 低メモリ実機での長時間・大規模な写真/動画混在プロファイル

## ローカル実行

初回に `npm.cmd ci` を実行してください。`index.html`を直接開くこともできますが、依存ライブラリの準備とブラウザのセキュリティ制限回避を兼ねた、同梱のローカルHTTPサーバーを推奨します。

```powershell
npm.cmd run serve
```

その後 `http://127.0.0.1:4173` を開きます。`serve` はPagesと同じ許可済みファイルだけを `dist/` へ生成して配信し、リポジトリ内の設定・テスト・`.git` はHTTP公開しません。サイト管理者が設定する共通Mapboxトークンは本番オリジンだけで利用できます。ローカル環境でも、利用者自身の公開トークンを設定して位置情報通信へ同意すればマップオーバーレイを利用できます。

## 開発とテスト

```powershell
npm.cmd ci
npm.cmd run prepare:vendor
npx.cmd playwright install chromium
npm.cmd test
```

クロスブラウザ契約をローカルで再現する場合はFirefoxとWebKitも導入し、`PLAYWRIGHT_BROWSER`と`PLAYWRIGHT_SUITE=cross-browser`を設定します。Microsoft Edge契約は、Windowsにインストールされた実際の`msedge`チャンネルを使用します。

`npm test`は、既定ではChromiumのフルE2Eを含む次の検証を実行します。

- JavaScript構文検査
- ESLint
- 純粋関数のユニットテスト
- axeによるCritical / Seriousアクセシビリティ検査
- 初期画面、動的設定、位置情報同意、地図、エクスポート中UIの全axe違反検査
- ライト、ソフトホワイト、ブルーグレー、ダーク、OS連動（明・暗）の動的設定と削除ダイアログに対するWCAG AA色コントラスト検査
- JPEG読込 → プレビュー → 書き出し
- PNG / WebPの実ファイル読込 → プレビュー → 各形式での書き出しとファイル署名
- EXIF編集と設定保存
- 複数JPEGのZIP出力
- 大量バッチのメモリ警告、入力・画素・Canvas・生成済み出力の安全上限、書き出しキャンセル
- EXIF・ZIP・フォントが必要になるまで初回取得されないこと
- 処理中エンコーダーと写真エンコードへのAbortSignal伝播、WebCodecsの背圧・生成途中の出力上限、動画メタデータ・フレーム進行のタイムアウト
- デコード済みフレーム単位の動画プレビュー、カード・ダウンロードBlob URL、Canvas、MediaStream、AudioContextの解放
- 戻る/進むキャッシュを繰り返した場合のCanvas・Blob URL解放とプレビュー復帰
- 日本語画質UI、6144px固定レイアウト、最大1200%のズーム追従バックバッファ
- リサイズ境界のキーボード操作と、デスクトップ / モバイル遷移時のフォーカス維持
- GPS読込時に同意前の位置情報通信がないこと
- 外部ネットワークを遮断した状態での写真プレビュー・書き出し
- 同意後の地図UIが自己ホストLeafletを読み、Leaflet CDNへ接続しないこと
- モバイル表示とEXIF編集パネル

GitHub Actionsでは、上記に加えて次のCI専用契約を実行します。

- Chromium・Firefox・WebKit・Microsoft Edgeで、16種類すべての自己ホストフォント、写真/UI/axe/プライバシー契約を検証
- Chromium・Firefox・Microsoft EdgeでのVP8 WebM動画プレビューと、WebKitでのデコード成功または明示的な非対応エラー
- H.264 Baseline映像とAAC-LC音声を含むMP4・QuickTime MOV・M4V入力の4ブラウザ契約（Chromium・Firefox・Microsoft Edgeは映像フレームのデコード必須、Playwright WebKitは明示エラーを許容。入力AAC音声のデコード・保持は対象外）
- Linux Chromiumでの音声付きWebMフレーム合成 → 動画・音声トラックを保持した書き出し
- 全品質ゲートと4ブラウザ契約が成功した`main`コミットだけをGitHub Pagesへデプロイ

## デプロイ

GitHub Pagesへの公開は、構文・Lint・ユニットテストに加え、Chromium・Firefox・WebKit・Microsoft Edgeのブラウザマトリクスがすべて成功したmainコミットだけを対象にします。その後 `dist/` を生成し、次のWeb公開物だけをデプロイします。

- `index.html`
- `css/`
- `js/`
- `vendor/`（固定バージョンのブラウザライブラリとライセンス）
- `assets/`（存在する場合）
- ファビコンSVG

IDE設定、テスト、Node.js依存関係、READMEなどは公開アーティファクトに含めません。Pull Requestと`main`へのpushでは、CIが構文・Lint・ユニット検査を1回実行し、Pagesと同じ `dist/` を生成してから、ChromiumのフルE2EとFirefox・WebKit・Microsoft Edgeの写真/UI/axe/プライバシー契約をマトリクス実行します。各ブラウザはローカル資産のrevisionと、リポジトリ内部ファイルが配信されないことも確認します。動画エンコード、HEIC/HEIF、MP4/MOVはブラウザ・OSコーデック依存のため、対応を一律には保証しません。

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
    └── ci.yml  # 品質ゲートとGitHub Pagesデプロイ
```

## License

[MIT](LICENSE)

---

## English summary

InstaFrame is a browser-only EXIF frame generator for photos and videos. Media processing stays on the device. Location services are opt-in and clearly disclose coordinate transfers to Nominatim, OpenStreetMap/ipapi, and Mapbox. No unrestricted Mapbox token is shipped; users may store their own public token locally. Frame fonts and browser libraries are self-hosted. Preview quality changes raster density without recalculating the 6144px logical layout, so typography and composition remain stable through 1200% zoom.

Run `npm ci`, `npx playwright install chromium`, and `npm test` for syntax, lint, unit, privacy, mobile, export, and photo/video browser tests. Browser tests build and serve the same allowlisted `dist/` boundary used by Pages, without exposing repository internals. CI also runs Firefox, WebKit, and the installed Microsoft Edge channel against the portable photo/UI/accessibility contract.
