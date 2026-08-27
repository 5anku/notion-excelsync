const { fetchAllVideos } = require('./notion');
const { syncVideosToSheet } = require('./sheets');

async function runSync() {
  const databaseId = process.env.NOTION_VIDEOS_DB_ID;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!databaseId) throw new Error('Missing NOTION_VIDEOS_DB_ID env var');
  if (!spreadsheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const videos = await fetchAllVideos(databaseId);

  const byClient = {};
  for (const v of videos) {
    const key = v.clientName || 'Unassigned';
    if (!byClient[key]) byClient[key] = [];
    byClient[key].push(v);
  }

  const summary = await syncVideosToSheet(spreadsheetId, byClient);
  const totalAdded = summary.reduce((s, r) => s + r.added, 0);

  return {
    ranAt: new Date().toISOString(),
    totalVideosFetched: videos.length,
    totalNewRowsAdded: totalAdded,
    perClient: summary,
  };
}

module.exports = { runSync };
