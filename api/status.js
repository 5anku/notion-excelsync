const { getLastSyncRun } = require('../lib/sheets');

module.exports = async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const last = await getLastSyncRun(spreadsheetId);
    res.status(200).json({ configured: true, lastRun: last });
  } catch (err) {
    res.status(500).json({ configured: false, error: err.message });
  }
};
