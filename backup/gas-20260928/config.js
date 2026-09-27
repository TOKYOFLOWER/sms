// config.js — 共有ユーティリティ
// Phase 4: 旧 getAccounts_() / OAUTH_CLIENT_ID / ACCOUNT_MAP 廃止。
// doGet は legacy テンプレート配信のみ残存（新フロントは doPost のみ）。

// スクリプトプロパティを安全に取得する（未設定なら即エラー）
function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    throw new Error('スクリプトプロパティ未設定: ' + key + ' を設定してください');
  }
  return v;
}

// ログシートへの書き込み
function writeToLogSheet(logData) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('log');
    if (!sheet) {
      sheet = ss.insertSheet('log');
      var headers = ['送信日時', '会員ID', '送信先電話番号', 'メッセージ内容',
                     'ステータス', '結果', '文字数情報'];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers])
           .setFontWeight('bold').setBackground('#f0f0f0');
    }
    sheet.appendRow(logData);
  } catch (err) {
    Logger.log('log write error: ' + err.message);
  }
}

// 必要 Script Properties 確認（手動実行用・値はログに出さない）
function checkScriptProperties() {
  var required = [
    'MASTER_SHEET_ID', 'SMS_SHEET_ID',
    'OTP_HASH_KEY', 'TOKEN_SIGN_KEY', 'RATE_PER_MIN'
  ];
  var sp      = PropertiesService.getScriptProperties();
  var missing = required.filter(function(k) { return !sp.getProperty(k); });
  Logger.log(missing.length ? '未設定: ' + missing.join(', ') : 'OK: 全キー設定済み');
}

// doGet: legacy HTML テンプレート配信（新フロントは docs/index.html を使用）
function doGet(e) {
  return HtmlService.createHtmlOutput('<p>SMS送信侍 — docs/index.html をご利用ください</p>')
    .setTitle('SMS送信侍');
}
