// test.js — Phase4-fix ログインロジック単体テスト（GASエディタから手動実行）
//
// 判定基準: entitled = license_valid && (kaihiActive || grandfathered)
//   - flag は参照しない（実行中フラグ）
//   - payment_status は参照しない（GMO廃止残骸）
//   - kaihipay_status はホワイトリスト（'active' のみ有効）
//   - role === 'grandfathered' なら kaihipay 判定をスキップして有効
//   - 格納pwが空なら入力に関わらず必ず失敗（空pw認証バイパス防止）
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
  Logger.log('  expiry         : ' + member.expiry);
  Logger.log('  kaihipay_status: "' + member.kaihipay_status + '"');
  Logger.log('  role           : "' + member.role + '"');
  Logger.log('  pw 列 設定あり  : ' + (member.pw ? 'YES' : 'NO (空)'));
  Logger.log('  --- 判定に使わない列（参照のみ） ---');
  Logger.log('  flag           : "' + member.flag + '" ← 実行中フラグ・利用権判定に不使用');
  Logger.log('  payment_status : "' + member.payment_status + '" ← GMO廃止残骸・利用権判定に不使用');

  // ── STEP 2: pw 照合 ────────────────────────────────────────────
  Logger.log('\n[STEP 2] pw照合（空pwガード + 固定時間 safeEqual_）');
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

  // 空pwガード: 格納pwが空なら入力に関わらず必ず失敗
  var pwNonEmpty = storedLen > 0;
  if (!pwNonEmpty) {
    Logger.log('  空pwガード: FAIL — 格納pwが空です（シートの pw 列に Base64エンコードしたpwを設定してください）');
  }
  var pwMatch = safeEqual_(storedPw, TEST_PW);
  var pwOk    = pwNonEmpty && pwMatch;
  Logger.log('  空pwガード: ' + (pwNonEmpty ? 'OK（格納pw非空）' : 'FAIL（格納pw空）'));
  Logger.log('  safeEqual_: ' + (pwMatch ? 'OK: 一致' : 'FAIL: 不一致（文字数または内容が違う）'));
  Logger.log('  結果: ' + (pwOk ? 'OK' : 'FAIL'));

  // ── STEP 3: expiry チェック（ライセンス有効期限） ─────────────
  Logger.log('\n[STEP 3] expiry チェック（ライセンス有効期限 / 未来日付であること）');
  var expiryOk = isValidExpiry_(member.expiry);
  Logger.log('  現在日時   : ' + new Date());
  Logger.log('  expiry 値  : ' + member.expiry);
  Logger.log('  結果: ' + (expiryOk ? 'OK: 有効期限内' : 'FAIL: 期限切れまたは日付が不正'));

  // ── STEP 4: kaihipay_status チェック（ホワイトリスト判定） ────
  Logger.log('\n[STEP 4] kaihipay_status チェック（ホワイトリスト: ' + KAIHI_ACTIVE_VALUES.join(', ') + '）');
  var kaihiOk = isKaihiActive_(member.kaihipay_status);
  Logger.log('  kaihipay_status 値: "' + member.kaihipay_status + '"');
  Logger.log('  有効値リスト: [' + KAIHI_ACTIVE_VALUES.map(function(v){ return '"' + v + '"'; }).join(', ') + ']');
  Logger.log('  結果: ' + (kaihiOk ? 'OK: 有効値に一致' : 'FAIL: 有効値に一致しない'));

  // ── STEP 5: role / grandfathered チェック ─────────────────────
  Logger.log('\n[STEP 5] role チェック（grandfathered なら kaihipay 判定をスキップして有効）');
  var grandfathered = String(member.role || '').trim() === 'grandfathered';
  Logger.log('  role 値: "' + member.role + '"');
  Logger.log('  grandfathered: ' + (grandfathered ? 'YES → kaihipay 判定スキップ・有効扱い' : 'NO → kaihipay で判定'));

  // ── STEP 6: entitled 判定 ─────────────────────────────────────
  Logger.log('\n[STEP 6] entitled 判定（license_valid && (kaihiActive || grandfathered)）');
  var entitledOk = isEntitled_(member);
  Logger.log('  expiry_ok    : ' + (expiryOk    ? '✓' : '✗'));
  Logger.log('  kaihi_ok     : ' + (kaihiOk     ? '✓' : '✗'));
  Logger.log('  grandfathered: ' + (grandfathered ? '✓' : '✗'));
  Logger.log('  → isEntitled_: ' + (entitledOk ? 'OK: 有効' : 'FAIL: 無効'));

  // ── STEP 7: email 存在確認 ─────────────────────────────────────
  Logger.log('\n[STEP 7] email 存在確認');
  var emailOk = !!member.email && member.email.indexOf('@') > 0;
  Logger.log('  email 値: ' + member.email);
  Logger.log('  結果: ' + (emailOk ? 'OK' : 'FAIL: email が空またはフォーマット不正'));

  // ── STEP 8: 総合判定 ──────────────────────────────────────────
  Logger.log('\n[STEP 8] 総合判定（pw_ok && entitled && email）');
  var allOk = pwOk && entitledOk && emailOk;
  Logger.log('  pw照合    : ' + (pwOk       ? '✓' : '✗') +
             ' / entitled: ' + (entitledOk  ? '✓' : '✗') +
             ' / email   : ' + (emailOk     ? '✓' : '✗'));

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
    Logger.log('  → ログイン失敗。上記 ✗ の項目を確認してください。');
    Logger.log('  ※ 本番エラーメッセージは曖昧化（理由を区別しない）が仕様です。');
  }

  Logger.log('\n=== testLogin_tokyoflower 完了 ===');
}
