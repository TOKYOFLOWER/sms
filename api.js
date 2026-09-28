// api.js — GAS Web App バックエンド（Phase 4: GSD会員認証+メールOTP）
// 認証: GSD会員ID+PW → メールOTP → HMACセッショントークン
// 旧Google認証(OAUTH_CLIENT_ID/ACCOUNT_MAP/ALLOWED_EMAILS)・旧3固定キー(TF_/CV_/ED_)は廃止

var SMS_RULES = { SEGMENT: 70, MAX: 660 };

// フォールバック送信（共通テスト番号での送信元番号pending中の代替送信）関連の定数。
//   FALLBACK_SEND_PREFIX: 実際に送信する本文の先頭に付与する目印。
//   FALLBACK_SEND_LIMIT:  1テナントあたりのフォールバック送信の上限回数
//     （trial無料枠のfree_usedカウンタとは独立。tenants.fallback_send_countで管理）。
var FALLBACK_SEND_PREFIX = '【テスト送信】';
var FALLBACK_SEND_LIMIT  = 30;

// PLAN_LIMITS: プラン制限の単一情報源（STEP3〜STEP7で共有）。
//   staffLimit/templateLimit の standard「実質無制限」は大きな整数値で表現。
//   historyMonths は light=3ヶ月、standard=null（無制限）。
var PLAN_LIMITS = {
  light: {
    dailyLimit:        1000,
    staffLimit:        3,
    templateLimit:     5,
    senderNumberLimit: 1,
    scheduledSend:     false,
    historyMonths:     3,
    freeLimit:         30
  },
  standard: {
    dailyLimit:        3000,
    staffLimit:        99999,  // 実質無制限
    templateLimit:     99999,  // 実質無制限
    senderNumberLimit: 3,
    scheduledSend:     true,
    historyMonths:     null,   // 無制限
    freeLimit:         30
  }
};

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
      'fincode_customer_id', 'fincode_card_id', 'daily_limit', 'created_at', 'updated_at',
      // STEP7: 申込フォーム(action=signup)で追加投入する項目
      '業種', '想定月間送信数', '紹介元', '規約同意', '特定電子メール法同意',
      // 積み残し2件目: 送信元番号pending中のフォールバック送信元キャッシュ
      'fallback_sms_account_key',
      // 積み残し追加分: フォールバック送信回数カウンタ（trial無料枠とは独立）
      'fallback_send_count'
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
      'status', 'result', 'sent_at', 'batch_id', 'retry_count'
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
  },
  {
    // 積み残し3件目: addendum F メール翌日再送用キュー
    sheetProp: 'SMS_SHEET_ID', tab: 'mail_queue',
    headers: ['to', 'subject', 'body', 'created_at', 'status', 'attempts']
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
      case 'bulkSend':              result = handleBulkSend_(body);             break;
      case 'listHistory':          result = handleListHistory_(body);          break;
      case 'ping':                 result = handlePing_(body);                 break;

      // ---- STEP7a: 申込フォームAPI（token不要・公開エンドポイント） ----
      case 'signup':               result = handleSignup_(body);               break;

      // ---- STEP5a: テンプレート・送信元番号・履歴エクスポート・月次レポート（すべてtoken必須） ----
      case 'listTemplates':        result = handleListTemplates_(body);        break;
      case 'createTemplate':       result = handleCreateTemplate_(body);       break;
      case 'updateTemplate':       result = handleUpdateTemplate_(body);       break;
      case 'deleteTemplate':       result = handleDeleteTemplate_(body);       break;
      case 'listSenderNumbers':    result = handleListSenderNumbers_(body);    break;
      case 'exportHistory':        result = handleExportHistory_(body);        break;
      case 'monthlyReport':        result = handleMonthlyReport_(body);        break;
      case 'myTenantStatus':       result = handleMyTenantStatus_(body);       break;

      // ---- STEP2: 管理API（すべて requireAdmin_ で ADMIN_SECRET 必須。bootstrapAdminのみ例外） ----
      case 'bootstrapAdmin':       result = handleBootstrapAdmin_(body);       break;
      case 'setup':                result = handleAdminSetup_(body);           break;
      case 'listTriggers':         result = handleListTriggers_(body);         break;
      case 'listTenants':          result = handleListTenants_(body);          break;
      case 'updateTenant':         result = handleUpdateTenant_(body);         break;
      case 'updateSenderNumber':   result = handleUpdateSenderNumber_(body);   break;
      case 'listSenderNumbersAdmin': result = handleListSenderNumbersAdmin_(body); break;
      case 'issueAccount':         result = handleIssueAccount_(body);         break;

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

  var tenant = resolveTenantForMember_(member);
  var effectiveAccountId = resolveEffectiveSmsAccountIdSafe_(member, tenant);
  if (!effectiveAccountId) {
    throw new Error('送信元番号の準備中です。しばらくお待ちください');
  }
  var isFallback = effectiveAccountId !== id;

  var result = sendSingleSMSFromForm({
    accountId:      id,
    smsAccountId:   effectiveAccountId,
    phoneNumber:    body.to,
    message:        body.text,
    countryCode:    '81',
    isFallbackSend: isFallback
  });
  if (!result.success) throw new Error(result.message);
  if (isFallback) incrementFallbackSendCount_(tenant.tenant_id);
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

  var tenant = resolveTenantForMember_(member);
  var effectiveAccountId = resolveEffectiveSmsAccountIdSafe_(member, tenant);
  if (!effectiveAccountId) {
    throw new Error('送信元番号の準備中です。しばらくお待ちください');
  }
  var isFallback = effectiveAccountId !== id;

  var result = sendSingleSMSFromForm({
    accountId:      id,
    smsAccountId:   effectiveAccountId,
    phoneNumber:    body.to,
    message:        body.text,
    countryCode:    String(body.countryCode || '81'),
    isFallbackSend: isFallback
  });
  if (!result.success) throw new Error(result.message);
  if (isFallback) incrementFallbackSendCount_(tenant.tenant_id);
  return result;
}

// resolveEffectiveAccountId_ を呼び出すラッパー（handleSendSms_/handleSendSmsForm_用）。
//   フォールバック上限到達の専用エラー(fallbackSendLimitError_)はそのまま呼び出し元へ
//   伝える（意図的な業務エラーのため。doPostの既存エラーハンドリング方針に沿ってクリーンに
//   ok:falseへ変換される）。それ以外の想定外エラーは安全側に倒してnull（「準備中」扱い）にし、
//   絶対に例外で落ちないようにする。
function resolveEffectiveSmsAccountIdSafe_(member, tenant) {
  try {
    return resolveEffectiveAccountId_(member, tenant);
  } catch (e) {
    if (String(e.message || '').indexOf('番号登録完了までお待ちください') === 0) {
      throw e;
    }
    Logger.log('[resolveEffectiveSmsAccountIdSafe_] error: ' + e.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// STEP4a: 一斉送信の投入API（バックエンド／キュー処理）
//   bulkSend: token検証 → queueタブへrecipientsを1行ずつ投入する。
//   実際の送信は processQueue_（トリガーから定期実行）が行う。
//   ※ bulkSendは国内一斉送信専用機能として設計しているため、電話番号正規化は
//     常に countryCode='81' 固定とする（GSDの複数国番号運用は既存の単発送信
//     (handleSendSms_/handleSendSmsForm_)のみ引き続きサポートし、この一斉送信
//     経路には影響しない）。国番号ガード(addendum B)自体は sendSingleSMSFromForm
//     に実装し、単発・queue経由の両方の実送信タイミングで一元的に効かせている。
// ────────────────────────────────────────────────────────────────────
function handleBulkSend_(body) {
  var claims = verifyToken_(body.token);
  var id     = claims.id;
  var member = getMember_(id);
  if (!member || !isEntitled_(member)) {
    throw new Error('ご契約が有効でないか、送信権限がありません');
  }

  var recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!recipients.length) throw new Error('recipients が空です');

  var bodyTemplate = String(body.bodyTemplate || '');
  if (!bodyTemplate.trim()) throw new Error('bodyTemplate が空です');

  var memberTenantId = member.tenant_id || 'GSD';

  // tenant管理(tenantsタブ)に未登録の会員は、既存GSD運用への影響回避を最優先し、
  // 無制限のGSD同様の挙動（daily_limit対象外・trial判定なし）にする。
  var tenant = getTenantById_(memberTenantId) || { tenant_id: 'GSD', plan: 'standard', status: 'active' };

  // 送信可否の事前チェック（拒否なら例外→doPostがok:falseで返す）
  checkSendAllowed_(tenant, recipients.length);

  var scheduledAt = new Date();
  if (body.scheduledAt) {
    if (!checkScheduledSendAllowed_(tenant)) {
      throw new Error('このプランでは予約送信はご利用いただけません');
    }
    var parsed = new Date(body.scheduledAt);
    if (isNaN(parsed.getTime())) throw new Error('scheduledAt の形式が不正です');
    scheduledAt = parsed;
  }

  var smsAcc     = getSmsAccount_(id);
  var senderFrom = smsAcc ? normalizePhoneFrom_(smsAcc.cpaas_sender) : '';

  var batchId = Utilities.getUuid();
  var rows    = [];
  var errors  = [];

  // 差し込み記法{{key}}の置換 → 文字数チェック → 電話番号正規化。
  // 判断: 1件のエラー（文字数超過・電話番号不正等）で全体を拒否せず、
  //   そのrecipientだけエラーとして記録し、他の正常なrecipientの投入は継続する
  //   （CSVアップロード運用を想定すると、1行の不備で全件やり直しになるのは
  //   ユーザー体験上望ましくないため）。
  recipients.forEach(function(r, idx) {
    try {
      var text = renderTemplate_(bodyTemplate, r);
      calcSegments_(text); // MAX超過ならここで例外
      var normalizedTo = normalizePhoneNumber_(r && r.to, '81');
      rows.push([
        Utilities.getUuid(), memberTenantId, id, senderFrom, normalizedTo, text,
        scheduledAt, 'pending', '', '', batchId, 0
      ]);
    } catch (e) {
      errors.push({ index: idx, to: (r && r.to) || '', error: e.message });
    }
  });

  if (rows.length) {
    var sheet = getQueueSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  logAudit_(id, 'bulkSend', '-',
            'queued:' + rows.length + ' errors:' + errors.length + ' batch:' + batchId);

  return { batch_id: batchId, queued: rows.length, errors: errors };
}

// {{key}} 差し込み記法の置換（未定義キーは空文字）
function renderTemplate_(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function(_, key) {
    return (vars && vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : '';
  });
}

// queue タブのSheetオブジェクトを取得する（無ければ例外。ensureSchema_で作成済み前提）
function getQueueSheet_() {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('queue');
  if (!sheet) throw new Error('queue タブが存在しません（ensureSchema_を実行してください）');
  return sheet;
}

// tenants タブから該当tenant_idの1行をオブジェクトで返す（無ければnull）
function getTenantById_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data  = sheet.getDataRange().getValues();
  var hdr   = data[0].map(function(h) { return String(h).trim(); });
  var idCol = hdr.indexOf('tenant_id');
  if (idCol === -1) return null;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol]).trim() !== String(tenantId).trim()) continue;
    var obj = {};
    hdr.forEach(function(h, i) { obj[h] = data[r][i]; });
    return obj;
  }
  return null;
}

// usage タブへの計上（tenant_id・当月の行が無ければ新規作成）。
//   isFree=true なら free_used のみ+1。isFree=false なら billable_count と
//   sent_count の両方を +segments（addendum C: 分割数分を課金単位として計上）。
//   ※ processQueue_ がスクリプトロック保持中に呼ぶ前提のため、ここでは
//     二重ロックによるデッドロックを避けるため独自のロックは取得しない。
function incrementUsage_(tenantId, isFree, segments) {
  segments = Number(segments) > 0 ? Number(segments) : 1;
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('usage');
  if (!sheet) return;

  var ym      = currentYearMonth_();
  var lastRow = sheet.getLastRow();
  var hdr     = lastRow >= 1
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); })
    : [];
  var col = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['年月'] === undefined) return;

  var data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() : [];
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    if (String(data[r][col['年月']]).trim() !== ym) continue;

    var sheetRow = r + 2;
    if (isFree) {
      var newFree = (Number(data[r][col['free_used']]) || 0) + 1;
      sheet.getRange(sheetRow, col['free_used'] + 1).setValue(newFree);
    } else {
      var newBillable = (Number(data[r][col['billable_count']]) || 0) + segments;
      var newSent     = (Number(data[r][col['sent_count']])     || 0) + segments;
      sheet.getRange(sheetRow, col['billable_count'] + 1).setValue(newBillable);
      sheet.getRange(sheetRow, col['sent_count'] + 1).setValue(newSent);
    }
    if (col['更新日時'] !== undefined) sheet.getRange(sheetRow, col['更新日時'] + 1).setValue(new Date());
    return;
  }

  // 該当行が無ければ新規作成
  var newRow = hdr.map(function(h) {
    if (h === 'tenant_id')       return tenantId;
    if (h === '年月')            return ym;
    if (h === 'sent_count')      return isFree ? 0 : segments;
    if (h === 'free_used')       return isFree ? 1 : 0;
    if (h === 'billable_count')  return isFree ? 0 : segments;
    if (h === '更新日時')        return new Date();
    return '';
  });
  sheet.appendRow(newRow);
}

// ────────────────────────────────────────────────────────────────────
// calcSegments_: 本文のセグメント数(通数)計算の単一情報源。
//   sendSingleSMSFromForm・STEP4のqueue課金計算・STEP7のフロント文字数
//   カウンタが同じロジックを共有する。
//   0文字→0。SMS_RULES.MAX超過→例外（既存のエラーメッセージを踏襲）。
// ────────────────────────────────────────────────────────────────────
function calcSegments_(text) {
  var len = String(text || '').length;
  if (len === 0) return 0;
  if (len > SMS_RULES.MAX) throw new Error('本文が長すぎます（上限 ' + SMS_RULES.MAX + '文字）');
  return Math.ceil(len / SMS_RULES.SEGMENT);
}

// ────────────────────────────────────────────────────────────────────
// sendSingleSMSFromForm: CPaaS 送信ロジック本体
//   doPost(handleSendSms_ / handleSendSmsForm_)・queue経由(processQueue_)
//   および将来の google.script.run 両方から呼べるよう token を持たない設計。
//   data.tenantId / data.batchId は省略可（logタブへの記録用。processQueue_が
//   queue行のtenant_id/batch_idを渡す。単発送信では未指定なら会員のtenant_id
//   を自動使用する）。
//   data.smsAccountId は省略可（積み残し2件目: 送信元番号pending中の共通テスト
//   番号フォールバック用）。指定があればCPaaS認証情報・送信元番号の解決に
//   data.accountIdの代わりにこちらを使う。ログの「会員ID」・logAudit_・
//   国番号ガードの判定は常にdata.accountId（実際の会員ID）を使い続けるため、
//   送信履歴(listHistory)の紐付けは一切変わらない。
//   data.isFallbackSend が true の場合、実際に送信・ログ記録する本文の先頭に
//   FALLBACK_SEND_PREFIX（【テスト送信】）を付与する。MAX文字数チェック
//   (calcSegments_)は付与後の文言に対して行われる。
// ────────────────────────────────────────────────────────────────────
function sendSingleSMSFromForm(data) {
  var sender       = null;
  var normalizedTo = null;
  var tenantIdForLog = data.tenantId || '';
  var fallbackPrefix = data.isFallbackSend ? FALLBACK_SEND_PREFIX : '';
  try {
    var smsAcc = getSmsAccount_(data.smsAccountId || data.accountId);
    if (!smsAcc) throw new Error('送信元設定がありません。管理者に連絡してください');
    if (String(smsAcc.enabled).toUpperCase() !== 'TRUE')
      throw new Error('送信が一時停止されています。管理者に連絡してください');

    // from: スプレッドシートが数値化しても先頭0を守るため必ず String
    sender = String(smsAcc.cpaas_sender || '').trim();
    if (sender.length > 0 && sender.length <= 9)
      Logger.log('[WARN] sender が9桁以下 — 先頭0が欠落している可能性: "' + sender + '"');

    // 国番号ガード(addendum B): 会員のtenant_idがGSD以外なら国内(81)番号のみ許可。
    // GSD（既存運用）・tenant_id未設定は従来通り制限しない（既存動作への影響回避を最優先）。
    var sendMember     = getMember_(data.accountId);
    var memberTenantId = sendMember ? sendMember.tenant_id : '';
    if (!tenantIdForLog) tenantIdForLog = memberTenantId || '';
    var countryCode = String(data.countryCode || '81');
    if (memberTenantId && memberTenantId !== 'GSD' && countryCode !== '81') {
      throw new Error('対応していない国番号です（国内番号のみご利用いただけます）');
    }

    normalizedTo = normalizePhoneNumber_(data.phoneNumber, countryCode);

    var text = String(data.message || '').trim();
    if (!text) throw new Error('本文が空です');
    if (fallbackPrefix) text = fallbackPrefix + text; // フォールバック送信のみ先頭に付与

    // 認証情報取得（ログ・レスポンスには出さない）
    var apiKey   = decodeBase64Str_(smsAcc.cpaas_api_key);
    var secret   = decodeBase64Str_(smsAcc.cpaas_secret);
    var segments = calcSegments_(text); // MAX超過チェックもここで行われる（プレフィックス込みの文言に対して）

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
      '文字数情報': text.length + ' / 660 (' + segments + ' SMS)',
      'tenant_id': tenantIdForLog, 'batch_id': data.batchId || ''
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
      'メッセージ内容': fallbackPrefix + String(data.message || ''),
      'ステータス': 'エラー', 'result_message': e.message,
      'tenant_id': tenantIdForLog, 'batch_id': data.batchId || ''
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
                           : '',
        tenant_id:       col['tenant_id'] !== undefined                 // 国番号ガード(addendum B)等に使用
                           ? String(data[r][col['tenant_id']] || '')
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
//   シートヘッダーが欠損・不一致なら自動修復してから書き込む（LOG_HEADERSの
//   範囲のみ。末尾に追加された tenant_id/batch_id 列は自己修復の対象外＝触れない）。
//   書き込み自体はシートの実際のヘッダー全体（LOG_HEADERS + 追加列）に合わせて
//   行うため、logObj に tenant_id/batch_id を含めればそれらの列にも反映される。
// ────────────────────────────────────────────────────────────────────
function appendSmsLog_(logObj) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('log');
    if (!sheet) sheet = ss.insertSheet('log');

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      // ヘッダー行を正規化して照合（LOG_HEADERSの範囲のみ）
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

      // 実際のヘッダー全体（LOG_HEADERS + tenant_id/batch_id 等の追加列）に合わせて
      // 値を並べる（対応なしは空文字）。
      var lastCol    = Math.max(sheet.getLastColumn(), LOG_HEADERS.length);
      var fullHeader = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(norm);
      var row = fullHeader.map(function(h) {
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
//   ・logタブの過去行(tenant_id空欄)への "GSD" バックフィルも実施
// ────────────────────────────────────────────────────────────────────
function ensureSchema_() {
  var report = SCHEMA.map(function(entry) {
    return ensureSheetSchema_(entry);
  });
  report.push(ensureMemberDefaults_());
  report.push(backfillLogTenantId_());
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

// logタブの既存行のうちtenant_idが空欄の行にのみ'GSD'を投入する（冪等・ensureMemberDefaults_と同じ思想）。
//   STEP4aでappendSmsLog_がtenant_id/batch_idを実際に書き込むようになる前の過去ログ行は
//   tenant_idが空欄のままで、exportHistory/monthlyReport/countTodaySent_のtenant_id
//   フィルタから漏れてしまう。過去分はすべてGSD運用（tenant_id='GSD'固定）だったことが
//   自明なため、空欄の行にのみバックフィルする。既に値がある行（STEP4a以降の新規行）は
//   上書きしない。batch_idは元々存在しない情報のため空欄のままにする。
function backfillLogTenantId_() {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('log');
  if (!sheet) return { tab: 'log', action: 'skipped_missing' };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { tab: 'log', action: 'no_data_rows' };

  var lastCol = sheet.getLastColumn();
  var norm    = function(h) { return String(h).normalize('NFKC').trim(); };
  var hdr     = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(norm);
  var tenantCol = hdr.indexOf('tenant_id');
  if (tenantCol === -1) return { tab: 'log', action: 'column_missing' };

  var dataRows   = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var tenantVals = [];
  var filled     = 0;

  for (var r = 0; r < dataRows.length; r++) {
    var v = String(dataRows[r][tenantCol] || '').trim();
    if (v) {
      tenantVals.push([dataRows[r][tenantCol]]);
    } else {
      tenantVals.push(['GSD']);
      filled++;
    }
  }
  sheet.getRange(2, tenantCol + 1, tenantVals.length, 1).setValues(tenantVals);

  return { tab: 'log', action: 'backfilled', dataRows: dataRows.length, tenantIdFilled: filled };
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

// ────────────────────────────────────────────────────────────────────
// STEP2: 管理API・セットアップ
//   ・ADMIN_SECRET は Script Properties に保存する共有シークレット。
//     bootstrapAdmin で一度だけ生成し、以後の管理系actionは全て
//     requireAdmin_(body) で body.admin_secret と照合する。
//   ・GAS の doPost は常に HTTP 200 を返す制約があるため、「403相当」は
//     レスポンスJSON内 { ok:false, error:'forbidden' } として表現する
//     （このファイルの既存のエラーハンドリング方針を踏襲）。
// ────────────────────────────────────────────────────────────────────

// Script Properties を未設定でも例外を投げずに取得する（getProp_ は未設定だと例外を投げるため別関数にする）
function getPropOptional_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

// bootstrapAdmin: ADMIN_SECRET が未設定の場合のみ生成・保存する（二重初期化防止）
//   値は絶対にレスポンス・ログへ出力しない。保存できた事実のみ返す。
function handleBootstrapAdmin_(body) {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('ADMIN_SECRET')) {
    throw new Error('forbidden: ADMIN_SECRET は既に初期化済みです');
  }
  var secret = Utilities.getUuid() + Utilities.getUuid(); // 256bit相当
  sp.setProperty('ADMIN_SECRET', secret);
  return { ok: true, initialized: true };
}

// 管理系action共通ガード: body.admin_secret を ADMIN_SECRET と固定時間比較
function requireAdmin_(body) {
  var adminSecret = getPropOptional_('ADMIN_SECRET');
  if (!adminSecret) throw new Error('forbidden: ADMIN_SECRET未設定です。bootstrapAdminを先に実行してください');
  var given = String((body && body.admin_secret) || '');
  if (!given || !safeEqual_(adminSecret, given)) throw new Error('forbidden');
}

// setup: backupSpreadsheet_ → ensureSchema_ → トリガー作成（すべて冪等）
function handleAdminSetup_(body) {
  requireAdmin_(body);
  var backup   = backupSpreadsheet_();
  var schema   = ensureSchema_();
  var triggers = ensureTriggers_();
  return { backup: backup, schema: schema, triggers: triggers };
}

// listTriggers: 現在のプロジェクトトリガー一覧（確認用）
function handleListTriggers_(body) {
  requireAdmin_(body);
  return ScriptApp.getProjectTriggers().map(function(t) {
    return {
      handlerFunction: t.getHandlerFunction(),
      eventType:       String(t.getEventType()),
      triggerSource:   String(t.getTriggerSource())
    };
  });
}

// インストール型トリガーを冪等に作成する（同名関数のトリガーが既にあればスキップ）
//   ※ トリガーはプロジェクトのHEAD（最新push）に対して発火するため、
//     本番運用開始前にこれを実行してはならない（呼び出し元のsetupはADMIN_SECRET必須）。
function ensureTriggers_() {
  var existing    = ScriptApp.getProjectTriggers();
  var existingFns = {};
  existing.forEach(function(t) { existingFns[t.getHandlerFunction()] = true; });

  var created = [];
  var skipped = [];

  if (existingFns['processQueue_']) {
    skipped.push('processQueue_');
  } else {
    ScriptApp.newTrigger('processQueue_').timeBased().everyMinutes(5).create();
    created.push('processQueue_ (5分毎)');
  }

  if (existingFns['closeMonth_']) {
    skipped.push('closeMonth_');
  } else {
    ScriptApp.newTrigger('closeMonth_').timeBased()
      .onMonthDay(1).atHour(2).nearMinute(0).inTimezone('Asia/Tokyo').create();
    created.push('closeMonth_ (毎月1日 02:00 JST)');
  }

  if (existingFns['dailyResetCheck_']) {
    skipped.push('dailyResetCheck_');
  } else {
    ScriptApp.newTrigger('dailyResetCheck_').timeBased()
      .everyDays(1).atHour(0).nearMinute(5).inTimezone('Asia/Tokyo').create();
    created.push('dailyResetCheck_ (毎日 00:05 JST)');
  }

  // addendum G: ログアーカイブ（月次、closeMonth_と同じタイミング）
  if (existingFns['archiveLog_']) {
    skipped.push('archiveLog_');
  } else {
    ScriptApp.newTrigger('archiveLog_').timeBased()
      .onMonthDay(1).atHour(2).nearMinute(0).inTimezone('Asia/Tokyo').create();
    created.push('archiveLog_ (毎月1日 02:00 JST)');
  }

  // 積み残し3件目: addendum Fのメール翌日再送（毎日00:10 JST）
  if (existingFns['flushMailQueue_']) {
    skipped.push('flushMailQueue_');
  } else {
    ScriptApp.newTrigger('flushMailQueue_').timeBased()
      .everyDays(1).atHour(0).nearMinute(10).inTimezone('Asia/Tokyo').create();
    created.push('flushMailQueue_ (毎日 00:10 JST)');
  }

  return { created: created, skipped: skipped };
}

// ────────────────────────────────────────────────────────────────────
// processQueue_: queueタブから送信待ちレコードを取り出しSMS送信する本体（STEP4a）。
//   5分毎のインストール型トリガーから呼ばれる想定。
//   ・LockServiceで多重実行を防止（取得できなければ何もせず終了）。
//   ・経過時間が4分を超えたら打ち切り、残りは次回のトリガー実行に委ねる。
//   ・status='pending' かつ scheduled_at<=now の行を最大200件、行番号昇順で処理。
// ────────────────────────────────────────────────────────────────────
function processQueue_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('[processQueue_] ロック取得できず終了（多重実行防止）');
    return { skipped: true, reason: 'lock_not_acquired' };
  }

  var startTime      = Date.now();
  var MAX_RUNTIME_MS = 4 * 60 * 1000; // 4分
  var MAX_ROWS        = 200;
  var stats = { processed: 0, sent: 0, failed: 0, retried: 0, truncated: false, elapsedMs: 0, apiCalls: 0 };

  try {
    var sheet   = getQueueSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return stats;

    var lastCol = sheet.getLastColumn();
    var hdr     = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); });
    var col     = {};
    hdr.forEach(function(h, i) { col[h] = i; });
    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var now = new Date();
    var targetRows = []; // dataの0-basedインデックス（行番号は+2）
    for (var i = 0; i < data.length; i++) {
      if (targetRows.length >= MAX_ROWS) { stats.truncated = true; break; }
      var status = String(data[i][col['status']] || '').trim();
      if (status !== 'pending') continue;
      var schedRaw = data[i][col['scheduled_at']];
      var sched    = schedRaw ? new Date(schedRaw) : new Date(0);
      if (sched > now) continue; // 予約時刻未到来 → 対象外
      targetRows.push(i);
    }

    var tenantCache = {};

    for (var t = 0; t < targetRows.length; t++) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        Logger.log('[processQueue_] 経過時間超過のため打ち切り。残りは次回のトリガー実行に委ねる。');
        stats.truncated = true;
        break;
      }

      var rowIdx    = targetRows[t];
      var sheetRow  = rowIdx + 2;
      var rowData   = data[rowIdx];

      var tenantId   = String(rowData[col['tenant_id']] || '');
      var memberId   = String(rowData[col['会員ID']] || '');
      var to         = String(rowData[col['to']] || '');
      var msgBody    = String(rowData[col['body']] || '');
      var batchId    = String(rowData[col['batch_id']] || '');
      var retryCount = Number(rowData[col['retry_count']]) || 0;

      stats.processed++;

      // tenant情報はqueue行のtenant_id（enqueue時点のスナップショット）から解決。
      // tenants未登録（GSD等）は無制限扱いにフォールバック（STEP3/bulkSendと同じ方針）。
      var tenant = tenantCache[tenantId];
      if (tenant === undefined) {
        tenant = getTenantById_(tenantId) || { tenant_id: 'GSD', plan: 'standard', status: 'active' };
        tenantCache[tenantId] = tenant;
      }

      var isFree;
      try {
        isFree = checkSendAllowed_(tenant, 1).isFree;
      } catch (e) {
        // 上限到達・status不正等はリトライしても解決しないためfailed確定
        sheet.getRange(sheetRow, col['status'] + 1).setValue('failed');
        sheet.getRange(sheetRow, col['result'] + 1).setValue(e.message);
        stats.failed++;
        continue;
      }

      // 積み残し2件目: 送信元番号pending中は共通テスト番号へフォールバック。
      // 未設定でnullが返る場合、またはフォールバック送信の上限到達の場合は
      // failed確定（いずれもリトライしても解決しないため）。
      var effectiveAccountId;
      var effectiveAccountError = null;
      try {
        effectiveAccountId = resolveEffectiveAccountId_({ id: memberId }, tenant);
      } catch (e) {
        effectiveAccountId = null;
        effectiveAccountError = e.message;
      }
      if (!effectiveAccountId) {
        sheet.getRange(sheetRow, col['status'] + 1).setValue('failed');
        sheet.getRange(sheetRow, col['result'] + 1).setValue(effectiveAccountError || '送信元番号の準備中です。しばらくお待ちください');
        stats.failed++;
        continue;
      }
      var isFallback = effectiveAccountId !== memberId;

      var sendResult = sendSingleSMSFromForm({
        accountId:      memberId,
        smsAccountId:   effectiveAccountId,
        phoneNumber:    to,
        message:        msgBody,
        countryCode:    '81', // tenant_id='GSD'以外は81固定。GSD経由のqueue利用は現状想定なし
        tenantId:       tenantId,
        batchId:        batchId,
        isFallbackSend: isFallback
      });
      stats.apiCalls++; // addendum F: usage_system記録用（実際の送信試行回数）

      if (sendResult.success) {
        sheet.getRange(sheetRow, col['status'] + 1).setValue('sent');
        sheet.getRange(sheetRow, col['result'] + 1).setValue(sendResult.result_message || '送信成功');
        sheet.getRange(sheetRow, col['sent_at'] + 1).setValue(new Date());
        stats.sent++;
        if (isFallback) incrementFallbackSendCount_(tenantId);

        var segments = 1;
        try { segments = calcSegments_(msgBody) || 1; } catch (_) { segments = 1; }
        incrementUsage_(tenantId, isFree, segments);

      } else {
        retryCount++;
        sheet.getRange(sheetRow, col['retry_count'] + 1).setValue(retryCount);
        sheet.getRange(sheetRow, col['result'] + 1).setValue(sendResult.message);
        if (retryCount >= 3) {
          sheet.getRange(sheetRow, col['status'] + 1).setValue('failed');
          stats.failed++;
        } else {
          // statusは'pending'のまま据え置き（次回のprocessQueue_実行で再試行）
          stats.retried++;
        }
      }
    }
  } catch (err) {
    Logger.log('[processQueue_] error: ' + err.message);
    stats.error = err.message;
  } finally {
    lock.releaseLock();
    // addendum F: 実行末尾でusage_systemタブに当日のapi_calls/mail_quota_remainingを記録
    try {
      var dateKey = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
      recordUsageSystem_(dateKey, stats.apiCalls, MailApp.getRemainingDailyQuota());
    } catch (e2) {
      Logger.log('[processQueue_] recordUsageSystem_ error: ' + e2.message);
    }
  }

  stats.elapsedMs = Date.now() - startTime;
  Logger.log('[processQueue_] ' + JSON.stringify(stats));
  return stats;
}

// usage_systemタブへの日次記録（addendum F）。dateKey（例:'yyyy/MM/dd'）をキーに
//   該当行を作成/更新する。api_calls はその日の累計に apiCallsDelta を加算し、
//   mail_quota_remaining は呼び出し時点のMailApp残クォータで上書きする。
function recordUsageSystem_(dateKey, apiCallsDelta, mailQuotaRemaining) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('usage_system');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var hdr = lastRow >= 1
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); })
    : [];
  var col = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['日付'] === undefined) return;

  var data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() : [];
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][col['日付']]).trim() !== String(dateKey).trim()) continue;
    var sheetRow = r + 2;
    if (col['api_calls'] !== undefined) {
      var newApiCalls = (Number(data[r][col['api_calls']]) || 0) + (Number(apiCallsDelta) || 0);
      sheet.getRange(sheetRow, col['api_calls'] + 1).setValue(newApiCalls);
    }
    if (col['mail_quota_remaining'] !== undefined) {
      sheet.getRange(sheetRow, col['mail_quota_remaining'] + 1).setValue(mailQuotaRemaining);
    }
    return;
  }

  // 該当日の行が無ければ新規作成
  var newRow = hdr.map(function(h) {
    if (h === '日付')                 return dateKey;
    if (h === 'api_calls')            return Number(apiCallsDelta) || 0;
    if (h === 'mail_quota_remaining') return mailQuotaRemaining;
    return '';
  });
  sheet.appendRow(newRow);
}

// TODO: STEP6で実装予定（月次締め: usage集計→invoices確定・請求処理）
// 現時点ではno-op stub（トリガー動作確認用）。
function closeMonth_() {
  Logger.log('[closeMonth_] STEP6未実装のため no-op');
}

// TODO: STEP3で実装予定（trial_end超過等のテナントstatus日次遷移チェック）
// 現時点ではno-op stub（トリガー動作確認用）。
function dailyResetCheck_() {
  Logger.log('[dailyResetCheck_] STEP3未実装のため no-op');
}

// addendum G: ログアーカイブ（月次トリガーから呼ばれる想定）。
//   TODO(将来の本実装): logタブの行数が閾値を超えたら、年月別の新規タブ
//     （例: 'log_202609'）を作成し、古い行をそちらへ移動する。
//     - アーカイブ対象の判定は「送信日時」列を基準に月単位で区切る。
//     - 移動後は元のlogタブから該当行を削除し、tenant_id/batch_id等の
//       追加列も含めてヘッダーごとコピーする（appendSmsLog_と同じ列構成）。
//     - 大量行のバッチ削除はGASの実行時間制限に注意し、
//       processQueue_同様に複数回のトリガー実行に分割する設計にすること。
//   現時点では上記の本実装は行わず、閾値判定とログ警告のみの安全なno-opとする。
function archiveLog_() {
  var ARCHIVE_THRESHOLD_ROWS = 500000;
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('log');
  if (!sheet) {
    Logger.log('[archiveLog_] logタブが見つかりません。no-op。');
    return { action: 'noop', reason: 'log_sheet_missing' };
  }

  var rowCount = Math.max(sheet.getLastRow() - 1, 0); // ヘッダー除く
  if (rowCount < ARCHIVE_THRESHOLD_ROWS) {
    Logger.log('[archiveLog_] 行数(' + rowCount + ')が閾値(' + ARCHIVE_THRESHOLD_ROWS + ')未満のため no-op。');
    return { action: 'noop', rowCount: rowCount, threshold: ARCHIVE_THRESHOLD_ROWS };
  }

  // 閾値超過: 本実装(年月別タブへの移動)は未実装のため警告のみ出す。
  Logger.log('[archiveLog_] WARN: logタブの行数(' + rowCount + ')が閾値(' + ARCHIVE_THRESHOLD_ROWS
    + ')を超えています。アーカイブ本実装が必要です（現状は警告のみでアーカイブは実行されません）。');
  return { action: 'warn_threshold_exceeded', rowCount: rowCount, threshold: ARCHIVE_THRESHOLD_ROWS };
}

// ────────────────────────────────────────────────────────────────────
// flushMailQueue_: 積み残し3件目(addendum Fのメール翌日再送)。
//   mail_queueのstatus='pending'行を古い順に処理し、MailApp.sendEmailで
//   再送を試みる（毎日00:10 JSTのトリガーから呼ばれる想定）。
//   成功→status='sent'。失敗→attempts+1し、3回未満はpendingのまま
//   次回に持ち越し、3回以上でstatus='failed'を確定し管理者へ通知する。
// ────────────────────────────────────────────────────────────────────
function flushMailQueue_() {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('mail_queue');
  if (!sheet) {
    Logger.log('[flushMailQueue_] mail_queueタブが見つかりません。no-op。');
    return { action: 'noop', reason: 'sheet_missing' };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { action: 'noop', reason: 'no_data_rows' };

  var lastCol = sheet.getLastColumn();
  var hdr = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); });
  var col = {};
  hdr.forEach(function(h, i) { col[h] = i; });

  var data  = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var stats = { processed: 0, sent: 0, failed: 0, retried: 0 };

  for (var r = 0; r < data.length; r++) {
    var status = String(data[r][col['status']] || '').trim();
    if (status !== 'pending') continue;

    var sheetRow = r + 2;
    var to       = String(data[r][col['to']] || '');
    var subject  = String(data[r][col['subject']] || '');
    var body     = String(data[r][col['body']] || '');
    var attempts = Number(data[r][col['attempts']]) || 0;

    stats.processed++;
    try {
      MailApp.sendEmail({ to: to, subject: subject, body: body });
      sheet.getRange(sheetRow, col['status'] + 1).setValue('sent');
      stats.sent++;
    } catch (e) {
      attempts++;
      sheet.getRange(sheetRow, col['attempts'] + 1).setValue(attempts);
      if (attempts >= 3) {
        sheet.getRange(sheetRow, col['status'] + 1).setValue('failed');
        stats.failed++;
        notifyMailRetryFailed_(to, subject, attempts, e.message);
      } else {
        stats.retried++; // statusは'pending'のまま据え置き（次回のflushMailQueue_実行で再試行）
      }
    }
  }

  Logger.log('[flushMailQueue_] ' + JSON.stringify(stats));
  return stats;
}

// 管理者への「メール再送に失敗しました」通知。checkMailQuota_のガード対象外＝最優先で送る。
//   通知自体が失敗しても例外を外に漏らさない（flushMailQueue_を止めないため）。
function notifyMailRetryFailed_(to, subject, attempts, lastError) {
  var adminEmail = getPropOptional_('ADMIN_NOTIFY_EMAIL') || 'tokyoflowerco.ltd@gmail.com';
  try {
    MailApp.sendEmail({
      to:      adminEmail,
      subject: '【SMS送信侍】メール再送に失敗しました',
      body: [
        '以下のメールの再送に' + attempts + '回失敗したため、送信を断念しました（キューからはfailed扱いで確定）。',
        '',
        '宛先: ' + to,
        '件名: ' + subject,
        '最後のエラー: ' + (lastError || '(不明)'),
        '',
        '手動での対応をご検討ください。'
      ].join('\n')
    });
  } catch (e) {
    Logger.log('[notifyMailRetryFailed_] 通知メール送信にも失敗しました: ' + e.message);
  }
}

// listTenants: tenants タブの全行をオブジェクト配列で返す
function handleListTenants_(body) {
  requireAdmin_(body);
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet || sheet.getLastRow() < 2) return { tenants: [] };

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var tenants = [];
  for (var r = 1; r < data.length; r++) {
    var obj = {};
    hdr.forEach(function(h, i) { obj[h] = data[r][i]; });
    tenants.push(obj);
  }
  return { tenants: tenants };
}

// updateTenant: tenants タブの該当行の plan/status（指定があれば）と updated_at を更新
function handleUpdateTenant_(body) {
  requireAdmin_(body);
  var tenantId = String(body.tenant_id || '').trim();
  if (!tenantId) throw new Error('tenant_id は必須です');

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet) throw new Error('tenants タブが存在しません');

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined) throw new Error('tenants タブに tenant_id 列がありません');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== tenantId) continue;

    if (body.plan !== undefined && col['plan'] !== undefined) {
      sheet.getRange(r + 1, col['plan'] + 1).setValue(body.plan);
    }
    if (body.status !== undefined && col['status'] !== undefined) {
      sheet.getRange(r + 1, col['status'] + 1).setValue(body.status);
    }
    if (col['updated_at'] !== undefined) {
      sheet.getRange(r + 1, col['updated_at'] + 1).setValue(new Date());
    }
    return { tenant_id: tenantId, updated: true };
  }
  throw new Error('tenant_id が見つかりません: ' + tenantId);
}

// updateSenderNumber: sender_numbers タブの該当行(tenant_id + 電話番号 で特定)を更新
//   ※ 電話番号列は setNumberFormat('@') 済みでもシート書き込み経路によっては数値化され
//     先頭0が失われることがある（sendSingleSMSFromForm の from 列と同じ既知の事象）。
//     そのため比較は normalizePhoneFrom_ で先頭0付き国内形式に揃えてから行う。
function handleUpdateSenderNumber_(body) {
  requireAdmin_(body);
  var tenantId = String(body.tenant_id || '').trim();
  var phone    = normalizePhoneFrom_(body['電話番号'] || body.phone || '');
  if (!tenantId || !phone) throw new Error('tenant_id と 電話番号 は必須です');

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('sender_numbers');
  if (!sheet) throw new Error('sender_numbers タブが存在しません');

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['電話番号'] === undefined) {
    throw new Error('sender_numbers タブに tenant_id / 電話番号 列がありません');
  }

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== tenantId) continue;
    if (normalizePhoneFrom_(data[r][col['電話番号']]) !== phone) continue;

    if (body.status !== undefined && col['status'] !== undefined) {
      sheet.getRange(r + 1, col['status'] + 1).setValue(body.status);
    }
    if (body.sms_account_key !== undefined && col['sms_account_key'] !== undefined) {
      sheet.getRange(r + 1, col['sms_account_key'] + 1).setValue(body.sms_account_key);
    }
    return { tenant_id: tenantId, phone: phone, updated: true };
  }
  throw new Error('該当する sender_number が見つかりません（tenant_id/電話番号を確認してください）');
}

// listSenderNumbersAdmin: 指定tenant_idのsender_numbers全行を返す（STEP7b管理画面用。
//   会員向けlistSenderNumbers_はtokenから自分のtenant_idを解決するが、管理画面は
//   任意のテナントを見る必要があるためtenant_idをbodyで明示的に受け取る）。
function handleListSenderNumbersAdmin_(body) {
  requireAdmin_(body);
  var tenantId = String(body.tenant_id || '').trim();
  if (!tenantId) throw new Error('tenant_id は必須です');

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('sender_numbers');
  if (!sheet || sheet.getLastRow() < 2) return { senderNumbers: [] };

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined) return { senderNumbers: [] };

  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== tenantId) continue;
    var obj = {};
    hdr.forEach(function(h, i) { obj[h] = data[r][i]; });
    out.push(obj);
  }
  return { senderNumbers: out };
}

// issueAccount: 会員マスタ(api_key, MASTER_SHEET_ID)に新規会員行を作成し、
//   初期パスワードを発行して担当者メールへ送信する。
//   既存の pw 格納形式（'BASE64:' プレフィックス付きBase64、decodeBase64Str_ が復号）に合わせる。
function handleIssueAccount_(body) {
  requireAdmin_(body);
  var tenantId = String(body.tenant_id || '').trim();
  var id       = String(body.id || '').trim();
  var email    = String(body.email || '').trim();
  if (!tenantId || !id || !email) throw new Error('tenant_id / id / email は必須です');
  if (getMember_(id)) throw new Error('id が既に存在します: ' + id);

  var ss    = SpreadsheetApp.openById(getProp_('MASTER_SHEET_ID'));
  var sheet = ss.getSheetByName('api_key');
  if (!sheet) throw new Error('api_key タブが存在しません');

  var lastCol = sheet.getLastColumn();
  var hdr     = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                  .map(function(h) { return String(h).normalize('NFKC').trim(); });

  var plainPw   = generateInitialPassword_();
  var encodedPw = 'BASE64:' + Utilities.base64Encode(plainPw);

  // 会員マスタは複数サービス共有シートのため、STEP2が把握している列名にのみ値を入れ、
  // それ以外の既存列（他サービス用）は空欄のまま追加する。
  var values = {
    id:               id,
    pw:               encodedPw,
    email:            email,
    kaihipay_status:  String(body.kaihipay_status || 'active'),
    tenant_id:        tenantId,
    tenant_role:      'owner',
    contact_name:     String(body.contact_name || '')
  };

  var row = hdr.map(function(h) {
    return values.hasOwnProperty(h) ? values[h] : '';
  });
  sheet.appendRow(row);

  sendInitialPasswordEmail_(email, id, plainPw);
  logAudit_('admin', 'issueAccount', id, 'ok: tenant=' + tenantId);

  return { id: id, tenant_id: tenantId, email: email };
}

// 初期パスワード生成（UUIDから記号を除いた英数字12文字）
function generateInitialPassword_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

// addendum F: メール送信前のクォータガード。残り10通未満なら true（=送信を見送るべき）。
//   OTP送信(sendOtpEmail_)はログイン導線の生命線のため対象外とし、それ以外
//   （初期パスワード発行・申込受付・管理者通知）のメールにのみ適用する。
//   true の場合は呼び出し元が実送信をスキップしLogger.logに記録する
//   （キュー化・翌日再送の仕組みは今回のスコープ外。まずは記録のみで十分と判断）。
function checkMailQuota_() {
  return MailApp.getRemainingDailyQuota() < 10;
}

// addendum F(積み残し3件目): checkMailQuota_でスキップされたメールをmail_queueに積む。
//   flushMailQueue_（毎日00:10 JSTトリガー）が翌日以降に再送を試みる。
function enqueueMailForRetry_(to, subject, body) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('mail_queue');
  if (!sheet) {
    Logger.log('[enqueueMailForRetry_] mail_queueタブが見つからないためキューイングできません。 to=' + to);
    return;
  }
  appendRowByHeaderNames_(sheet, {
    to: to, subject: subject, body: body,
    created_at: new Date(), status: 'pending', attempts: 0
  });
}

function sendInitialPasswordEmail_(email, id, plainPw) {
  var subject = '【SMS送信侍】アカウント発行のお知らせ';
  var body    = [
    'アカウントを発行しました。',
    '',
    'ログインID: ' + id,
    '初期パスワード: ' + plainPw,
    '',
    '初回ログイン後、お早めにパスワードの変更をご検討ください。',
    '心当たりのない場合はこのメールを無視してください。'
  ].join('\n');

  if (checkMailQuota_()) {
    Logger.log('[sendInitialPasswordEmail_] メール送信不可(クォータ残少)のためmail_queueに積みました。'
      + '翌日以降に自動再送されます。 email=' + email + ' id=' + id);
    enqueueMailForRetry_(email, subject, body);
    return;
  }
  // 平文パスワードはメール本文のみ。ログ・レスポンスには一切出さない。
  MailApp.sendEmail({ to: email, subject: subject, body: body });
}

// ────────────────────────────────────────────────────────────────────
// STEP3: プラン制御・上限・無料枠
//   tenant 引数は tenants タブの1行分オブジェクト（{tenant_id, plan, status,
//   trial_end, daily_limit, ...}）。呼び出し元（STEP4以降のqueue処理・
//   管理画面）は本関数群を通してのみ送信可否・上限判定を行うこと
//   （判定ロジックの単一情報源化）。
// ────────────────────────────────────────────────────────────────────

function currentYearMonth_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMM');
}

// tenant.plan から PLAN_LIMITS を解決する（未知/空のplanは安全側でlightにフォールバック）
function getPlanLimits_(tenant) {
  var plan = tenant && tenant.plan ? String(tenant.plan).trim().toLowerCase() : '';
  return PLAN_LIMITS[plan] || PLAN_LIMITS.light;
}

// 当日(JST)の送信済み件数を tenant_id で絞り込んで log タブから数える
function countTodaySent_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('log');
  if (!sheet || sheet.getLastRow() < 2) return 0;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  var tenantCol = col['tenant_id'];
  var dtCol     = col['送信日時'];
  if (tenantCol === undefined || dtCol === undefined) return 0;

  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][tenantCol]).trim() !== String(tenantId).trim()) continue;
    var dtRaw = data[r][dtCol];
    var dtStr = dtRaw instanceof Date
      ? Utilities.formatDate(dtRaw, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
      : String(dtRaw || '');
    if (dtStr.indexOf(todayStr) === 0) count++;
  }
  return count;
}

// usage タブから指定テナント・年月の行を取得する（無ければ null）
function getUsageRow_(tenantId, yearMonth) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('usage');
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['年月'] === undefined) return null;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    if (String(data[r][col['年月']]).trim() !== String(yearMonth).trim()) continue;
    return {
      free_used:      col['free_used']      !== undefined ? (Number(data[r][col['free_used']])      || 0) : 0,
      sent_count:     col['sent_count']     !== undefined ? (Number(data[r][col['sent_count']])     || 0) : 0,
      billable_count: col['billable_count'] !== undefined ? (Number(data[r][col['billable_count']]) || 0) : 0
    };
  }
  return null;
}

// tenants タブの該当行の status（＋updated_at）を直接更新する内部専用関数。
//   ADMIN_SECRET不要（管理API updateTenant とは別経路。trial自動遷移など内部ロジック用）。
function setTenantStatus_(tenantId, status) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet) return false;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['status'] === undefined) return false;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    sheet.getRange(r + 1, col['status'] + 1).setValue(status);
    if (col['updated_at'] !== undefined) {
      sheet.getRange(r + 1, col['updated_at'] + 1).setValue(new Date());
    }
    return true;
  }
  return false;
}

// trial → active 自動遷移（冪等）。無料枠(free_used>=freeLimit)またはtrial_end超過で遷移する。
//   引数のtenantが status='trial' でなければ何もしない。
//   遷移した場合は tenants タブを更新し、渡された tenant オブジェクトの status も
//   'active' に書き換える（呼び出し元がそのまま最新状態を参照できるように）。
function transitionTrialIfNeeded_(tenant) {
  if (!tenant || String(tenant.status || '').trim().toLowerCase() !== 'trial') return false;

  var limits       = getPlanLimits_(tenant);
  var usage        = getUsageRow_(tenant.tenant_id, currentYearMonth_()) || { free_used: 0 };
  var trialEndOver = !!tenant.trial_end && new Date() > new Date(tenant.trial_end);
  var freeUsedOver = usage.free_used >= limits.freeLimit;

  if (!trialEndOver && !freeUsedOver) return false;

  var updated = setTenantStatus_(tenant.tenant_id, 'active');
  if (updated) tenant.status = 'active';
  return updated;
}

// checkSendAllowed_: 送信可否判定（STEP4のqueue処理から呼ばれる想定）
//   tenant: tenants タブの1行分オブジェクト、count: 今回送信しようとしている件数
//   許可できない場合は理由付きで例外をthrowする（doPostの既存エラーハンドリング方針に合わせる）。
//   戻り値の isFree は今回の送信が無料枠扱いかどうか（STEP4のusage計上で使用）。
function checkSendAllowed_(tenant, count) {
  count = Number(count) > 0 ? Number(count) : 1;
  if (!tenant || !tenant.tenant_id) throw new Error('tenant_not_found');

  var origStatus = String(tenant.status || '').trim().toLowerCase();
  if (origStatus !== 'trial' && origStatus !== 'active') {
    throw new Error('tenant_not_active');
  }

  // trial自動遷移（無料枠超過 or trial_end超過なら active へ）。以後 tenant.status は最新化される。
  if (origStatus === 'trial') transitionTrialIfNeeded_(tenant);

  // 日次上限チェック（tenant_id='GSD'は既存運用保護のため対象外＝無制限のまま）
  var limits = getPlanLimits_(tenant);
  if (String(tenant.tenant_id).trim() !== 'GSD') {
    var dailyLimit = Number(tenant.daily_limit) > 0 ? Number(tenant.daily_limit) : limits.dailyLimit;
    var todaySent  = countTodaySent_(tenant.tenant_id);
    if (todaySent + count > dailyLimit) {
      throw new Error('daily_limit_exceeded');
    }
  }

  // 無料枠判定: transitionTrialIfNeeded_後もまだtrialのまま＝無料枠内・trial_end内
  var isFree = String(tenant.status || '').trim().toLowerCase() === 'trial';

  return { allowed: true, isFree: isFree, tenant_id: tenant.tenant_id };
}

// checkStaffLimit_ / checkTemplateLimit_ / checkSenderNumberLimit_:
//   現在件数がプラン上限未満かどうかを判定する（呼び出し元の実装はSTEP5以降）
function checkStaffLimit_(tenant, currentStaffCount) {
  var limits = getPlanLimits_(tenant);
  return {
    allowed: Number(currentStaffCount) < limits.staffLimit,
    limit:   limits.staffLimit,
    current: Number(currentStaffCount) || 0
  };
}

function checkTemplateLimit_(tenant, currentTemplateCount) {
  var limits = getPlanLimits_(tenant);
  return {
    allowed: Number(currentTemplateCount) < limits.templateLimit,
    limit:   limits.templateLimit,
    current: Number(currentTemplateCount) || 0
  };
}

function checkSenderNumberLimit_(tenant, currentSenderNumberCount) {
  var limits = getPlanLimits_(tenant);
  return {
    allowed: Number(currentSenderNumberCount) < limits.senderNumberLimit,
    limit:   limits.senderNumberLimit,
    current: Number(currentSenderNumberCount) || 0
  };
}

// checkScheduledSendAllowed_: standardプランのみ予約送信を許可
function checkScheduledSendAllowed_(tenant) {
  return getPlanLimits_(tenant).scheduledSend === true;
}

// getHistoryMonthsLimit_: 履歴閲覧可能な月数（light=3, standard=null=無制限）
function getHistoryMonthsLimit_(tenant) {
  return getPlanLimits_(tenant).historyMonths;
}

// ────────────────────────────────────────────────────────────────────
// testPlanGuards_: checkSendAllowed_ / transitionTrialIfNeeded_ の自己完結テスト。
//   実データの tenants/usage は汚さない。検証用に一時テナント行(TEST-PLANGUARD-*)を
//   自ら作成し、テスト終了時に必ず削除する。GASエディタから手動実行しても、
//   一時デバッグaction経由で実行しても、戻り値とLoggerに結果が出る。
// ────────────────────────────────────────────────────────────────────
function testPlanGuards_() {
  var results = [];
  function check(name, expected, actual) {
    var pass = JSON.stringify(expected) === JSON.stringify(actual);
    results.push({ case: name, expected: expected, actual: actual, pass: pass });
    Logger.log((pass ? '[PASS] ' : '[FAIL] ') + name +
               ' expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  }

  // ---- ケース1: status='suspended' → 拒否 ----
  try {
    checkSendAllowed_({ tenant_id: 'TEST-PLANGUARD-DUMMY', plan: 'light', status: 'suspended' }, 1);
    check('1_suspended_rejected', 'tenant_not_active', 'no_throw');
  } catch (e) {
    check('1_suspended_rejected', 'tenant_not_active', e.message);
  }

  // ---- ケース2: 日次上限超過 → 拒否（GSD以外） ----
  try {
    checkSendAllowed_({ tenant_id: 'TEST-PLANGUARD-DUMMY', plan: 'light', status: 'active', daily_limit: 5 }, 6);
    check('2_daily_limit_exceeded', 'daily_limit_exceeded', 'no_throw');
  } catch (e) {
    check('2_daily_limit_exceeded', 'daily_limit_exceeded', e.message);
  }

  // ---- ケース3: 日次上限内 → 許可 ----
  try {
    var r3 = checkSendAllowed_({ tenant_id: 'TEST-PLANGUARD-DUMMY', plan: 'light', status: 'active', daily_limit: 5 }, 3);
    check('3_daily_limit_within', true, r3.allowed === true);
  } catch (e) {
    check('3_daily_limit_within', true, 'threw: ' + e.message);
  }

  // ---- 一時テナント行の準備（trial系の検証は実シート読み書きが必要） ----
  var ss          = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var tenantSheet = ss.getSheetByName('tenants');
  var usageSheet  = ss.getSheetByName('usage');
  var now         = new Date();
  var ym          = currentYearMonth_();
  var futureDate  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  var pastDate    = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  var idFreeOk   = 'TEST-PLANGUARD-FREEOK';
  var idFreeOver = 'TEST-PLANGUARD-FREEOVER';
  var idExpired  = 'TEST-PLANGUARD-EXPIRED';

  function appendTestTenant(tenantId, trialEnd) {
    tenantSheet.appendRow([
      tenantId, 'TESTカンパニー', 'TEST代表', 'TEST担当', 'tokyoflowerco.ltd@gmail.com',
      '0000000000', 'TEST住所', 'light', 'trial', now, trialEnd, 30, '', '', 0, now, now
    ]);
  }
  appendTestTenant(idFreeOk, futureDate);
  appendTestTenant(idFreeOver, futureDate);
  appendTestTenant(idExpired, pastDate);
  usageSheet.appendRow([idFreeOver, ym, 0, 30, 0, now]); // free_used=30（上限到達済み）

  // ---- ケース4: trial中でfree_used<30かつtrial_end内 → isFree=true で許可 ----
  try {
    var tenant4 = { tenant_id: idFreeOk, plan: 'light', status: 'trial', trial_end: futureDate };
    var r4 = checkSendAllowed_(tenant4, 1);
    check('4_trial_free_ok',
          { allowed: true, isFree: true, statusAfter: 'trial' },
          { allowed: r4.allowed, isFree: r4.isFree, statusAfter: tenant4.status });
  } catch (e) {
    check('4_trial_free_ok', { allowed: true, isFree: true, statusAfter: 'trial' }, 'threw: ' + e.message);
  }

  // ---- ケース5: free_used>=30 → trial→active自動遷移 & isFree=false ----
  try {
    var tenant5 = { tenant_id: idFreeOver, plan: 'light', status: 'trial', trial_end: futureDate };
    var r5 = checkSendAllowed_(tenant5, 1);
    var sheetStatus5 = getTenantStatusFromSheet_(idFreeOver);
    check('5_free_over_transitions',
          { allowed: true, isFree: false, statusAfter: 'active', sheetStatus: 'active' },
          { allowed: r5.allowed, isFree: r5.isFree, statusAfter: tenant5.status, sheetStatus: sheetStatus5 });
  } catch (e) {
    check('5_free_over_transitions',
          { allowed: true, isFree: false, statusAfter: 'active', sheetStatus: 'active' }, 'threw: ' + e.message);
  }

  // ---- ケース6: trial_end超過 → trial→active自動遷移 ----
  try {
    var tenant6 = { tenant_id: idExpired, plan: 'light', status: 'trial', trial_end: pastDate };
    var r6 = checkSendAllowed_(tenant6, 1);
    var sheetStatus6 = getTenantStatusFromSheet_(idExpired);
    check('6_trial_end_expired_transitions',
          { statusAfter: 'active', sheetStatus: 'active' },
          { statusAfter: tenant6.status, sheetStatus: sheetStatus6 });
  } catch (e) {
    check('6_trial_end_expired_transitions', { statusAfter: 'active', sheetStatus: 'active' }, 'threw: ' + e.message);
  }

  // ---- 後片付け: テスト用tenant/usage行を削除 ----
  [idFreeOk, idFreeOver, idExpired].forEach(function(id) {
    deleteTenantRow_(tenantSheet, id);
  });
  deleteUsageRow_(usageSheet, idFreeOver, ym);

  var allPass = results.every(function(r) { return r.pass; });
  Logger.log('[testPlanGuards_] allPass=' + allPass);
  return { allPass: allPass, results: results };
}

// tenants シートから指定tenant_idのstatusを読む（テスト検証用）
function getTenantStatusFromSheet_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  var data  = sheet.getDataRange().getValues();
  var hdr   = data[0].map(function(h) { return String(h).trim(); });
  var col   = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() === String(tenantId).trim()) {
      return String(data[r][col['status']]);
    }
  }
  return null;
}

// テスト後片付け専用: tenants/usage シートから該当行を削除する
function deleteTenantRow_(sheet, tenantId) {
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var idCol = hdr.indexOf('tenant_id');
  if (idCol === -1) return;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][idCol]).trim() === String(tenantId).trim()) sheet.deleteRow(r + 1);
  }
}

function deleteUsageRow_(sheet, tenantId, yearMonth) {
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var idCol = hdr.indexOf('tenant_id');
  var ymCol = hdr.indexOf('年月');
  if (idCol === -1 || ymCol === -1) return;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][idCol]).trim() === String(tenantId).trim() &&
        String(data[r][ymCol]).trim() === String(yearMonth).trim()) {
      sheet.deleteRow(r + 1);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// STEP5a: テンプレートCRUD・送信元番号一覧・履歴CSVエクスポート・月次レポート
//   すべてtoken必須。tenant解決はbulkSendと同じ方針を踏襲する:
//   member.tenant_id → getTenantById_、tenants未登録（GSD含む）は
//   無制限のGSD同様の挙動（plan='standard'相当）にフォールバックする
//   （既存運用への影響回避を最優先。resolveTenantForMember_ に集約）。
// ────────────────────────────────────────────────────────────────────

// 会員のtenant_idからtenantオブジェクトを解決する共通ヘルパー（bulkSendの方針を踏襲）
function resolveTenantForMember_(member) {
  var tenantId = (member && member.tenant_id) || 'GSD';
  return getTenantById_(tenantId) || { tenant_id: 'GSD', plan: 'standard', status: 'active' };
}

// ────────────────────────────────────────────────────────────────────
// 積み残し2件目: 送信元番号pending中の共通テスト番号でのフォールバック送信
// ────────────────────────────────────────────────────────────────────

// sender_numbersタブに該当tenant_idのstatus='registered'行が1件でもあるか
function hasRegisteredSenderNumber_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('sender_numbers');
  if (!sheet || sheet.getLastRow() < 2) return false;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['status'] === undefined) return false;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    if (String(data[r][col['status']]).trim().toLowerCase() === 'registered') return true;
  }
  return false;
}

// tenantsタブのfallback_sms_account_key列を更新する（キャッシュ目的。内部専用）
function setTenantFallbackSmsAccountKey_(tenantId, key) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet) return false;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['fallback_sms_account_key'] === undefined) return false;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    sheet.getRange(r + 1, col['fallback_sms_account_key'] + 1).setValue(key);
    return true;
  }
  return false;
}

// tenantsタブのfallback_send_count列を+1する（フォールバック送信が成功するたびに呼ぶ）
function incrementFallbackSendCount_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('tenants');
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined || col['fallback_send_count'] === undefined) return;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    var current = Number(data[r][col['fallback_send_count']]) || 0;
    sheet.getRange(r + 1, col['fallback_send_count'] + 1).setValue(current + 1);
    return;
  }
}

// FALLBACK_SEND_LIMIT到達時に投げる専用エラー。メッセージ文字列は呼び出し元
// (resolveEffectiveSmsAccountIdSafe_)が識別に使うため変更しないこと。
function fallbackSendLimitError_() {
  return new Error('番号登録完了までお待ちください（テスト送信の上限に達しました）');
}

// resolveEffectiveAccountId_: sendSingleSMSFromFormのsmsAccountId解決に使う実効アカウントIDを返す。
//   ・tenant管理外（GSD含む、tenants未登録）は従来通りmember.idをそのまま返す
//     （既存動作を一切変えない）。
//   ・tenant管理下でhasRegisteredSenderNumber_がtrueならmember.idを返す
//     （自番号。既存の「1会員1送信元(sms_accounts)」の仕組みのまま）。
//   ・registeredが1件も無い場合、フォールバック送信回数(tenants.fallback_send_count)
//     がFALLBACK_SEND_LIMIT(30)に達していれば専用エラーをthrowする（上限到達）。
//     達していなければ Script Property COMMON_TEST_SENDER_KEY
//     （getPropOptional_で取得。無ければtenant.fallback_sms_account_keyを見る）
//     を返す。取得できた場合はtenants.fallback_sms_account_key列にキャッシュする。
//   ・最終的にnullなら「送信元番号の準備中」を意味し、呼び出し元でエラー処理すること。
function resolveEffectiveAccountId_(member, tenant) {
  if (!tenant || String(tenant.tenant_id).trim() === 'GSD') {
    return member.id; // tenant管理外(GSD含む)は従来通り自番号
  }

  if (hasRegisteredSenderNumber_(tenant.tenant_id)) {
    return member.id; // 自番号（registered済みなのでこの会員のsms_accounts行が用意されている前提）
  }

  var fallbackCount = Number(tenant.fallback_send_count) || 0;
  if (fallbackCount >= FALLBACK_SEND_LIMIT) {
    throw fallbackSendLimitError_();
  }

  var commonKey = getPropOptional_('COMMON_TEST_SENDER_KEY') || tenant.fallback_sms_account_key || null;
  if (commonKey && !tenant.fallback_sms_account_key) {
    setTenantFallbackSmsAccountKey_(tenant.tenant_id, commonKey); // キャッシュ（無くても機能に影響しない）
    tenant.fallback_sms_account_key = commonKey;
  }
  return commonKey || null;
}

// token検証 + 会員の有効性確認をまとめたヘルパー（STEP5a各actionで共通）
function requireEntitledMember_(body) {
  var claims = verifyToken_(body.token);
  var member = getMember_(claims.id);
  if (!member || !isEntitled_(member)) {
    throw new Error('ご契約が有効でないか、送信権限がありません');
  }
  return member;
}

// 指定シートの実ヘッダー順に合わせて1行を追記する（対応なしは空文字）
function appendRowByHeaderNames_(sheet, valuesByName) {
  var lastCol = sheet.getLastColumn();
  var hdr = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
              .map(function(h) { return String(h).normalize('NFKC').trim(); });
  var row = hdr.map(function(h) { return valuesByName.hasOwnProperty(h) ? valuesByName[h] : ''; });
  sheet.appendRow(row);
}

// 数字だけの文字列がシート書き込み時に数値化され先頭0を失うのを防ぐ。
//   setNumberFormat('@') 済みの列でも appendRow/setValues 経由だと数値化されることが
//   ある（STEP2で判明した既知の事象）ため、電話番号等を書き込む前に必ずこれを通す。
//   先頭にアポストロフィを付けるとSheetsはテキスト強制として扱い、実際の値には
//   アポストロフィは含まれない（手動入力で '0312345678 と打つのと同じ挙動）。
function forceTextValue_(v) {
  var s = String(v || '');
  return /^\d+$/.test(s) ? ("'" + s) : s;
}

// ── テンプレートCRUD ──────────────────────────────────────────────

function countTemplatesForTenant_(tenantId) {
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('templates');
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var idx  = hdr.indexOf('tenant_id');
  if (idx === -1) return 0;
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx]).trim() === String(tenantId).trim()) count++;
  }
  return count;
}

// myTenantStatus: 呼び出し会員のtenant状況を返す軽量API（STEP7bのフロント表示用）。
//   tenants未登録(GSD等)はresolveTenantForMember_のフォールバックにより
//   plan='standard'相当・daily_limit=null(無制限)を返す。
function handleMyTenantStatus_(body) {
  var member = requireEntitledMember_(body);
  var tenant = resolveTenantForMember_(member);
  var ym     = currentYearMonth_();
  var usage  = getUsageRow_(tenant.tenant_id, ym) || { free_used: 0, sent_count: 0, billable_count: 0 };

  var isGsd = String(tenant.tenant_id).trim() === 'GSD';
  var dailyLimit = null; // GSD・tenants未登録は無制限扱い（既存運用に影響しない値）
  if (!isGsd) {
    var limits = getPlanLimits_(tenant);
    dailyLimit = Number(tenant.daily_limit) > 0 ? Number(tenant.daily_limit) : limits.dailyLimit;
  }

  // 積み残し2件目: 送信元番号がregistered済みでないテナントには案内文言を返す
  var senderNumberNotice = null;
  if (!isGsd && !hasRegisteredSenderNumber_(tenant.tenant_id)) {
    senderNumberNotice = '番号登録申請中（約2週間）：テスト用共通番号で送信されます';
  }

  return {
    tenant_id:   tenant.tenant_id,
    plan:        tenant.plan || 'standard',
    status:      tenant.status || 'active',
    free_used:   usage.free_used,
    sent_count:  usage.sent_count,
    daily_limit: dailyLimit,
    todaySent:   countTodaySent_(tenant.tenant_id),
    senderNumberNotice: senderNumberNotice
  };
}

// listTemplates: 呼び出し会員のtenant_idに紐づくtemplates全行を返す
function handleListTemplates_(body) {
  var member   = requireEntitledMember_(body);
  var tenantId = member.tenant_id || 'GSD';

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('templates');
  if (!sheet || sheet.getLastRow() < 2) return { templates: [] };

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined) return { templates: [] };

  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    var obj = {};
    hdr.forEach(function(h, i) { obj[h] = data[r][i]; });
    out.push(obj);
  }
  return { templates: out };
}

// createTemplate: プラン上限(checkTemplateLimit_)チェック → templatesへ1行追加
function handleCreateTemplate_(body) {
  var member = requireEntitledMember_(body);
  var name   = String(body['名称'] || '').trim();
  var text   = String(body['本文'] || '').trim();
  if (!name || !text) throw new Error('名称と本文は必須です');

  var tenant       = resolveTenantForMember_(member);
  var currentCount = countTemplatesForTenant_(tenant.tenant_id);
  var limitCheck   = checkTemplateLimit_(tenant, currentCount);
  if (!limitCheck.allowed) {
    throw new Error('プランのテンプレート上限（' + limitCheck.limit + '件）に達しています。standardプランで無制限になります');
  }

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('templates');
  if (!sheet) throw new Error('templates タブが存在しません');

  var templateId = Utilities.getUuid();
  var now        = new Date();
  appendRowByHeaderNames_(sheet, {
    template_id: templateId, tenant_id: tenant.tenant_id,
    '名称': name, '本文': text, created_by: member.id, created_at: now
  });

  return { template_id: templateId, tenant_id: tenant.tenant_id, '名称': name, '本文': text };
}

// updateTemplate / deleteTemplate: 該当tenant_idの行のみ操作可能（他テナントのものは見えない）
function handleUpdateTemplate_(body) {
  var member     = requireEntitledMember_(body);
  var tenantId   = member.tenant_id || 'GSD';
  var templateId = String(body.template_id || '').trim();
  if (!templateId) throw new Error('template_id は必須です');

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('templates');
  if (!sheet) throw new Error('templates タブが存在しません');

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['template_id']]).trim() !== templateId) continue;
    // 他テナントのtemplate_idは「存在しない」ものとして扱う（見えない・操作不可）
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) break;

    if (body['名称'] !== undefined && col['名称'] !== undefined) {
      sheet.getRange(r + 1, col['名称'] + 1).setValue(body['名称']);
    }
    if (body['本文'] !== undefined && col['本文'] !== undefined) {
      sheet.getRange(r + 1, col['本文'] + 1).setValue(body['本文']);
    }
    return { template_id: templateId, updated: true };
  }
  throw new Error('template_id が見つかりません: ' + templateId);
}

function handleDeleteTemplate_(body) {
  var member     = requireEntitledMember_(body);
  var tenantId   = member.tenant_id || 'GSD';
  var templateId = String(body.template_id || '').trim();
  if (!templateId) throw new Error('template_id は必須です');

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('templates');
  if (!sheet) throw new Error('templates タブが存在しません');

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['template_id']]).trim() !== templateId) continue;
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) break;
    sheet.deleteRow(r + 1);
    return { template_id: templateId, deleted: true };
  }
  throw new Error('template_id が見つかりません: ' + templateId);
}

// ── 送信元番号一覧 ────────────────────────────────────────────────

// listSenderNumbers: 呼び出し会員のtenant_idに紐づくsender_numbers全行を返す。
//   usable=true は status='registered' の場合のみ。'pending'には案内文を付与する。
//   ※ 実際の送信元切り替え（複数登録番号からの選択送信）はSTEP5aの範囲では実装しない
//     （sendSingleSMSFromFormの「1会員1送信元(sms_accounts)」という既存設計を変えない
//     ため。未registeredの番号での代替送信＝共通テスト番号の利用は、既存のsms_accounts
//     側の設定をそのまま使う運用を想定し、コード上の新しい切り替えロジックは追加しない。
//     判断の詳細は実装報告を参照）。
function handleListSenderNumbers_(body) {
  var member   = requireEntitledMember_(body);
  var tenantId = member.tenant_id || 'GSD';

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('sender_numbers');
  if (!sheet || sheet.getLastRow() < 2) return { senderNumbers: [] };

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });
  if (col['tenant_id'] === undefined) return { senderNumbers: [] };

  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][col['tenant_id']]).trim() !== String(tenantId).trim()) continue;
    var obj = {};
    hdr.forEach(function(h, i) { obj[h] = data[r][i]; });

    var status = String(obj['status'] || '').trim().toLowerCase();
    obj.usable = status === 'registered';
    if (status === 'pending') {
      obj.statusMessage = '登録申請中（約2週間）';
    } else if (obj.usable) {
      obj.statusMessage = '利用可能';
    } else {
      obj.statusMessage = status ? ('ステータス: ' + status) : '';
    }
    out.push(obj);
  }

  // 積み残し2件目: registered済みが1件も無い場合は案内文言も併せて返す（myTenantStatusと同文言）
  var hasRegistered = out.some(function(o) { return o.usable; });
  var notice = null;
  if (String(tenantId).trim() !== 'GSD' && !hasRegistered) {
    notice = '番号登録申請中（約2週間）：テスト用共通番号で送信されます';
  }
  return { senderNumbers: out, hasRegisteredSenderNumber: hasRegistered, notice: notice };
}

// ── 履歴CSVエクスポート ──────────────────────────────────────────

// CSV 1行分の組み立て（カンマ・ダブルクォート・改行を含む値はダブルクォートで囲む）
function toCsvLine_(fields) {
  return fields.map(function(f) {
    var s = (f === undefined || f === null) ? '' : String(f);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

// log タブの「送信日時」列（'yyyy/MM/dd HH:mm:ss' 文字列 or Date）をDateへ変換する
function parseLogDateStr_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v).trim();
  var m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// exportHistory: tenant.planがstandardなら全期間、lightならgetHistoryMonthsLimit_(3ヶ月)分の
//   log行をCSV文字列にして返す。列選定は既存のhandleListHistory_に準ずる
//   （送信日時・宛先・メッセージ内容・ステータス）。
function handleExportHistory_(body) {
  var member = requireEntitledMember_(body);
  var tenant = resolveTenantForMember_(member);

  var csvHeader = ['送信日時', '宛先', 'メッセージ内容', 'ステータス'];
  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('log');
  if (!sheet || sheet.getLastRow() < 2) {
    return { csv: toCsvLine_(csvHeader) };
  }

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
  var col  = {};
  hdr.forEach(function(h, i) { col[h] = i; });

  var dtCol     = col['送信日時'];
  var toCol     = col['to'];
  var msgCol    = col['メッセージ内容'];
  var stCol     = col['ステータス'];
  var tenantCol = col['tenant_id'];

  var monthsLimit = getHistoryMonthsLimit_(tenant); // light=3, standard=null(無制限)
  var cutoff = null;
  if (monthsLimit) {
    cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthsLimit);
  }

  var lines = [toCsvLine_(csvHeader)];
  for (var r = 1; r < data.length; r++) {
    if (tenantCol !== undefined && String(data[r][tenantCol]).trim() !== String(tenant.tenant_id).trim()) continue;

    var dtRaw = dtCol !== undefined ? data[r][dtCol] : '';
    if (cutoff) {
      var dtDate = parseLogDateStr_(dtRaw);
      if (dtDate && dtDate < cutoff) continue;
    }
    var dtStr = dtRaw instanceof Date
      ? Utilities.formatDate(dtRaw, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
      : String(dtRaw || '');

    lines.push(toCsvLine_([
      dtStr,
      toCol  !== undefined ? String(data[r][toCol]  || '') : '',
      msgCol !== undefined ? String(data[r][msgCol] || '') : '',
      stCol  !== undefined ? String(data[r][stCol]  || '') : ''
    ]));
  }

  return { csv: lines.join('\n') };
}

// ── 月次レポート（standardのみ） ──────────────────────────────────

// monthlyReport: usageタブのsent_count（=課金対象の分割通数）＋logタブ集計の到達率を返す。
//   ※ usage.sent_count はSTEP4aのincrementUsage_でcalcSegments_(body)の分割数分を
//     加算しているため、生の送信件数ではなく既に「分割通数」である。そのため
//     レスポンスの sent_count と 分割通数 は同じ値になる（コーディネーター指示の通り、
//     両フィールドともusage.sent_countをそのまま使う）。
function handleMonthlyReport_(body) {
  var member = requireEntitledMember_(body);
  var tenant = resolveTenantForMember_(member);

  if (String(tenant.plan || '').trim().toLowerCase() !== 'standard') {
    throw new Error('月次レポートはstandardプランで利用可能です');
  }

  var yearMonth = String(body.yearMonth || currentYearMonth_()).trim();
  if (!/^\d{6}$/.test(yearMonth)) throw new Error('yearMonth はyyyyMM形式で指定してください（例: 202609）');

  var usage = getUsageRow_(tenant.tenant_id, yearMonth) || { sent_count: 0, free_used: 0, billable_count: 0 };

  var ss    = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var sheet = ss.getSheetByName('log');
  var sentCount = 0, failedCount = 0;

  if (sheet && sheet.getLastRow() >= 2) {
    var data = sheet.getDataRange().getValues();
    var hdr  = data[0].map(function(h) { return String(h).normalize('NFKC').trim(); });
    var col  = {};
    hdr.forEach(function(h, i) { col[h] = i; });

    var dtCol     = col['送信日時'];
    var stCol     = col['ステータス'];
    var tenantCol = col['tenant_id'];

    for (var r = 1; r < data.length; r++) {
      if (tenantCol !== undefined && String(data[r][tenantCol]).trim() !== String(tenant.tenant_id).trim()) continue;
      var dtDate = dtCol !== undefined ? parseLogDateStr_(data[r][dtCol]) : null;
      if (!dtDate) continue;
      if (Utilities.formatDate(dtDate, 'Asia/Tokyo', 'yyyyMM') !== yearMonth) continue;

      var status = stCol !== undefined ? String(data[r][stCol] || '') : '';
      if (status.indexOf('成功') !== -1) sentCount++;
      else failedCount++;
    }
  }

  var total        = sentCount + failedCount;
  var deliveryRate = total === 0 ? 100 : Math.round((sentCount / total) * 10000) / 100; // % (小数2桁)

  return {
    '年月':     yearMonth,
    sent_count: usage.sent_count,
    '到達率':   deliveryRate,
    '分割通数': usage.sent_count
  };
}

// ────────────────────────────────────────────────────────────────────
// STEP7a: 申込フォームAPI（バックエンド）。action=signup は token不要の公開
// エンドポイント（未契約の見込み客が呼ぶため）。
//   1. 必須項目・plan値・規約同意チェック
//   2. tenant_id発行 → tenants タブへ1行追加（status='pending_number'）
//   3. sender_numbers タブへ送信元電話番号ごとに1行追加（status='pending'）
//   4. 担当者へ受付メール、TF管理者へ番号登録依頼メールを送信
// ────────────────────────────────────────────────────────────────────
function handleSignup_(body) {
  var companyName    = String(body['会社名'] || '').trim();
  var repName         = String(body['代表者名'] || '').trim();
  var contactName      = String(body['担当者名'] || '').trim();
  var contactEmail    = String(body['担当者メール'] || '').trim();
  var contactPhone    = String(body['担当者電話'] || '').trim();
  var address         = String(body['住所'] || '').trim();
  var senderNumbersRaw = Array.isArray(body['送信元電話番号']) ? body['送信元電話番号'] : [];
  var numberOwner     = String(body['番号名義'] || '').trim();
  var plan             = String(body['plan'] || '').trim().toLowerCase();
  var industry        = String(body['業種'] || '').trim();
  var monthlyVolume   = body['想定月間送信数'] !== undefined && body['想定月間送信数'] !== null
                          ? String(body['想定月間送信数']).trim() : '';
  var referral        = String(body['紹介元'] || '').trim();
  var agreeTerms      = body['規約同意'] === true;
  var agreeEmailLaw   = body['特定電子メール法同意'] === true;

  // 1. 必須項目チェック
  var missing = [];
  if (!companyName) missing.push('会社名');
  if (!repName) missing.push('代表者名');
  if (!contactName) missing.push('担当者名');
  if (!contactEmail) missing.push('担当者メール');
  if (!contactPhone) missing.push('担当者電話');
  if (!address) missing.push('住所');
  if (!senderNumbersRaw.length) missing.push('送信元電話番号（1件以上）');
  if (!numberOwner) missing.push('番号名義');
  if (!plan) missing.push('plan');
  if (missing.length) {
    throw new Error('未入力の項目があります: ' + missing.join('、'));
  }
  if (['light', 'standard'].indexOf(plan) === -1) {
    throw new Error('plan は light または standard を指定してください');
  }
  if (senderNumbersRaw.length > 3) {
    throw new Error('送信元電話番号は最大3件までです');
  }
  if (!agreeTerms) throw new Error('利用規約への同意が必要です');
  if (!agreeEmailLaw) throw new Error('特定電子メール法に基づく表示への同意が必要です');

  var normalizedNumbers = senderNumbersRaw
    .map(function(n) { return normalizePhoneFrom_(n); })
    .filter(function(n) { return n; });
  if (!normalizedNumbers.length) throw new Error('有効な送信元電話番号がありません');

  // 2. tenant_id発行 → tenants タブへ追加
  var tenantId = generateTenantId_();
  var now      = new Date();
  var trialEnd = endOfMonthJst_(now);
  var limits   = PLAN_LIMITS[plan];

  var ss          = SpreadsheetApp.openById(getProp_('SMS_SHEET_ID'));
  var tenantSheet = ss.getSheetByName('tenants');
  if (!tenantSheet) throw new Error('tenants タブが存在しません');

  appendRowByHeaderNames_(tenantSheet, {
    tenant_id: tenantId,
    '会社名': companyName, '代表者名': repName, '担当者名': contactName,
    '担当者メール': contactEmail, '担当者電話': contactPhone, '住所': address,
    plan: plan, status: 'pending_number', '申込日': now,
    trial_end: trialEnd, trial_free_limit: limits.freeLimit,
    daily_limit: limits.dailyLimit,
    created_at: now, updated_at: now,
    '業種': industry, '想定月間送信数': monthlyVolume, '紹介元': referral,
    '規約同意': true, '特定電子メール法同意': true
  });

  // 3. sender_numbers タブへ番号ごとに1行追加
  //    ※ 電話番号は setNumberFormat('@') 済みの列でも appendRow 経由だと数値化され
  //      先頭0が失われることがある（STEP2で判明した既知の事象）ため、
  //      forceTextValue_ でテキスト強制してから書き込む。
  var senderSheet = ss.getSheetByName('sender_numbers');
  if (!senderSheet) throw new Error('sender_numbers タブが存在しません');
  normalizedNumbers.forEach(function(num) {
    appendRowByHeaderNames_(senderSheet, {
      tenant_id: tenantId, '電話番号': forceTextValue_(num), '名義': numberOwner,
      status: 'pending', '申請日': now
    });
  });

  // 4. メール送信（担当者への受付メール、TF管理者への番号登録依頼メール）
  sendSignupConfirmationEmail_(contactEmail, companyName, plan, normalizedNumbers);
  sendSignupAdminNotifyEmail_({
    tenantId: tenantId, companyName: companyName, numberOwner: numberOwner,
    numbers: normalizedNumbers, contactName: contactName,
    contactEmail: contactEmail, contactPhone: contactPhone
  });

  logAudit_('-', 'signup', contactEmail, 'ok: tenant=' + tenantId);

  return { tenant_id: tenantId, status: 'pending_number' };
}

// tenant_id発行: 'T'+UUID先頭8桁(大文字)。衝突時は再試行（極めて低確率だが念のため）。
function generateTenantId_() {
  for (var i = 0; i < 5; i++) {
    var candidate = 'T' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
    if (!getTenantById_(candidate)) return candidate;
  }
  return 'T' + Utilities.getUuid().replace(/-/g, '').toUpperCase(); // フォールバック（32桁、事実上衝突しない）
}

// 指定日時が属する月の月末23:59:59（JST）を返す
function endOfMonthJst_(baseDate) {
  var d = baseDate || new Date();
  var ymStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM');
  var parts = ymStr.split('/');
  var year  = Number(parts[0]);
  var month = Number(parts[1]); // 1-12
  var nextMonth = month === 12 ? 1 : month + 1;
  var nextYear  = month === 12 ? year + 1 : year;
  var nextMonthStartStr = nextYear + '/' + ('0' + nextMonth).slice(-2) + '/01 00:00:00';
  var nextMonthStart = Utilities.parseDate(nextMonthStartStr, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  return new Date(nextMonthStart.getTime() - 1000); // 翌月1日00:00:00の1秒前 = 当月末23:59:59
}

function sendSignupConfirmationEmail_(email, companyName, plan, numbers) {
  var planLabel  = plan === 'standard' ? 'standard（スタンダード）' : 'light（ライト）';
  var numberList = numbers.map(function(n) { return '　・' + n; }).join('\n');
  var subject = '【SMS送信侍】お申し込みを受け付けました';
  var body = [
    (companyName || 'ご担当者') + ' 様',
    '',
    'この度はSMS送信侍にお申し込みいただき、誠にありがとうございます。',
    '以下の内容でお申し込みを受け付けました。',
    '',
    'プラン: ' + planLabel,
    '送信元電話番号:',
    numberList,
    '',
    '【今後の流れ】',
    '送信元電話番号の登録には約2週間ほどお時間をいただきます。',
    '登録が完了次第、担当者よりご連絡いたします。',
    '',
    'ご不明な点がございましたら本メールにご返信ください。'
  ].join('\n');

  if (checkMailQuota_()) {
    Logger.log('[sendSignupConfirmationEmail_] メール送信不可(クォータ残少)のためmail_queueに積みました。'
      + '翌日以降に自動再送されます。 email=' + email + ' companyName=' + companyName);
    enqueueMailForRetry_(email, subject, body);
    return;
  }
  MailApp.sendEmail({ to: email, subject: subject, body: body });
}

// TF管理者への通知メール（楽天モバイルへの番号登録申請にそのまま使える形式で整形）
function sendSignupAdminNotifyEmail_(info) {
  var adminEmail = getPropOptional_('ADMIN_NOTIFY_EMAIL') || 'tokyoflowerco.ltd@gmail.com';
  var numberList = info.numbers.map(function(n, i) { return (i + 1) + '. ' + n; }).join('\n');
  var subject = '【SMS送信侍】新規申込（楽天モバイル番号登録要）';
  var body = [
    '新規テナントの申込がありました。楽天モバイルへの番号登録申請をお願いします。',
    '',
    '── 楽天モバイル提出用 ──────────────',
    '名義　　: ' + info.numberOwner,
    '電話番号:',
    numberList,
    '─────────────────────────',
    '',
    'tenant_id  : ' + info.tenantId,
    '会社名　　 : ' + info.companyName,
    '担当者名　 : ' + info.contactName,
    '担当者メール: ' + info.contactEmail,
    '担当者電話 : ' + info.contactPhone
  ].join('\n');

  if (checkMailQuota_()) {
    Logger.log('[sendSignupAdminNotifyEmail_] メール送信不可(クォータ残少)のためmail_queueに積みました。'
      + '翌日以降に自動再送されます。 tenant_id=' + info.tenantId + ' companyName=' + info.companyName);
    enqueueMailForRetry_(adminEmail, subject, body);
    return;
  }
  MailApp.sendEmail({ to: adminEmail, subject: subject, body: body });
}

// ────────────────────────────────────────────────────────────────────
// authorizeOnce: Apps Script エディタから手動実行するための公開ラッパー。
//   末尾が _ の関数はエディタの実行対象関数一覧に出ないため、初回のみ
//   デプロイユーザー(tokyoflower)がここでDrive/Scriptの権限許可を行う目的で
//   用意する。backupSpreadsheet_ → ensureTriggers_ の順に呼び、結果をLoggerに
//   出力する。以後は不要（通常運用ではsetupアクション経由で呼ばれる）。
// ────────────────────────────────────────────────────────────────────
function authorizeOnce() {
  var backupResult = backupSpreadsheet_();
  Logger.log('[authorizeOnce] backupSpreadsheet_ 完了: ' + JSON.stringify(backupResult));

  var triggerResult = ensureTriggers_();
  Logger.log('[authorizeOnce] ensureTriggers_ 完了: ' + JSON.stringify(triggerResult));

  Logger.log('[authorizeOnce] 権限許可の確認が完了しました。');
}


