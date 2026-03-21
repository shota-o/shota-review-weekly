const { httpRequest, estimateTokens } = require('./utils');

const TOKEN_LIMIT = 120000;

async function callClaude(system, user, maxTokens = 8000) {
  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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

async function batchAnalyze(system, items, instruction, label) {
  const BATCH_TOKEN_TARGET = 100000;

  const allStr = JSON.stringify(items, null, 2);
  if (estimateTokens(allStr) + estimateTokens(instruction) < TOKEN_LIMIT) {
    return await callClaude(system, `${instruction}\n\n絶対ルール：「他X件」「等」のような省略は禁止。該当する項目は全件列挙すること。\n\nデータ（${items.length}件）:\n${allStr}`);
  }

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

module.exports = { callClaude, batchAnalyze, TOKEN_LIMIT };
