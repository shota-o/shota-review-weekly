const https = require('https');

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

function truncate(s, n) { return !s ? '' : s.length > n ? s.substring(0, n) + '...' : s; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function estimateTokens(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return Math.ceil(s.length / 3);
}
function jstNow() { return new Date(Date.now() + 9 * 3600000); }

function sanitizeText(text) {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/(?<!\`)\*\*(.+?)\*\*(?!\`)/g, '$1')
    .replace(/(?<!\`)(?<!\w)\*([^*\n]+?)\*(?!\`)(?!\w)/g, '$1');
}

module.exports = { httpRequest, truncate, sleep, estimateTokens, jstNow, sanitizeText };
