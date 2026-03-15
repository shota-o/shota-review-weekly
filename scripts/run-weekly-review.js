// ============================================================
// 週次レビュー自動化スクリプト v4
//
// Stage 0: 全データ収集
//   - Gmail: 7日間の全受送信（件数制限なし・本文付き）
//   - Calendar: 過去7日+未来7日の全イベント
//   - Notion: "Master Table" DBのみ、30日→14日フォールバック
//   - Slack: 全チャンネル7日間のメッセージ
// Stage 1: Gmail分析（Claude API）
// Stage 2: Calendar分析（Claude API）
// Stage 3: Notion分析（Claude API）
// Stage 4: Slack分析（Claude API）
// Stage 5: 統合レビュー生成（Claude API）
// Stage 6: 事実確認（Claude API）
// Stage 7: Slack投稿
// ============================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const {
  ANTHROPIC_API_KEY, NOTION_TOKEN,
  SLACK_BOT_TOKEN, SLACK_CHANNEL_ID,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
} = process.env;

// --- ユーティリティ ---
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function truncate(str, len) {
  if (!str || len === 0) return str || '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jstDate(d) {
  return new Date((d || new Date()).getTime() + 9 * 3600000);
}

// ================================================================
// Stage 0: データ収集
// ================================================================

async function getGoogleAccessToken() {
  const body = querystring.stringify({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  const res = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);
  if (res.data.access_token) return res.data.access_token;
  throw new Error('Google Token取得失敗: ' + JSON.stringify(res.data));
}

// --- Gmail: 7日間の全受送信（件数制限なし） ---
async function collectGmail(accessToken) {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const profileRes = await httpRequest('https://www.googleapis.com/gmail/v1/users/me/profile', auth);
  if (profileRes.status !== 200) {
    console.error('❌ Gmail API アクセス失敗:', JSON.stringify(profileRes.data));
    return { inbox: [], sent: [], awaitingReply: [], myEmail: '' };
  }
  const myEmail = profileRes.data.emailAddress;
  console.log(`✅ Gmail: ${myEmail} に接続`);

  // メール詳細取得（本文付き・再帰パーツ探索）
  async function getFullMessage(msgId) {
    const detail = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, auth
    );
    if (detail.status !== 200) return null;

    const headers = detail.data.payload?.headers || [];
    const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

    let bodyText = '';
    function extractText(part) {
      if (!part) return;
      if (part.mimeType === 'text/plain' && part.body?.data) {
        bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    extractText(detail.data.payload);
    if (!bodyText.trim()) bodyText = detail.data.snippet || '';

    return {
      id: msgId, threadId: detail.data.threadId,
      subject: getH('Subject') || '(件名なし)',
      from: getH('From'), to: getH('To'), cc: getH('Cc'),
      date: getH('Date'),
      body: truncate(bodyText.replace(/[\r\n]{3,}/g, '\n\n').trim(), 1000),
      labels: detail.data.labelIds || [],
    };
  }

  // ページネーション: 件数制限なしで全件取得
  async function listAllMessages(query) {
    const allMsgs = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ q: query, maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await httpRequest(
        `https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, auth
      );
      if (res.status !== 200 || !res.data.messages) break;
      allMsgs.push(...res.data.messages);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return allMsgs;
  }

  // 7日間の全受信
  console.log('  Gmail: 7日間の受信メール取得中...');
  const inboxMsgIds = await listAllMessages('in:inbox newer_than:7d');
  console.log(`  受信メッセージID: ${inboxMsgIds.length}件`);
  const inboxEmails = [];
  for (const msg of inboxMsgIds) {
    const detail = await getFullMessage(msg.id);
    if (detail) inboxEmails.push(detail);
  }
  console.log(`  ✅ 受信: ${inboxEmails.length}件（本文付き）`);

  // 7日間の全送信
  console.log('  Gmail: 7日間の送信メール取得中...');
  const sentMsgIds = await listAllMessages('in:sent newer_than:7d');
  console.log(`  送信メッセージID: ${sentMsgIds.length}件`);
  const sentEmails = [];
  for (const msg of sentMsgIds) {
    const detail = await getFullMessage(msg.id);
    if (detail) sentEmails.push(detail);
  }
  console.log(`  ✅ 送信: ${sentEmails.length}件（本文付き）`);

  // スレッド分析（未返信検出）
  console.log('  Gmail: スレッド分析中...');
  const threadMap = new Map();
  for (const email of sentEmails) {
    if (threadMap.has(email.threadId)) continue;
    const threadRes = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/threads/${email.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      auth
    );
    if (threadRes.status === 200) {
      const msgs = threadRes.data.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      const lastFrom = (lastMsg?.payload?.headers || []).find(h => h.name === 'From')?.value || '';
      threadMap.set(email.threadId, {
        messageCount: msgs.length, lastFrom,
        isAwaitingReply: msgs.length === 1 || lastFrom.includes(myEmail),
        subject: email.subject, to: email.to, date: email.date,
      });
    }
  }

  const awaitingReply = [];
  for (const [threadId, info] of threadMap) {
    if (info.isAwaitingReply) awaitingReply.push({ threadId, ...info });
  }
  console.log(`  ✅ 返信待ち: ${awaitingReply.length}件`);

  return { inbox: inboxEmails, sent: sentEmails, awaitingReply, myEmail };
}

// --- Google Calendar ---
async function collectCalendar(accessToken) {
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 999);

  const allEvents = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await httpRequest(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.status !== 200) { console.error('Calendar API エラー:', res.data); break; }

    allEvents.push(...(res.data.items || []).map(e => ({
      title: e.summary || '(無題)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || '',
      description: truncate(e.description, 500),
      attendees: (e.attendees || []).filter(a => !a.resource)
        .map(a => ({ name: a.displayName || '', email: a.email, response: a.responseStatus })),
      organizer: e.organizer?.displayName || e.organizer?.email || '',
      meetLink: e.hangoutLink || '',
    })));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`✅ Calendar: ${allEvents.length}件のイベントを取得`);
  return allEvents;
}

// --- Notion: "Master Table" DBのみ、30日→14日フォールバック ---
async function collectNotion() {
  const headers = {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };

  // 全DB検索
  const allDatabases = [];
  let hasMore = true, startCursor = undefined;
  while (hasMore) {
    const body = { filter: { property: 'object', value: 'database' }, page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const res = await httpRequest('https://api.notion.com/v1/search', { method: 'POST', headers }, JSON.stringify(body));
    if (res.status !== 200) break;
    allDatabases.push(...(res.data.results || []));
    hasMore = res.data.has_more;
    startCursor = res.data.next_cursor;
  }

  // "Master Table" を含むDBのみフィルタ
  const masterDbs = allDatabases.filter(db => {
    const title = db.title?.map(t => t.plain_text).join('') || '';
    return title.includes('Master') || title.includes('master');
  });

  console.log(`✅ Notion: ${allDatabases.length}個中 ${masterDbs.length}個の Master Table DBを選択`);
  masterDbs.forEach(db => {
    const title = db.title?.map(t => t.plain_text).join('') || '(無名)';
    console.log(`  - ${title}`);
  });

  // 30日以内のレコードを取得
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();

  const allRecords = [];
  for (const db of masterDbs) {
    const dbTitle = db.title?.map(t => t.plain_text).join('') || '(無名DB)';
    let dbHasMore = true, dbCursor = undefined;
    const dbRecords = [];

    while (dbHasMore) {
      const body = {
        page_size: 100,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      };
      if (dbCursor) body.start_cursor = dbCursor;

      const res = await httpRequest(
        `https://api.notion.com/v1/databases/${db.id}/query`,
        { method: 'POST', headers }, JSON.stringify(body)
      );
      if (res.status !== 200) break;

      const results = res.data.results || [];
      // 30日より古いレコードが出てきたら打ち切り
      const recent = results.filter(p => p.last_edited_time >= thirtyDaysAgo);
      for (const p of recent) {
        const props = {};
        for (const [key, val] of Object.entries(p.properties || {})) {
          if (val.type === 'title') props[key] = val.title?.map(t => t.plain_text).join('') || '';
          else if (val.type === 'select') props[key] = val.select?.name || '';
          else if (val.type === 'status') props[key] = val.status?.name || '';
          else if (val.type === 'date') props[key] = val.date ? `${val.date.start}${val.date.end ? ' → ' + val.date.end : ''}` : '';
          else if (val.type === 'rich_text') props[key] = val.rich_text?.map(t => t.plain_text).join('') || '';
          else if (val.type === 'number') props[key] = val.number;
          else if (val.type === 'checkbox') props[key] = val.checkbox;
          else if (val.type === 'multi_select') props[key] = val.multi_select?.map(s => s.name).join(', ') || '';
          else if (val.type === 'people') props[key] = val.people?.map(pp => pp.name || '').join(', ') || '';
          else if (val.type === 'url') props[key] = val.url || '';
          else if (val.type === 'relation') props[key] = `(${val.relation?.length || 0}件)`;
          else if (val.type === 'formula') props[key] = val.formula?.string || val.formula?.number || '';
        }
        dbRecords.push({ database: dbTitle, id: p.id, lastEdited: p.last_edited_time, properties: props });
      }
      if (recent.length < results.length) { dbHasMore = false; break; }
      dbHasMore = res.data.has_more;
      dbCursor = res.data.next_cursor;
    }

    allRecords.push(...dbRecords);
    console.log(`  - DB「${dbTitle}」: ${dbRecords.length}件（30日以内）`);
  }

  // サイズチェック: 大きすぎたら14日に絞る
  const dataStr = JSON.stringify(allRecords);
  const estimatedTokens = Math.ceil(dataStr.length / 3);
  console.log(`  Notion推定トークン: ${estimatedTokens}`);

  let finalRecords = allRecords;
  if (estimatedTokens > 120000) {
    finalRecords = allRecords.filter(r => r.lastEdited >= fourteenDaysAgo);
    console.log(`  ⚠️ データ量過多 → 14日以内に絞り込み: ${finalRecords.length}件`);
  }

  console.log(`✅ Notion: 合計${finalRecords.length}件のレコード`);
  return {
    databases: masterDbs.map(d => d.title?.map(t => t.plain_text).join('') || ''),
    records: finalRecords,
  };
}

// --- Slack: 全チャンネル7日間のメッセージ取得 ---
async function collectSlack() {
  const auth = { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } };
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 86400000) / 1000);

  // 公開チャンネル一覧
  console.log('  Slack: チャンネル一覧取得中...');
  const allChannels = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await httpRequest(`https://slack.com/api/conversations.list?${params}`, auth);
    if (!res.data.ok) {
      console.error('  Slack conversations.list エラー:', res.data.error);
      break;
    }
    allChannels.push(...(res.data.channels || []));
    cursor = res.data.response_metadata?.next_cursor || '';
  } while (cursor);

  console.log(`  ✅ チャンネル: ${allChannels.length}個を発見`);

  // 各チャンネルの直近7日間のメッセージを取得
  // Botが参加しているチャンネルのみ読める。まずBotをjoinさせる必要はないので、読めるものだけ読む
  const allMessages = [];

  for (const ch of allChannels) {
    const params = new URLSearchParams({
      channel: ch.id,
      oldest: String(sevenDaysAgo),
      limit: '200',
    });

    const res = await httpRequest(`https://slack.com/api/conversations.history?${params}`, auth);
    if (!res.data.ok) {
      // not_in_channel は無視（Botが参加していないチャンネル）
      if (res.data.error !== 'not_in_channel') {
        console.log(`  ⚠️ #${ch.name}: ${res.data.error}`);
      }
      continue;
    }

    const messages = (res.data.messages || [])
      .filter(m => !m.subtype || m.subtype === 'bot_message') // 通常メッセージとbotメッセージのみ
      .map(m => ({
        channel: ch.name,
        user: m.user || m.username || 'bot',
        text: truncate(m.text, 500),
        ts: m.ts,
        date: new Date(parseFloat(m.ts) * 1000).toISOString(),
        replyCount: m.reply_count || 0,
      }));

    if (messages.length > 0) {
      allMessages.push(...messages);
      console.log(`  - #${ch.name}: ${messages.length}件`);
    }

    // レート制限対策
    await sleep(300);
  }

  console.log(`✅ Slack: ${allMessages.length}件のメッセージを取得`);

  // ユーザーID→名前の解決
  const userIds = [...new Set(allMessages.map(m => m.user).filter(u => u && u.startsWith('U')))];
  const userMap = {};
  for (const uid of userIds) {
    const res = await httpRequest(`https://slack.com/api/users.info?user=${uid}`, auth);
    if (res.data.ok) {
      userMap[uid] = res.data.user.real_name || res.data.user.name;
    }
    await sleep(200);
  }

  // ユーザー名を解決
  for (const msg of allMessages) {
    if (userMap[msg.user]) msg.userName = userMap[msg.user];
  }

  return allMessages;
}

// ================================================================
// Claude API
// ================================================================

async function callClaude(systemPrompt, userContent, maxTokens = 8000) {
  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  }, JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  }));

  if (res.status !== 200) {
    console.error('Claude API エラー:', JSON.stringify(res.data).substring(0, 500));
    throw new Error('Claude API エラー (status ' + res.status + ')');
  }
  return res.data.content?.map(c => c.text).join('') || '';
}

const SYSTEM_BASE = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
データにない情報を推測で補わないでください。具体的な人名・会社名・日時をそのまま使ってください。`;

// --- Stage 1: Gmail分析 ---
async function analyzeGmail(gmailData) {
  console.log('\n=== Stage 1: Gmail分析 ===');
  const dateStr = jstDate().toISOString().split('T')[0];

  // データが大きい場合は分割
  const fullData = JSON.stringify({ inbox: gmailData.inbox, sent: gmailData.sent, awaitingReply: gmailData.awaitingReply });
  const tokens = Math.ceil(fullData.length / 3);
  console.log(`  データ推定トークン: ${tokens}`);

  if (tokens > 150000) {
    console.log('  → 分割分析');
    const inboxResult = await callClaude(SYSTEM_BASE,
      `今日: ${dateStr}\n自分: ${gmailData.myEmail}\n\n【受信メール（${gmailData.inbox.length}件）】\n${JSON.stringify(gmailData.inbox, null, 2)}\n\n未読・返信必要・期限言及のあるメールを全て特定してください。`);
    const sentResult = await callClaude(SYSTEM_BASE,
      `今日: ${dateStr}\n自分: ${gmailData.myEmail}\n\n【送信メール（${gmailData.sent.length}件）】\n${JSON.stringify(gmailData.sent, null, 2)}\n\n【返信待ち（${gmailData.awaitingReply.length}件）】\n${JSON.stringify(gmailData.awaitingReply, null, 2)}\n\nフォローアップすべきメール、二通目送信すべきものを全て特定してください。`);
    return `【受信分析】\n${inboxResult}\n\n【送信分析】\n${sentResult}`;
  }

  return await callClaude(SYSTEM_BASE,
    `今日: ${dateStr}\n自分: ${gmailData.myEmail}\n\n【受信メール（${gmailData.inbox.length}件）】\n${JSON.stringify(gmailData.inbox, null, 2)}\n\n【送信メール（${gmailData.sent.length}件）】\n${JSON.stringify(gmailData.sent, null, 2)}\n\n【返信待ち（${gmailData.awaitingReply.length}件）】\n${JSON.stringify(gmailData.awaitingReply, null, 2)}\n\n以下を網羅的に分析：\n1. 未読で返信必要なメール（全件、差出人・件名・本文要約・推奨アクション）\n2. 返信がないメール（全件、相手・件名・送信日・緊急度）\n3. 二通目を送るべきメール\n4. 重要な進行中スレッド\n5. 期限・締切の言及`);
}

// --- Stage 2: Calendar分析 ---
async function analyzeCalendar(calendarEvents) {
  console.log('\n=== Stage 2: Calendar分析 ===');
  const dateStr = jstDate().toISOString().split('T')[0];

  return await callClaude(SYSTEM_BASE,
    `今日: ${dateStr}（日曜日）\n\n【全イベント（${calendarEvents.length}件）】\n${JSON.stringify(calendarEvents, null, 2)}\n\n以下を網羅的に分析（日本時間で）：\n1. 今週実施した商談・会議の振り返り（全件、相手先名・内容）\n2. 来週の全予定（日別・時間順、各予定の準備事項を具体的に）\n3. スケジュールの重複・過密・移動時間問題\n4. 特に準備が必要な重要予定\n5. 来週の空き時間（まとまった作業可能時間）`);
}

// --- Stage 3: Notion分析 ---
async function analyzeNotion(notionData) {
  console.log('\n=== Stage 3: Notion分析 ===');

  if (notionData.records.length === 0) {
    return 'Notion: Master Table DBのデータなし。インテグレーション接続を確認してください。';
  }

  const dataStr = JSON.stringify(notionData.records, null, 2);
  const tokens = Math.ceil(dataStr.length / 3);
  console.log(`  データ推定トークン: ${tokens}`);

  if (tokens > 150000) {
    // DB別に分割分析
    console.log('  → DB別分割分析');
    const byDb = {};
    for (const r of notionData.records) {
      if (!byDb[r.database]) byDb[r.database] = [];
      byDb[r.database].push(r);
    }

    const results = [];
    for (const [dbName, records] of Object.entries(byDb)) {
      const dbStr = JSON.stringify(records, null, 2);
      const dbTokens = Math.ceil(dbStr.length / 3);
      const data = dbTokens > 150000 ? JSON.stringify(records.slice(0, 50), null, 2) : dbStr;

      const result = await callClaude(SYSTEM_BASE,
        `DB「${dbName}」のレコード（${records.length}件）:\n${data}\n\n未完了タスク、商談状況、放置アイテム、開発タスクの進捗を網羅的に分析してください。`);
      results.push(`【${dbName}】\n${result}`);
      console.log(`  ✅ DB「${dbName}」分析完了`);
    }
    return results.join('\n\n');
  }

  return await callClaude(SYSTEM_BASE,
    `【DB一覧】${JSON.stringify(notionData.databases)}\n\n【レコード（${notionData.records.length}件）】\n${dataStr}\n\n以下を網羅的に分析：\n1. 未完了タスク（全件、期限順、担当者付き）\n2. 商談パイプライン（全商談のステータスと次アクション）\n3. 最近活発なドキュメント\n4. 放置アイテム（更新が止まっているもの全件）\n5. 開発タスクの進捗と見落としリスク`);
}

// --- Stage 4: Slack分析 ---
async function analyzeSlack(slackMessages) {
  console.log('\n=== Stage 4: Slack分析 ===');

  if (slackMessages.length === 0) {
    return 'Slack: メッセージデータなし。Botがチャンネルに参加しているか確認してください。';
  }

  // チャンネル別にグループ化
  const byChannel = {};
  for (const m of slackMessages) {
    if (!byChannel[m.channel]) byChannel[m.channel] = [];
    byChannel[m.channel].push(m);
  }

  const channelSummary = Object.entries(byChannel)
    .map(([ch, msgs]) => `#${ch}: ${msgs.length}件`)
    .join(', ');
  console.log(`  チャンネル別: ${channelSummary}`);

  const dataStr = JSON.stringify(slackMessages, null, 2);
  const tokens = Math.ceil(dataStr.length / 3);
  console.log(`  データ推定トークン: ${tokens}`);

  if (tokens > 150000) {
    // チャンネル別に分割
    console.log('  → チャンネル別分割分析');
    const results = [];
    for (const [ch, msgs] of Object.entries(byChannel)) {
      const chStr = JSON.stringify(msgs, null, 2);
      const chTokens = Math.ceil(chStr.length / 3);
      const data = chTokens > 150000 ? JSON.stringify(msgs.slice(0, 100), null, 2) : chStr;

      const result = await callClaude(SYSTEM_BASE,
        `Slackチャンネル #${ch} のメッセージ（${msgs.length}件、直近7日間）:\n${data}\n\n重要な議論、決定事項、アクションアイテム、フォローが必要な話題を特定してください。`);
      results.push(`【#${ch}】\n${result}`);
    }
    return results.join('\n\n');
  }

  return await callClaude(SYSTEM_BASE,
    `【Slackメッセージ（${slackMessages.length}件、直近7日間）】\nチャンネル: ${channelSummary}\n\n${dataStr}\n\n以下を網羅的に分析：\n1. 重要な議論・決定事項\n2. 未解決の質問・依頼\n3. アクションアイテム（誰が何をすべきか）\n4. フォローが必要な話題\n5. チーム内で共有すべき重要情報`);
}

// --- Stage 5: 統合レビュー ---
async function synthesizeReview(gmailAnalysis, calendarAnalysis, notionAnalysis, slackAnalysis) {
  console.log('\n=== Stage 5: 統合レビュー生成 ===');

  const system = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
各データソースの分析結果を統合し、包括的な週次レビューを作成してください。

最重要ルール：
- アクションアイテムは網羅的に列挙。可能性があるものは全て出す。漏れは絶対に避ける。
- 具体的な人名・会社名・日時を必ず含める。伏字禁止。
- データにない推測はしない。推測が必要な場合は明示。
- 営業フォローアップの見落としを積極的にリマインド。
- Slack記法（*太字*、•箇条書き）を使用。`;

  const userData = `【Gmail分析】\n${gmailAnalysis}\n\n【Calendar分析】\n${calendarAnalysis}\n\n【Notion分析】\n${notionAnalysis}\n\n【Slack分析】\n${slackAnalysis}\n\n上記を統合して週次レビューを作成。

*📋 今週の振り返り*
• 実施した商談・会議を全て列挙（相手先名・内容）
• Slackでの重要な議論・決定事項
• 成果・進展

*📌 来週のアクションアイテム（日別・優先度順）*
★ ここが最重要セクション。網羅的に全て列挙すること。
• 月曜〜金曜の各日: 予定＋準備事項＋タスク期限
• Notionの未完了タスク
• Slackで発生したアクションアイテム
• メールから発生したアクション
• 可能性があるものは全てリストアップ

*📧 メール対応（重要度順）*
• 未読返信必要（全件）
• 送信済み未返信（全件、フォローアップ推奨日付き）
• 二通目送るべき相手

*💬 Slack要対応*
• 未回答の質問・依頼
• フォローが必要な議論

*📊 商談パイプライン*
• 全商談のステータスと次アクション

*🔧 開発・プロダクト*
• 進捗と見落としリスク

*⚠️ リスク・注意事項*
• スケジュール重複・過密
• 期限切れ案件（全件）
• 放置案件（全件）

*💡 提案*
• 改善ポイント、効率化の提案`;

  return await callClaude(system, userData, 12000);
}

// --- Stage 6: 事実確認 ---
async function factCheck(review, rawSummary) {
  console.log('\n=== Stage 6: 事実確認 ===');

  const system = `ファクトチェッカーとして、レビュー内の人名・会社名・日時が元データと一致するか確認。
問題があれば修正版を出力。問題なければ元のレビューをそのまま出力。`;

  const summary = rawSummary.length > 100000 ? rawSummary.substring(0, 100000) + '\n...(省略)' : rawSummary;
  return await callClaude(system, `【レビュー】\n${review}\n\n【元データ（照合用）】\n${summary}`, 12000);
}

// --- Slack投稿 ---
async function postToSlack(message) {
  const MAX = 3900;
  const chunks = [];
  let remaining = message;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX);
    if (splitAt === -1 || splitAt < MAX * 0.5) splitAt = MAX;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt + 1);
  }

  for (let i = 0; i < chunks.length; i++) {
    const res = await httpRequest('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    }, JSON.stringify({ channel: SLACK_CHANNEL_ID, text: chunks[i], unfurl_links: false }));
    if (!res.data.ok) throw new Error(`Slack投稿エラー: ${JSON.stringify(res.data)}`);
    if (i < chunks.length - 1) await sleep(1000);
  }
  console.log(`✅ Slack投稿完了 (${chunks.length}メッセージ)`);
}

// ================================================================
// メイン
// ================================================================

async function main() {
  const startTime = Date.now();
  console.log('=== 週次レビュー v4 開始 ===');
  console.log('実行時刻:', new Date().toISOString());

  const required = ['ANTHROPIC_API_KEY', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error('環境変数が未設定: ' + missing.join(', '));

  // --- Stage 0: データ収集 ---
  console.log('\n=== Stage 0: データ収集 ===');
  const googleToken = await getGoogleAccessToken();

  const [calendarEvents, gmailData, notionData, slackMessages] = await Promise.all([
    collectCalendar(googleToken),
    collectGmail(googleToken),
    collectNotion(),
    collectSlack(),
  ]);

  console.log('\n--- データ収集サマリー ---');
  console.log(`Calendar: ${calendarEvents.length}件`);
  console.log(`Gmail: 受信${gmailData.inbox.length}件, 送信${gmailData.sent.length}件, 返信待ち${gmailData.awaitingReply.length}件`);
  console.log(`Notion: DB${notionData.databases.length}個, レコード${notionData.records.length}件`);
  console.log(`Slack: ${slackMessages.length}件のメッセージ`);

  // --- Stage 1-4: 個別分析 ---
  let gmailAnalysis, calendarAnalysis, notionAnalysis, slackAnalysis;

  try {
    [gmailAnalysis, calendarAnalysis] = await Promise.all([
      analyzeGmail(gmailData),
      analyzeCalendar(calendarEvents),
    ]);
  } catch (e) {
    console.error('Gmail/Calendar分析エラー:', e.message);
    gmailAnalysis = gmailAnalysis || 'Gmail分析: エラー';
    calendarAnalysis = calendarAnalysis || 'Calendar分析: エラー';
  }

  try {
    notionAnalysis = await analyzeNotion(notionData);
  } catch (e) {
    console.error('Notion分析エラー:', e.message);
    notionAnalysis = 'Notion分析: エラー（データ量過多の可能性）';
  }

  try {
    slackAnalysis = await analyzeSlack(slackMessages);
  } catch (e) {
    console.error('Slack分析エラー:', e.message);
    slackAnalysis = 'Slack分析: エラー';
  }

  console.log('\n各分析完了');

  // --- Stage 5: 統合レビュー ---
  let review = await synthesizeReview(gmailAnalysis, calendarAnalysis, notionAnalysis, slackAnalysis);

  // --- Stage 6: 事実確認 ---
  const rawSummary = [
    `Calendar: ${calendarEvents.slice(0, 50).map(e => `${e.start} ${e.title}`).join(', ')}`,
    `Gmail受信: ${gmailData.inbox.slice(0, 30).map(e => `${e.from}: ${e.subject}`).join(', ')}`,
    `Gmail送信: ${gmailData.sent.slice(0, 30).map(e => `→${e.to}: ${e.subject}`).join(', ')}`,
    `Notion DB: ${notionData.databases.join(', ')}`,
    `Slack: ${slackMessages.slice(0, 50).map(m => `#${m.channel} ${m.userName || m.user}: ${truncate(m.text, 50)}`).join(', ')}`,
  ].join('\n');

  review = await factCheck(review, rawSummary);

  // --- Stage 7: Slack投稿 ---
  await postToSlack(review);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== 週次レビュー完了（${elapsed}秒） ===`);
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
