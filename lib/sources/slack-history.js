const { httpRequest, truncate, sleep } = require('../utils');

async function collectSlack() {
  const auth = { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } };
  const oldest = String(Math.floor((Date.now() - 7 * 86400000) / 1000));

  const channels = [];
  let cur = '';
  do {
    const p = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' });
    if (cur) p.set('cursor', cur);
    const r = await httpRequest(`https://slack.com/api/conversations.list?${p}`, auth);
    if (!r.data.ok) { console.error('  Slack list エラー:', r.data.error); break; }
    channels.push(...(r.data.channels || []));
    cur = r.data.response_metadata?.next_cursor || '';
  } while (cur);
  console.log(`  Slackチャンネル: ${channels.length}個`);

  for (const ch of channels) {
    if (!ch.is_member) {
      await httpRequest('https://slack.com/api/conversations.join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      }, JSON.stringify({ channel: ch.id }));
      await sleep(200);
    }
  }

  const msgs = [];
  for (const ch of channels) {
    const p = new URLSearchParams({ channel: ch.id, oldest, limit: '200' });
    const r = await httpRequest(`https://slack.com/api/conversations.history?${p}`, auth);
    if (!r.data.ok) continue;

    const chMsgs = (r.data.messages || [])
      .filter(m => m.text && (!m.subtype || m.subtype === 'bot_message'))
      .map(m => ({
        ch: ch.name, user: m.user || 'bot',
        text: truncate(m.text, 300),
        date: new Date(parseFloat(m.ts) * 1000).toISOString(),
        replies: m.reply_count || 0,
      }));
    if (chMsgs.length > 0) {
      msgs.push(...chMsgs);
      console.log(`  - #${ch.name}: ${chMsgs.length}件`);
    }
    await sleep(300);
  }

  const uids = [...new Set(msgs.map(m => m.user).filter(u => u?.startsWith('U')))];
  const umap = {};
  for (const uid of uids) {
    const r = await httpRequest(`https://slack.com/api/users.info?user=${uid}`, auth);
    if (r.data.ok) umap[uid] = r.data.user.real_name || r.data.user.name;
    await sleep(200);
  }
  for (const m of msgs) { if (umap[m.user]) m.user = umap[m.user]; }

  console.log(`✅ Slack: ${msgs.length}件`);
  return msgs;
}

module.exports = { collectSlack };
