// api.js — GAS Web App バックエンド（Phase 4: GSD会員認証+メールOTP）
// 認証: GSD会員ID+PW → メールOTP → HMACセッショントークン
// 旧Google認証(OAUTH_CLIENT_ID/ACCOUNT_MAP/ALLOWED_EMAILS)・旧3固定キー(TF_/CV_/ED_)は廃止

var SMS_RULES = { SEGMENT: 70, MAX: 660 };

// 利用権判定: kaihipay_status の有効値（ホワイトリスト）
// 未知の値を誤って有効にしないよう明示一致のみ有効
var KAIHI_ACTIVE_VALUES = ['active'];

function doPost(e) {
  var action = '-';
  try {
    var body = JSON.parse(e.postData.contents);
    action = body.action || '-';

    var result;
    switch (action) {
      case 'login':                result = handleLogin_(body);                break;
      case 'verifyOtp':            result = handleVerifyOtp_(body);            break;
      case 'verifyTrustedDevice':  result = handleVerifyTrustedDevice_(body);  break;
      case 'registerTrustedDevice':result = handleRegisterTrustedDevice_(body);break;
      case 'sendSms':              result = handleSendSms_(body);              break;
      case 'sendSmsForm':          result = handleSendSmsForm_(body);          break;
      case 'ping':                 result = handlePing_(body);                 break;
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
  var storedPw   = member ? decodeBase64Str_(member.pw) : '';
  // 空pwガード: 格納pwが空なら入力に関わらず必ず失敗（空==空の偽陽性を防ぐ）
  var pwNonEmpty = storedPw.length > 0;
  var pwOk       = pwNonEmpty && safeEqual_(storedPw, pw);

  // entitled = license_valid && (kaihiActive || grandfathered)
  // flag・payment_status(GMO廃止残骸)は判定に使わない
  var isValid = member && pwOk && member.email && isEntitled_(member);

  // 失敗理由は一切区別しない
  if (!isValid) {
    throw new Error('IDかパスワードが違うか、ご契約が有効でない可能性があります');
  }

  // otp_required チェック（sms_accounts 列がなければ TRUE 扱い・安全側）
  var smsAcc = getSmsAccount_(id);
  if (smsAcc && !smsAcc.otp_required) {
    var exp = Math.floor(Date.now() / 1000) + 43200;
    var tok = signToken_({ id: id, exp: exp });
    logAudit_(id, 'login', '-', 'token_issued_direct');
    return { stage: 'token_issued', token: tok, label: smsAcc.label };
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

  // 会員有効性を都度再チェック（entitled = license_valid && (kaihiActive || grandfathered)）
  var member = getMember_(id);
  if (!member || !isEntitled_(member)) {
    throw new Error('ご契約が有効でないか、送信権限がありません');
  }

  rateLimitCheck_(id);

  var result = sendSingleSMSFromForm({
    accountId:   id,
    phoneNumber: body.to,
    message:     body.text,
    countryCode: '81'
  });
  if (!result.success) throw new Error(result.message);
  return { segments: result.how_many_message_parts, message: result.result_message };
}

// token 検証 + 会員確認 → sendSingleSMSFromForm へ委譲（doPost action:'sendSmsForm'）
function handleSendSmsForm_(body) {
  var claims = verifyToken_(body.token);
  var id     = claims.id;
  var member = getMember_(id);
  if (!member || !isEntitled_(member))
    throw new Error('ご契約が有効でないか、送信権限がありません');
  rateLimitCheck_(id);
  var result = sendSingleSMSFromForm({
    accountId:   id,
    phoneNumber: body.to,
    message:     body.text,
    countryCode: String(body.countryCode || '81')
  });
  if (!result.success) throw new Error(result.message);
  return result;
}

// ────────────────────────────────────────────────────────────────────
// sendSingleSMSFromForm: CPaaS 送信ロジック本体
//   doPost(handleSendSms_ / handleSendSmsForm_) および
//   将来の google.script.run 両方から呼べるよう token を持たない設計
// ────────────────────────────────────────────────────────────────────
function sendSingleSMSFromForm(data) {
  var sender       = null;
  var normalizedTo = null;
  try {
    var smsAcc = getSmsAccount_(data.accountId);
    if (!smsAcc) throw new Error('送信元設定がありません。管理者に連絡してください');
    if (String(smsAcc.enabled).toUpperCase() !== 'TRUE')
      throw new Error('送信が一時停止されています。管理者に連絡してください');

    // from: スプレッドシートが数値化しても先頭0を守るため必ず String
    sender = String(smsAcc.cpaas_sender || '').trim();
    if (sender.length > 0 && sender.length <= 9)
      Logger.log('[WARN] sender が9桁以下 — 先頭0が欠落している可能性: "' + sender + '"');

    normalizedTo = normalizePhoneNumber_(data.phoneNumber, data.countryCode || '81');

    var text = String(data.message || '').trim();
    if (!text) throw new Error('本文が空です');
    if (text.length > SMS_RULES.MAX)
      throw new Error('本文が長すぎます（上限 ' + SMS_RULES.MAX + '文字）');

    // 認証情報取得（ログ・レスポンスには出さない）
    var apiKey   = decodeBase64Str_(smsAcc.cpaas_api_key);
    var secret   = decodeBase64Str_(smsAcc.cpaas_secret);
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

    // 送信前ログ（secret / JWT は出さない）
    var payload = {
      from: sender, to: normalizedTo,
      message_type: 'unicode',
      unicode_message: { text: text }
    };
    Logger.log('SMS送信開始');
    Logger.log('accountId: '      + data.accountId);
    Logger.log('from: '           + sender);
    Logger.log('to: '             + normalizedTo);
    Logger.log('message length: ' + text.length);
    Logger.log('payload: '        + JSON.stringify(payload));

    // SMS 送信
    var smsRes = UrlFetchApp.fetch('https://api.cpaas.symphony.rakuten.net/sms/v1/submit', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + jwtToken,
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=UTF-8'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var statusCode   = smsRes.getResponseCode();
    var responseText = smsRes.getContentText();
    Logger.log('Rakuten CPaaS statusCode: ' + statusCode);
    Logger.log('Rakuten CPaaS response: '   + responseText);

    var smsJson = JSON.parse(responseText);
    // HTTP 200 かつ result_code === 0 のみ成功
    if (statusCode !== 200 || Number(smsJson.result_code) !== 0)
      throw new Error('SMS送信失敗: ' + (smsJson.result_message || statusCode));

    appendSmsLog_({
      '送信日時': new Date(), '会員ID': data.accountId,
      'from': sender, 'to': normalizedTo, 'メッセージ内容': text,
      'ステータス': '送信成功', 'result_code': smsJson.result_code,
      'result_message': smsJson.result_message, 'message_id': smsJson.message_id,
      'how_many_message_parts': smsJson.how_many_message_parts,
      '文字数情報': text.length + ' / 660 (' + segments + ' SMS)'
    });
    logAudit_(data.accountId, 'sendSms', normalizedTo, 'ok: ' + smsAcc.label);

    return {
      success: true, message: '送信しました',
      result_code: smsJson.result_code, result_message: smsJson.result_message,
      message_id: smsJson.message_id,
      how_many_message_parts: smsJson.how_many_message_parts,
      to: normalizedTo, from: sender
    };

  } catch (e) {
    appendSmsLog_({
      '送信日時': new Date(), '会員ID': String(data.accountId || ''),
      'from': sender || '', 'to': normalizedTo || String(data.phoneNumber || ''),
      'メッセージ内容': String(data.message || ''),
      'ステータス': 'エラー', 'result_message': e.message
    });
    logAudit_(String(data.accountId || '-'), 'sendSms',
              normalizedTo || String(data.phoneNumber || '-'), 'error: ' + e.message);
    return { success: false, message: e.message,
             to: normalizedTo, from: sender };
  }
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
        flag:            String(data[r][col['flag']] || ''),            // 参照のみ・判定に使わない
        expiry:          data[r][col['expiry']],
        payment_status:  String(data[r][col['payment_status']] || ''), // GMO廃止残骸・判定に使わない
        kaihipay_status: String(data[r][col['kaihipay_status']] || ''),
        role:            col['role'] !== undefined                      // grandfathered 判定に使用
                           ? String(data[r][col['role']] || '')
                           : ''
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
        enabled:       String(data[r][col['enabled']]).toUpperCase().trim(),
        // 列なし・空・TRUE以外 → true（安全側に倒す）
        otp_required:  col['otp_required'] !== undefined
                         ? String(data[r][col['otp_required']] || '').toUpperCase().trim() !== 'FALSE'
                         : true
      };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// 信頼デバイス: 登録・照合・清掃
// ────────────────────────────────────────────────────────────────────

// 信頼デバイストークンの HMAC ハッシュ（TOKEN_SIGN_KEY で署名）
function trustedDeviceHash_(raw) {
  var key  = Utilities.newBlob(getProp_('TOKEN_SIGN_KEY')).getBytes();
  var data = Utilities.newBlob(String(raw)).getBytes();
  var sig  = Utilities.computeHmacSha256Signature(data, key);
  return sig.map(function(b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

// 同一id の期限切れ信頼デバイス行を削除（肥大化防止）
function cleanExpiredTrustedDevices_(id) {
  try {
    var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
    var sheet = ss.getSheetByName('trusted_devices');
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var now  = new Date();
    // 下から削除して行番号ずれを防ぐ
    for (var r = data.length - 1; r >= 1; r--) {
      if (String(data[r][0]).trim() !== String(id).trim()) continue;
      if (now > new Date(data[r][2])) sheet.deleteRow(r + 1);
    }
  } catch (_) {}
}

// verifyTrustedDevice: 信頼トークン照合 → セッショントークン発行
function handleVerifyTrustedDevice_(body) {
  var id           = String(body.id || '').trim();
  var trustedToken = String(body.trusted_token || '').trim();
  if (!id || !trustedToken) throw new Error('認証情報が不正です');

  cleanExpiredTrustedDevices_(id); // 古いレコードを先に清掃

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('trusted_devices');
  if (!sheet) throw new Error('認証情報が不正です');

  var data = sheet.getDataRange().getValues();
  var now  = new Date();
  var hash = trustedDeviceHash_(trustedToken);

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim() !== id) continue;
    if (!safeEqual_(String(data[r][1]), hash)) continue;
    if (now > new Date(data[r][2])) {
      sheet.deleteRow(r + 1);
      throw new Error('認証情報が不正です'); // 曖昧エラー
    }
    // 有効 → 会員有効性を再確認
    var member = getMember_(id);
    if (!member || !isEntitled_(member))
      throw new Error('ご契約が有効でないか、送信権限がありません');

    var exp    = Math.floor(Date.now() / 1000) + 43200;
    var token  = signToken_({ id: id, exp: exp });
    var smsAcc = getSmsAccount_(id);
    var label  = smsAcc ? smsAcc.label : id;

    logAudit_(id, 'verifyTrustedDevice', '-', 'ok');
    return { token: token, label: label };
  }
  throw new Error('認証情報が不正です'); // 曖昧エラー
}

// registerTrustedDevice: OTP認証済みセッションで信頼デバイスを登録
function handleRegisterTrustedDevice_(body) {
  var claims    = verifyToken_(body.token);
  var id        = claims.id;
  var userAgent = String(body.user_agent || '').substring(0, 512);

  var rawToken = Utilities.getUuid() + Utilities.getUuid(); // 256bit 相当
  var hash     = trustedDeviceHash_(rawToken);
  var now      = new Date();
  var expires  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30日

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('trusted_devices');
  if (!sheet) {
    sheet = ss.insertSheet('trusted_devices');
    sheet.getRange(1, 1, 1, 5)
         .setValues([['id', 'token_hash', 'expires_at', 'user_agent', 'created_at']])
         .setFontWeight('bold').setBackground('#f0f0f0');
  }
  sheet.appendRow([id, hash, expires, userAgent, now]);
  cleanExpiredTrustedDevices_(id); // 古いレコードを清掃

  logAudit_(id, 'registerTrustedDevice', '-', 'ok');
  return { trusted_token: rawToken }; // 生トークンは1回限り返却
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
    // シートの値が "BASE64:xxxxx" 形式で保存されている場合はプレフィックスを除去
    var s = String(b64 || '').replace(/^BASE64:/i, '');
    return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString();
  } catch (_) { return ''; }
}

function isValidExpiry_(expiry) {
  if (!expiry) return false;
  var d = expiry instanceof Date ? expiry : new Date(expiry);
  return !isNaN(d.getTime()) && d > new Date();
}

// kaihipay_status のホワイトリスト判定（未知の値を誤って有効にしないよう明示一致）
function isKaihiActive_(status) {
  var s = String(status || '').trim().toLowerCase();
  return KAIHI_ACTIVE_VALUES.indexOf(s) !== -1;
}

// 利用権判定: entitled = license_valid && (kaihiActive || grandfathered)
// flag（実行中フラグ）・payment_status（GMO廃止残骸）は参照しない
function isEntitled_(member) {
  if (!member) return false;
  if (!isValidExpiry_(member.expiry)) return false;
  var kaihiActive   = isKaihiActive_(member.kaihipay_status);
  var grandfathered = String(member.role || '').trim() === 'grandfathered';
  return kaihiActive || grandfathered;
}

function normalizePhoneNumber_(raw, countryCode) {
  var phone = String(raw || '').replace(/[^\d]/g, '');
  if (!phone) throw new Error('宛先電話番号が空です');
  var code = String(countryCode || '81').replace(/[^\d]/g, '');
  if (phone.indexOf(code) === 0) return phone;          // 81... はそのまま
  if (phone.charAt(0) === '0') return code + phone.substring(1); // 070... → 8170...
  return code + phone;                                  // 70... → 8170...
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

// ────────────────────────────────────────────────────────────────────
// 列追記対応ログ書き込み
//   既存シートのヘッダー行を読み取り、列名の揺れをエイリアスで吸収して
//   正しい列位置に書き込む。同名列は最初の出現位置を優先。
//   from/result_* 等の拡張列は H列（index 7）以降に配置。
// ────────────────────────────────────────────────────────────────────
function appendSmsLog_(logObj) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('log');

    // シートがない場合のみ新規作成
    if (!sheet) {
      sheet = ss.insertSheet('log');
      sheet.getRange(1, 1, 1, 12).setValues([[
        '日時','会員ID','宛先','メッセージ','ステータス','文字数情報','',
        'from','result_code','result_message','message_id','how_many_message_parts'
      ]]).setFontWeight('bold').setBackground('#f0f0f0');
    }

    // logObj キー → 実シートのヘッダー名（列名の揺れを吸収）
    var KEY_ALIAS = {
      '送信日時':      '日時',   // A列
      'to':            '宛先',   // C列
      'メッセージ内容': 'メッセージ' // D列
    };
    // H列以降に配置する拡張列（既存になければ追加）
    var EXTENDED_COLS = ['from','result_code','result_message','message_id','how_many_message_parts'];

    // ヘッダー行読み取り（同名列は最初の出現位置を優先して重複を無視）
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var hdrRow  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var hdrMap  = {};
    hdrRow.forEach(function(h, i) {
      var name = String(h).trim();
      if (name && hdrMap[name] === undefined) hdrMap[name] = i;
    });

    // 拡張列が未登録なら H列（index 7 = 8列目）以降に追加
    EXTENDED_COLS.forEach(function(col) {
      if (hdrMap[col] === undefined) {
        var c = Math.max(sheet.getLastColumn() + 1, 8);
        sheet.getRange(1, c).setValue(col).setFontWeight('bold').setBackground('#f0f0f0');
        hdrMap[col] = c - 1;
      }
    });

    // エイリアス解決後にデータ行を組み立て
    var row = new Array(sheet.getLastColumn()).fill('');
    Object.keys(logObj).forEach(function(key) {
      var colName = KEY_ALIAS[key] !== undefined ? KEY_ALIAS[key] : key;
      if (hdrMap[colName] !== undefined) row[hdrMap[colName]] = logObj[key];
    });
    sheet.appendRow(row);
  } catch (err) {
    Logger.log('log write error: ' + err.message);
  }
}
