const { httpRequest, sleep, sanitizeText } = require('./utils');

async function post(message, channelId, threadTs) {
  message = sanitizeText(message);

  const rawSections = message.split(/\n---\n/).map(s => s.trim()).filter(Boolean);

  const MAX_BLOCK_TEXT = 2900;
  const allBlocks = [];

  for (const section of rawSections) {
    if (section.length <= MAX_BLOCK_TEXT) {
      allBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: section } });
    } else {
      const lines = section.split('\n');
      let chunk = '';
      for (const line of lines) {
        if ((chunk + '\n' + line).length > MAX_BLOCK_TEXT) {
          if (chunk) allBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
          chunk = line;
        } else {
          chunk = chunk ? chunk + '\n' + line : line;
        }
      }
      if (chunk) allBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
    allBlocks.push({ type: 'divider' });
  }

  if (allBlocks.length > 0 && allBlocks[allBlocks.length - 1].type === 'divider') {
    allBlocks.pop();
  }

  const channel = channelId || process.env.SLACK_CHANNEL_ID;
  const BLOCKS_PER_MSG = 48;
  const messageChunks = [];
  for (let i = 0; i < allBlocks.length; i += BLOCKS_PER_MSG) {
    messageChunks.push(allBlocks.slice(i, i + BLOCKS_PER_MSG));
  }

  for (let i = 0; i < messageChunks.length; i++) {
    const payload = {
      channel,
      text: '週次レビュー',
      blocks: messageChunks[i],
      unfurl_links: false,
    };
    if (threadTs) payload.thread_ts = threadTs;

    const r = await httpRequest('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    }, JSON.stringify(payload));
    if (!r.data.ok) throw new Error(`Slack: ${JSON.stringify(r.data)}`);
    if (i < messageChunks.length - 1) await sleep(1000);
  }
  console.log(`✅ Slack投稿完了 (${messageChunks.length}メッセージ, ${allBlocks.length}ブロック)`);
}

module.exports = { post };
