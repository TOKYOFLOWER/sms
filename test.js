// test.gs — Phase4 ログインロジック単体テスト（GASエディタから手動実行）
//
// 事前準備:
//   スクリプトプロパティ "TEST_PW_TF" に tokyoflower の平文パスワードを設定すること。
//   （このファイルには絶対に pw を直書きしない・git にコミットしない）
//
// 実行方法:
//   GAS エディタで testLogin_tokyoflower を選択して「実行」→ ログで各ステップを確認。

function testLogin_tokyoflower() {
  var TEST_ID = 'tokyoflower';
  var TEST_PW = PropertiesService.getScriptProperties().getProperty('TEST_PW_TF') || '';

  Logger.log('=== testLogin_tokyoflower 開始 ===');
  Logger.log('対象 ID: ' + TEST_ID);
  Logger.log('TEST_PW 設定あり: ' + (TEST_PW ? 'YES' : 'NO — スクリプトプロパティ TEST_PW_TF を設定してください'));

  // ── STEP 1: 会員マスタ検索（MASTER_SHEET_ID / api_key タブ） ──
  Logger.log('\n[STEP 1] getMember_("' + TEST_ID + '")');
  var member;
  try {
    member = getMember_(TEST_ID);
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
    Logger.log('=== テスト中断 ===');
    return;
  }

  if (!member) {
    Logger.log('  FAIL: IDが見つかりません（getMember_ が null を返した）');
    Logger.log('  → MASTER_SHEET_ID の api_key タブに id="' + TEST_ID + '" の行があるか確認してください');
    Logger.log('=== テスト中断 ===');
    return;
  }
  Logger.log('  OK: 行を発見');
  Logger.log('  email          : ' + member.email);
  Logger.log('  flag           : "' + member.flag + '"');
  Logger.log('  expiry         : ' + member.expiry);
  Logger.log('  payment_status : "' + member.payment_status + '"');
  Logger.log('  kaihipay_status: "' + member.kaihipay_status + '"');
  Logger.log('  pw 列 設定あり  : ' + (member.pw ? 'YES' : 'NO (空)'));

  // ── STEP 2: Base64デコード → パスワード照合（固定時間比較） ──
  Logger.log('\n[STEP 2] Base64デコード + safeEqual_() によるpw照合');
  var storedPw = '';
  try {
    storedPw = decodeBase64Str_(member.pw);
  } catch (e) {
    Logger.log('  ERROR: Base64デコード失敗: ' + e.message);
    Logger.log('  → シートの pw 列が正しい Base64 文字列か確認してください');
  }
  var storedLen = storedPw.length;
  var inputLen  = TEST_PW.length;
  Logger.log('  格納pw の文字数: ' + storedLen + ' / 入力pw の文字数: ' + inputLen);
  var pwOk = safeEqual_(storedPw, TEST_PW);
  Logger.log('  結果: ' + (pwOk ? 'OK: 一致' : 'FAIL: 不一致（文字数または内容が違う）'));

  // ── STEP 3: flag チェック ──────────────────────────────────────
  Logger.log('\n[STEP 3] flag チェック（期待値: "TRUE"）');
  var flagOk = member.flag === 'TRUE';
  Logger.log('  flag 値: "' + member.flag + '"');
  Logger.log('  結果: ' + (flagOk ? 'OK' : 'FAIL: "TRUE" ではない'));

  // ── STEP 4: expiry チェック ────────────────────────────────────
  Logger.log('\n[STEP 4] expiry チェック（期待値: 今日より未来の日付）');
  var expiryOk = isValidExpiry_(member.expiry);
  var now = new Date();
  Logger.log('  現在日時   : ' + now);
  Logger.log('  expiry 値  : ' + member.expiry);
  Logger.log('  結果: ' + (expiryOk ? 'OK: 有効期限内' : 'FAIL: 期限切れまたは日付が不正'));

  // ── STEP 5: payment_status チェック ───────────────────────────
  Logger.log('\n[STEP 5] payment_status チェック');
  var payOk = isValidStatus_(member.payment_status);
  Logger.log('  payment_status 値: "' + member.payment_status + '"');
  Logger.log('  isValidStatus_ の判定: ' + (payOk ? 'OK: 有効' : 'FAIL: 無効値と判定'));
  if (!payOk) {
    Logger.log('  → isValidStatus_ が false を返す値: false/invalid/expired/inactive/0/no/無効/cancelled/canceled/unpaid/overdue');
  }

  // ── STEP 6: kaihipay_status チェック ──────────────────────────
  Logger.log('\n[STEP 6] kaihipay_status チェック');
  var kaihiOk = isValidStatus_(member.kaihipay_status);
  Logger.log('  kaihipay_status 値: "' + member.kaihipay_status + '"');
  Logger.log('  isValidStatus_ の判定: ' + (kaihiOk ? 'OK: 有効' : 'FAIL: 無効値と判定'));

  // ── STEP 7: email 存在確認 ─────────────────────────────────────
  Logger.log('\n[STEP 7] email 存在確認');
  var emailOk = !!member.email && member.email.indexOf('@') > 0;
  Logger.log('  email 値: ' + member.email);
  Logger.log('  結果: ' + (emailOk ? 'OK' : 'FAIL: email が空またはフォーマット不正'));

  // ── STEP 8: 総合判定 ──────────────────────────────────────────
  Logger.log('\n[STEP 8] 総合判定');
  var checks = {
    'pw照合'     : pwOk,
    'flag'       : flagOk,
    'expiry'     : expiryOk,
    'payment'    : payOk,
    'kaihi'      : kaihiOk,
    'email'      : emailOk
  };
  var allOk = true;
  var summary = [];
  for (var k in checks) {
    var v = checks[k];
    summary.push(k + ': ' + (v ? '✓' : '✗'));
    if (!v) allOk = false;
  }
  Logger.log('  ' + summary.join(' / '));

  if (allOk) {
    Logger.log('  → 全チェック通過。実際の handleLogin_ を呼べばOTPが送信されるはず。');

    // ── STEP 9: sms_accounts 確認 ─────────────────────────────
    Logger.log('\n[STEP 9] getSmsAccount_("' + TEST_ID + '") 確認');
    try {
      var smsAcc = getSmsAccount_(TEST_ID);
      if (!smsAcc) {
        Logger.log('  WARN: sms_accounts タブに id="' + TEST_ID + '" の行がありません');
        Logger.log('  → Bシートに sms_accounts タブを作成し、行を追加してください');
      } else {
        Logger.log('  label         : "' + smsAcc.label + '"');
        Logger.log('  enabled       : "' + smsAcc.enabled + '"');
        Logger.log('  cpaas_sender  : "' + smsAcc.cpaas_sender + '"');
        Logger.log('  cpaas_api_key 設定あり: ' + (smsAcc.cpaas_api_key ? 'YES' : 'NO'));
        Logger.log('  cpaas_secret  設定あり: ' + (smsAcc.cpaas_secret  ? 'YES' : 'NO'));
        var enabledOk = smsAcc.enabled === 'TRUE';
        Logger.log('  enabled チェック: ' + (enabledOk ? 'OK: 送信可' : 'FAIL: enabled が TRUE ではない'));
      }
    } catch (e) {
      Logger.log('  ERROR: ' + e.message);
    }
  } else {
    Logger.log('  → ログイン失敗。上記 ✗ の項目を修正してください。');
    Logger.log('  ※ 本番エラーメッセージは曖昧化（理由を区別しない）が仕様です。');
  }

  Logger.log('\n=== testLogin_tokyoflower 完了 ===');
}
