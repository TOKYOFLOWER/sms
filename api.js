// api.js — GAS Web App バックエンド（Phase 2-4 改訂）
// 認可: ACCOUNT_MAP (Script Property, JSON) のみが権威。ALLOWED_EMAILS は参照しない。
// 送信元アカウントはサーバがログインメールから自動決定。クライアントの account 指定は無視。

// SMS セグメントルール — 権威的定義（docs/index.html の SMS_RULES と必ず一致させること）
// Rakuten CPaaS unicode モード: 1セグメント = 70文字、上限 = 660文字
var SMS_RULES = { SEGMENT: 70, MAX: 660 };

// アカウント識別子 → Script Property プレフィックスの対応
var ACCOUNT_PREFIX = { tokyoflower: 'TF', conveni: 'CV', edute: 'ED' };

// アカウント識別子 → 表示名
var ACCOUNT_LABEL = {
  tokyoflower: '銀座東京フラワー',
  conveni:     '伝票印刷製本のコンビニ',
  edute:       'エデュテ'
};

function doPost(e) {
  var auth   = null;
  var action = '-';
  try {
    var body = JSON.parse(e.postData.contents);
    action   = body.action || '-';

    auth = verifyIdToken_(body.idToken);   // {email, account}
    rateLimitCheck_(auth.email);

    var result;
    switch (body.action) {
      case 'ping':
        result = {
          pong:    true,
          user:    auth.email,
          account: auth.account,
          label:   ACCOUNT_LABEL[auth.account] || auth.account
        };
        break;
      case 'sendSms':
        result = handleSendSms_(auth, body);
        break;
      default:
        throw new Error('unknown action: ' + body.action);
    }

    logAudit_(auth.email, auth.account, action, body.to || '-', 'ok');
    return json_({ ok: true, result: result });

  } catch (err) {
    var errEmail   = auth ? auth.email   : '(unauthenticated)';
    var errAccount = auth ? auth.account : '-';
    logAudit_(errEmail, errAccount, action, '-', 'error: ' + (err.message || String(err)));
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Google ID トークン検証 → {email, account} を返す
// ACCOUNT_MAP の JSON でメール→アカウントを解決。キーに無ければ送信不可。
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('未ログイン');
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error('トークン検証失敗（期限切れ等）');
  var info = JSON.parse(res.getContentText());

  if (info.aud !== getProp_('OAUTH_CLIENT_ID'))     throw new Error('aud 不一致');
  if (info.iss !== 'https://accounts.google.com' &&
      info.iss !== 'accounts.google.com')           throw new Error('iss 不正');
  if (String(info.email_verified) !== 'true')       throw new Error('メール未確認');

  var email   = String(info.email).toLowerCase();
  var map     = JSON.parse(getProp_('ACCOUNT_MAP'));  // {"email@x.com": "tokyoflower", ...}
  var account = map[email];
  if (!account) throw new Error('このGoogleアカウントには送信権限がありません: ' + info.email);

  return { email: email, account: account };
}

// ログイン中アカウントの認証情報（1社分のみ）を読む
// 他社の Script Property は一切参照しない
function getAccountCreds_(account) {
  var p = ACCOUNT_PREFIX[account];
  if (!p) throw new Error('不明なアカウント: ' + account);
  return {
    apiKey: getProp_(p + '_API_KEY'),
    secret: getProp_(p + '_SECRET'),
    sender: getProp_(p + '_SENDER')
  };
}

// Rakuten CPaaS 認証トークン取得（creds を直接受け取り、全アカウント一括読みを回避）
function getAuthTokenFromCreds_(creds) {
  var res = UrlFetchApp.fetch('https://api.cpaas.symphony.rakuten.net/auth/v1/token', {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.apiKey + ':' + creds.secret),
      'Accept':        'application/json'
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200)
    throw new Error('CPaaS 認証エラー: ' + res.getResponseCode());
  return JSON.parse(res.getContentText()).jwt_token;
}

// 簡易レート制限: RATE_PER_MIN 回/分 per ユーザー（CacheService）
function rateLimitCheck_(email) {
  var cache = CacheService.getScriptCache();
  var key   = 'rl_' + email;
  var cur   = Number(cache.get(key) || '0');
  if (cur >= Number(getProp_('RATE_PER_MIN')))
    throw new Error('送信が多すぎます。少し待ってください');
  cache.put(key, String(cur + 1), 60);
}

// 監査ログ（誰が・どのアカウントで・いつ・どこへ・結果）
function logAudit_(email, account, action, to, status) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('audit');
    if (!sheet) {
      sheet = ss.insertSheet('audit');
      var h = ['日時', 'ユーザー', 'アカウント', 'アクション', '宛先', 'ステータス'];
      sheet.getRange(1, 1, 1, h.length).setValues([h])
           .setFontWeight('bold').setBackground('#f0f0f0');
    }
    sheet.appendRow([new Date(), email, account, action, to, status]);
  } catch (err) {
    Logger.log('audit log error: ' + err.message);
  }
}

// sendSms アクション: アカウントは auth から取得。body.account は参照しない。
function handleSendSms_(auth, body) {
  var creds    = getAccountCreds_(auth.account);   // ログイン中の1社分のみ読む
  var to       = normalizePhone_(body.to);
  var text     = String(body.text || '').trim();
  if (!text) throw new Error('本文が空です');
  if (text.length > SMS_RULES.MAX)
    throw new Error('本文が長すぎます（上限 ' + SMS_RULES.MAX + '文字）');

  var segments = Math.ceil(text.length / SMS_RULES.SEGMENT);
  var token    = getAuthTokenFromCreds_(creds);

  var res = UrlFetchApp.fetch('https://api.cpaas.symphony.rakuten.net/sms/v1/submit', {
    method:  'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept':        'application/json',
      'Content-Type':  'application/json; charset=UTF-8'
    },
    payload: JSON.stringify({
      from:            creds.sender,
      to:              to,
      message_type:    'unicode',
      unicode_message: { text: text }
    }),
    muteHttpExceptions: true
  });

  var jsonRes = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200)
    throw new Error('SMS 送信失敗: ' + (jsonRes.result_message || res.getResponseCode()));

  writeToLogSheet([
    new Date(), auth.account, to, text,
    '送信成功', jsonRes.result_message,
    text.length + ' / 660 (' + segments + ' SMS)'
  ]);

  return { segments: segments, message: jsonRes.result_message };
}

// 電話番号の正規化・バリデーション（非数字除去後、7〜15 桁）
function normalizePhone_(raw) {
  if (!raw) throw new Error('宛先電話番号が空です');
  var digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15)
    throw new Error('電話番号の桁数が不正です（' + digits.length + '桁）');
  return digits;
}
