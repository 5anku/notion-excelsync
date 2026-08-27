# notion-sheets-sync

A small Vercel-hosted job that runs once a day, pulls every row from your
Notion **Videos** database, and appends any videos that aren't already
present into a per-client tab in a Google Sheet — deduping by video title,
the same approach used for the manual xlsx merge.

## What it does each run

1. Fetches every page from `NOTION_VIDEOS_DB_ID` (fully paginated).
2. Groups them by client name.
3. For each client:
   - Creates a tab in the target Google Sheet if one doesn't exist yet
     (named after the client, with a header row).
   - Reads the existing "Video Title" column to know what's already there.
   - Appends only the videos whose (normalized) title isn't already present.
4. Returns a JSON summary: how many videos were fetched, how many new rows
   were added, and a per-client breakdown.

## 1. Notion setup

1. Create an internal integration at https://www.notion.so/my-integrations
   → copy the **Internal Integration Secret** → this is `NOTION_TOKEN`.
2. Open your Videos database in Notion → `•••` menu → **Connections** → add
   your integration, so it's allowed to read the database.
3. Copy the database ID from its URL:
   `https://notion.so/yourworkspace/<DATABASE_ID>?v=...` → this is
   `NOTION_VIDEOS_DB_ID`.
4. **Check `lib/notion.js`** — the `PROP` object at the top maps this
   script's expected fields to your actual Notion property names. I guessed
   these from the CSV export you showed me (`Video Title`, `Client Name`,
   `Shoot Date`, `Status`, `Notes`, `Editor`, `Re-edit Count`, `Posted
   Date`). If your real property names differ, or `Client Name` isn't a
   plain-text/rollup field (just a relation), update this file — a relation
   alone doesn't carry the readable client name, so you'll want a rollup or
   formula property in Notion that surfaces it as text.

## 2. Google Sheets setup

1. In Google Cloud Console, create a project (or reuse one) → enable the
   **Google Sheets API**.
2. Create a **Service Account** → create a JSON key for it.
3. From that JSON: `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
   `private_key` → `GOOGLE_PRIVATE_KEY` (keep the `\n` escapes as-is; the
   code un-escapes them at runtime).
4. Create (or pick) the destination Google Sheet, then **share it** with
   the service account's email address (Editor access).
5. Copy the spreadsheet ID from its URL:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit` → `GOOGLE_SHEET_ID`.

## 3. Deploy to Vercel

```bash
npm install
vercel        # first deploy, follow prompts
```

Then in the Vercel project dashboard → **Settings → Environment Variables**,
add everything from `.env.example` (with your real values) for both
Production and Preview.

Redeploy once the env vars are set:

```bash
vercel --prod
```

The cron schedule lives in `vercel.json` (`0 3 * * *` = 3:00 AM UTC daily —
edit this if you want a different time; Vercel Cron on the free/Hobby plan
only supports daily granularity).

## 4. Verify it

- Vercel will show cron invocations under **Project → Cron Jobs**.
- You can also trigger it manually:
  ```bash
  curl -H "Authorization: Bearer <your CRON_SECRET>" https://your-project.vercel.app/api/sync
  ```
- A successful run returns JSON like:
  ```json
  {
    "ranAt": "2026-08-28T03:00:00.000Z",
    "totalVideosFetched": 811,
    "totalNewRowsAdded": 12,
    "perClient": [
      { "client": "AL EMAD", "tab": "AL EMAD", "added": 3, "skipped": 45 }
    ]
  }
  ```

## Notes / things to decide later

- This creates a **flat one-row-per-video tab per client** — it does not
  try to replicate the old xlsx's month-block layout (that structure was
  specific to reconciling historical data by hand; a running log is far
  simpler to keep in sync automatically). Let me know if you'd rather it
  matched the month-block format instead.
- Dedup is by video title only, same limitation as the manual merge: if two
  different videos ever get the same title, one will be silently skipped.
- Nothing here touches Shoots or Clients databases yet — only Videos. Say
  the word if you want those synced too.
