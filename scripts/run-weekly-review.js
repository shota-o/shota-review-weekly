// ============================================================
// 週次レビュー自動化スクリプト
// Notion + Gmail + Google Calendar → Anthropic API → Slack
// ============================================================

const https = require('https');
const querystring = require('querystring');

// --- 環境変数 ---
const {
  ANTHROPIC_API_KEY,
  NOTION_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
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
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// --- Google: Access Token取得 ---
async function getGoogleAccessToken() {
  const body = querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);
  if (res.data.access_token) {
    console.log('✅ Google Access Token 取得成功');
    return res.data.access_token;
  }
  throw new Error('Google Token取得失敗: ' + JSON.stringify(res.data));
}

// --- Google Calendar: 今週・来週の予定取得 ---
async function getCalendarEvents(accessToken) {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1); // 月曜
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfNextWeek = new Date(startOfWeek);
  endOfNextWeek.setDate(startOfWeek.getDate() + 13); // 来週日曜まで
  endOfNextWeek.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: startOfWeek.toISOString(),
    timeMax: endOfNextWeek.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const res = await httpRequest(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (res.status !== 200) {
    console.error('Calendar API エラー:', res.data);
    return [];
  }

  const events = (res.data.items || []).map((e) => ({
    title: e.summary || '(無題)',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    attendees: (e.attendees || []).map((a) => a.email).join(', '),
  }));

  console.log(`✅ Calendar: ${events.length}件の予定を取得`);
  return events;
}

// --- Gmail: 受信・送信・未返信を総合的にチェック ---
async function getGmailData(accessToken) {
  // 日付をYYYY/MM/DD形式にする（Gmail検索で確実に動く形式）
  const d = new Date(Date.now() - 14 * 86400 * 1000);
  const twoWeeksAgo = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  console.log('Gmail検索期間: after:' + twoWeeksAgo);

  // まずGmail APIの疎通テスト
  const profileRes = await httpRequest(
    'https://www.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  console.log('Gmail profile:', JSON.stringify(profileRes.data));
  if (profileRes.status !== 200) {
    console.error('❌ Gmail API アクセス失敗 (status ' + profileRes.status + '):', JSON.stringify(profileRes.data));
    return { inbox: [], sent: [], unreplied: [] };
  }
  console.log(`✅ Gmail: ${profileRes.data.emailAddress} に接続`);

  // --- 受信メール（未読・要対応）---
  const inboxQuery = `in:inbox is:unread newer_than:14d`;
  console.log('Gmail受信クエリ:', inboxQuery);
  const inboxRes = await httpRequest(
    `https://www.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: inboxQuery, maxResults: '20' })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  console.log('Gmail受信レスポンス status:', inboxRes.status, 'resultSizeEstimate:', inboxRes.data.resultSizeEstimate);

  const inboxEmails = [];
  if (inboxRes.status === 200 && inboxRes.data.messages) {
    for (const msg of inboxRes.data.messages.slice(0, 10)) {
      const detail = await httpRequest(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (detail.status === 200) {
        const headers = detail.data.payload?.headers || [];
        inboxEmails.push({
          subject: headers.find((h) => h.name === 'Subject')?.value || '(件名なし)',
          from: headers.find((h) => h.name === 'From')?.value || '',
          date: headers.find((h) => h.name === 'Date')?.value || '',
        });
      }
    }
  }
  console.log(`✅ Gmail受信（未読）: ${inboxEmails.length}件`);

  // --- 送信メール ---
  const sentQuery = `in:sent newer_than:14d`;
  console.log('Gmail送信クエリ:', sentQuery);
  const sentRes = await httpRequest(
    `https://www.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: sentQuery, maxResults: '20' })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  console.log('Gmail送信レスポンス status:', sentRes.status, 'resultSizeEstimate:', sentRes.data.resultSizeEstimate);

  const sentEmails = [];
  if (sentRes.status === 200 && sentRes.data.messages) {
    for (const msg of sentRes.data.messages.slice(0, 10)) {
      const detail = await httpRequest(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (detail.status === 200) {
        const headers = detail.data.payload?.headers || [];
        sentEmails.push({
          subject: headers.find((h) => h.name === 'Subject')?.value || '(件名なし)',
          to: headers.find((h) => h.name === 'To')?.value || '',
          date: headers.find((h) => h.name === 'Date')?.value || '',
          threadId: detail.data.threadId,
        });
      }
    }
  }
  console.log(`✅ Gmail送信: ${sentEmails.length}件`);

  // --- 未返信チェック（送ったが返信なし）---
  const unreplied = [];
  for (const email of sentEmails) {
    const threadRes = await httpRequest(
      `https://www.googleapis.com/gmail/v1/users/me/threads/${email.threadId}?format=metadata&metadataHeaders=From`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (threadRes.status === 200) {
      const messages = threadRes.data.messages || [];
      // スレッドに1通しかない = 自分が送っただけで返信なし
      if (messages.length === 1) {
        unreplied.push(email);
      }
    }
  }
  console.log(`✅ Gmail未返信候補: ${unreplied.length}件`);

  return { inbox: inboxEmails, sent: sentEmails, unreplied };
}

// --- Notion: データベースから取得 ---
async function getNotionData() {
  // Notionの全データベースを検索
  const searchRes = await httpRequest('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
  }, JSON.stringify({
    filter: { property: 'object', value: 'database' },
    page_size: 20,
  }));

  if (searchRes.status !== 200) {
    console.error('Notion検索エラー:', searchRes.data);
    return { databases: [], pages: [] };
  }

  const databases = searchRes.data.results || [];
  console.log(`✅ Notion: ${databases.length}個のDBを発見`);

  const allPages = [];

  for (const db of databases) {
    const dbTitle = db.title?.map((t) => t.plain_text).join('') || '(無名DB)';
    const queryRes = await httpRequest(`https://api.notion.com/v1/databases/${db.id}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
    }, JSON.stringify({ page_size: 30 }));

    if (queryRes.status === 200) {
      const pages = (queryRes.data.results || []).map((p) => {
        const props = {};
        for (const [key, val] of Object.entries(p.properties || {})) {
          if (val.type === 'title') {
            props[key] = val.title?.map((t) => t.plain_text).join('') || '';
          } else if (val.type === 'select') {
            props[key] = val.select?.name || '';
          } else if (val.type === 'status') {
            props[key] = val.status?.name || '';
          } else if (val.type === 'date') {
            props[key] = val.date?.start || '';
          } else if (val.type === 'rich_text') {
            props[key] = val.rich_text?.map((t) => t.plain_text).join('') || '';
          } else if (val.type === 'number') {
            props[key] = val.number;
          } else if (val.type === 'checkbox') {
            props[key] = val.checkbox;
          } else if (val.type === 'multi_select') {
            props[key] = val.multi_select?.map((s) => s.name).join(', ') || '';
          }
        }
        return { database: dbTitle, properties: props };
      });
      allPages.push(...pages);
    }
  }

  console.log(`✅ Notion: 合計${allPages.length}件のページを取得`);
  return { databases: databases.map((d) => d.title?.map((t) => t.plain_text).join('') || ''), pages: allPages };
}

// --- Anthropic API: サマリー生成 ---
async function generateSummary(calendarEvents, gmailData, notionData) {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = jstNow.toISOString().split('T')[0];

  const prompt = `あなたは優秀な営業アシスタントです。以下のデータを分析して、日本語で週次レビューを作成してください。

今日の日付: ${dateStr}（日曜日）

## Google Calendarの予定
${JSON.stringify(calendarEvents, null, 2)}

## Gmail（過去14日間）
未読の受信メール: ${JSON.stringify(gmailData.inbox, null, 2)}
送信メール: ${JSON.stringify(gmailData.sent, null, 2)}
送信したが返信がないメール: ${JSON.stringify(gmailData.unreplied, null, 2)}

## Notionのデータ
データベース一覧: ${JSON.stringify(notionData.databases)}
ページデータ: ${JSON.stringify(notionData.pages, null, 2)}

---

以下のフォーマットで出力してください：

📋 **今週の振り返り**
- 今週行った主な商談・会議・作業を箇条書き

📌 **来週やるべきこと（優先度順）**
- 来週のカレンダー予定と、それに向けた準備事項
- Notionのタスクから未完了のもの

📧 **フォローアップが必要なメール**
- 送ったが返信がないメール（相手名・件名・送信日）
- 二通目を送るべきメール

📬 **未読の重要メール（要対応）**
- 受信したが未読・未対応のメールで重要なもの

⚠️ **注意事項・リスク**
- 期限が近いタスク
- 長期間放置されている商談

各項目は簡潔に。絵文字を適度に使って見やすくしてください。`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  }, JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  }));

  if (res.status !== 200) {
    throw new Error('Anthropic API エラー: ' + JSON.stringify(res.data));
  }

  const text = res.data.content?.map((c) => c.text).join('') || '';
  console.log('✅ Anthropic: サマリー生成完了');
  return text;
}

// --- Slack投稿 ---
async function postToSlack(message) {
  const res = await httpRequest('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
  }, JSON.stringify({
    channel: SLACK_CHANNEL_ID,
    text: message,
    unfurl_links: false,
  }));

  if (res.data.ok) {
    console.log('✅ Slack投稿完了');
  } else {
    throw new Error('Slack投稿エラー: ' + JSON.stringify(res.data));
  }
}

// --- メイン ---
async function main() {
  console.log('=== 週次レビュー開始 ===');
  console.log('実行時刻:', new Date().toISOString());

  // 環境変数チェック
  const required = ['ANTHROPIC_API_KEY', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error('環境変数が未設定: ' + missing.join(', '));
  }

  // 1. Google Access Token取得
  const googleToken = await getGoogleAccessToken();

  // 2. データ収集（並列実行）
  const [calendarEvents, gmailData, notionData] = await Promise.all([
    getCalendarEvents(googleToken),
    getGmailData(googleToken),
    getNotionData(),
  ]);

  // 3. Anthropic APIでサマリー生成
  const summary = await generateSummary(calendarEvents, gmailData, notionData);

  // 4. Slack投稿
  await postToSlack(summary);

  console.log('=== 週次レビュー完了 ===');
}

main().catch((err) => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
