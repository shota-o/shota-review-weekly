#!/usr/bin/env node
/**
 * Claude Code を非対話モードで起動し、週次レビューを実行する
 * GitHub Actions から呼ばれる
 */

const { execSync } = require('child_process');
const path = require('path');

const prompt = `
今日は日曜日です。CLAUDE.md の手順に従って週次レビューを実行してください。

1. Google Calendar・Gmail・Notion から今週・来週のデータを漏れなく収集
2. 優先順位を分析
3. CLAUDE.md のフォーマットで Slack に投稿

必ず最後に Slack への投稿まで完了させてください。
`.trim();

console.log('=== 週次レビュー開始 ===');
console.log('実行時刻:', new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));

try {
  execSync(
    `claude --print --no-update-notifier "${prompt.replace(/"/g, '\\"')}"`,
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        // MCP設定ファイルのパスを明示
        CLAUDE_MCP_CONFIG: path.resolve(__dirname, '../.claude/mcp.json'),
      },
      // タイムアウト: 10分
      timeout: 10 * 60 * 1000,
    }
  );
  console.log('=== 週次レビュー完了 ===');
} catch (e) {
  console.error('=== エラーが発生しました ===');
  console.error(e.message);
  process.exit(1);
}
