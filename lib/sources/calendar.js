const { httpRequest, truncate } = require('../utils');
const { isInterviewRelated } = require('../filters');

async function collectCalendar(accessToken) {
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 999);

  const all = [];
  let pt = null;
  do {
    const p = new URLSearchParams({
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    if (pt) p.set('pageToken', pt);
    const r = await httpRequest(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status !== 200) break;

    all.push(...(r.data.items || [])
      .filter(e => !isInterviewRelated(e.summary) && !isInterviewRelated(e.description))
      .map(e => ({
        title: e.summary || '(無題)',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        location: e.location || '',
        description: truncate(e.description, 200),
        attendees: (e.attendees || []).filter(a => !a.resource)
          .map(a => a.displayName || a.email).join(', '),
        organizer: e.organizer?.displayName || e.organizer?.email || '',
      })));
    pt = r.data.nextPageToken;
  } while (pt);

  console.log(`✅ Calendar: ${all.length}件`);
  return all;
}

module.exports = { collectCalendar };
