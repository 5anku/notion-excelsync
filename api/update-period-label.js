const { setPeriodLabel } = require('../lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const password = req.headers['x-ledger-password'];
  if (!process.env.LEDGER_EDIT_PASSWORD || password !== process.env.LEDGER_EDIT_PASSWORD) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  const { clientName, periodIndex, label } = req.body || {};
  if (!clientName || !periodIndex) {
    res.status(400).json({ error: 'Missing clientName or periodIndex' });
    return;
  }

  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');
    await setPeriodLabel(spreadsheetId, clientName, periodIndex, label || '');
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
