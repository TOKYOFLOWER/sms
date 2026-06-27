function onEdit(e) {
  var sheet = e.source.getSheetByName('sms');  // smsシートを指定
  var range = e.range;
  
  // B列が編集された場合にD列へ文字数とSMS通数を書き出す
  if (range.getColumn() == 2 && range.getRow() > 1) {
    var message = range.getValue();
    var charCount = message.length;
    
    // SMS1通は70文字、最大660文字で送信可能（分割時）
    var maxChars = 660;
    var smsCount = Math.ceil(charCount / 70);  // 70文字で1通、以降70文字ごとに+1通
    
    // 文字数とSMS通数をD列に記録
    var result = charCount + " / " + maxChars + " (" + smsCount + " SMS)";
    sheet.getRange(range.getRow(), 4).setValue(result);
  }
}