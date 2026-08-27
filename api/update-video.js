const { updateVideo } = require('../lib/notion');

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

  const { pageId, status, postedDate } = req.body || {};
  if (!pageId) {
    res.status(400).json({ error: 'Missing pageId' });
    return;
  }

  try {
    await updateVideo(pageId, { status, postedDate });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
