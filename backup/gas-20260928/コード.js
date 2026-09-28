// スプレッドシートのアクティブシートから一括SMS送信する関数
// ※ 手動実行用。実行前に必ずスプレッドシートを確認すること。
function sendSMS() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();

  const authEndpoint = "https://api.cpaas.symphony.rakuten.net/auth/v1/token";
  const smsEndpoint = "https://api.cpaas.symphony.rakuten.net/sms/v1/submit";

  // 送信に使うアカウントIDを指定（スプレッドシート用途に応じて変更）
  const accountId = "tokyoflower";
  const accounts = getAccounts_();
  const account = accounts[accountId];

  const tokenResponse = UrlFetchApp.fetch(authEndpoint, {
    method: "GET",
    headers: {
      "Authorization": "Basic " + Utilities.base64Encode(account.apiKey + ":" + account.secret),
      "Accept": "application/json"
    }
  });

  const tokenData = JSON.parse(tokenResponse.getContentText());
  const jwtToken = tokenData.jwt_token;

  for (let i = 1; i < data.length; i++) {
    const to = data[i][0];
    const message = data[i][1];

    if (to && message) {
      const payload = {
        from: account.sender,
        to: to,
        message_type: "unicode",
        unicode_message: {
          text: message
        }
      };

      const response = UrlFetchApp.fetch(smsEndpoint, {
        method: "POST",
        contentType: "application/json",
        headers: {
          "Authorization": "Bearer " + jwtToken,
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        payload: JSON.stringify(payload)
      });

      const result = JSON.parse(response.getContentText());
      Logger.log(`SMS送信結果: ${JSON.stringify(result)}`);
    }
  }
}
