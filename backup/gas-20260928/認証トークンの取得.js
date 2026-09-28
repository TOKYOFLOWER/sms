// 認証トークンを取得する関数（アカウント指定版）
function getAuthToken(accountId) {
  var accounts = getAccounts_();
  var account = accounts[accountId];
  if (!account) {
    throw new Error("指定されたアカウントが存在しません: " + accountId);
  }
  var url = 'https://api.cpaas.symphony.rakuten.net/auth/v1/token';

  var options = {
    'method': 'get',
    'headers': {
      'Authorization': 'Basic ' + Utilities.base64Encode(account.apiKey + ':' + account.secret),
      'Accept': 'application/json'
    }
  };

  var response = UrlFetchApp.fetch(url, options);
  var json = JSON.parse(response.getContentText());
  return json.jwt_token;
}

// フォームから渡された番号、メッセージ、アカウント識別子でSMSを送信する関数
function sendSingleSMS(phoneNumber, message, accountId) {
  var accounts = getAccounts_();
  var token = getAuthToken(accountId);
  var account = accounts[accountId];
  var url = 'https://api.cpaas.symphony.rakuten.net/sms/v1/submit';

  var payload = {
    "from": account.sender,
    "to": phoneNumber,
    "message_type": "unicode",
    "unicode_message": {
      "text": message
    }
  };

  var options = {
    'method': 'post',
    'headers': {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=UTF-8'
    },
    'payload': JSON.stringify(payload)
  };

  var timestamp = new Date();

  try {
    var response = UrlFetchApp.fetch(url, options);
    var jsonResponse = JSON.parse(response.getContentText());

    writeToLogSheet([
      timestamp,
      accountId,
      phoneNumber,
      message,
      "送信成功",
      jsonResponse.result_message,
      message.length + " / 660 (" + Math.ceil(message.length / 70) + " SMS)"
    ]);

    return "送信成功: " + jsonResponse.result_message;

  } catch (e) {
    writeToLogSheet([
      timestamp,
      accountId,
      phoneNumber,
      message,
      "送信失敗",
      e.message,
      message.length + " / 660 (" + Math.ceil(message.length / 70) + " SMS)"
    ]);

    return "送信失敗: " + e.message;
  }
}

// ログシートに書き込む関数（ヘッダー自動追加版）
function writeToLogSheet(logData) {
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = spreadsheet.getSheetByName("log");

    if (!logSheet) {
      logSheet = spreadsheet.insertSheet("log");
    }

    var lastRow = logSheet.getLastRow();
    if (lastRow === 0 || logSheet.getRange(1, 1).getValue() === "") {
      var headers = ["送信日時", "アカウントID", "送信先電話番号", "メッセージ内容", "ステータス", "結果", "文字数情報"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

      var headerRange = logSheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#f0f0f0");
    }

    logSheet.appendRow(logData);

  } catch (error) {
    Logger.log("ログ書き込みエラー: " + error.message);
  }
}
