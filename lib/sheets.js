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
 *
 * Batches everything into a handful of Sheets API calls total (rather than
 * several per client) to stay well under the API's per-minute quota even
 * with 70+ client tabs: one metadata read, one batched sheet-creation call,
 * one batched read of every tab's current contents, and one batched write.
 */
async function syncVideosToSheet(spreadsheetId, videosByClient) {
  const sheets = await getAuthedSheets();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingByLower = new Map(
    meta.data.sheets.map(s => [s.properties.title.toLowerCase(), s.properties.title])
  );

  const clients = Object.entries(videosByClient).map(([clientName, videos]) => {
    const requested = safeTabName(clientName);
    const existingTitle = existingByLower.get(requested.toLowerCase());
    return { clientName, videos, tabName: existingTitle || requested, isNew: !existingTitle };
  });

  const toCreate = clients.filter(c => c.isNew);
  if (toCreate.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toCreate.map(c => ({ addSheet: { properties: { title: c.tabName } } })),
      },
    });
  }

  const lastCol = String.fromCharCode(64 + HEADER.length);
  const batchResp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: clients.map(c => `'${c.tabName}'!A1:${lastCol}`),
  });

  const writes = [];
  const summary = [];

  clients.forEach((c, i) => {
    const rowsInTab = batchResp.data.valueRanges[i].values || [];
    const headerRow = rowsInTab[0] || [];
    const dataRows = rowsInTab.slice(1);

    if (headerRow.length === 0) {
      writes.push({ range: `'${c.tabName}'!A1`, values: [HEADER] });
    } else if (headerRow.length < HEADER.length) {
      const startCol = String.fromCharCode(64 + headerRow.length + 1);
      writes.push({ range: `'${c.tabName}'!${startCol}1`, values: [HEADER.slice(headerRow.length)] });
    }

    const existingTitles = new Set(dataRows.map(r => normTitle(r[2])));
    let nextNumber = dataRows.length + 1;
    const newVideos = c.videos.filter(v => !existingTitles.has(normTitle(v.title)));
    const rows = newVideos.map(v => ([
      nextNumber++,
      toShortDate(v.shootDate),
      v.title,
      (v.status === 'Done' || v.status === 'Posted') ? 'TRUE' : 'FALSE',
      toShortDate(v.postedDate),
      v.pageId,
    ]));

    if (rows.length) {
      const startRow = dataRows.length + 2; // +1 for header, +1 for 1-indexing
      writes.push({ range: `'${c.tabName}'!A${startRow}`, values: rows });
    }

    summary.push({ client: c.clientName, tab: c.tabName, added: rows.length, skipped: c.videos.length - rows.length });
  });

  if (writes.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
    });
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

const PERIOD_LABELS_TAB = 'Period Labels';
const PERIOD_LABELS_HEADER = ['Client', 'Period Index', 'Label'];

/**
 * Reads custom contract-month table names the ledger's edit mode has saved.
 * Returns a map keyed "clientName|periodIndex" -> label. Notion has no field
 * for this, so it lives in its own quiet tab in the Sheet instead.
 */
async function getPeriodLabels(spreadsheetId) {
  const sheets = await getAuthedSheets();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${PERIOD_LABELS_TAB}'!A2:C`,
    });
  } catch (err) {
    if (err.code === 400) return {}; // tab doesn't exist yet — no custom labels saved
    throw err;
  }
  const rows = resp.data.values || [];
  const map = {};
  for (const [client, periodIndex, label] of rows) {
    if (client && periodIndex) map[`${client}|${periodIndex}`] = label || '';
  }
  return map;
}

/** Upserts a single contract-month table's custom label. */
async function setPeriodLabel(spreadsheetId, clientName, periodIndex, label) {
  const sheets = await getAuthedSheets();
  await ensureTab(sheets, spreadsheetId, PERIOD_LABELS_TAB);
  await ensureHeader(sheets, spreadsheetId, PERIOD_LABELS_TAB, PERIOD_LABELS_HEADER);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${PERIOD_LABELS_TAB}'!A2:C`,
  });
  const rows = resp.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === clientName && String(r[1]) === String(periodIndex));

  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${PERIOD_LABELS_TAB}'!C${rowIndex + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[label]] },
    });
  } else {
    await appendRows(sheets, spreadsheetId, PERIOD_LABELS_TAB, [[clientName, periodIndex, label]]);
  }
}

module.exports = { syncVideosToSheet, logSyncRun, getLastSyncRun, getPeriodLabels, setPeriodLabel };
