# TASK.md — SMS システム 改修タスク

## このプロジェクトについて
`tokyoflowerco.ltd@gmail.com` の GAS プロジェクトを clasp で clone したもの。
SMS 送信機能を持つ。昔作ったため、認証情報がコード直書きの想定。

- Script ID: `1gO_VLUEa4aLRYxpp-mS8ufttBdWhe3xXP35k6F6USJ2j7xyjdqWcnggo`
- 構成ファイル: `config.js` / `SMS.js` / `認証トークンの取得.js` / `コード.js` / `文字数カウント.js` / `index.html` / `conveni.html` / `edute.html` / `tokyoflower.html` / `tokyoflower000.html` / `appsscript.json`

## ゴール（3つ）
1. **現状把握** — 何がどう動いているかを文書化する
2. **セキュア情報のスクリプトプロパティ化** — ID/PW/トークン等をコードから除去し PropertiesService へ
3. **HTML の GitHub Pages 移行** — 公開してよいページを静的化し Pages へ。送信機能は安全な形で残す

## 進め方のルール（重要）
- **Phase 0 → 1 は連続で実行してよい。Phase 2 に入る前に必ず一度止まり、移行計画と仕切りを私に確認すること。**
- 各 Phase の頭で `git add -A && git commit` を行い、いつでも戻せる状態を作る（最初に `git init` 済みであること）。
- **実 SMS を送るコードを改修中に誤って実行しない。** テスト送信は私の明示指示があるまで行わない。
- 認証情報の実値（ID/PW/トークン）を **コード・ログ・git・このファイルに絶対に書き込まない**。

---

## Phase 0 — 準備と現状把握

### 0-1. ロールバック地点を作る
```bash
git init
printf ".clasp.json\n.clasprc.json\nnode_modules/\n*.log\n" > .gitignore
git add -A && git commit -m "snapshot: cloned state before refactor"
```

### 0-2. 全ファイルを読み、現状把握レポートを `REPORT.md` に出力する
以下を必ず明記すること:

- **エントリポイント**: `doGet` / `doPost` の有無と、どの HTML をどう配信しているか（`HtmlService.createTemplateFromFile` か `createHtmlOutputFromFile` か）
- **フロント↔バック連携方式**: 各 HTML が `google.script.run` を使っているか / テンプレートスクリプトレット（`<?= ?>` `<?!= ?>`）を使っているか / `<base target>` や `include()` の有無
- **SMS 送信の実装**: どの関数が、どの SMS API（業者・エンドポイント）を、どんな認証で叩いているか
- **HTML 5枚の役割分類**（次の3区分で必ずタグ付けする):
  - `[PUBLIC]` 顧客向けで送信機能を持たない（SMS リンク先LP・案内ページ等）→ Pages 移行候補
  - `[SENDER]` SMS 送信を起動する管理/操作パネル → 公開Pages不可、要認証
  - `[UNKNOWN]` 判断不能 → 私に確認を上げる
- **直書きシークレット一覧**: `ファイル名:行番号` と「何の値か（ラベルのみ・実値は書かない）」。
  探索キーワード例: `id` `pass` `pw` `password` `token` `secret` `apikey` `api_key` `authToken` `accountSid` `Basic ` `Bearer ` `key=` および全角の「パスワード」「トークン」

レポートを出力したら Phase 1 へ進んでよい（ここでは止まらない）。

---

## Phase 1 — セキュア情報をスクリプトプロパティへ

### 1-1. プロパティ読み出しの共通関数を用意する
`config.js` に追加（既存の同等物があればそれに統合）:
```javascript
function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    throw new Error('スクリプトプロパティ未設定: ' + key + ' を設定してください');
  }
  return v;
}

// 必要キーが揃っているか確認する手動実行用（実値はログに出さない）
function checkScriptProperties() {
  const required = [/* ここに Phase 0 で見つけたキー名を列挙 */];
  const sp = PropertiesService.getScriptProperties();
  const missing = required.filter(k => !sp.getProperty(k));
  Logger.log(missing.length ? '未設定: ' + missing.join(', ') : 'OK: 全キー設定済み');
}
```

### 1-2. 直書き値を全て置換する
Phase 0 のシークレット一覧について、直書きの値を `getProp_('KEY_NAME')` 呼び出しに置き換える。
- キー名は `SMS_API_USER` `SMS_API_PASS` `SMS_API_TOKEN` のように用途が分かる命名に統一。
- 置換後、コード・HTML 全体を再 grep し、**実値が1つも残っていないこと**を確認してレポートに記載。

### 1-3. 設定値の入れ方（私が手動でやる。コードに値を書くな）
プロパティの実値投入は **GAS エディタの「プロジェクトの設定 → スクリプトプロパティ」から私が手で行う**。
→ Claude Code は「投入すべきキー名の一覧」だけを `REPORT.md` に出力すること（値は空欄）。

### 1-4. コミット
```bash
clasp push --user tokyoflower   # まだ push しない方針なら省略可。指示があるまでローカルのみでも可
git add -A && git commit -m "refactor: move secrets to Script Properties"
```
※ `clasp push` するとリモートの本番コードが上書きされる。**push してよいか不明な場合は push せず私に確認すること。**

---

## Phase 2 — GitHub Pages 移行（※開始前に必ず確認を取る）

Phase 0 のページ分類をもとに、ここで **移行計画を提示して私の承認を得てから**着手する。

### 2-1. 基本方針
- `[PUBLIC]` ページのみ静的化して GitHub Pages（`/docs` 配下）へ。
- `[SENDER]` ページは公開しない。下記いずれかを私に選ばせる:
  - (a) 送信パネルは GAS の Web アプリのまま残す（最小変更・安全）
  - (b) Pages 化するなら、後述のトークン認証必須 + サーバ側レート制限を実装
- スクリプトレット（`<?= ?>` 等）や `include()` は静的化できないため、**該当箇所を素の HTML/JS にインライン展開**する。
- `google.script.run` 呼び出しは GitHub Pages では動かない。→ 下記 fetch 方式に書き換える。

### 2-2. バックエンドを Web API 化（残す送信機能用）
`コード.js` に doPost を実装し、フロントから fetch で叩けるようにする:
```javascript
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);          // text/plain で受ける（CORS preflight 回避）
    if (body.token !== getProp_('WEBAPP_SHARED_TOKEN')) {  // 簡易認証
      return json_({ ok: false, error: 'unauthorized' });
    }
    switch (body.action) {
      case 'sendSms':
        // 既存の送信関数を呼ぶ
        return json_({ ok: true, result: /* ... */ });
      default:
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

### 2-3. フロント側の fetch 雛形（GitHub Pages 側）
```javascript
const WEBAPP_URL = 'https://script.google.com/macros/s/XXXX/exec';
async function callBackend(action, payload) {
  const res = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // ← preflight を出さないため text/plain
    body: JSON.stringify({ action, token: '???', ...payload })
  });
  return res.json();
}
```

### 2-4. ⚠ セキュリティ上の必須確認（私に上げること）
- クライアント JS に置いたトークンは閲覧者に見える。送信エンドポイントを公開 Pages から叩かせる構成は **第三者に SMS を乱発される（コスト・特定電子メール法リスク）**。
- そのため `[SENDER]` 系は **原則 (a)＝GASのまま** を推奨。どうしても Pages 化する場合は、サーバ側で「送信元許可リスト」「1分あたり送信上限」「日次上限」を `getProp_` 由来の値で必ず実装する。
- ここは私の判断が要るので、**勝手に公開デプロイしない**。

### 2-5. ディレクトリ構成（Pages 用）
```
/docs            ← GitHub Pages 公開ルート
  index.html     ← [PUBLIC] のみ
  conveni.html   ← 分類に応じて
  ...
```
GitHub リポジトリ作成・`docs/` を Pages 公開設定にする手順、push 手順を `REPORT.md` に追記。

---

## 完了条件チェックリスト
- [ ] `REPORT.md` に現状把握・ページ分類・キー一覧・移行計画が揃っている
- [ ] コード/HTML/git にシークレット実値が一切残っていない（再 grep 済み）
- [ ] `checkScriptProperties()` が OK を返す
- [ ] `[SENDER]` 系が無防備に公開されていない
- [ ] 各 Phase ごとに git commit 済み
