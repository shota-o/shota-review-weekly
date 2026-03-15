# shota-weekly

毎週日曜 朝9時（JST）に自動実行される週次レビューBot。

## データソース
- **Google Calendar**: 今週・来週の予定
- **Gmail**: 送信メール・未返信チェック
- **Notion**: タスク・商談DB

## 処理フロー
1. 各APIからデータ収集
2. Anthropic API（Claude）でサマリー生成
3. Slackに投稿

## 必要なGitHub Secrets
| Secret | 説明 |
|--------|------|
| ANTHROPIC_API_KEY | Anthropic APIキー |
| NOTION_TOKEN | Notion APIトークン |
| SLACK_BOT_TOKEN | Slack Bot Token (xoxb-...) |
| SLACK_CHANNEL_ID | 投稿先チャンネルID |
| GOOGLE_CLIENT_ID | Google OAuth Client ID |
| GOOGLE_CLIENT_SECRET | Google OAuth Client Secret |
| GOOGLE_REFRESH_TOKEN | Google OAuth Refresh Token |

## 手動実行
GitHub Actions → 「週次レビュー自動実行」→ 「Run workflow」
