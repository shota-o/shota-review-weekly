const { callClaude } = require('../claude');

const ROUTER_SYSTEM = `あなたはデータソースルーターです。ユーザーの質問を分析し、回答に必要なデータソースと時間範囲をJSON形式で返してください。

利用可能なデータソース:
- gmail: メールの内容、やり取り、返信待ち
- calendar: 予定、会議、商談スケジュール
- notion: タスク、商談管理DB、プロジェクト
- slack: チーム内のコミュニケーション、議論
- attio: CRMデータ（会社情報、人脈、商談パイプライン、通話記録ノート）

必ず以下のJSON形式のみを返してください（説明文不要）:
{
  "sources": ["gmail", "calendar"],
  "timeRange": "7d",
  "focus": "sales",
  "searchTerms": []
}

timeRange: "1d", "3d", "7d", "14d", "30d", "90d" のいずれか。
focus: "sales"（営業）, "tasks"（タスク）, "schedule"（予定）, "communication"（コミュニケーション）, "general"（一般）のいずれか。
searchTerms: 質問中に出てきた会社名・人名・キーワード（あれば）。

判断例:
- "来週の予定" → sources: ["calendar"], timeRange: "7d", focus: "schedule"
- "営業戦略を考えて" → sources: ["notion", "attio", "gmail", "calendar"], timeRange: "90d", focus: "sales"
- "Slackで何か見落としてる？" → sources: ["slack"], timeRange: "3d", focus: "communication"
- "タスクの進捗は？" → sources: ["notion"], timeRange: "14d", focus: "tasks"
- "〇〇社との状況は？" → sources: ["gmail", "attio", "notion", "calendar"], timeRange: "30d", focus: "sales", searchTerms: ["〇〇社"]`;

async function routeQuestion(question) {
  const response = await callClaude(ROUTER_SYSTEM, question, 500);

  try {
    // JSONブロックを抽出（```json ... ``` または直接JSON）
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON not found');
    const parsed = JSON.parse(jsonMatch[0]);

    // バリデーション
    const validSources = ['gmail', 'calendar', 'notion', 'slack', 'attio'];
    parsed.sources = (parsed.sources || []).filter(s => validSources.includes(s));
    if (parsed.sources.length === 0) parsed.sources = ['gmail', 'calendar', 'notion'];

    const validRanges = ['1d', '3d', '7d', '14d', '30d', '90d'];
    if (!validRanges.includes(parsed.timeRange)) parsed.timeRange = '7d';

    parsed.focus = parsed.focus || 'general';
    parsed.searchTerms = parsed.searchTerms || [];

    return parsed;
  } catch (e) {
    console.error('  ルーティングJSON解析失敗、デフォルト使用:', e.message);
    return {
      sources: ['gmail', 'calendar', 'notion', 'attio'],
      timeRange: '7d',
      focus: 'general',
      searchTerms: [],
    };
  }
}

module.exports = { routeQuestion };
