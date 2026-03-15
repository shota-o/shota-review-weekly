// ============================================================
// 週次レビュー自動化スクリプト v3（マルチステージ完全版）
//
// アーキテクチャ:
//   Stage 0: 全データ収集（Gmail全文、Calendar全件、Notion全件）
//   Stage 1: Gmail分析（Claude API）
//   Stage 2: Calendar分析（Claude API）
//   Stage 3: Notion分析（Claude API）
//   Stage 4: 統合レビュー生成（Claude API）
//   Stage 5: 事実確認（Claude API）
//   Stage 6: Slack投稿
// ============================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const {
  ANTHROPIC_API_KEY,
  NOTION_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} = process.env;

// --- 設定読み込み ---
function loadConfig() {
  try {
    const configPath = path.resolve(__dirname, '../config/review-config.yaml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    // 簡易YAMLパーサー（依存なし）
    const config = {};
    let currentSection = null;
    let currentSub = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const indent = line.search(/\S/);
      const trimmed = line.trim();
      if (indent === 0 && trimmed.endsWith(':')) {
        currentSection = trimmed.slice(0, -1);
        config[currentSection] = {};
        currentSub = null;
      } else if (indent === 2 && trimmed.endsWith(':')) {
        currentSub = trimmed.slice(0, -1);
        if (currentSection) config[currentSection][currentSub] = {};
      } else if (trimmed.includes(':')) {
        const [key, ...rest] = trimmed.split(':');
        let val = rest.join(':').trim().replace(/^["']|["']$/g, '');
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (/^\d+$/.test(val)) val = parseInt(val);
        if (currentSection && currentSub) {
          config[currentSection][currentSub][key.trim()] = val;
        } else if (currentSection) {
          config[currentSection][key.trim()] = val;
        }
      }
    }
    return config;
  } catch (e) {
    console.log('設定ファイル読み込みエラー、デフォルト値を使用:', e.message);
    return {
      collection: {
        gmail: { lookback_days: 14, fetch_body: true, body_max_chars: 1000, max_messages: 50 },
        calendar: { past_days: 7, future_days: 7, fetch_description: true },
        notion: { fetch_blocks: true, max_blocks_per_page: 50, recent_pages_limit: 30 },
      },
      analysis: { model: 'claude-sonnet-4-20250514', max_tokens_per_stage: 8000, max_tokens_final: 12000, fact_check: true },
      output: { slack_chunk_size: 3900, timezone_offset_hours: 9 },
    };
  }
}

// --- HTTP ---
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

// ================================================================
// Stage 0: データ収集
// ================================================================

// --- Google Access Token ---
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

// --- Gmail: 全メール取得（ページネーション対応） ---
async function collectGmail(accessToken, config) {
  const cfg = config.collection.gmail;
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  // プロフィール確認
  const profileRes = await httpRequest('https://www.googleapis.com/gmail/v1/users/me/profile', auth);
  if (profileRes.status !== 200) {
    console.error('❌ Gmail API アクセス失敗:', JSON.stringify(profileRes.data));
    return { inbox: [], sent: [], allThreads: [], myEmail: '' };
  }
  const myEmail = profileRes.data.emailAddress;
  console.log(`✅ Gmail: ${myEmail} に接続 (${profileRes.data.messagesTotal}件のメール)`);

  // メール詳細取得（本文付き）
  async function getFullMessage(msgId) {
    const detail = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, auth
    );
    if (detail.status !== 200) return null;

    const headers = detail.data.payload?.headers || [];
    const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

    // 本文抽出（再帰的にパーツを探索）
    let bodyText = '';
    function extractText(part) {
      if (!part) return;
      if (part.mimeType === 'text/plain' && part.body?.data) {
        bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    extractText(detail.data.payload);

    // 本文がなければsnippetを使用
    if (!bodyText.trim()) bodyText = detail.data.snippet || '';

    return {
      id: msgId,
      threadId: detail.data.threadId,
      subject: getH('Subject') || '(件名なし)',
      from: getH('From'),
      to: getH('To'),
      cc: getH('Cc'),
      date: getH('Date'),
      body: cfg.fetch_body ? truncate(bodyText.replace(/[\r\n]{3,}/g, '\n\n').trim(), cfg.body_max_chars) : '',
      labels: detail.data.labelIds || [],
    };
  }

  // ページネーション付きメッセージ一覧取得
  async function listMessages(query, maxTotal) {
    const allMsgs = [];
    let pageToken = null;
    while (allMsgs.length < maxTotal) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(50, maxTotal - allMsgs.length)),
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await httpRequest(
        `https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, auth
      );
      if (res.status !== 200 || !res.data.messages) break;
      allMsgs.push(...res.data.messages);
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }
    return allMsgs.slice(0, maxTotal);
  }

  const days = cfg.lookback_days;

  // 受信メール（未読 + 最近の重要メール）
  console.log('  Gmail: 受信メール取得中...');
  const inboxMsgIds = await listMessages(`in:inbox newer_than:${days}d`, cfg.max_messages);
  const inboxEmails = [];
  for (const msg of inboxMsgIds) {
    const detail = await getFullMessage(msg.id);
    if (detail) inboxEmails.push(detail);
  }
  console.log(`  ✅ 受信: ${inboxEmails.length}件`);

  // 送信メール
  console.log('  Gmail: 送信メール取得中...');
  const sentMsgIds = await listMessages(`in:sent newer_than:${days}d`, cfg.max_messages);
  const sentEmails = [];
  for (const msg of sentMsgIds) {
    const detail = await getFullMessage(msg.id);
    if (detail) sentEmails.push(detail);
  }
  console.log(`  ✅ 送信: ${sentEmails.length}件`);

  // スレッド分析（未返信検出）
  console.log('  Gmail: スレッド分析中...');
  const threadMap = new Map();
  for (const email of [...sentEmails]) {
    if (!threadMap.has(email.threadId)) {
      const threadRes = await httpRequest(
        `https://www.googleapis.com/gmail/v1/users/me/threads/${email.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        auth
      );
      if (threadRes.status === 200) {
        const msgs = threadRes.data.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        const lastFrom = (lastMsg?.payload?.headers || []).find(h => h.name === 'From')?.value || '';
        threadMap.set(email.threadId, {
          messageCount: msgs.length,
          lastFrom,
          isAwaitingReply: msgs.length === 1 || lastFrom.includes(myEmail),
          subject: email.subject,
          to: email.to,
          date: email.date,
        });
      }
    }
  }

  const awaitingReply = [];
  for (const [threadId, info] of threadMap) {
    if (info.isAwaitingReply) {
      awaitingReply.push({ threadId, ...info });
    }
  }
  console.log(`  ✅ 返信待ち: ${awaitingReply.length}件`);

  return { inbox: inboxEmails, sent: sentEmails, awaitingReply, myEmail };
}

// --- Google Calendar: 全イベント取得 ---
async function collectCalendar(accessToken, config) {
  const cfg = config.collection.calendar;
  const now = new Date();

  const start = new Date(now);
  start.setDate(start.getDate() - cfg.past_days);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setDate(end.getDate() + cfg.future_days);
  end.setHours(23, 59, 59, 999);

  // ページネーション対応
  const allEvents = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await httpRequest(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.status !== 200) {
      console.error('Calendar API エラー:', res.data);
      break;
    }

    const events = (res.data.items || []).map(e => ({
      title: e.summary || '(無題)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || '',
      description: cfg.fetch_description ? truncate(e.description, 500) : '',
      attendees: (e.attendees || [])
        .filter(a => !a.resource)
        .map(a => ({ name: a.displayName || '', email: a.email, response: a.responseStatus })),
      organizer: e.organizer?.displayName || e.organizer?.email || '',
      meetLink: e.hangoutLink || '',
      status: e.status || '',
    }));

    allEvents.push(...events);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`✅ Calendar: ${allEvents.length}件のイベントを取得`);
  return allEvents;
}

// --- Notion: 全データ取得（ブロック内容含む） ---
async function collectNotion(config) {
  const cfg = config.collection.notion;
  const headers = {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };

  // 全データベース検索
  const databases = [];
  let hasMore = true;
  let startCursor = undefined;
  while (hasMore) {
    const body = { filter: { property: 'object', value: 'database' }, page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const res = await httpRequest('https://api.notion.com/v1/search', { method: 'POST', headers }, JSON.stringify(body));
    if (res.status !== 200) break;
    databases.push(...(res.data.results || []));
    hasMore = res.data.has_more;
    startCursor = res.data.next_cursor;
  }
  console.log(`✅ Notion: ${databases.length}個のDBを発見`);

  // 各DBのレコードを全件取得
  const allRecords = [];
  for (const db of databases) {
    const dbTitle = db.title?.map(t => t.plain_text).join('') || '(無名DB)';
    let dbHasMore = true;
    let dbCursor = undefined;
    const dbRecords = [];

    while (dbHasMore) {
      const body = {
        page_size: 100,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      };
      if (dbCursor) body.start_cursor = dbCursor;

      const res = await httpRequest(
        `https://api.notion.com/v1/databases/${db.id}/query`,
        { method: 'POST', headers },
        JSON.stringify(body)
      );
      if (res.status !== 200) break;

      for (const p of (res.data.results || [])) {
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
          else if (val.type === 'people') props[key] = val.people?.map(p => p.name || '').join(', ') || '';
          else if (val.type === 'url') props[key] = val.url || '';
          else if (val.type === 'email') props[key] = val.email || '';
          else if (val.type === 'relation') props[key] = `(${val.relation?.length || 0}件)`;
          else if (val.type === 'formula') props[key] = val.formula?.string || val.formula?.number || '';
          else if (val.type === 'rollup') props[key] = val.rollup?.number || val.rollup?.array?.length || '';
        }
        dbRecords.push({ database: dbTitle, id: p.id, lastEdited: p.last_edited_time, properties: props });
      }

      dbHasMore = res.data.has_more;
      dbCursor = res.data.next_cursor;
    }

    allRecords.push(...dbRecords);
    if (dbRecords.length > 0) console.log(`  - DB「${dbTitle}」: ${dbRecords.length}件`);
  }

  // 最近編集されたページのブロック内容を取得
  if (cfg.fetch_blocks) {
    const recentPages = allRecords
      .sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited))
      .slice(0, cfg.recent_pages_limit);

    console.log(`  Notion: 最近の${recentPages.length}ページのブロック取得中...`);
    for (const page of recentPages) {
      try {
        const blockRes = await httpRequest(
          `https://api.notion.com/v1/blocks/${page.id}/children?page_size=${cfg.max_blocks_per_page}`,
          { method: 'GET', headers }
        );
        if (blockRes.status === 200) {
          const blocks = (blockRes.data.results || []).map(b => {
            const type = b.type;
            const content = b[type];
            if (!content) return null;
            if (content.rich_text) return content.rich_text.map(t => t.plain_text).join('');
            if (content.title) return content.title.map(t => t.plain_text).join('');
            return null;
          }).filter(Boolean);
          page.blockContent = blocks.join('\n');
        }
      } catch (e) {
        // ブロック取得失敗は無視して続行
      }
    }
  }

  // スタンドアロンページも検索
  const pageSearch = await httpRequest('https://api.notion.com/v1/search', {
    method: 'POST', headers,
  }, JSON.stringify({
    filter: { property: 'object', value: 'page' },
    page_size: 50,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  }));
  const standalonePages = (pageSearch.status === 200 ? pageSearch.data.results : []).map(p => {
    const title = Object.values(p.properties || {}).find(v => v.type === 'title');
    return { title: title?.title?.map(t => t.plain_text).join('') || '(無題)', lastEdited: p.last_edited_time };
  });

  console.log(`✅ Notion: 合計${allRecords.length}件のレコード, ${standalonePages.length}件のページ`);
  return {
    databases: databases.map(d => d.title?.map(t => t.plain_text).join('') || ''),
    records: allRecords,
    recentPages: standalonePages,
  };
}

// ================================================================
// Stage 1-5: Claude API 分析
// ================================================================

async function callClaude(systemPrompt, userContent, config, maxTokens) {
  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  }, JSON.stringify({
    model: config.analysis.model,
    max_tokens: maxTokens || config.analysis.max_tokens_per_stage,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  }));

  if (res.status !== 200) {
    console.error('Claude API エラー:', JSON.stringify(res.data).substring(0, 500));
    throw new Error('Claude API エラー (status ' + res.status + ')');
  }

  return res.data.content?.map(c => c.text).join('') || '';
}

// データをチャンク分割してClaudeに渡す（コンテキスト上限対策）
function chunkData(data, maxChars) {
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (str.length <= maxChars) return [str];

  const chunks = [];
  let remaining = str;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    // JSONの場合、オブジェクト境界で分割を試みる
    let splitAt = remaining.lastIndexOf('\n  },', maxChars);
    if (splitAt === -1 || splitAt < maxChars * 0.5) splitAt = maxChars;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}

async function analyzeGmail(gmailData, config) {
  console.log('\n=== Stage 1: Gmail分析 ===');
  const now = new Date();
  const jstNow = new Date(now.getTime() + config.output.timezone_offset_hours * 3600000);

  const system = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
Gmailデータを分析し、正確なJSON形式で結果を返してください。
データにない情報を推測で補わないでください。`;

  const userData = `今日: ${jstNow.toISOString().split('T')[0]}
自分のメールアドレス: ${gmailData.myEmail}

【受信メール（${gmailData.inbox.length}件）】
${JSON.stringify(gmailData.inbox, null, 2)}

【送信メール（${gmailData.sent.length}件）】
${JSON.stringify(gmailData.sent, null, 2)}

【返信待ちスレッド（${gmailData.awaitingReply.length}件）】
${JSON.stringify(gmailData.awaitingReply, null, 2)}

以下を分析してください：
1. 未読で返信が必要な重要メール（差出人・件名・本文要約・推奨アクション）
2. 送信したが返信がないメール（相手・件名・送信日・緊急度）
3. 二通目を送るべきメール
4. 重要な進行中のやりとり
5. メール本文中の期限・締切への言及

分析結果を構造化された日本語テキストで返してください。`;

  // データが大きい場合は分割
  const dataSize = userData.length;
  if (dataSize > 150000) {
    console.log(`  データサイズ: ${dataSize}文字 → 分割分析`);
    // 受信と送信を分けて分析
    const inboxAnalysis = await callClaude(system,
      `受信メール分析:\n${JSON.stringify(gmailData.inbox, null, 2)}\n\n未読で重要なメール、返信が必要なものを特定してください。`, config);
    const sentAnalysis = await callClaude(system,
      `送信メール・返信待ち分析:\n送信: ${JSON.stringify(gmailData.sent, null, 2)}\n返信待ち: ${JSON.stringify(gmailData.awaitingReply, null, 2)}\n\nフォローアップが必要なメールを特定してください。`, config);
    return `【受信メール分析】\n${inboxAnalysis}\n\n【送信メール分析】\n${sentAnalysis}`;
  }

  return await callClaude(system, userData, config);
}

async function analyzeCalendar(calendarEvents, config) {
  console.log('\n=== Stage 2: Calendar分析 ===');
  const now = new Date();
  const jstNow = new Date(now.getTime() + config.output.timezone_offset_hours * 3600000);

  const system = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
カレンダーデータを分析してください。正確な日時と参加者名を必ず含めてください。`;

  const userData = `今日: ${jstNow.toISOString().split('T')[0]}（日曜日）

【全イベント（${calendarEvents.length}件）】
${JSON.stringify(calendarEvents, null, 2)}

以下を分析してください：
1. 今週実施した商談・会議の振り返り（相手先・内容・結果の推測）
2. 来週の全予定（日別・時間順で整理、各予定の準備事項）
3. スケジュールの重複・問題点（移動時間、連続会議の負荷）
4. 特に準備が必要な重要予定（初回商談、大手企業、プレゼン等）
5. 来週の空き時間（作業に使える時間帯）

日本時間で出力してください。`;

  return await callClaude(system, userData, config);
}

async function analyzeNotion(notionData, config) {
  console.log('\n=== Stage 3: Notion分析 ===');

  if (notionData.records.length === 0 && notionData.recentPages.length === 0) {
    console.log('  Notion: データなし（インテグレーション未接続の可能性）');
    return 'Notionデータ: 取得できたデータがありません。Notionのインテグレーション接続を確認してください。';
  }

  const system = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
Notionデータを分析してください。`;

  const userData = `【データベース一覧】
${JSON.stringify(notionData.databases)}

【レコード（${notionData.records.length}件）】
${JSON.stringify(notionData.records, null, 2)}

【最近のページ（${notionData.recentPages.length}件）】
${JSON.stringify(notionData.recentPages, null, 2)}

以下を分析してください：
1. 未完了タスク（期限順、担当者付き）
2. 商談パイプライン（各商談のステータスと次アクション）
3. 最近活発に編集されているドキュメント
4. 長期間更新がない放置アイテム
5. 開発関連タスクの進捗と見落としリスク`;

  return await callClaude(system, userData, config);
}

async function synthesizeReview(gmailAnalysis, calendarAnalysis, notionAnalysis, config) {
  console.log('\n=== Stage 4: 統合レビュー生成 ===');

  const system = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
各データソースの分析結果を統合し、包括的な週次レビューを作成してください。

ルール：
- 具体的な人名・会社名・日時を必ず含める。「○○様」「△△社」のような伏字は絶対に禁止。
- データにない情報を推測で補わない。推測が必要な場合は明示する。
- 営業フォローアップの見落としを積極的にリマインド。
- 開発の見落としリスクがあれば指摘。
- Slack記法（*太字*、•箇条書き）を使用。`;

  const userData = `【Gmail分析結果】
${gmailAnalysis}

【Calendar分析結果】
${calendarAnalysis}

【Notion分析結果】
${notionAnalysis}

上記を統合して、以下の形式で週次レビューを作成してください：

*📋 今週の振り返り*
• 実施した商談・会議を相手先名と内容付きで列挙
• 成果・進展

*📌 来週のアクションアイテム（日別・優先度順）*
• 月曜日: ...
• 火曜日: ...
（各日の予定と準備事項を具体的に）

*📧 メール対応（重要度順）*
• 未読で返信必要なメール
• 送信済み未返信（フォローアップ推奨日付き）

*📊 商談パイプライン*
• 各商談の現在ステータスと次アクション

*🔧 開発・プロダクト*
• 進捗と見落としリスク

*⚠️ リスク・注意事項*
• スケジュール重複、期限切れ、放置案件

*💡 提案*
• 改善ポイント、効率化の提案`;

  return await callClaude(system, userData, config, config.analysis.max_tokens_final);
}

async function factCheck(review, rawDataSummary, config) {
  console.log('\n=== Stage 5: 事実確認 ===');

  const system = `あなたはファクトチェッカーです。以下の週次レビューに含まれる情報が、元データと一致しているか確認してください。

チェック項目：
1. 人名・会社名が元データに存在するか
2. 日時が正確か
3. 元データにない情報が含まれていないか
4. 推測が事実として記述されていないか

問題がある箇所があれば修正した完全版を出力してください。
問題がなければ元のレビューをそのまま出力してください。`;

  const userData = `【レビュー】
${review}

【元データサマリー（照合用）】
${rawDataSummary}`;

  return await callClaude(system, userData, config, config.analysis.max_tokens_final);
}

// ================================================================
// Stage 6: Slack投稿
// ================================================================

async function postToSlack(message, config) {
  const MAX = config.output.slack_chunk_size;
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
    if (i < chunks.length - 1) await sleep(1000); // レート制限対策
  }

  console.log(`✅ Slack投稿完了 (${chunks.length}メッセージ)`);
}

// ================================================================
// メイン
// ================================================================

async function main() {
  const startTime = Date.now();
  console.log('=== 週次レビュー v3（マルチステージ）開始 ===');
  console.log('実行時刻:', new Date().toISOString());

  // 環境変数チェック
  const required = ['ANTHROPIC_API_KEY', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error('環境変数が未設定: ' + missing.join(', '));

  const config = loadConfig();
  console.log('設定:', JSON.stringify(config.collection, null, 2));

  // --- Stage 0: データ収集 ---
  console.log('\n=== Stage 0: データ収集 ===');
  const googleToken = await getGoogleAccessToken();

  const [calendarEvents, gmailData, notionData] = await Promise.all([
    collectCalendar(googleToken, config),
    collectGmail(googleToken, config),
    collectNotion(config),
  ]);

  console.log('\n--- データ収集サマリー ---');
  console.log(`Calendar: ${calendarEvents.length}件`);
  console.log(`Gmail: 受信${gmailData.inbox.length}件, 送信${gmailData.sent.length}件, 返信待ち${gmailData.awaitingReply.length}件`);
  console.log(`Notion: DB${notionData.databases.length}個, レコード${notionData.records.length}件, ページ${notionData.recentPages.length}件`);

  // --- Stage 1-3: 個別分析 ---
  const [gmailAnalysis, calendarAnalysis, notionAnalysis] = await Promise.all([
    analyzeGmail(gmailData, config),
    analyzeCalendar(calendarEvents, config),
    analyzeNotion(notionData, config),
  ]);

  console.log('\n各分析完了');

  // --- Stage 4: 統合レビュー ---
  let review = await synthesizeReview(gmailAnalysis, calendarAnalysis, notionAnalysis, config);

  // --- Stage 5: 事実確認 ---
  if (config.analysis.fact_check) {
    // 照合用に元データのサマリーを作成
    const rawSummary = [
      `Calendar件名一覧: ${calendarEvents.map(e => `${e.start} ${e.title}`).join(', ')}`,
      `Gmail受信件名: ${gmailData.inbox.slice(0, 30).map(e => `${e.from}: ${e.subject}`).join(', ')}`,
      `Gmail送信件名: ${gmailData.sent.slice(0, 30).map(e => `→${e.to}: ${e.subject}`).join(', ')}`,
      `Notion DB: ${notionData.databases.join(', ')}`,
    ].join('\n');

    review = await factCheck(review, rawSummary, config);
  }

  // --- Stage 6: Slack投稿 ---
  await postToSlack(review, config);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== 週次レビュー完了（${elapsed}秒） ===`);
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
