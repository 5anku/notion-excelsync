const { runSync } = require('../lib/sync');

module.exports = async (req, res) => {
  // Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when it
  // triggers this via the schedule in vercel.json, as long as CRON_SECRET is
  // set as an env var on the project. This also lets you trigger it manually
  // by calling the URL with that header (e.g. from curl or Postman).
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const result = await runSync();
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
