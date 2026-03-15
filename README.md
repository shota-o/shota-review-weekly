# shota-weekly-review v3

毎週日曜 朝9時（JST）に自動実行される週次レビューBot（マルチステージ版）。

## アーキテクチャ

```
Stage 0: データ収集（全件・本文含む）
  ├── Gmail API（受信・送信・スレッド分析）
  ├── Google Calendar API（全イベント・参加者・説明）
  └── Notion API（全DB・全レコード・ブロック内容）
      ↓
Stage 1: Gmail分析      ← Claude API
Stage 2: Calendar分析   ← Claude API
Stage 3: Notion分析     ← Claude API
      ↓
Stage 4: 統合レビュー生成 ← Claude API
      ↓
Stage 5: 事実確認（ハルシネーション除去）← Claude API
      ↓
Stage 6: Slack投稿
```

## ファイル構成

```
├── .github/workflows/weekly-review.yml  # 定期実行設定
├── config/
│   ├── review-config.yaml               # 収集・分析の設定
│   └── prompts.md                       # プロンプト定義（参考）
├── scripts/
│   └── run-weekly-review.js             # メインスクリプト
└── package.json
```

## カスタマイズ

`config/review-config.yaml` を編集することで：
- メール取得件数・本文文字数の調整
- カレンダーの参照期間変更
- Notionのブロック取得ON/OFF
- 事実確認パスのON/OFF
- Claudeモデルの変更
