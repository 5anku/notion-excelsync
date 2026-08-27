const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

/**
 * Pull every row out of the Notion Videos database, fully paginated.
 * Adjust the property names below (PROP.*) to match your actual Notion
 * database schema — these are guesses based on the CSV export you showed
 * me (Video Title, Client, Shoot Date, Status, Notes, Editor, Re-edit
 * Count, Posted Date, Client Name).
 */
const PROP = {
  title: 'Video Title',       // title property
  clientRelation: 'Client',   // relation property (linked Clients DB page)
  clientNameRollup: 'Client Name', // rollup/text property with the plain client name
  shootDate: 'Shoot Date',    // date property
  status: 'Status',           // status or select property
  notes: 'Notes',             // rich_text property
  editor: 'Editor',           // rich_text or select property
  reeditCount: 'Re-edit Count', // number property
  postedDate: 'Posted Date',  // date property
};

function getPlainText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  if (prop.type === 'select') return prop.select ? prop.select.name : '';
  if (prop.type === 'status') return prop.status ? prop.status.name : '';
  if (prop.type === 'multi_select') return (prop.multi_select || []).map(o => o.name).join(', ');
  if (prop.type === 'number') return prop.number != null ? String(prop.number) : '';
  if (prop.type === 'formula') {
    const f = prop.formula;
    if (!f) return '';
    if (f.type === 'string') return f.string || '';
    if (f.type === 'number') return f.number != null ? String(f.number) : '';
    if (f.type === 'boolean') return f.boolean ? 'true' : 'false';
    if (f.type === 'date') return f.date ? f.date.start : '';
    return '';
  }
  if (prop.type === 'rollup') {
    const rollup = prop.rollup;
    if (!rollup) return '';
    if (rollup.type === 'array') {
      return rollup.array.map(getPlainText).filter(Boolean).join(', ');
    }
    if (rollup.type === 'number') return rollup.number != null ? String(rollup.number) : '';
    return '';
  }
  return '';
}

function getDate(prop) {
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  return prop.date.start || null; // 'YYYY-MM-DD' or ISO datetime string
}

const STATUS_OPTIONS = [
  'Scheduled', 'Shot', 'Sent to Editor', 'In Editing', 'Internal Approval',
  'Re-Edit (Internal)', 'Client Approval', 'Re-Edit (Client)', 'Done', 'Posted', 'Cancelled',
];

const CLIENT_PROP = { name: 'Client Name', quota: 'Quota' };

function getNumber(prop) {
  if (!prop) return null;
  if (prop.type === 'number') return prop.number;
  if (prop.type === 'formula' && prop.formula && prop.formula.type === 'number') return prop.formula.number;
  return null;
}

/** Pull client names + monthly quota from the Notion Clients database. Nothing else is used. */
async function fetchAllClients(databaseId) {
  const results = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of resp.results) {
      const props = page.properties;
      results.push({
        name: getPlainText(props[CLIENT_PROP.name]).trim(),
        quota: getNumber(props[CLIENT_PROP.quota]),
      });
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** Writes Status and/or Posted Date back to a single video page in Notion. */
async function updateVideo(pageId, { status, postedDate }) {
  const properties = {};
  if (status !== undefined) {
    if (status && !STATUS_OPTIONS.includes(status)) {
      throw new Error(`Invalid status "${status}"`);
    }
    properties[PROP.status] = status ? { select: { name: status } } : { select: null };
  }
  if (postedDate !== undefined) {
    properties[PROP.postedDate] = postedDate ? { date: { start: postedDate } } : { date: null };
  }
  await notion.pages.update({ page_id: pageId, properties });
}

async function fetchAllVideos(databaseId) {
  const results = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of resp.results) {
      const props = page.properties;
      let clientName = getPlainText(props[PROP.clientNameRollup]);
      if (!clientName && props[PROP.clientRelation] && props[PROP.clientRelation].type === 'relation') {
        // Fall back: if there's no rollup, we only get related page IDs here,
        // not the name. Prefer configuring a rollup/text "Client Name" field
        // in Notion so this script can read plain text directly.
        clientName = '';
      }
      results.push({
        pageId: page.id,
        title: getPlainText(props[PROP.title]),
        clientName: clientName.trim(),
        shootDate: getDate(props[PROP.shootDate]),
        status: getPlainText(props[PROP.status]),
        notes: getPlainText(props[PROP.notes]),
        editor: getPlainText(props[PROP.editor]),
        reeditCount: getPlainText(props[PROP.reeditCount]),
        postedDate: getDate(props[PROP.postedDate]),
        lastEdited: page.last_edited_time,
      });
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

module.exports = { fetchAllVideos, fetchAllClients, updateVideo, PROP, STATUS_OPTIONS };
