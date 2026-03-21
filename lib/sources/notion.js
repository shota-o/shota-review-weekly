const { httpRequest, estimateTokens } = require('../utils');
const { TOKEN_LIMIT } = require('../claude');

async function collectNotion() {
  const h = {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
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

  let final = recs;
  if (estimateTokens(recs) > TOKEN_LIMIT) {
    final = recs.filter(r => r.lastEdited >= fourteenAgo);
    console.log(`  ⚠️ 14日に絞り込み: ${final.length}件`);
  }

  console.log(`✅ Notion: ${final.length}件`);
  return { databases: masterDbs.map(d => d.title?.map(x => x.plain_text).join('') || ''), records: final };
}

module.exports = { collectNotion };
