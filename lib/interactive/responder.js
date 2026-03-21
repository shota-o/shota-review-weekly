const { callClaude } = require('../claude');
const { estimateTokens, jstNow, sanitizeText } = require('../utils');
const { getGoogleAccessToken } = require('../sources/google-auth');
const { collectGmail } = require('../sources/gmail');
const { collectCalendar } = require('../sources/calendar');
const { collectNotion } = require('../sources/notion');
const { collectSlack } = require('../sources/slack-history');
const { collectAttio } = require('../sources/attio');
const { routeQuestion } = require('./router');
const { httpRequest, sleep } = require('../utils');

const INTERACTIVE_SYS = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属アシスタントです。
Slackでの質問に対して、収集したデータに基づいて回答します。

回答ルール：
- 質問に直接答える。週次レポート形式にしない。
- データに基づく根拠を引用する（「3/15のXさんからのメールによると…」「Attioの商談データでは…」など）
- 推測が必要な場合は「推測ですが」と明記する
- Slack mrkdwn形式で書く
- *太字* **太字** は使わない
- 会社名・人名・キーワードは \`バッククォート\` で囲む
- 重要ポイントは > 引用ブロックで囲む
- 末尾に「:mag: 参照ソース」として、どのデータを参照したかを簡潔に記載する
- 面接・採用選考関連（Indeed、interview、面接、応募、候補者対応など）はスキップ

回答の長さ：質問の複雑さに応じて調整。簡単な質問には短く、戦略的な質問には詳しく（ただし最大2000文字程度）。`;

function buildPrompt(question, data, route) {
  const parts = [`質問: ${question}\n\n今日: ${jstNow().toISOString().split('T')[0]}\nデータ収集範囲: ${route.timeRange}\nフォーカス: ${route.focus}\n`];

  if (data.gmail) {
    parts.push(`【Gmail】受信${data.gmail.inbox.length}件, 送信${data.gmail.sent.length}件, 返信待ち${data.gmail.awaitingReply.length}件\n${JSON.stringify(data.gmail, null, 2)}`);
  }
  if (data.calendar) {
    parts.push(`【Calendar】${data.calendar.length}件\n${JSON.stringify(data.calendar, null, 2)}`);
  }
  if (data.notion) {
    parts.push(`【Notion】${data.notion.records.length}件\n${JSON.stringify(data.notion, null, 2)}`);
  }
  if (data.slack) {
    parts.push(`【Slack】${data.slack.length}件\n${JSON.stringify(data.slack, null, 2)}`);
  }
  if (data.attio) {
    parts.push(`【Attio CRM】会社${data.attio.companies.length}, 人${data.attio.people.length}, 商談${data.attio.deals.length}, ノート${data.attio.notes.length}\n${JSON.stringify(data.attio, null, 2)}`);
  }

  let prompt = parts.join('\n\n');

  // トークン制限チェック（100kを超えたらデータを縮小）
  const TOKEN_BUDGET = 100000;
  if (estimateTokens(prompt) > TOKEN_BUDGET) {
    console.log('  データが大きいため縮小中...');
    // 各データソースを個別に要約して縮小
    const condensed = [`質問: ${question}\n\n今日: ${jstNow().toISOString().split('T')[0]}\n※データが大きいため要約版です。\n`];

    if (data.gmail) {
      const gmailSummary = {
        inbox: data.gmail.inbox.slice(0, 20).map(m => ({ subject: m.subject, from: m.from, date: m.date })),
        sent: data.gmail.sent.slice(0, 20).map(m => ({ subject: m.subject, to: m.to, date: m.date })),
        awaitingReply: data.gmail.awaitingReply,
      };
      condensed.push(`【Gmail要約】\n${JSON.stringify(gmailSummary, null, 2)}`);
    }
    if (data.calendar) condensed.push(`【Calendar】\n${JSON.stringify(data.calendar.slice(0, 30), null, 2)}`);
    if (data.notion) condensed.push(`【Notion】\n${JSON.stringify(data.notion.records.slice(0, 30), null, 2)}`);
    if (data.slack) condensed.push(`【Slack】\n${JSON.stringify(data.slack.slice(0, 30), null, 2)}`);
    if (data.attio) {
      const attioSummary = {
        companies: data.attio.companies.slice(0, 30),
        deals: data.attio.deals.slice(0, 30),
        notes: data.attio.notes.slice(0, 20),
      };
      condensed.push(`【Attio CRM要約】\n${JSON.stringify(attioSummary, null, 2)}`);
    }

    prompt = condensed.join('\n\n');
  }

  return prompt;
}

async function postThreadReply(channelId, threadTs, text) {
  text = sanitizeText(text);

  const MAX_BLOCK_TEXT = 2900;
  const blocks = [];
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX_BLOCK_TEXT) {
      if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });

  const r = await httpRequest('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  }, JSON.stringify({
    channel: channelId,
    thread_ts: threadTs,
    text: text.substring(0, 200),
    blocks,
    unfurl_links: false,
  }));

  if (!r.data.ok) throw new Error(`Slack reply: ${JSON.stringify(r.data)}`);
  console.log(`✅ スレッド返信完了 (${blocks.length}ブロック)`);
}

async function handleQuestion(question, channelId, threadTs) {
  console.log(`\n=== インタラクティブ: "${question.substring(0, 50)}" ===`);

  // 1. ルーティング
  console.log('  ルーティング中...');
  const route = await routeQuestion(question);
  console.log(`  → sources: [${route.sources.join(', ')}], timeRange: ${route.timeRange}, focus: ${route.focus}`);

  // 2. データ収集（必要なソースのみ、並列）
  console.log('  データ収集中...');
  const collectors = {};

  let gtoken = null;
  if (route.sources.includes('gmail') || route.sources.includes('calendar')) {
    try { gtoken = await getGoogleAccessToken(); } catch (e) { console.error('  Google Token失敗:', e.message); }
  }

  if (route.sources.includes('gmail') && gtoken) collectors.gmail = collectGmail(gtoken);
  if (route.sources.includes('calendar') && gtoken) collectors.calendar = collectCalendar(gtoken);
  if (route.sources.includes('notion')) collectors.notion = collectNotion();
  if (route.sources.includes('slack')) collectors.slack = collectSlack();
  if (route.sources.includes('attio')) collectors.attio = collectAttio();

  const data = {};
  const entries = Object.entries(collectors);
  const settled = await Promise.allSettled(entries.map(([, p]) => p));
  entries.forEach(([key], i) => {
    if (settled[i].status === 'fulfilled' && settled[i].value) {
      data[key] = settled[i].value;
    } else if (settled[i].status === 'rejected') {
      console.error(`  ${key}収集エラー:`, settled[i].reason?.message);
    }
  });

  const sourceNames = Object.keys(data);
  console.log(`  収集完了: [${sourceNames.join(', ')}]`);

  if (sourceNames.length === 0) {
    await postThreadReply(channelId, threadTs, 'データソースにアクセスできませんでした。環境変数を確認してください。');
    return;
  }

  // 3. Claude分析
  console.log('  Claude分析中...');
  const prompt = buildPrompt(question, data, route);
  const answer = await callClaude(INTERACTIVE_SYS, prompt, 4000);

  // 4. スレッド返信
  await postThreadReply(channelId, threadTs, answer);
  console.log('=== インタラクティブ完了 ===');
}

module.exports = { handleQuestion };
