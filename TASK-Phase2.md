# TASK-Phase2.md — SMS送信パネルの GitHub Pages 化（B方式）

## 採用方針
HTML 5枚は全て [SENDER]（SMS送信パネル）。モバイルで GAS の上部バーを出したくないため、
**フロントを GitHub Pages の静的SPA に移し、GAS は Web App バックエンド（API）化**する。
認可は「Google ログイン（ID トークン）＋メール・ホワイトリスト」でアプリ層に持たせる。

```
[スマホ/PC] --(fetch text/plain + idToken)--> [GAS Web App doPost] --(検証OK)--> 既存の送信ロジック
   GitHub Pages 静的フロント                     ContentService で JSON 返却
```

## 不変条件（厳守）
- **apiKey / secret / 送信元番号は絶対にフロント（Pages）に出さない。** SMS 送信は必ず GAS 側だけで行う。
- フロントから来た値は信用しない。**送信先・本文・文字数・送信元アカウントはサーバ側でも再検証**する。
- 私の明示指示があるまで実 SMS を送らない（テストは `ping` アクションまで）。
- 各ステップで `git commit`。`clasp push` と公開デプロイは指示を待つ。

---

## 事前準備（とみぃが手動。Claude Code は実値を扱わない）
Claude Code は「やること一覧」を `REPORT.md` に書くだけでよい。実作業は私がやる。

1. **OAuth クライアントID 発行**: Google Cloud Console → 認証情報 → 「OAuth 2.0 クライアント ID」→ 種類「ウェブアプリケーション」。
   - 承認済みの JavaScript 生成元 に GitHub Pages の origin（例 `https://tokyoflowerco-ltd.github.io`、独自ドメインがあればそれも）を登録。
   - 発行された `xxxx.apps.googleusercontent.com` を控える。
2. **OAuth 同意画面**: テスト中なら自分のメールを「テストユーザー」に追加（実質もう1段のホワイトリストになる）。
3. **Script Properties に追加投入**（Phase1 のキーに加えて）:
   | キー名 | 用途 |
   |---|---|
   | `OAUTH_CLIENT_ID` | 上記クライアントID（aud 検証用） |
   | `ALLOWED_EMAILS` | 送信を許可する Google アカウント（カンマ区切り） |
   | `RATE_PER_MIN` | 1ユーザーあたり毎分送信上限（例 `10`） |

---

## Phase 2-0. 既存5ページの棚卸し（まず実行）
`index.html / conveni.html / edute.html / tokyoflower.html / tokyoflower000.html` を読み、`REPORT.md` に:
- 各ページの役割と、対応アカウント（tokyoflower / conveni / edute のどれか）
- 各ページが叩いている送信関数名と入力項目（宛先・本文・オプション）
- 重複・統合できる箇所

そのうえで **UI 構成案を提示**する。デフォルト案は「**1つの SPA にアカウント切替（tokyoflower/conveni/edute）を持たせる**」。
ページごとに項目が大きく違うなら個別ビューでもよい。案を `REPORT.md` に書いてから 2-1 へ。

---

## Phase 2-1. バックエンドを Web App API 化
`api.js` を新規作成（既存 `コード.js` の doGet 等はそのまま温存）。

```javascript
function doPost(e) {
  try {
    const body  = JSON.parse(e.postData.contents);
    const email = verifyIdToken_(body.idToken);   // 失敗で throw
    rateLimitCheck_(email);                        // 超過で throw
    let result;
    switch (body.action) {
      case 'ping':    result = { pong: true, user: email }; break;
      case 'sendSms': result = handleSendSms_(email, body); break; // ←実送信。後述の検証必須
      default: throw new Error('unknown action: ' + body.action);
    }
    logAudit_(email, body, 'ok');
    return json_({ ok: true, result });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Google ID トークン検証 → 許可メールなら検証済みメールを返す
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('未ログイン');
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('トークン検証失敗（期限切れ等）');
  const info = JSON.parse(res.getContentText());
  if (info.aud !== getProp_('OAUTH_CLIENT_ID')) throw new Error('aud 不一致');
  if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com')
    throw new Error('iss 不正');
  if (String(info.email_verified) !== 'true') throw new Error('メール未確認');
  const allowed = getProp_('ALLOWED_EMAILS').split(',').map(s => s.trim().toLowerCase());
  if (allowed.indexOf(String(info.email).toLowerCase()) === -1)
    throw new Error('許可されていないユーザー: ' + info.email);
  return info.email;
}

// 簡易レート制限（毎分）
function rateLimitCheck_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + email;
  const cur = Number(cache.get(key) || '0');
  if (cur >= Number(getProp_('RATE_PER_MIN'))) throw new Error('送信が多すぎます。少し待ってください');
  cache.put(key, String(cur + 1), 60);
}

// 監査ログ（誰が・いつ・どのアカウントで・どこへ）。本文は必要なら要約のみ。
function logAudit_(email, body, status) {
  // 専用シート（例: 'audit'）に appendRow。シートIDは Script Properties で管理。
}

// 実送信。フロント値を信用せずサーバ側で再検証してから既存ロジックを呼ぶ
function handleSendSms_(email, body) {
  const account = body.account;                       // 'tokyoflower' | 'conveni' | 'edute'
  if (['tokyoflower','conveni','edute'].indexOf(account) === -1) throw new Error('不正なアカウント');
  const to   = normalizePhone_(body.to);              // サーバ側で番号バリデーション
  const text = String(body.text || '');
  if (!text) throw new Error('本文が空です');
  // 文字数も getProp_ 経由の上限でサーバ側チェック（文字数カウント.js のロジックを流用）
  // 既存の sendSingleSMS / getAuthToken（getAccounts_ 経由）を呼んで送信
  // return { messageId, segments } 等
}
```
- `getProp_` / `getAccounts_`（Phase1で実装済み）を再利用すること。
- `normalizePhone_` と文字数チェックは `文字数カウント.js` の既存ロジックを移植/共用。
- `handleSendSms_` の中身は Phase 2-0 で把握した既存送信関数に接続する。

---

## Phase 2-2. フロントを静的SPA化（/docs）
`/docs` 配下にモバイルファーストで再構築。GAS の HTML 由来の `google.script.run`・スクリプトレットは全廃し fetch に置換。

- Google Identity Services でログイン:
```html
<script src="https://accounts.google.com/gsi/client" async></script>
```
```javascript
const CLIENT_ID  = 'xxxx.apps.googleusercontent.com'; // 公開してよい値（秘密ではない）
const WEBAPP_URL = 'https://script.google.com/macros/s/XXXX/exec';
let idToken = null;

google.accounts.id.initialize({ client_id: CLIENT_ID,
  callback: r => { idToken = r.credential; onSignedIn(); } });
google.accounts.id.renderButton(document.getElementById('signin'), { theme:'outline', size:'large' });

async function callApi(action, payload) {
  if (!idToken) { google.accounts.id.prompt(); throw new Error('未ログイン'); }
  const res = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // ★preflight回避（CORS対策）
    body: JSON.stringify({ action, idToken, ...payload })
  });
  const data = await res.json();
  if (!data.ok && /ログイン|トークン|aud|許可/.test(data.error||'')) {
    idToken = null; google.accounts.id.prompt();   // 期限切れ→再ログイン誘導
  }
  return data;
}
```
- UI: アカウント切替（tokyoflower/conveni/edute）／宛先入力／本文＋**文字数リアルタイム表示**（`文字数カウント.js` をクライアントへ移植）／送信ボタン／結果トースト。
- ID トークンは**メモリ保持のみ**（localStorage に置かない＝XSS 対策）。リロード時は再ログイン。
- モバイル最適化: `<meta name="viewport">`、上部バー無し、タップしやすいボタン。
- PWA 化（任意・推奨）: `manifest.json` ＋最小 service worker でホーム追加対応。
- **送信先・本文の最終確認モーダル**を入れて誤送信を防ぐ。

---

## Phase 2-3. デプロイ（指示を待って実施）
1. バックエンド: `clasp push --user tokyoflower` → エディタ or `clasp create-deployment` で
   **「実行：自分／アクセス：全員」**の Web アプリとしてデプロイ → `/exec` URL を取得。
2. フロント: `CLIENT_ID` と `WEBAPP_URL` を埋め、GitHub リポジトリに push → Settings → Pages で
   公開元を `/docs` に設定 → 公開 origin を OAuth の「承認済み JavaScript 生成元」に追加。
3. `git commit`。

---

## 完了条件チェックリスト
- [ ] フロントに apiKey/secret/送信元番号が一切無い（grep 済み）
- [ ] 許可メールのみ送信可、未許可メールは拒否される
- [ ] サーバ側で宛先・本文・文字数・アカウントを再検証している
- [ ] レート制限と監査ログが動作
- [ ] モバイルで上部バーが出ず、レイアウトが崩れない
- [ ] `ping` で疎通確認（実送信は私の合図まで保留）
- [ ] 各ステップ commit 済み
