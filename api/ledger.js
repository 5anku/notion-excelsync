const { fetchAllVideos, fetchAllClients, STATUS_OPTIONS } = require('../lib/notion');
const { getPeriodLabels } = require('../lib/sheets');

module.exports = async (req, res) => {
  try {
    const videosDbId = process.env.NOTION_VIDEOS_DB_ID;
    const clientsDbId = process.env.NOTION_CLIENTS_DB_ID;
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!videosDbId) throw new Error('Missing NOTION_VIDEOS_DB_ID env var');

    const [videos, clients, periodLabels] = await Promise.all([
      fetchAllVideos(videosDbId),
      clientsDbId ? fetchAllClients(clientsDbId) : Promise.resolve([]),
      spreadsheetId ? getPeriodLabels(spreadsheetId) : Promise.resolve({}),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ videos, clients, periodLabels, statusOptions: STATUS_OPTIONS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
