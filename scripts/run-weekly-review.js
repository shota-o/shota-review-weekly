// ============================================================
// 週次レビュー v5.0 - lib/ モジュール版エントリポイント
// ============================================================

const { getGoogleAccessToken } = require('../lib/sources/google-auth');
const { collectGmail } = require('../lib/sources/gmail');
const { collectCalendar } = require('../lib/sources/calendar');
const { collectNotion } = require('../lib/sources/notion');
const { collectSlack } = require('../lib/sources/slack-history');
const { analyzeGmail, analyzeCalendar, analyzeNotion, analyzeSlack, synthesize } = require('../lib/weekly-review');
const { post } = require('../lib/slack-post');

async function main() {
  const t0 = Date.now();
  console.log('=== 週次レビュー v5.0 開始 ===');

  const required = ['ANTHROPIC_API_KEY', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error('未設定: ' + missing.join(', '));

  // --- 収集 ---
  console.log('\n=== データ収集 ===');
  const gtoken = await getGoogleAccessToken();
  console.log('✅ Google Token取得');

  const [cal, gmail, notion, slack] = await Promise.all([
    collectCalendar(gtoken),
    collectGmail(gtoken),
    collectNotion(),
    collectSlack(),
  ]);

  console.log('\n--- サマリー ---');
  console.log(`Calendar: ${cal.length}件`);
  console.log(`Gmail: 受信${gmail.inbox.length}, 送信${gmail.sent.length}, 返信待ち${gmail.awaitingReply.length}`);
  console.log(`Notion: DB${notion.databases.length}個, レコード${notion.records.length}件`);
  console.log(`Slack: ${slack.length}件`);

  // --- 分析 ---
  let ga, ca, na, sa;

  try { [ga, ca] = await Promise.all([analyzeGmail(gmail), analyzeCalendar(cal)]); }
  catch (e) { console.error('Gmail/Cal分析エラー:', e.message); ga = ga || 'エラー'; ca = ca || 'エラー'; }

  try { na = await analyzeNotion(notion); }
  catch (e) { console.error('Notion分析エラー:', e.message); na = 'エラー'; }

  try { sa = await analyzeSlack(slack); }
  catch (e) { console.error('Slack分析エラー:', e.message); sa = 'エラー'; }

  // --- 統合 ---
  const review = await synthesize(ga, ca, na, sa);

  // --- 投稿 ---
  await post(review);

  console.log(`\n=== 完了（${Math.round((Date.now() - t0) / 1000)}秒） ===`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
