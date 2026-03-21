const querystring = require('querystring');
const { httpRequest } = require('../utils');

async function getGoogleAccessToken() {
  const body = querystring.stringify({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);
  if (res.data.access_token) return res.data.access_token;
  throw new Error('Google Token失敗: ' + JSON.stringify(res.data));
}

module.exports = { getGoogleAccessToken };
