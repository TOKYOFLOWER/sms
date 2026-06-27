# REPORT.md — SMS システム 現状把握レポート

## 1. エントリポイント

有効な `doGet` は `config.js:102-108` のみ（他はコメントアウト）。

```js
// config.js:102-108 (有効)
function doGet(e) {
  var accountId = "conveni";
  var template = HtmlService.createTemplateFromFile('conveni');
  template.senderNumber = accounts[accountId].sender;
  return template.evaluate()
    .setTitle('SMS送信フォーム - 伝票印刷製本のコンビニ');
}
```

- 配信方式: `HtmlService.createTemplateFromFile()` → `template.evaluate()` （テンプレートスクリプトレット有効）
- 現在デプロイ対象: `conveni.html` のみ
- `doPost` は `SMS.js` に書かれているが、ファイル全体がコメントアウト → **現在 doPost は存在しない**

---

## 2. フロント↔バック連携方式

| ファイル | 連携方式 | スクリプトレット | base target |
|---|---|---|---|
| index.html | `google.script.run` | `<?= senderNumber ?>` あり | なし |
| conveni.html | `google.script.run` | `<?= senderNumber ?>` あり | なし |
| edute.html | `google.script.run` | `<?= senderNumber ?>` あり | なし |
| tokyoflower.html | `google.script.run` | `<?= senderNumber ?>` あり | なし |
| tokyoflower000.html | `google.script.run` | なし | `<base target="_top">` あり |

- `include()` の使用: なし
- 全 HTML は `google.script.run.sendSingleSMS(phone, message, accountId)` でサーバ関数を呼び出す

---

## 3. SMS 送信の実装

**API 業者**: Rakuten CPaaS (Symphony)
- 認証エンドポイント: `https://api.cpaas.symphony.rakuten.net/auth/v1/token`
- 送信エンドポイント: `https://api.cpaas.symphony.rakuten.net/sms/v1/submit`

**認証フロー**:
1. `認証トークンの取得.js:25-47` の `getAuthToken(accountId)` が実行される
2. `config.js` の `accounts` オブジェクトから `apiKey` と `secret` を取得
3. `"apiKey:secret"` を Base64 エンコード → `Authorization: Basic ...` で GET リクエスト
4. レスポンスの `jwt_token` を取得 → `Authorization: Bearer <jwt>` で SMS 送信 POST

**送信関数**: `認証トークンの取得.js:88-147` の `sendSingleSMS(phoneNumber, message, accountId)`
- ログを `writeToLogSheet()` でスプレッドシートの "log" シートに記録

**その他**: `コード.js:1-54` にも `sendSMS()` 関数があるが、これはスプレッドシートからの一括送信用（古いコード、`accounts` オブジェクトを使わず独自の apiKey/secret 直書き）

---

## 4. HTML 5枚の役割分類

| ファイル | 分類 | 理由 |
|---|---|---|
| `index.html` | `[SENDER]` | `google.script.run.sendSingleSMS` を呼び出し; accountId="default" |
| `conveni.html` | `[SENDER]` | `google.script.run.sendSingleSMS` を呼び出し; accountId="conveni" |
| `edute.html` | `[SENDER]` | `google.script.run.sendSingleSMS` を呼び出し; accountId="edute" |
| `tokyoflower.html` | `[SENDER]` | `google.script.run.sendSingleSMS` を呼び出し; accountId="tokyoflower" |
| `tokyoflower000.html` | `[SENDER]` | `google.script.run.sendSingleSMS` を呼び出し; accountId="tokyoflower" 固定 (旧版) |

**全 HTML が `[SENDER]`**。`[PUBLIC]` ページは存在しない。

---

## 5. 直書きシークレット一覧（実値は記載しない）

| ファイル:行番号 | 何の値か |
|---|---|
| `config.js:65` | tokyoflower — Rakuten CPaaS の apiKey |
| `config.js:66` | tokyoflower — Rakuten CPaaS の secret（パスワード） |
| `config.js:67` | tokyoflower — SMS 送信元電話番号 |
| `config.js:69` | conveni — Rakuten CPaaS の apiKey |
| `config.js:70` | conveni — Rakuten CPaaS の secret |
| `config.js:71` | conveni — SMS 送信元電話番号 |
| `config.js:73` | edute — Rakuten CPaaS の apiKey |
| `config.js:74` | edute — Rakuten CPaaS の secret |
| `config.js:75` | edute — SMS 送信元電話番号 |
| `コード.js:8` | tokyoflower — Rakuten CPaaS の apiKey（重複） |
| `コード.js:9` | tokyoflower — Rakuten CPaaS の secret（重複） |
| `SMS.js:174` (コメント内) | tokyoflower — SMS 送信元電話番号（コメントのみ） |

---

## 6. Phase 1 で投入すべきスクリプトプロパティ キー名一覧

GAS エディタ「プロジェクトの設定 → スクリプトプロパティ」から手動で設定してください（値はここに書きません）。

| キー名 | 用途 |
|---|---|
| `TF_API_KEY` | tokyoflower の Rakuten CPaaS apiKey |
| `TF_SECRET` | tokyoflower の Rakuten CPaaS secret |
| `TF_SENDER` | tokyoflower の SMS 送信元電話番号 |
| `CV_API_KEY` | conveni の Rakuten CPaaS apiKey |
| `CV_SECRET` | conveni の Rakuten CPaaS secret |
| `CV_SENDER` | conveni の SMS 送信元電話番号 |
| `ED_API_KEY` | edute の Rakuten CPaaS apiKey |
| `ED_SECRET` | edute の Rakuten CPaaS secret |
| `ED_SENDER` | edute の SMS 送信元電話番号 |

---

## 7. Phase 2 事前メモ（Phase 1 完了時点）

- 全 HTML が `[SENDER]` のため、**GitHub Pages へ移行できるページはゼロ**
- Phase 2 で移行先に `[PUBLIC]` ページが必要な場合は新規作成が必要
- `[SENDER]` は原則 GAS の Web アプリのまま運用（TASK.md Phase 2-2-4 参照）
- Phase 2 着手前に必ず移行計画を提示して承認を得る

---

## Phase 2-0. 既存5ページ 棚卸しレポート

### 各ページ詳細

#### 1. `index.html` — 旧汎用フォーム
| 項目 | 内容 |
|---|---|
| 対応アカウント | `"default"` → **`getAccounts_()` に存在しないキー。現状呼ぶと即エラー** |
| 送信関数 | `google.script.run.sendSingleSMS(fullPhoneNumber, message, "default")` |
| 入力項目 | 国番号（全リスト・日本選択済）, 電話番号（text）, メッセージ（textarea） |
| 機能 | 文字数カウント: **なし**, スピナー: **なし**, 確認モーダル: **なし** |
| スクリプトレット | `<?= senderNumber ?>` あり |
| デザイン | Noto Sans JP、青ボタン。旧バージョン |
| 状態 | **実質デッドコード**（accountId="default" が無効） |

#### 2. `conveni.html` — 伝票印刷製本のコンビニ（現行デプロイ中）
| 項目 | 内容 |
|---|---|
| 対応アカウント | `"conveni"` |
| 送信関数 | `google.script.run.sendSingleSMS(fullPhoneNumber, message, "conveni")` |
| 入力項目 | 国番号（全リスト・日本選択済）, 電話番号（tel / numeric）, メッセージ（textarea） |
| 機能 | 文字数カウント: **あり**（0/660, SMS通数）, スピナー: **あり**, 確認モーダル: **なし** |
| スクリプトレット | `<?= senderNumber ?>` あり（モーダル上部に「送信元番号: 」として表示） |
| デザイン | Kosugi Maru、「SMS送信侍」タイトル、tokyoflower.jp のランダム画像 |

#### 3. `edute.html` — エデュテ
| 項目 | 内容 |
|---|---|
| 対応アカウント | `"edute"` |
| 送信関数 | `google.script.run.sendSingleSMS(fullPhoneNumber, message, "edute")` |
| 入力項目 | 国番号（全リスト・日本選択済）, 電話番号（tel / numeric）, メッセージ（textarea） |
| 機能 | 文字数カウント: **あり**, スピナー: **あり**, 確認モーダル: **なし** |
| スクリプトレット | `<?= senderNumber ?>` あり |
| デザイン | `conveni.html` と**コード完全一致**（accountId hidden 値のみ異なる） |

#### 4. `tokyoflower.html` — 銀座東京フラワー
| 項目 | 内容 |
|---|---|
| 対応アカウント | `"tokyoflower"` |
| 送信関数 | `google.script.run.sendSingleSMS(fullPhoneNumber, message, "tokyoflower")` |
| 入力項目 | 国番号（全リスト・日本選択済）, 電話番号（tel / numeric）, メッセージ（textarea） |
| 機能 | 文字数カウント: **あり**, スピナー: **あり**, 確認モーダル: **なし** |
| スクリプトレット | `<?= senderNumber ?>` あり |
| デザイン | `conveni.html` と**コード完全一致**（accountId hidden 値のみ異なる） |

#### 5. `tokyoflower000.html` — 銀座東京フラワー（旧版・最小構成）
| 項目 | 内容 |
|---|---|
| 対応アカウント | `"tokyoflower"` （hidden フィールドなし、JS に直書き） |
| 送信関数 | `google.script.run.sendSingleSMS(fullPhoneNumber, message, "tokyoflower")` |
| 入力項目 | 国番号（**日本のみ**）, 電話番号（text）, メッセージ（textarea） |
| 機能 | 文字数カウント: **なし**, スピナー: **なし**, 確認モーダル: **なし** |
| スクリプトレット | **なし**（`<base target="_top">` あり） |
| デザイン | 素のHTML。最小構成 |
| 状態 | tokyoflower.html の旧版。**冗長** |

---

### 重複・統合できる箇所

```
conveni.html      ┐
edute.html        ├── 全く同じ HTML（hidden value だけ違う）→ SPA 1枚に統合可
tokyoflower.html  ┘

index.html          → accountId="default" が無効。廃止
tokyoflower000.html → tokyoflower.html の機能サブセット。廃止
```

**共通ロジックの重複：**
- 国番号フルリスト（150+ 行）が conveni/edute/tokyoflower/index の4ファイルに完全コピー
- 文字数カウント関数が conveni/edute/tokyoflower と `文字数カウント.js`（スプレッドシート用）で別実装
- handleSubmit / 国番号+電話番号の組み立てロジックが全ページ同一

---

### UI 構成案

**デフォルト案: 1 SPA にアカウント切替を持たせる**

```
docs/
  index.html     ← 1枚の静的 SPA
  manifest.json  ← PWA（任意）
  sw.js          ← service worker（任意）
```

SPA の画面フロー:
```
[Google ログイン] → [アカウント切替タブ: tokyoflower / conveni / edute]
                 → [国番号 + 電話番号 + メッセージ + 文字数]
                 → [確認モーダル（送信先・本文・アカウント）]
                 → [送信ボタン] → [スピナー] → [結果トースト]
```

**採用理由：**
- 3ページが同一コードのため統合が自然
- アカウントごとに URL を変えたい場合は `?account=conveni` の URL パラメータで対応可（ブックマーク対応）
- 管理者（1人）が複数アカウントを使い分けるユースケースに適合

**各要素の実装方針：**
| 要素 | 方針 |
|---|---|
| 認証 | Google Identity Services（idToken をメモリのみ保持） |
| アカウント切替 | タブ or セレクト。URLパラメータ `?a=conveni` でブックマーク対応 |
| 国番号 | 共通コンポーネント化（1箇所管理）。日本をデフォルト選択 |
| 電話番号 | `<input type="tel" inputmode="numeric">` |
| 文字数カウント | JS でリアルタイム（70文字/通、上限660文字） |
| 確認モーダル | 送信前に「〇〇番へ送信: [本文プレビュー]」を表示 |
| 送信元番号表示 | GAS から取得せず非表示（apiKey/secret は GAS 側で管理） |
| スタイル | Kosugi Maru継承、モバイルファースト、上部バーなし |

---

## Phase 2-1 / 2-2 実装メモ

### SMS セグメントルール（権威的定義）

| 項目 | 値 | 根拠 |
|---|---|---|
| モード | unicode（日本語対応） | Rakuten CPaaS の `message_type: "unicode"` |
| 1セグメント | **70 文字** | Unicode SMS（UCS-2）の仕様 |
| 最大文字数 | **660 文字** | Rakuten CPaaS の送信上限 |
| 通数計算 | `ceil(len / 70)` | 0文字のときは 0通 |

**実装箇所:**
- `api.js` の `SMS_RULES` が権威（サーバ側で再検証）
- `docs/index.html` の `SMS_RULES` はフロント表示用（同じ値を参照）
- `文字数カウント.js` はスプレッドシートの onEdit 用（別系統・1通=70文字で共通）

### アカウント別権限の拡張余地

現状は `ALLOWED_EMAILS` 1本（全ブランド共通）。将来 edute 等を別オペレーターに渡す場合は `ALLOWED_EMAILS_CONVENI` / `ALLOWED_EMAILS_EDUTE` 等のキーに分割し `verifyIdToken_` をアカウント別参照に拡張可。

### Phase 2-3 に向けてやること（作業者: とみぃ）

1. Google Cloud Console で「ウェブアプリケーション」型 OAuth クライアントID を発行
2. Script Properties に `OAUTH_CLIENT_ID` / `ALLOWED_EMAILS` / `RATE_PER_MIN` を投入
3. GAS を Web App としてデプロイ（実行: 自分、アクセス: 全員）→ `/exec` URL 取得
4. `docs/index.html` の `CLIENT_ID` と `WEBAPP_URL` を実値に置き換え
5. GitHub リポジトリ作成 → `/docs` を Pages 公開元に設定
6. OAuth クライアントIDの「承認済み JavaScript 生成元」に Pages URL を登録
7. `ping` で疎通確認 → OKなら実 SMS 送信テスト（私の合図で）
