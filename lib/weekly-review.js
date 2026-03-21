const { callClaude, batchAnalyze, TOKEN_LIMIT } = require('./claude');
const { jstNow, estimateTokens } = require('./utils');

const SYS = `あなたは株式会社Mavericks 代表取締役 奥野翔太の専属エグゼクティブアシスタントです。
データにない推測は禁止。具体的な人名・会社名・日時をそのまま使ってください。
重要：面接・採用選考関連（Indeed、interview、面接、応募、候補者対応など）の情報はすべてスキップし、レビューに含めないこと。`;

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

まず全体のまとめを > 引用ブロックで3-5行書く。今週全体として何が進んだか、どんな1週間だったか、大きな流れや成果を俯瞰する。

そのあと、各日の詳細を書く。各日を > 引用ブロックで囲み、日と日の間に空行。
相手の反応、やりとりの中身、宿題や次のアクションにつながる情報を含めて、少し詳しく書く。
各日3-5行。何もなかった日は飛ばす。
会社名・キーワードは \`バッククォート\` で囲む。

ポイント：「何が進んだか」「相手の反応」「決まったこと」「宿題・次のアクション」`, 8000);
  sections.push(sec1);

  console.log('  セクション2: 来週のTODO（統合）');
  const sec2 = await callClaude(sys, `${input}\n\n以下を出力。「他X件」省略は絶対禁止。全件書くこと。

このセクションは、来週やるべきことを「期限」ベースでまとめたもの。
商談準備、メール対応、フォローアップ、タスク期限、スケジュール注意点、すべてを1つのリストに統合する。
別々のセクションに分けない。全部ここにまとめる。

:calendar: 来週やること（${nextWeekLabel}）

→ ○曜 M/D までに
→ ○曜 M/D までに
...
→ スケジュール注意点

のように期限の近い順に「→ ○曜 M/D までに」でグループ化し、各項目を > 引用ブロックで囲み、項目間に空行を入れる。
会社名・件名は \`バッククォート\` で囲む。
各項目は1-2行で簡潔に。背景や理由も自然に含める。

含めるべき項目（全てを1つのリストに統合すること）：
- 商談の準備（初回なら先方の背景、継続なら前回の宿題）
- 返信が来ていないメールへのフォロー（全件。相手名・件名・送信日・背景付き）
- もう一度連絡した方がいい相手（全件。理由付き）
- 重要メールへの対応（期限付きのもの）
- Notionのタスクで期限が近いもの
- その他デッドラインがあるもの
- スケジュールの重複・注意点（重複があればどちらを優先すべきかの提案）`, 8000);
  sections.push(sec2);

  console.log('  セクション3: Slack + 開発 + ひとこと');
  const sec3 = await callClaude(sys, `${input}\n\n以下を出力。

:speech_balloon: Slackから拾っておくこと

翔太が見落としていそうなもの・覚えておくべきことを幅広く拾う。
各項目を > 引用ブロックで囲み、項目間に空行。
トピック名やキーワードは \`バッククォート\` で囲む。

:wrench: 開発・タスク

Notionのタスクで気にしておくべきもの。期限が近いもの、止まっているもの。
各項目を > 引用ブロックで。

:bulb: ひとこと

全体を見て気づいたことを1-2点。気軽に。`, 8000);
  sections.push(sec3);

  console.log('  ✅ 全セクション生成完了');
  return sections.join('\n\n---\n\n');
}

module.exports = { analyzeGmail, analyzeCalendar, analyzeNotion, analyzeSlack, synthesize };
