// ============================================================
// 週次レビュー v4.1 - 安定版
//
// 全てのClaude API呼び出しにトークン安全装置付き。
// データが大きい場合は自動でバッチ分割→結果統合。
// ============================================================

const https = require('https');
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

function truncate(s, n) { return !s ? '' : s.length > n ? s.substring(0, n) + '...' : s; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function estimateTokens(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return Math.ceil(s.length / 3);
}
function jstNow() { return new Date(Date.now() + 9 * 3600000); }

// ================================================================
// Claude API（安全装置付き）
// ================================================================

// 1回のAPI呼び出し上限: 120kトークン（200k上限に対し余裕を持たせる）
const TOKEN_LIMIT = 120000;

async function callClaude(system, user, maxTokens = 8000) {
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
    system, messages: [{ role: 'user', content: user }],
  }));

  if (res.status !== 200) {
    const msg = JSON.stringify(res.data).substring(0, 300);
    console.error(`  Claude API error (${res.status}): ${msg}`);
    throw new Error(`Claude API (${res.status})`);
  }
  return res.data.content?.map(c => c.text).join('') || '';
}

// 配列データをバッチ分割してClaudeに投げ、結果を統合
async function batchAnalyze(system, items, instruction, label) {
  const BATCH_TOKEN_TARGET = 100000;

  // 全体が収まるならそのまま
  const allStr = JSON.stringify(items, null, 2);
  if (estimateTokens(allStr) + estimateTokens(instruction) < TOKEN_LIMIT) {
    return await callClaude(system, `${instruction}\n\n絶対ルール：「他X件」「等」のような省略は禁止。該当する項目は全件列挙すること。\n\nデータ（${items.length}件）:\n${allStr}`);
  }

  // バッチサイズを推定
  const avgTokensPerItem = estimateTokens(JSON.stringify(items[0], null, 2));
  const batchSize = Math.max(10, Math.floor(BATCH_TOKEN_TARGET / avgTokensPerItem));

  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  console.log(`  ${label}: ${items.length}件 → ${batches.length}バッチ（各~${batchSize}件）`);

  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const batchStr = JSON.stringify(batches[i], null, 2);
    console.log(`  ${label} バッチ${i + 1}/${batches.length} (${batches[i].length}件, ~${estimateTokens(batchStr)}トークン)`);
    const result = await callClaude(system,
      `${instruction}\n\n絶対ルール：「他X件」「等」のような省略は禁止。該当する項目は全件列挙すること。\n\nデータ（バッチ${i + 1}/${batches.length}、${batches[i].length}件）:\n${batchStr}`);
    results.push(result);
  }

  // バッチが2以上なら結果を統合（全件保持）
  if (results.length > 1) {
    console.log(`  ${label}: ${results.length}バッチの結果を統合中...`);
    const combined = results.map((r, i) => `--- バッチ${i + 1} ---\n${r}`).join('\n\n');

    if (estimateTokens(combined) < TOKEN_LIMIT) {
      return await callClaude(system,
        `以下は同じデータセットを分割分析した結果です。全ての項目を保持したまま統合してください。項目を省略・圧縮しないこと。重複のみ排除。\n\n${combined}`);
    }
    return combined;
  }

  return results[0];
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
  throw new Error('Google Token失敗: ' + JSON.stringify(res.data));
}

// --- Gmail ---
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

  // 受信
  console.log('  受信メール取得中...');
  const inboxIds = await listAll('in:inbox newer_than:7d');
  const inbox = [];
  for (const m of inboxIds) { const d = await getMsg(m.id); if (d) inbox.push(d); }
  console.log(`  ✅ 受信: ${inbox.length}件`);

  // 送信
  console.log('  送信メール取得中...');
  const sentIds = await listAll('in:sent newer_than:7d');
  const sent = [];
  for (const m of sentIds) { const d = await getMsg(m.id); if (d) sent.push(d); }
  console.log(`  ✅ 送信: ${sent.length}件`);

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

// --- Calendar ---
async function collectCalendar(accessToken) {
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 999);

  const all = [];
  let pt = null;
  do {
    const p = new URLSearchParams({
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    if (pt) p.set('pageToken', pt);
    const r = await httpRequest(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status !== 200) break;

    all.push(...(r.data.items || []).map(e => ({
      title: e.summary || '(無題)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || '',
      description: truncate(e.description, 200),
      attendees: (e.attendees || []).filter(a => !a.resource)
        .map(a => a.displayName || a.email).join(', '),
      organizer: e.organizer?.displayName || e.organizer?.email || '',
    })));
    pt = r.data.nextPageToken;
  } while (pt);

  console.log(`✅ Calendar: ${all.length}件`);
  return all;
}

// --- Notion ---
async function collectNotion() {
  const h = {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };

  const dbs = [];
  let more = true, cur;
  while (more) {
    const b = { filter: { property: 'object', value: 'database' }, page_size: 100 };
    if (cur) b.start_cursor = cur;
    const r = await httpRequest('https://api.notion.com/v1/search', { method: 'POST', headers: h }, JSON.stringify(b));
    if (r.status !== 200) break;
    dbs.push(...(r.data.results || []));
    more = r.data.has_more; cur = r.data.next_cursor;
  }

  const masterDbs = dbs.filter(d => {
    const t = d.title?.map(x => x.plain_text).join('') || '';
    return t.toLowerCase().includes('master');
  });
  console.log(`✅ Notion: ${dbs.length}個中 ${masterDbs.length}個の Master DB`);

  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const fourteenAgo = new Date(Date.now() - 14 * 86400000).toISOString();

  const recs = [];
  for (const db of masterDbs) {
    const title = db.title?.map(x => x.plain_text).join('') || '(無名)';
    let dm = true, dc;
    while (dm) {
      const b = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] };
      if (dc) b.start_cursor = dc;
      const r = await httpRequest(`https://api.notion.com/v1/databases/${db.id}/query`, { method: 'POST', headers: h }, JSON.stringify(b));
      if (r.status !== 200) break;

      const results = r.data.results || [];
      const recent = results.filter(p => p.last_edited_time >= thirtyAgo);
      for (const p of recent) {
        const props = {};
        for (const [k, v] of Object.entries(p.properties || {})) {
          if (v.type === 'title') props[k] = v.title?.map(t => t.plain_text).join('') || '';
          else if (v.type === 'select') props[k] = v.select?.name || '';
          else if (v.type === 'status') props[k] = v.status?.name || '';
          else if (v.type === 'date') props[k] = v.date?.start || '';
          else if (v.type === 'rich_text') props[k] = v.rich_text?.map(t => t.plain_text).join('') || '';
          else if (v.type === 'number') props[k] = v.number;
          else if (v.type === 'checkbox') props[k] = v.checkbox;
          else if (v.type === 'multi_select') props[k] = v.multi_select?.map(s => s.name).join(', ') || '';
          else if (v.type === 'people') props[k] = v.people?.map(p => p.name || '').join(', ') || '';
        }
        recs.push({ db: title, lastEdited: p.last_edited_time, props });
      }
      if (recent.length < results.length) break;
      dm = r.data.has_more; dc = r.data.next_cursor;
    }
    console.log(`  - ${title}: ${recs.filter(r => r.db === title).length}件`);
  }

  // 14日フォールバック
  let final = recs;
  if (estimateTokens(recs) > TOKEN_LIMIT) {
    final = recs.filter(r => r.lastEdited >= fourteenAgo);
    console.log(`  ⚠️ 14日に絞り込み: ${final.length}件`);
  }

  console.log(`✅ Notion: ${final.length}件`);
  return { databases: masterDbs.map(d => d.title?.map(x => x.plain_text).join('') || ''), records: final };
}

// --- Slack ---
async function collectSlack() {
  const auth = { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } };
  const oldest = String(Math.floor((Date.now() - 7 * 86400000) / 1000));

  // チャンネル一覧
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

  // Botを各チャンネルにjoin（参加していないと履歴が読めない）
  for (const ch of channels) {
    if (!ch.is_member) {
      await httpRequest('https://slack.com/api/conversations.join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }, JSON.stringify({ channel: ch.id }));
      await sleep(200);
    }
  }

  // メッセージ取得
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

  // ユーザー名解決
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

// ================================================================
// 分析ステージ
// ================================================================

const SYS = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
データにない推測は禁止。具体的な人名・会社名・日時をそのまま使ってください。`;

async function analyzeGmail(data) {
  console.log('\n=== Stage 1: Gmail分析 ===');
  const d = jstNow().toISOString().split('T')[0];
  const inst = `今日: ${d}\n自分: ${data.myEmail}\n\n網羅的に分析（未読/既読は問わない。重要度で判断）:\n1. 重要なメール（商談進展、依頼、期限付き対応、意思決定が必要なもの）→ 背景・ステータス・ネクストアクション付き\n2. 返信が来ていない相手（全件、相手・件名・送信日・背景）\n3. もう一度連絡した方がいい相手（全件、理由付き）\n4. メール本文中の期限・締切への言及`;

  const inboxResult = await batchAnalyze(SYS, data.inbox, `${inst}\n\n以下は受信メールです。`, '受信');
  const sentResult = await batchAnalyze(SYS, data.sent, `${inst}\n\n以下は送信メールです。返信待ち一覧:\n${JSON.stringify(data.awaitingReply, null, 2)}`, '送信');

  return `【受信メール分析】\n${inboxResult}\n\n【送信メール・返信待ち分析】\n${sentResult}`;
}

async function analyzeCalendar(events) {
  console.log('\n=== Stage 2: Calendar分析 ===');
  const d = jstNow().toISOString().split('T')[0];
  const inst = `今日: ${d}（日曜日）\n\n日本時間で分析:\n1. 今週の商談・会議の振り返り（全件）\n2. 来週の全予定（日別・時間順、準備事項）\n3. スケジュール重複・問題\n4. 特に準備が必要な予定\n5. 来週の空き時間`;

  return await batchAnalyze(SYS, events, inst, 'Calendar');
}

async function analyzeNotion(data) {
  console.log('\n=== Stage 3: Notion分析 ===');
  if (data.records.length === 0) return 'Notion: Master Table DBのデータなし。';

  const inst = `DB一覧: ${JSON.stringify(data.databases)}\n\n網羅的に分析:\n1. 未完了タスク（全件、期限順）\n2. 商談パイプライン（全商談のステータス・次アクション）\n3. 放置アイテム\n4. 開発タスクの進捗・見落としリスク`;

  return await batchAnalyze(SYS, data.records, inst, 'Notion');
}

async function analyzeSlack(messages) {
  console.log('\n=== Stage 4: Slack分析 ===');
  if (messages.length === 0) return 'Slack: メッセージなし（Botのチャンネル参加を確認）';

  const inst = `直近7日間のSlackメッセージ。翔太が見落としていそうなもの・覚えておくべきことを幅広く拾う:\n1. 重要な情報共有・意思決定・合意事項\n2. 誰かの相談や提案で翔太がリアクションすべきもの\n3. 技術的トピック・プロダクトに影響する話題\n4. チームの動きやモチベーションに関わること\n5. 未解決の議論やペンディング事項`;

  return await batchAnalyze(SYS, messages, inst, 'Slack');
}

// --- 統合 ---
async function synthesize(gmail, calendar, notion, slack) {
  console.log('\n=== Stage 5: 統合レビュー（セクション別生成） ===');

  const sys = `あなたは株式会社Mavericks 代表取締役 奥野翔太の右腕です。
トーン：明るく、テンポよく。大袈裟にしない。フレンドリーだけど中身はしっかり。

Slack mrkdwn 書式ルール（厳守）：
- *アスタリスクで囲む太字* は1つも使わないこと。見出しにも本文にも使わない。
- **ダブルアスタリスク** も絶対に使わない。
- ## # も使わない。
- セクション見出しは :emoji: テキスト の形式。
- 絵文字はSlackショートコードで書く（:sunny: :calendar: :speech_balloon: :wrench: :bulb: :clock3:）

レイアウトルール（最重要。視認性のために厳守）：
- 各項目（メール1件、予定1日分、Slackトピック1つ等）を > 引用ブロックでグループ化する
- 引用ブロックの中では全行を > で始める
- 項目と項目の間は必ず空行を1行入れて余白をつくる
- 会社名・件名・キーワードは \`バッククォート\` で囲む
- コードブロック（\`\`\`）はメインコンテンツには使わない（文字が小さくなるため）
- 箇条書き記号「• 」は引用ブロックの外でのみ使ってよい

中身のルール：
- 「他X件」「等」のような省略は絶対禁止。全件書く。
- 具体的な人名・会社名・日時を含める。伏字禁止。
- データにない推測はしない。`;

  let input = `【Gmail分析】\n${gmail}\n\n【Calendar分析】\n${calendar}\n\n【Notion分析】\n${notion}\n\n【Slack分析】\n${slack}`;

  if (estimateTokens(input) > TOKEN_LIMIT) {
    console.log('  入力が大きいため要約中...');
    const summarize = async (name, text) => {
      if (estimateTokens(text) > 25000) {
        return await callClaude(SYS,
          `以下の${name}分析結果を要約してください。ただし個別の項目（メール件名、相手名、タスク名等）は全件保持すること。「他X件」のような省略は禁止。構造やコメントを圧縮して、リスト自体は全件残してください。\n\n${text}`);
      }
      return text;
    };
    gmail = await summarize('Gmail', gmail);
    calendar = await summarize('Calendar', calendar);
    notion = await summarize('Notion', notion);
    slack = await summarize('Slack', slack);
    input = `【Gmail分析】\n${gmail}\n\n【Calendar分析】\n${calendar}\n\n【Notion分析】\n${notion}\n\n【Slack分析】\n${slack}`;
  }

  const sections = [];

  // 日付計算
  const today = jstNow();
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - today.getDay() + 1);
  const thisFriday = new Date(thisMonday);
  thisFriday.setDate(thisMonday.getDate() + 4);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(thisMonday.getDate() + 7);
  const nextFriday = new Date(nextMonday);
  nextFriday.setDate(nextMonday.getDate() + 4);
  const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const thisWeekLabel = `${fmt(thisMonday)}〜${fmt(thisFriday)}`;
  const nextWeekLabel = `${fmt(nextMonday)}〜${fmt(nextFriday)}`;

  console.log('  セクション1: 今週の振り返り');
  const sec1 = await callClaude(sys, `${input}\n\n以下を出力。

:sunny: 今週の振り返り（${thisWeekLabel}）

まず全体のまとめを3-5行で書く。今週全体として何が進んだか、どんな1週間だったか、大きな流れや成果を俯瞰する。

> ここに今週全体のまとめを書く
> 例：「今週は自治体営業が活発で8自治体と商談。企業側では BEMAC・デンソーとの既存案件が前進。NoLangのスライド生成マーケMTGも実施し、プロダクト方向性の議論が進んだ。」

そのあと、各日の詳細を書く。各日を > 引用ブロックで囲み、日と日の間に空行。
今までより少し詳しく書く。相手の反応や、やりとりの中身、次のアクションにつながる情報を含める。

月 ${fmt(thisMonday)}
> \`PwC\` ○○の件で打合せ。△△の方向で合意。先方は□□を次のステップとして提案
> \`アステラス製薬\` NoLang紹介。先方は△△部門での活用に関心、具体的に××の用途を想定。次回デモ設定の流れ

火 ${fmt(new Date(thisMonday.getTime() + 86400000))}
> \`BEMAC\` 対面。□□のアーキテクチャについて議論。先方の関心は△△にシフト
> 宿題: ××の資料を次回までに準備。▽▽さんにヒアリング日程を確認

各日3-5行。何もなかった日は飛ばす。
ポイント：「何が進んだか」「相手の反応」「決まったこと」「宿題・次のアクション」`, 8000);
  sections.push(sec1);

  console.log('  セクション2: 来週のTODO（統合）');
  const sec2 = await callClaude(sys, `${input}\n\n以下を出力。「他X件」省略は絶対禁止。全件書くこと。

このセクションは、来週やるべきことを「期限」ベースでまとめたもの。
商談準備、メール対応、フォローアップ、タスク期限、すべてを1つのリストに統合する。
別々のセクション（メール、商談、予定整理）に分けない。全部ここにまとめる。

:calendar: 来週やること（${nextWeekLabel}）

期限が近い順に並べる。各項目を > 引用ブロックで囲み、項目間に空行を入れる。
会社名・件名は \`バッククォート\` で囲む。

出力フォーマット（この通りに書くこと）：

→ 月 ${fmt(nextMonday)} までに

> \`PR TIMES\` プレスリリース修正版の送付（締切: 月曜）
> 修正依頼が来ていた件。最終版を確認して送信

> \`BEMAC + PwC\` 対面の準備
> 前回の宿題だった○○の資料を仕上げる。日曜中に確認しておくこと

→ 水 ${fmt(new Date(nextMonday.getTime() + 2 * 86400000))} までに

> \`川口市\` 齋藤様との初回商談の準備
> 自治体DX文脈。先方はAI活用に前向き。自治体向け提案資料を用意

> \`○○社\` △△さんへフォローメール
> 3/10に送った \`NoLangサービス紹介\` に返信なし。1週間経過したので進捗確認

→ 金 ${fmt(nextFriday)} までに

> \`さくらインターネット\` クレカ情報変更（期限: 金曜）

> \`○○社\` ▽▽さんへ再コンタクト
> 前回から2週間経過。検討状況の確認メールを送る

→ スケジュール注意点

> 火曜: \`デンソー\` と \`レスター\` が時間被り → デンソー優先でレスターはリスケ提案
> 木曜: 公庫訪問あり → 財務資料の最新版を前日までに確認

含めるべき項目（全てを1つのリストに統合すること）：
- 商談の準備（初回なら先方の背景、継続なら前回の宿題）
- 返信が来ていないメールへのフォロー（全件。相手名・件名・送信日・背景付き）
- もう一度連絡した方がいい相手（全件。理由付き）
- 重要メールへの対応（期限付きのもの）
- Notionのタスクで期限が近いもの
- その他デッドラインがあるもの
- スケジュールの重複・注意点`, 8000);
  sections.push(sec2);

  console.log('  セクション3: Slack + 開発 + ひとこと');
  const sec3 = await callClaude(sys, `${input}\n\n以下を出力。

絶対に *アスタリスクで囲む太字* を使わないこと。1つも使わないこと。見出しにも本文にも使わない。

:speech_balloon: Slackから拾っておくこと

翔太が見落としていそうなもの・覚えておくべきことを幅広く。各項目を > 引用ブロックで囲み、項目間に空行。

> \`Chromeゼロデイ脆弱性\` の共有あり（#general）
> 全社的にアップデート推奨。開発チームのブラウザ環境も確認

> 岩切さんが \`NoLangの○○機能\` について相談（#dev）
> まだ返信ついていない。方針をコメントしてあげると進みそう

:wrench: 開発・タスク

Notionのタスクで気にしておくべきもの。各項目を > 引用ブロックで。

> \`○○タスク\` 期限: 3/19
> △△の対応が必要。□□と連携して進める

:bulb: ひとこと

全体を見て気づいたことを1-2点。気軽に。`, 8000);
  sections.push(sec3);

  console.log('  ✅ 全セクション生成完了');
  return sections.join('\n\n---\n\n');
}

// --- 事実確認 ---
async function factCheck(review, summary) {
  console.log('\n=== Stage 6: 事実確認 ===');
  const s = summary.length > 80000 ? summary.substring(0, 80000) + '...' : summary;
  return await callClaude(
    `ファクトチェッカー。レビュー内の人名・日時が元データと一致するか確認。

重要ルール：
- 構成・トーン・書式は一切変えない
- *アスタリスク太字* や **ダブルアスタリスク** は絶対に追加しない
- 事実の誤りのみ修正。問題なければ元のまま出力`,
    `【レビュー】\n${review}\n\n【元データ（照合用）】\n${s}`, 12000
  );
}

// --- テキストサニタイズ（文字化け防止 + *太字*除去） ---
function sanitizeText(text) {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    // *太字* を除去（バッククォート内は保護）
    .replace(/(?<!\`)\*\*(.+?)\*\*(?!\`)/g, '$1')  // **bold** → bold
    .replace(/(?<!\`)(?<!\w)\*([^*\n]+?)\*(?!\`)(?!\w)/g, '$1');  // *bold* → bold（ただしショートコード :xxx: は保護）
}

// --- Slack投稿（Blocks API使用 → mrkdwn確実レンダリング） ---
async function post(message) {
  message = sanitizeText(message);

  // セクション分割（--- で区切られている）
  const rawSections = message.split(/\n---\n/).map(s => s.trim()).filter(Boolean);

  // 各セクションを Slack blocks に変換
  // Slack blocks の1セクションは3000文字制限があるので分割
  const MAX_BLOCK_TEXT = 2900;
  const allBlocks = [];

  for (const section of rawSections) {
    if (section.length <= MAX_BLOCK_TEXT) {
      allBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: section } });
    } else {
      // 改行で分割して3000文字以内のチャンクにする
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
    // セクション間にdivider
    allBlocks.push({ type: 'divider' });
  }

  // 末尾のdividerを除去
  if (allBlocks.length > 0 && allBlocks[allBlocks.length - 1].type === 'divider') {
    allBlocks.pop();
  }

  // Slack blocks は1メッセージ50ブロック制限
  const BLOCKS_PER_MSG = 48;
  const messageChunks = [];
  for (let i = 0; i < allBlocks.length; i += BLOCKS_PER_MSG) {
    messageChunks.push(allBlocks.slice(i, i + BLOCKS_PER_MSG));
  }

  for (let i = 0; i < messageChunks.length; i++) {
    const r = await httpRequest('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    }, JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: '週次レビュー',  // blocks非対応クライアント向けフォールバック
      blocks: messageChunks[i],
      unfurl_links: false,
    }));
    if (!r.data.ok) throw new Error(`Slack: ${JSON.stringify(r.data)}`);
    if (i < messageChunks.length - 1) await sleep(1000);
  }
  console.log(`✅ Slack投稿完了 (${messageChunks.length}メッセージ, ${allBlocks.length}ブロック)`);
}

// ================================================================
// メイン
// ================================================================
async function main() {
  const t0 = Date.now();
  console.log('=== 週次レビュー v4.1 開始 ===');

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
  let review = await synthesize(ga, ca, na, sa);

  // --- 事実確認 ---
  const raw = [
    `Cal: ${cal.slice(0, 50).map(e => `${e.start} ${e.title}`).join('; ')}`,
    `Gmail受信: ${gmail.inbox.slice(0, 30).map(e => `${e.from}: ${e.subject}`).join('; ')}`,
    `Gmail送信: ${gmail.sent.slice(0, 30).map(e => `→${e.to}: ${e.subject}`).join('; ')}`,
    `Notion: ${notion.databases.join(', ')}`,
    `Slack: ${slack.slice(0, 30).map(m => `#${m.ch} ${m.user}: ${truncate(m.text, 40)}`).join('; ')}`,
  ].join('\n');
  review = await factCheck(review, raw);

  // --- 投稿 ---
  await post(review);

  console.log(`\n=== 完了（${Math.round((Date.now() - t0) / 1000)}秒） ===`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
