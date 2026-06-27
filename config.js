// getAccounts_() — 全社一括読み込み（非推奨）
// Phase 2-4 以降、新規コードでは getAccountCreds_()（api.js）を使うこと。
// doGet の legacy テンプレート配信でのみ残存。
function getAccounts_() {
  return {
    "tokyoflower": {
      apiKey: getProp_('TF_API_KEY'),
      secret: getProp_('TF_SECRET'),
      sender: getProp_('TF_SENDER')
    },
    "conveni": {
      apiKey: getProp_('CV_API_KEY'),
      secret: getProp_('CV_SECRET'),
      sender: getProp_('CV_SENDER')
    },
    "edute": {
      apiKey: getProp_('ED_API_KEY'),
      secret: getProp_('ED_SECRET'),
      sender: getProp_('ED_SENDER')
    }
  };
}

// スクリプトプロパティを安全に取得する（未設定なら即エラー）
function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    throw new Error('スクリプトプロパティ未設定: ' + key + ' を設定してください');
  }
  return v;
}

// 必要キーが全て設定されているか確認する手動実行用（実値はログに出さない）
// ACCOUNT_MAP の形式: {"email@example.com":"tokyoflower"} （JSON 文字列）
// ALLOWED_EMAILS は Phase 2-4 で廃止。残っていても害はないが参照しない。
function checkScriptProperties() {
  var required = [
    'TF_API_KEY', 'TF_SECRET', 'TF_SENDER',
    'OAUTH_CLIENT_ID', 'ACCOUNT_MAP', 'RATE_PER_MIN'
    // CV_*/ED_* は当該社のオペレーターが設定するタイミングで追加
  ];
  var sp      = PropertiesService.getScriptProperties();
  var missing = required.filter(function(k) { return !sp.getProperty(k); });
  Logger.log(missing.length ? '未設定: ' + missing.join(', ') : 'OK: 全キー設定済み');
}

// doGet() は legacy テンプレート配信（GAS 上部バーが出る旧フロント用）
// 新フロント（docs/index.html）は doPost のみを利用する
function doGet(e) {
  var accountId = "conveni";
  var accounts  = getAccounts_();
  var template  = HtmlService.createTemplateFromFile('conveni');
  template.senderNumber = accounts[accountId].sender;
  return template.evaluate()
    .setTitle('SMS送信フォーム - 伝票印刷製本のコンビニ');
}
