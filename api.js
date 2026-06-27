// api.js — GAS Web App バックエンド（Phase 4: GSD会員認証+メールOTP）
// 認証: GSD会員ID+PW → メールOTP → HMACセッショントークン
// 旧Google認証(OAUTH_CLIENT_ID/ACCOUNT_MAP/ALLOWED_EMAILS)・旧3固定キー(TF_/CV_/ED_)は廃止

var SMS_RULES = { SEGMENT: 70, MAX: 660 };

function doPost(e) {
  var action = '-';
  try {
    var body = JSON.parse(e.postData.contents);
    action = body.action || '-';

    var result;
    switch (action) {
      case 'login':     result = handleLogin_(body);     break;
      case 'verifyOtp': result = handleVerifyOtp_(body); break;
      case 'sendSms':   result = handleSendSms_(body);   break;
      case 'ping':      result = handlePing_(body);      break;
      default: throw new Error('unknown action: ' + action);
    }
    return json_({ ok: true, result: result });

  } catch (err) {
    logAudit_('-', action, '-', 'error: ' + (err.message || String(err)));
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ────────────────────────────────────────────────────────────────────
// login: id + pw → OTP メール送信
// ────────────────────────────────────────────────────────────────────
function handleLogin_(body) {
  var id = String(body.id || '').trim();
  var pw = String(body.pw || '');
  // id/pw が空でも同一エラーを返す（列挙不可）
  var member = id ? getMember_(id) : null;

  // 固定時間パスワード照合（タイミング攻撃対策: 必ずsafeEqual_を通す）
  var storedPw = member ? decodeBase64Str_(member.pw) : '';
  var pwOk     = safeEqual_(storedPw, pw);

  var isValid = member &&
    pwOk &&
    member.flag === 'TRUE' &&
    member.email &&
    isValidExpiry_(member.expiry) &&
    isValidStatus_(member.payment_status) &&
    isValidStatus_(member.kaihipay_status);

  // 失敗理由は一切区別しない
  if (!isValid) {
    throw new Error('IDかパスワードが違うか、ご契約が有効でない可能性があります');
  }

  var otp = generateOtp_();
  storeOtp_(id, otp);          // レート制限もここで確認
  sendOtpEmail_(member.email, otp);   // 平文はここ以降どこにも残さない

  logAudit_(id, 'login', '-', 'otp_sent');
  return { stage: 'otp_sent', email_hint: maskEmail_(member.email) };
}

// ────────────────────────────────────────────────────────────────────
// verifyOtp: OTP照合 → セッショントークン発行
// ────────────────────────────────────────────────────────────────────
function handleVerifyOtp_(body) {
  var id  = String(body.id  || '').trim();
  var otp = String(body.otp || '').trim();
  if (!id || !otp) throw new Error('IDとコードを入力してください');

  verifyOtp_(id, otp);

  var exp   = Math.floor(Date.now() / 1000) + 43200; // 12時間
  var token = signToken_({ id: id, exp: exp });

  var smsAcc = getSmsAccount_(id);
  var label  = smsAcc ? smsAcc.label : id;

  logAudit_(id, 'verifyOtp', '-', 'ok');
  return { token: token, label: label };
}

// ────────────────────────────────────────────────────────────────────
// sendSms: トークン検証 → 会員再確認 → SMS送信
// ────────────────────────────────────────────────────────────────────
function handleSendSms_(body) {
  var claims = verifyToken_(body.token);
  var id     = claims.id;

  // 会員有効性を都度再チェック
  var member = getMember_(id);
  if (!member ||
      member.flag !== 'TRUE' ||
      !isValidExpiry_(member.expiry) ||
      !isValidStatus_(member.payment_status) ||
      !isValidStatus_(member.kaihipay_status)) {
    throw new Error('ご契約が有効でないか、送信権限がありません');
  }

  rateLimitCheck_(id);

  var smsAcc = getSmsAccount_(id);
  if (!smsAcc) throw new Error('送信元設定がありません。管理者に連絡してください');
  if (String(smsAcc.enabled).toUpperCase() !== 'TRUE')
    throw new Error('送信が一時停止されています。管理者に連絡してください');

  // Base64デコードで認証情報取得（ログ・レスポンスには出さない）
  var apiKey = decodeBase64Str_(smsAcc.cpaas_api_key);
  var secret = decodeBase64Str_(smsAcc.cpaas_secret);
  var sender = smsAcc.cpaas_sender;
  var label  = smsAcc.label;

  var to   = normalizePhone_(body.to);
  var text = String(body.text || '').trim();
  if (!text) throw new Error('本文が空です');
  if (text.length > SMS_RULES.MAX)
    throw new Error('本文が長すぎます（上限 ' + SMS_RULES.MAX + '文字）');

  var segments = Math.ceil(text.length / SMS_RULES.SEGMENT);

  // CPaaS 認証トークン取得
  var authRes = UrlFetchApp.fetch('https://api.cpaas.symphony.rakuten.net/auth/v1/token', {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(apiKey + ':' + secret),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });
  if (authRes.getResponseCode() !== 200)
    throw new Error('CPaaS 認証エラー: ' + authRes.getResponseCode());
  var jwtToken = JSON.parse(authRes.getContentText()).jwt_token;

  // SMS 送信
  var smsRes = UrlFetchApp.fetch('https://api.cpaas.symphony.rakuten.net/sms/v1/submit', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + jwtToken,
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=UTF-8'
    },
    payload: JSON.stringify({
      from: sender, to: to,
      message_type: 'unicode',
      unicode_message: { text: text }
    }),
    muteHttpExceptions: true
  });

  var smsJson = JSON.parse(smsRes.getContentText());
  if (smsRes.getResponseCode() !== 200)
    throw new Error('SMS送信失敗: ' + (smsJson.result_message || smsRes.getResponseCode()));

  writeToLogSheet([
    new Date(), id, to, text,
    '送信成功', smsJson.result_message,
    text.length + ' / 660 (' + segments + ' SMS)'
  ]);
  logAudit_(id, 'sendSms', to, 'ok: ' + label);

  return { segments: segments, message: smsJson.result_message };
}

// ────────────────────────────────────────────────────────────────────
// ping: 疎通確認（トークンがあれば label も返す）
// ────────────────────────────────────────────────────────────────────
function handlePing_(body) {
  var result = { pong: true };
  if (body.token) {
    try {
      var claims = verifyToken_(body.token);
      var smsAcc = getSmsAccount_(claims.id);
      result.id    = claims.id;
      result.label = smsAcc ? smsAcc.label : claims.id;
    } catch (_) { /* トークンなしでも pong は返す */ }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// 会員マスタ取得（A シート: MASTER_SHEET_ID / api_key タブ）
// ────────────────────────────────────────────────────────────────────
function getMember_(id) {
  var ss    = SpreadsheetApp.openById(getProp_('MASTER_SHEET_ID'));
  var sheet = ss.getSheetByName('api_key');
  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0];
  var col  = {};
  hdr.forEach(function(h, i) { col[String(h).trim().toLowerCase()] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['id'] || 0]).trim() === String(id).trim()) {
      return {
        id:              String(data[r][col['id']]),
        pw:              String(data[r][col['pw']]),
        email:           String(data[r][col['email']]),
        flag:            String(data[r][col['flag']]).toUpperCase().trim(),
        expiry:          data[r][col['expiry']],
        payment_status:  String(data[r][col['payment_status']]),
        kaihipay_status: String(data[r][col['kaihipay_status']])
      };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// SMS送信元取得（B シート: SMS_SHEET_ID / sms_accounts タブ）
// ────────────────────────────────────────────────────────────────────
function getSmsAccount_(id) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('sms_accounts');
  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0];
  var col  = {};
  hdr.forEach(function(h, i) { col[String(h).trim().toLowerCase()] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['id'] || 0]).trim() === String(id).trim()) {
      return {
        id:            String(data[r][col['id']]),
        cpaas_api_key: String(data[r][col['cpaas_api_key']]),
        cpaas_secret:  String(data[r][col['cpaas_secret']]),
        cpaas_sender:  String(data[r][col['cpaas_sender']]),
        label:         String(data[r][col['label']]),
        enabled:       String(data[r][col['enabled']]).toUpperCase().trim()
      };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// OTP: 生成・保存・照合・送信
// ────────────────────────────────────────────────────────────────────
function generateOtp_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpHash_(code) {
  var key  = Utilities.newBlob(getProp_('OTP_HASH_KEY')).getBytes();
  var data = Utilities.newBlob(String(code)).getBytes();
  var sig  = Utilities.computeHmacSha256Signature(data, key);
  return sig.map(function(b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function storeOtp_(id, otp) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('otp');
  if (!sheet) {
    sheet = ss.insertSheet('otp');
    sheet.getRange(1, 1, 1, 5)
         .setValues([['id', 'otp_hash', 'expires_at', 'attempts', 'last_sent_at']])
         .setFontWeight('bold').setBackground('#f0f0f0');
  }

  var data    = sheet.getDataRange().getValues();
  var now     = new Date();
  var expires = new Date(now.getTime() + 5 * 60 * 1000);
  var hash    = otpHash_(otp);

  // 既存レコードがあればレート制限チェック後に更新
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim() !== String(id).trim()) continue;

    var lastSent = data[r][4] ? new Date(data[r][4]) : null;
    if (lastSent && (now - lastSent) < 60000)
      throw new Error('再送は60秒後にお試しください（しばらくお待ちください）');

    sheet.getRange(r + 1, 1, 1, 5)
         .setValues([[id, hash, expires, 0, now]]);
    return;
  }
  // 新規追加
  sheet.appendRow([id, hash, expires, 0, now]);
}

function verifyOtp_(id, otp) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('otp');
  if (!sheet) throw new Error('コードが無効です（期限切れ等）');

  var data = sheet.getDataRange().getValues();
  var now  = new Date();

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim() !== String(id).trim()) continue;

    var storedHash = String(data[r][1]);
    var expiresAt  = new Date(data[r][2]);
    var attempts   = Number(data[r][3]) || 0;

    // 期限切れ・試行超過 → 削除して拒否
    if (now > expiresAt || attempts >= 5) {
      sheet.deleteRow(r + 1);
      throw new Error('コードが無効です（期限切れまたは試行回数超過）');
    }

    var inputHash = otpHash_(otp);
    if (safeEqual_(storedHash, inputHash)) {
      sheet.deleteRow(r + 1); // ワンタイム: 成功即削除
      return;
    }

    // 不一致: attempts インクリメント
    attempts++;
    if (attempts >= 5) {
      sheet.deleteRow(r + 1);
      throw new Error('コードが無効です（試行回数超過。再度ログインしてください）');
    }
    sheet.getRange(r + 1, 4).setValue(attempts);
    throw new Error('コードが違います（残り ' + (5 - attempts) + ' 回）');
  }
  throw new Error('コードが無効です（期限切れ等。再度ログインしてください）');
}

function sendOtpEmail_(email, otp) {
  // otp 平文はメール本文のみ。ログ・レスポンスには一切出さない。
  MailApp.sendEmail({
    to:      email,
    subject: '【SMS送信侍】認証コード',
    body:    [
      '認証コード: ' + otp,
      '',
      'このコードは5分間有効です。',
      '心当たりのない場合はこのメールを無視してください。'
    ].join('\n')
  });
}

function maskEmail_(email) {
  var parts = String(email).split('@');
  if (parts.length !== 2) return '***@***';
  var local  = parts[0];
  var masked = local.length <= 2
    ? '***'
    : local[0] + '***' + local[local.length - 1];
  return masked + '@' + parts[1];
}

// ────────────────────────────────────────────────────────────────────
// セッショントークン（HMAC-SHA256署名）
// ────────────────────────────────────────────────────────────────────
function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function signToken_(payload) {
  var payloadStr = JSON.stringify(payload);
  var payloadB64 = b64url_(Utilities.newBlob(payloadStr).getBytes());
  var key        = Utilities.newBlob(getProp_('TOKEN_SIGN_KEY')).getBytes();
  var sig        = Utilities.computeHmacSha256Signature(
                     Utilities.newBlob(payloadB64).getBytes(), key);
  return payloadB64 + '.' + b64url_(sig);
}

function verifyToken_(token) {
  if (!token) throw new Error('ログインが必要です');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('トークン形式エラー');

  var payloadB64 = parts[0];
  var sigB64     = parts[1];
  var key        = Utilities.newBlob(getProp_('TOKEN_SIGN_KEY')).getBytes();
  var expected   = b64url_(Utilities.computeHmacSha256Signature(
                     Utilities.newBlob(payloadB64).getBytes(), key));

  if (!safeEqual_(sigB64, expected)) throw new Error('トークン署名エラー');

  var payload = JSON.parse(
    Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64 + '==')).getDataAsString()
  );
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp)
    throw new Error('セッションの有効期限が切れました。再ログインしてください');

  return payload; // { id, exp }
}

// ────────────────────────────────────────────────────────────────────
// バリデーション・ユーティリティ
// ────────────────────────────────────────────────────────────────────

// 固定時間文字列比較（タイミング攻撃対策）
function safeEqual_(a, b) {
  var aS = String(a);
  var bS = String(b);
  var maxLen = Math.max(aS.length, bS.length);
  var aP = aS.padEnd(maxLen, '\0');
  var bP = bS.padEnd(maxLen, '\0');
  var r  = 0;
  for (var i = 0; i < maxLen; i++) r |= aP.charCodeAt(i) ^ bP.charCodeAt(i);
  return r === 0 && aS.length === bS.length;
}

function decodeBase64Str_(b64) {
  try {
    return Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString();
  } catch (_) { return ''; }
}

function isValidExpiry_(expiry) {
  if (!expiry) return false;
  var d = expiry instanceof Date ? expiry : new Date(expiry);
  return !isNaN(d.getTime()) && d > new Date();
}

function isValidStatus_(status) {
  var s = String(status || '').trim().toLowerCase();
  if (!s) return false;
  var invalid = ['false', 'invalid', 'expired', 'inactive', '0', 'no',
                 '無効', 'cancelled', 'canceled', 'unpaid', 'overdue'];
  return invalid.indexOf(s) === -1;
}

function normalizePhone_(raw) {
  if (!raw) throw new Error('宛先電話番号が空です');
  var digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15)
    throw new Error('電話番号の桁数が不正です（' + digits.length + '桁）');
  return digits;
}

function rateLimitCheck_(id) {
  var cache = CacheService.getScriptCache();
  var key   = 'rl_' + id;
  var cur   = Number(cache.get(key) || '0');
  if (cur >= Number(getProp_('RATE_PER_MIN')))
    throw new Error('送信が多すぎます。しばらく待ってください');
  cache.put(key, String(cur + 1), 60);
}

// ────────────────────────────────────────────────────────────────────
// 監査ログ・ロギング
// ────────────────────────────────────────────────────────────────────
function logAudit_(id, action, to, status) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('audit');
    if (!sheet) {
      sheet = ss.insertSheet('audit');
      sheet.getRange(1, 1, 1, 5)
           .setValues([['日時', '会員ID', 'アクション', '宛先', 'ステータス']])
           .setFontWeight('bold').setBackground('#f0f0f0');
    }
    sheet.appendRow([new Date(), id, action, to, status]);
  } catch (err) {
    Logger.log('audit log error: ' + err.message);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
