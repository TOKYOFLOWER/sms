# TASK-Phase2-4.md — アカウント別ログイン方式へ変更

## 目的（仕様変更）
タブで送信元を選ぶ現行方式をやめ、**ログインした Google アカウントに紐づく1社だけが送信できる**方式にする。
- 送信元アカウントは **サーバ側がログインメールから自動決定**（クライアントの指定は信用しない）。
- ユーザーは自社以外のアカウントを **見ることも選ぶことも送ることもできない**。
- 副次効果として、未投入アカウントのキーを読みにいくバグ（例: 東京フラワー送信時に `CV_API_KEY` を要求）も解消する＝**ログイン中の1社分の認証情報だけを遅延読み込み**する。

## 認可・対応付けの方針
新しい Script Property `ACCOUNT_MAP`（JSON, email→account）を唯一の権限ソースにする。
例: `{"tokyoflowerco.ltd@gmail.com":"tokyoflower"}`（conveni / edute は各社のメールが決まり次第キーを追加）。
- `ACCOUNT_MAP` のキー（メール）に無いアカウントは送信不可。→ 旧 `ALLOWED_EMAILS` は不要（残っていても害は無いが参照しない）。

---

## バックエンド（api.js）変更

### 1. トークン検証で「メール＋アカウント」を返す
```javascript
const ACCOUNT_PREFIX = { tokyoflower:'TF', conveni:'CV', edute:'ED' };
const ACCOUNT_LABEL  = { tokyoflower:'東京フラワー', conveni:'コンビニ', edute:'エデュテ' };

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

  const email = String(info.email).toLowerCase();
  const map = JSON.parse(getProp_('ACCOUNT_MAP'));   // {email: account}
  const account = map[email];
  if (!account) throw new Error('このGoogleアカウントには送信権限がありません: ' + info.email);
  return { email: email, account: account };          // ← オブジェクトで返す
}
```

### 2. 認証情報は「決定した1社分だけ」遅延読み込み
```javascript
function getAccountCreds_(account) {
  const p = ACCOUNT_PREFIX[account];
  if (!p) throw new Error('不明なアカウント: ' + account);
  return {
    apiKey: getProp_(p + '_API_KEY'),
    secret: getProp_(p + '_SECRET'),
    sender: getProp_(p + '_SENDER')
  };
}
```
- 既存の全アカウント一括読み（`getAccounts_()` 等）は廃止 or この関数に置換。**全9キーを起動時に読むのをやめる**。

### 3. doPost：authを各処理へ渡す。クライアントの account は無視
```javascript
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const auth = verifyIdToken_(body.idToken);        // {email, account}
    rateLimitCheck_(auth.email);
    let result;
    switch (body.action) {
      case 'ping':
        result = { pong: true, user: auth.email,
                   account: auth.account, label: ACCOUNT_LABEL[auth.account] };
        break;
      case 'sendSms':
        result = handleSendSms_(auth, body);          // ← body.account は使わない
        break;
      default: throw new Error('unknown action: ' + body.action);
    }
    logAudit_(auth.email, auth.account, body, 'ok');
    return json_({ ok: true, result });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}
```

### 4. handleSendSms_：アカウントは auth から取得
```javascript
function handleSendSms_(auth, body) {
  const creds = getAccountCreds_(auth.account);       // ログイン中の1社のみ
  const to    = normalizePhone_(body.to);
  const text  = String(body.text || '');
  if (!text) throw new Error('本文が空です');
  // 文字数上限チェック（既存ロジック流用）
  // creds.apiKey / creds.secret / creds.sender を使って既存 sendSingleSMS を呼ぶ
  // return { messageId, segments } 等
}
```
- `logAudit_` の引数に `account` を追加し、どの会社で送ったかも監査シートに残す。

---

## フロント（docs/index.html）変更

1. **3タブ（東京フラワー/コンビニ/エデュテ）を完全撤去。** `?a=` の解釈も削除。
2. サインイン成功後に `ping` を呼び、応答の `label` を使って **「送信元: ◯◯◯（読み取り専用表示）」**をフォーム上部に出す。ユーザーは選択不可。
3. 送信フォームは「国番号 / 電話番号 / メッセージ / 送信」だけ。`sendSms` 呼び出しに **account を含めない**（含めてもサーバが無視するが、混乱を避け削除）。
4. 自社以外の情報・送信元番号・他社名は画面に一切出さない。
5. `ping` が `account` を返さない/権限なしの場合は、フォームを出さず「このアカウントには送信権限がありません」と表示するだけにする。

---

## 完了条件
- [ ] 東京フラワーのアカウントでログイン → 「送信元: 東京フラワー」表示、タブ無し
- [ ] `CV_API_KEY` 等を未投入でも東京フラワー送信が成立（1社分のみ読む）
- [ ] クライアントから別 account を偽装注入しても、ログインメール由来のアカウントで処理される
- [ ] `ACCOUNT_MAP` に無いアカウントは送信不可表示
- [ ] commit & push。**実 SMS はユーザー操作で1通のみ**（コードからは送らない）

---

## 注意（未処理の課題・別途）
旧認証情報が **公開リポジトリの過去コミットに露出**したままなので、この変更の push 後に
「履歴を1コミットへ作り直して force-push」＋「SMSプロバイダ側でキー再発行」を実施すること。
