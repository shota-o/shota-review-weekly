const { httpRequest, truncate, sleep } = require('../utils');
const { isInterviewRelated } = require('../filters');

async function collectGmail(accessToken) {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const profileRes = await httpRequest('https://www.googleapis.com/gmail/v1/users/me/profile', auth);
  if (profileRes.status !== 200) {
    console.error('❌ Gmail失敗');
    return { inbox: [], sent: [], awaitingReply: [], myEmail: '' };
  }
  const myEmail = profileRes.data.emailAddress;
  console.log(`✅ Gmail: ${myEmail}`);

  async function getMsg(msgId) {
    const d = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, auth
    );
    if (d.status !== 200) return null;
    const hh = d.data.payload?.headers || [];
    const g = n => hh.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

    let body = '';
    (function extract(part) {
      if (!part) return;
      if (part.mimeType === 'text/plain' && part.body?.data)
        body += Buffer.from(part.body.data, 'base64').toString('utf-8');
      if (part.parts) part.parts.forEach(extract);
    })(d.data.payload);
    if (!body.trim()) body = d.data.snippet || '';

    return {
      id: msgId, threadId: d.data.threadId,
      subject: g('Subject') || '(件名なし)',
      from: g('From'), to: g('To'),
      date: g('Date'),
      body: truncate(body.replace(/[\r\n]{3,}/g, '\n').trim(), 500),
    };
  }

  async function listAll(query) {
    const all = [];
    let pt = null;
    do {
      const p = new URLSearchParams({ q: query, maxResults: '100' });
      if (pt) p.set('pageToken', pt);
      const r = await httpRequest(`https://www.googleapis.com/gmail/v1/users/me/messages?${p}`, auth);
      if (r.status !== 200 || !r.data.messages) break;
      all.push(...r.data.messages);
      pt = r.data.nextPageToken;
    } while (pt);
    return all;
  }

  // 受信（面接関連を除外）
  console.log('  受信メール取得中...');
  const inboxIds = await listAll('in:inbox newer_than:7d');
  const inbox = [];
  let inboxSkipped = 0;
  for (const m of inboxIds) {
    const d = await getMsg(m.id);
    if (d && !isInterviewRelated(d.subject) && !isInterviewRelated(d.from)) { inbox.push(d); }
    else if (d) { inboxSkipped++; }
  }
  console.log(`  ✅ 受信: ${inbox.length}件（面接除外: ${inboxSkipped}件）`);

  // 送信（面接関連を除外）
  console.log('  送信メール取得中...');
  const sentIds = await listAll('in:sent newer_than:7d');
  const sent = [];
  let sentSkipped = 0;
  for (const m of sentIds) {
    const d = await getMsg(m.id);
    if (d && !isInterviewRelated(d.subject) && !isInterviewRelated(d.to)) { sent.push(d); }
    else if (d) { sentSkipped++; }
  }
  console.log(`  ✅ 送信: ${sent.length}件（面接除外: ${sentSkipped}件）`);

  // 返信待ち
  console.log('  スレッド分析中...');
  const tMap = new Map();
  for (const e of sent) {
    if (tMap.has(e.threadId)) continue;
    const r = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/threads/${e.threadId}?format=metadata&metadataHeaders=From`, auth
    );
    if (r.status === 200) {
      const msgs = r.data.messages || [];
      const last = (msgs[msgs.length - 1]?.payload?.headers || []).find(h => h.name === 'From')?.value || '';
      if (msgs.length === 1 || last.includes(myEmail)) {
        tMap.set(e.threadId, { subject: e.subject, to: e.to, date: e.date });
      }
    }
  }
  const awaiting = [...tMap.values()];
  console.log(`  ✅ 返信待ち: ${awaiting.length}件`);

  return { inbox, sent, awaitingReply: awaiting, myEmail };
}

module.exports = { collectGmail };
