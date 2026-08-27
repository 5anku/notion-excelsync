const { google } = require('googleapis');

// Matches the columns already used in the manually-maintained client tabs,
// plus a trailing Notion Page ID column so edits can be written back to Notion.
const HEADER = ['Number', 'Shot on', 'Video Title', 'Edited/Not', 'Posted on', 'Notion Page ID'];

function normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[\u2060\ufeff]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** '2026-08-27' -> '27/8' (day/month, no leading zeros) to match the existing manual date style. */
function toShortDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  if (!d) return isoDate;
  return `${Number(d)}/${Number(m)}`;
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

/**
 * Finds or creates the tab for a client. Google Sheets tab names are unique
 * case-insensitively, so this matches case-insensitively against existing
 * tabs (e.g. a Notion client name "Hala Drive" reuses the existing "HALA
 * DRIVE" tab rather than colliding when trying to create a near-duplicate).
 * Returns the tab's real, existing-cased title plus its sheetId.
 */
async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(
    s => s.properties.title.toLowerCase() === tabName.toLowerCase()
  );
  if (existing) return { sheetId: existing.properties.sheetId, tabName: existing.properties.title };

  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  const newSheetId = resp.data.replies[0].addSheet.properties.sheetId;
  return { sheetId: newSheetId, tabName };
}

/**
 * Creates the header row on a fresh tab. If a tab already has a shorter
 * header (e.g. an existing manual tab with only the first 5 columns), only
 * fills in the missing trailing columns (e.g. "Notion Page ID") without
 * touching the existing header cells.
 */
async function ensureHeader(sheets, spreadsheetId, tabName, header) {
  const lastCol = String.fromCharCode(64 + header.length);
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:${lastCol}1`,
  });
  const firstRow = (meta.data.values && meta.data.values[0]) || [];
  if (firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } else if (firstRow.length < header.length) {
    const startCol = String.fromCharCode(64 + firstRow.length + 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!${startCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header.slice(firstRow.length)] },
    });
  }
}

/** Video Title lives in column C in the shared 6-column layout. */
async function getExistingTitles(sheets, spreadsheetId, tabName) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!C2:C`,
  });
  const rows = resp.data.values || [];
  return new Set(rows.map(r => normTitle(r[0])));
}

/** How many data rows already exist, so new "Number" values can continue counting up. */
async function countExistingRows(sheets, spreadsheetId, tabName) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!C2:C`,
  });
  return (resp.data.values || []).length;
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
    const requestedName = safeTabName(clientName);
    const { tabName } = await ensureTab(sheets, spreadsheetId, requestedName);
    await ensureHeader(sheets, spreadsheetId, tabName, HEADER);

    const existingTitles = await getExistingTitles(sheets, spreadsheetId, tabName);
    let nextNumber = (await countExistingRows(sheets, spreadsheetId, tabName)) + 1;

    const newVideos = videos.filter(v => !existingTitles.has(normTitle(v.title)));
    const rows = newVideos.map(v => ([
      nextNumber++,
      toShortDate(v.shootDate),
      v.title,
      (v.status === 'Done' || v.status === 'Posted') ? 'TRUE' : 'FALSE',
      toShortDate(v.postedDate),
      v.pageId,
    ]));

    await appendRows(sheets, spreadsheetId, tabName, rows);
    summary.push({ client: clientName, tab: tabName, added: rows.length, skipped: videos.length - rows.length });
  }

  return summary;
}

const LOG_TAB = 'Sync Log';
const LOG_HEADER = ['Timestamp', 'Videos Fetched', 'Rows Added', 'Clients Touched'];

async function logSyncRun(spreadsheetId, result) {
  const sheets = await getAuthedSheets();
  await ensureTab(sheets, spreadsheetId, LOG_TAB);
  await ensureHeader(sheets, spreadsheetId, LOG_TAB, LOG_HEADER);

  await appendRows(sheets, spreadsheetId, LOG_TAB, [[
    result.ranAt,
    result.totalVideosFetched,
    result.totalNewRowsAdded,
    result.perClient.map(c => c.client).join(', '),
  ]]);
}

async function getLastSyncRun(spreadsheetId) {
  const sheets = await getAuthedSheets();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${LOG_TAB}'!A2:D`,
    });
  } catch (err) {
    if (err.code === 400) return null; // tab doesn't exist yet — no runs logged
    throw err;
  }
  const rows = resp.data.values || [];
  if (!rows.length) return null;
  const [ranAt, videosFetched, rowsAdded, clients] = rows[rows.length - 1];
  return { ranAt, videosFetched: Number(videosFetched), rowsAdded: Number(rowsAdded), clients, totalRuns: rows.length };
}

module.exports = { syncVideosToSheet, logSyncRun, getLastSyncRun };
