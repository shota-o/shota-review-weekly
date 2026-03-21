const { httpRequest, truncate } = require('../utils');

const ATTIO_BASE = 'https://api.attio.com/v2';

function attioHeaders() {
  return {
    Authorization: `Bearer ${process.env.ATTIO_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function attioRequest(path, method = 'GET', body = null) {
  const url = `${ATTIO_BASE}${path}`;
  const opts = { method, headers: attioHeaders() };
  const res = await httpRequest(url, opts, body ? JSON.stringify(body) : undefined);
  if (res.status !== 200) {
    console.error(`  Attio API error (${res.status}) ${path}: ${JSON.stringify(res.data).substring(0, 200)}`);
    return null;
  }
  return res.data;
}

// レコードからプロパティ値を抽出
function extractValues(record) {
  const result = {};
  for (const [key, attr] of Object.entries(record.values || {})) {
    const vals = attr || [];
    if (vals.length === 0) continue;
    const first = vals[0];
    // 型によって値を取得
    if (first.value !== undefined) {
      result[key] = first.value;
    } else if (first.target_object) {
      result[key] = first.target_record_id;
    } else if (first.full_name) {
      result[key] = first.full_name;
    } else if (first.email_address) {
      result[key] = first.email_address;
    } else if (first.domain) {
      result[key] = first.domain;
    } else if (first.currency_value !== undefined) {
      result[key] = `${first.currency_value} ${first.currency_code || ''}`.trim();
    } else if (first.option) {
      result[key] = vals.map(v => v.option?.title || v.option).join(', ');
    } else if (first.referenced_actor_id) {
      result[key] = first.referenced_actor_id;
    } else {
      // フォールバック: 最初の値をそのまま文字列化
      const str = JSON.stringify(first);
      if (str.length < 200) result[key] = str;
    }
  }
  return result;
}

async function collectAttioRecords(objectSlug, limit = 100) {
  const records = [];
  let offset = 0;
  const pageSize = Math.min(limit, 50);

  while (records.length < limit) {
    const data = await attioRequest(`/objects/${objectSlug}/records/query`, 'POST', {
      limit: pageSize,
      offset,
      sorts: [{ attribute: 'created_at', field: 'created_at', direction: 'desc' }],
    });
    if (!data || !data.data || data.data.length === 0) break;

    for (const rec of data.data) {
      records.push({
        id: rec.id?.record_id || rec.id,
        ...extractValues(rec),
      });
    }

    offset += data.data.length;
    if (data.data.length < pageSize) break;
  }

  return records;
}

async function collectAttioNotes(limit = 50) {
  const data = await attioRequest(`/notes?limit=${limit}`);
  if (!data || !data.data) return [];

  return data.data.map(note => ({
    id: note.id,
    title: note.title || '',
    content: truncate(note.content_plaintext || '', 500),
    parentObject: note.parent_object,
    parentRecordId: note.parent_record_id,
    createdAt: note.created_at,
    author: note.author?.name || '',
  }));
}

async function collectAttioLists() {
  const data = await attioRequest('/lists');
  if (!data || !data.data) return [];

  const lists = [];
  for (const list of data.data) {
    const entries = await attioRequest(`/lists/${list.id.list_id || list.id}/entries/query`, 'POST', {
      limit: 50,
    });

    lists.push({
      id: list.id?.list_id || list.id,
      name: list.name || '',
      entryCount: entries?.data?.length || 0,
      entries: (entries?.data || []).map(e => ({
        id: e.id?.entry_id || e.id,
        ...extractValues(e),
      })),
    });
  }

  return lists;
}

async function collectAttio() {
  if (!process.env.ATTIO_API_TOKEN) {
    console.log('⚠️ ATTIO_API_TOKEN未設定、Attioスキップ');
    return null;
  }

  console.log('  Attioデータ収集中...');

  const [companies, people, deals, notes, lists] = await Promise.all([
    collectAttioRecords('companies', 100).catch(e => { console.error('  Attio companies:', e.message); return []; }),
    collectAttioRecords('people', 100).catch(e => { console.error('  Attio people:', e.message); return []; }),
    collectAttioRecords('deals', 100).catch(e => { console.error('  Attio deals:', e.message); return []; }),
    collectAttioNotes(50).catch(e => { console.error('  Attio notes:', e.message); return []; }),
    collectAttioLists().catch(e => { console.error('  Attio lists:', e.message); return []; }),
  ]);

  console.log(`✅ Attio: ${companies.length}社, ${people.length}人, ${deals.length}商談, ${notes.length}ノート, ${lists.length}リスト`);

  return { companies, people, deals, notes, lists };
}

module.exports = { collectAttio };
