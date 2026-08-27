// Quick local test runner: `node scripts/run-local.js`
// Loads .env (if present) and runs the same sync the Vercel cron would run.
require('dotenv').config();
const { runSync } = require('../lib/sync');

runSync()
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
