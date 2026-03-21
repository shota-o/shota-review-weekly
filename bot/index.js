const { App } = require('@slack/bolt');
const { handleQuestion } = require('../lib/interactive/responder');
const { httpRequest } = require('../lib/utils');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// @mavbot メンションのハンドラ
app.event('app_mention', async ({ event, client }) => {
  // メンションタグを除去して質問文を取得
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!question) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: '何か質問してください！ :speech_balloon:\n例: 「来週の予定を教えて」「営業の状況をまとめて」',
    });
    return;
  }

  // 「考え中」メッセージを即送信
  let thinkingTs;
  try {
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: ':hourglass_flowing_sand: データを収集・分析中です...',
    });
    thinkingTs = thinking.ts;
  } catch (e) {
    console.error('Thinking message failed:', e.message);
  }

  try {
    await handleQuestion(question, event.channel, event.ts);

    // 「考え中」メッセージを削除
    if (thinkingTs) {
      await client.chat.delete({ channel: event.channel, ts: thinkingTs }).catch(() => {});
    }
  } catch (err) {
    console.error('Error handling question:', err);

    // 「考え中」メッセージをエラーに更新
    if (thinkingTs) {
      await client.chat.update({
        channel: event.channel,
        ts: thinkingTs,
        text: ':warning: エラーが発生しました。もう一度お試しください。',
      }).catch(() => {});
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: ':warning: エラーが発生しました。もう一度お試しください。',
      }).catch(() => {});
    }
  }
});

(async () => {
  // 必須環境変数チェック
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('❌ 未設定:', missing.join(', '));
    process.exit(1);
  }

  await app.start();
  console.log('✅ Mavbot is running in Socket Mode');
  console.log('   メンションで質問を受け付けます');
})();
