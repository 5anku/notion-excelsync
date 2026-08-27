const { google } = require('googleapis');

const HEADER = [
  'Video Title', 'Shoot Date', 'Status', 'Approved and Completely Delivered',
  'Posted Date', 'Editor', 'Re-edit Count', 'Notes', 'Notion Page ID',
];

function normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[\u2060\ufeff]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function getAuthedSheets() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/** Sheet/tab names can't exceed 100 chars and can't contain: : \ / ? * [ ] */
function safeTabName(name) {
  return name.replace(/[:\\/?*\[\]]/g, '-').slice(0, 100) || 'Unnamed Client';
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;

  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  const newSheetId = resp.data.replies[0].addSheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });

  return newSheetId;
}

async function getExistingTitles(sheets, spreadsheetId, tabName) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A2:A`,
  });
  const rows = resp.data.values || [];
  return new Set(rows.map(r => normTitle(r[0])));
}

async function appendRows(sheets, spreadsheetId, tabName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * Pushes new videos (grouped by client) into per-client tabs.
 * Returns a summary of what was written, per client.
 */
async function syncVideosToSheet(spreadsheetId, videosByClient) {
  const sheets = await getAuthedSheets();
  const summary = [];

  for (const [clientName, videos] of Object.entries(videosByClient)) {
    const tabName = safeTabName(clientName);
    await ensureTab(sheets, spreadsheetId, tabName);
    const existingTitles = await getExistingTitles(sheets, spreadsheetId, tabName);

    const newVideos = videos.filter(v => !existingTitles.has(normTitle(v.title)));
    const rows = newVideos.map(v => ([
      v.title,
      v.shootDate || '',
      v.status || '',
      v.status === 'Done' ? 'Yes' : 'No',
      v.postedDate || '',
      v.editor || '',
      v.reeditCount || '',
      v.notes || '',
      v.pageId,
    ]));

    await appendRows(sheets, spreadsheetId, tabName, rows);
    summary.push({ client: clientName, tab: tabName, added: rows.length, skipped: videos.length - rows.length });
  }

  return summary;
}

module.exports = { syncVideosToSheet };
