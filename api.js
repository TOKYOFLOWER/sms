// api.js — GAS Web App バックエンド（Phase 4: GSD会員認証+メールOTP）
// 認証: GSD会員ID+PW → メールOTP → HMACセッショントークン
// 旧Google認証(OAUTH_CLIENT_ID/ACCOUNT_MAP/ALLOWED_EMAILS)・旧3固定キー(TF_/CV_/ED_)は廃止

var SMS_RULES = { SEGMENT: 70, MAX: 660 };

// 利用権判定: kaihipay_status の有効値（ホワイトリスト）
// 未知の値を誤って有効にしないよう明示一致のみ有効
var KAIHI_ACTIVE_VALUES = ['active'];

// log シートの列定義（唯一の真実）。シートの列順と一致させること。
var LOG_HEADERS = [
  '送信日時', '会員ID', 'from', 'to', 'メッセージ内容', 'ステータス',
  'result_code', 'result_message', 'message_id', 'how_many_messages', '文字数情報'
];

// ────────────────────────────────────────────────────────────────────
// SCHEMA: 商用化データモデル（タブ→ヘッダーの単一情報源）
//   ensureSchema_() がこれを走査してシート作成・列追加を行う。
//   ・sheetProp:      'MASTER_SHEET_ID' | 'SMS_SHEET_ID'（getProp_() で解決）
//   ・headers:        新規作成時に書き込むヘッダー全体。既存必須タブ（headers未定義な
//                      らタブが無くても作成しない＝存在前提のタブ）は null。
//   ・appendHeaders:  既存タブの末尾に追記する列（無ければ headers 全体を追記候補にする）。
//   ・phoneColumns:   電話番号を格納する列名。setNumberFormat('@') を適用する対象。
//   既存列の削除・並び替えは絶対に行わない（末尾追加のみ）。
// ────────────────────────────────────────────────────────────────────
var SCHEMA = [
  // ---- 既存タブ: 末尾に列追加のみ（タブが無い場合は作成しない） ----
  {
    sheetProp: 'MASTER_SHEET_ID', tab: 'api_key',
    headers: null,
    // tenant_role: 商用化のテナント内ロール(owner|staff)。
    // entitlement判定に使う既存の role 列（grandfathered等）とは別物なので列名を分離している。
    appendHeaders: ['tenant_id', 'tenant_role']
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'log',
    headers: LOG_HEADERS,
    appendHeaders: ['tenant_id', 'batch_id']
  },

  // ---- 新規タブ（すべて SMS_SHEET_ID 側） ----
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'tenants',
    headers: [
      'tenant_id', '会社名', '代表者名', '担当者名', '担当者メール', '担当者電話', '住所',
      'plan', 'status', '申込日', 'trial_end', 'trial_free_limit',
      'fincode_customer_id', 'fincode_card_id', 'daily_limit', 'created_at', 'updated_at'
    ]
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'sender_numbers',
    headers: ['tenant_id', '電話番号', '名義', 'status', '申請日', '登録日', 'sms_account_key'],
    phoneColumns: ['電話番号']
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'templates',
    headers: ['template_id', 'tenant_id', '名称', '本文', 'created_by', 'created_at']
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'queue',
    headers: [
      'queue_id', 'tenant_id', '会員ID', 'from', 'to', 'body', 'scheduled_at',
      'status', 'result', 'sent_at', 'batch_id'
    ],
    phoneColumns: ['from', 'to']
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'usage',
    headers: ['tenant_id', '年月', 'sent_count', 'free_used', 'billable_count', '更新日時']
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'invoices',
    headers: [
      'invoice_id', 'tenant_id', '年月', 'plan', 'sent_count', 'included',
      'overage_count', 'base_fee', 'overage_fee', 'subtotal', 'tax', 'total',
      'fincode_order_id', 'status', 'charged_at'
    ]
  },
  {
    sheetProp: 'SMS_SHEET_ID', tab: 'usage_system',
    headers: ['日付', 'api_calls', 'mail_quota_remaining', 'notes']
  }
];

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
      case 'listHistory':          result = handleListHistory_(body);          break;
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

  // entitled = kaihiActive || grandfathered（expiry は SMS では参照しない）
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

  // 会員有効性を都度再チェック（entitled = kaihiActive || grandfathered）
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
      '送信日時': Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
      '会員ID': data.accountId,
      'from': normalizePhoneFrom_(sender),
      'to': normalizedTo, 'メッセージ内容': text,
      'ステータス': '送信成功', 'result_code': smsJson.result_code,
      'result_message': smsJson.result_message, 'message_id': smsJson.message_id,
      'how_many_messages': smsJson.how_many_message_parts,
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
      '送信日時': Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
      '会員ID': String(data.accountId || ''),
      'from': normalizePhoneFrom_(sender),
      'to': normalizedTo || String(data.phoneNumber || ''),
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
        // スプレッドシートが FALSE をブール値で返す場合も考慮
        otp_required: (function() {
          if (col['otp_required'] === undefined) return true;
          var rawOtp = data[r][col['otp_required']];
          return !(String(rawOtp).toUpperCase() === 'FALSE' || rawOtp === false);
        })()
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

// kaihipay_status のホワイトリスト判定（未知の値を誤って有効にしないよう明示一致）
function isKaihiActive_(status) {
  var s = String(status || '').trim().toLowerCase();
  return KAIHI_ACTIVE_VALUES.indexOf(s) !== -1;
}

// 利用権判定（SMS送信侍）: entitled = kaihiActive || grandfathered
// expiry（楽天ライセンス期限）は楽天系ツール専用の概念のため SMS では参照しない
// （GSD方針: SMS専業会員は expiry 空欄。2026-09 に tokyoflower が期限切れ→空欄化でログイン不可になった対策）
// flag（実行中フラグ）・payment_status（GMO廃止残骸）は参照しない
function isEntitled_(member) {
  if (!member) return false;
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

// ログ用: from を先頭0付き国内形式に正規化（形式不問）
// +81335615787 → "0335615787" / 335615787 → "0335615787" / "0335615787" → そのまま
function normalizePhoneFrom_(num) {
  var s = String(num || '').trim().replace(/\s/g, '');
  if (s.indexOf('+81') === 0) s = '0' + s.slice(3);
  if (/^\d{8,10}$/.test(s) && s.charAt(0) !== '0') s = '0' + s;
  return s;
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
// log 書き込み（ヘッダー整列・自己修復・排他ロック付き）
//   logObj は { ヘッダー名: 値 } のオブジェクト。LOG_HEADERS を唯一の真実とし、
//   シートヘッダーが欠損・不一致なら自動修復してから書き込む。
// ────────────────────────────────────────────────────────────────────
function appendSmsLog_(logObj) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('log');
    if (!sheet) sheet = ss.insertSheet('log');

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      // ヘッダー行を正規化して照合
      var norm = function(h) { return String(h).normalize('NFKC').trim(); };
      var needsRepair = true;
      if (sheet.getLastRow() >= 1 && sheet.getLastColumn() >= LOG_HEADERS.length) {
        var existing = sheet.getRange(1, 1, 1, LOG_HEADERS.length).getValues()[0];
        needsRepair = !LOG_HEADERS.every(function(h, i) { return norm(existing[i]) === norm(h); });
      }
      if (needsRepair) {
        sheet.getRange(1, 1, 1, LOG_HEADERS.length)
             .setValues([LOG_HEADERS])
             .setFontWeight('bold').setBackground('#f0f0f0');
      }

      // LOG_HEADERS 順に値を並べる（対応なしは空文字）
      var row = LOG_HEADERS.map(function(h) {
        var v = logObj[h];
        return (v === undefined || v === null) ? '' : v;
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('log write error: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
// listHistory: トークン検証 → 自分の送信履歴を返す（最新50件）
//   会員IDはトークンから取得。クライアント指定は受け付けない。
//   返却列: 送信日時 / to / メッセージ内容 / ステータス のみ。
// ────────────────────────────────────────────────────────────────────
function handleListHistory_(body) {
  var claims = verifyToken_(body.token);
  var id     = claims.id;

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('log');
  if (!sheet || sheet.getLastRow() < 2) return { history: [] };

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0];

  var colMap = {};
  hdr.forEach(function(h, i) {
    colMap[String(h).normalize('NFKC').trim()] = i;
  });

  var idCol  = colMap['会員ID'];
  if (idCol === undefined) return { history: [] };

  var dtCol  = colMap['送信日時'];
  var toCol  = colMap['to'];
  var msgCol = colMap['メッセージ内容'];
  var stCol  = colMap['ステータス'];

  var normalizedId = String(id).normalize('NFKC').trim();
  var rows = [];

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').normalize('NFKC').trim() !== normalizedId) continue;
    var dt   = dtCol  !== undefined ? data[r][dtCol]  : '';
    var dtStr = dt instanceof Date ? dt.toISOString() : String(dt || '');
    rows.push({
      dt:  dtStr,
      to:  toCol  !== undefined ? String(data[r][toCol]  || '') : '',
      msg: msgCol !== undefined ? String(data[r][msgCol] || '') : '',
      st:  stCol  !== undefined ? String(data[r][stCol]  || '') : ''
    });
  }

  rows.sort(function(a, b) { return b.dt > a.dt ? 1 : -1; });
  return { history: rows.slice(0, 50) };
}

// ────────────────────────────────────────────────────────────────────
// ensureSchema_: SCHEMA を走査してシート作成・不足列の追記を行う（冪等）
//   ・シートが無ければ作成しヘッダー設定（新規タブのみ。既存必須タブは作らない）
//   ・シートがあればヘッダー行を読み取り、不足している列だけを末尾に追加
//   ・既存列の内容・順序は一切変更しない
//   ・会員マスタ(api_key)への tenant_id="GSD" / tenant_role="owner" デフォルト投入も実施
// ────────────────────────────────────────────────────────────────────
function ensureSchema_() {
  var report = SCHEMA.map(function(entry) {
    return ensureSheetSchema_(entry);
  });
  report.push(ensureMemberDefaults_());
  return report;
}

// SCHEMA の1エントリ分の作成/追記処理
function ensureSheetSchema_(entry) {
  var ss    = SpreadsheetApp.openById(getProp_(entry.sheetProp));
  var sheet = ss.getSheetByName(entry.tab);
  var norm  = function(h) { return String(h).normalize('NFKC').trim(); };
  var fullHeaders = (entry.headers || []).concat(entry.appendHeaders || []);

  // シートが存在しない場合
  if (!sheet) {
    if (!entry.headers) {
      // 既存必須タブ（api_key 等）が見つからない場合は作成せずスキップ
      Logger.log('[ensureSchema_] WARN: 必須タブが見つかりません: ' + entry.tab);
      return { tab: entry.tab, action: 'skipped_missing_required' };
    }
    sheet = ss.insertSheet(entry.tab);
    sheet.getRange(1, 1, 1, fullHeaders.length)
         .setValues([fullHeaders])
         .setFontWeight('bold').setBackground('#f0f0f0');
    applyPhoneFormat_(sheet, fullHeaders, entry.phoneColumns, 1);
    return { tab: entry.tab, action: 'created', headers: fullHeaders };
  }

  // シートはあるがヘッダー行すら無い（完全に空）場合
  if (sheet.getLastRow() === 0) {
    var headersToWrite = fullHeaders.length ? fullHeaders : (entry.appendHeaders || []);
    if (!headersToWrite.length) return { tab: entry.tab, action: 'noop_empty_no_headers' };
    sheet.getRange(1, 1, 1, headersToWrite.length)
         .setValues([headersToWrite])
         .setFontWeight('bold').setBackground('#f0f0f0');
    applyPhoneFormat_(sheet, headersToWrite, entry.phoneColumns, 1);
    return { tab: entry.tab, action: 'header_initialized', headers: headersToWrite };
  }

  // 既存ヘッダーを読み取り、不足列だけを末尾に追記
  var lastCol   = sheet.getLastColumn();
  var existing  = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(norm);
  var existingSet = {};
  existing.forEach(function(h) { if (h) existingSet[h] = true; });

  var candidateAppend = entry.appendHeaders || entry.headers || [];
  var toAdd = candidateAppend.filter(function(h) { return !existingSet[norm(h)]; });

  if (toAdd.length === 0) {
    return { tab: entry.tab, action: 'noop', headers: existing };
  }

  var startCol = lastCol + 1;
  sheet.getRange(1, startCol, 1, toAdd.length)
       .setValues([toAdd])
       .setFontWeight('bold').setBackground('#f0f0f0');
  applyPhoneFormat_(sheet, toAdd, entry.phoneColumns, startCol);

  return { tab: entry.tab, action: 'appended', added: toAdd };
}

// 電話番号列に文字列書式 '@' を適用（先頭0欠落防止）。既存データの値は変更しない。
function applyPhoneFormat_(sheet, headerSlice, phoneColumns, startCol) {
  if (!phoneColumns || !phoneColumns.length) return;
  headerSlice.forEach(function(h, i) {
    if (phoneColumns.indexOf(h) === -1) return;
    var col = startCol + i;
    var rows = Math.max(sheet.getMaxRows(), 1000);
    sheet.getRange(1, col, rows, 1).setNumberFormat('@');
  });
}

// 会員マスタ(api_key)の既存全行に対し、tenant_id/tenant_role の空欄をデフォルト値で埋める（冪等）
//   既に値がある行は上書きしない。列自体が無ければ何もしない
//   （ensureSheetSchema_ が先に api_key タブへ列追加している前提）。
//   ※ tenant_role は商用化のテナント内ロール(owner|staff)。entitlement判定に使う
//     既存の role 列（grandfathered等、isEntitled_ が参照）とは別物であり、一切触れない。
function ensureMemberDefaults_() {
  var ss    = SpreadsheetApp.openById(getProp_('MASTER_SHEET_ID'));
  var sheet = ss.getSheetByName('api_key');
  if (!sheet) return { tab: 'api_key', action: 'skipped_missing' };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { tab: 'api_key', action: 'no_data_rows' };

  var lastCol = sheet.getLastColumn();
  var norm    = function(h) { return String(h).normalize('NFKC').trim(); };
  var hdr     = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(norm);
  var tenantCol = hdr.indexOf('tenant_id');
  var roleCol   = hdr.indexOf('tenant_role'); // テナント内ロール列。entitlement用の既存 role 列とは別物
  if (tenantCol === -1 || roleCol === -1) {
    return { tab: 'api_key', action: 'columns_missing', tenantCol: tenantCol, roleCol: roleCol };
  }

  var dataRows   = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var tenantVals = [];
  var roleVals   = [];
  var tenantFilled = 0;
  var roleFilled   = 0;

  for (var r = 0; r < dataRows.length; r++) {
    var tenantVal = String(dataRows[r][tenantCol] || '').trim();
    var roleVal   = String(dataRows[r][roleCol]   || '').trim();
    if (tenantVal) {
      tenantVals.push([dataRows[r][tenantCol]]);
    } else {
      tenantVals.push(['GSD']);
      tenantFilled++;
    }
    if (roleVal) {
      roleVals.push([dataRows[r][roleCol]]);
    } else {
      roleVals.push(['owner']);
      roleFilled++;
    }
  }

  sheet.getRange(2, tenantCol + 1, tenantVals.length, 1).setValues(tenantVals);
  sheet.getRange(2, roleCol + 1, roleVals.length, 1).setValues(roleVals);

  return {
    tab: 'api_key', action: 'defaults_applied',
    dataRows: dataRows.length, tenantIdFilled: tenantFilled, roleFilled: roleFilled
  };
}

// ────────────────────────────────────────────────────────────────────
// backupSpreadsheet_: MASTER_SHEET_ID / SMS_SHEET_ID をそれぞれ Drive 上にコピー
//   ファイル名: sms_backup_master_YYYYMMDD / sms_backup_sms_YYYYMMDD
// ────────────────────────────────────────────────────────────────────
function backupSpreadsheet_() {
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');

  var masterId = getProp_('MASTER_SHEET_ID');
  var smsId    = getProp_('SMS_SHEET_ID');

  var masterCopy = DriveApp.getFileById(masterId).makeCopy('sms_backup_master_' + dateStr);
  var smsCopy    = DriveApp.getFileById(smsId).makeCopy('sms_backup_sms_' + dateStr);

  var result = {
    date: dateStr,
    masterBackupId: masterCopy.getId(),
    smsBackupId: smsCopy.getId()
  };
  Logger.log('[backupSpreadsheet_] master backup id: ' + result.masterBackupId);
  Logger.log('[backupSpreadsheet_] sms backup id: '    + result.smsBackupId);
  return result;
}
