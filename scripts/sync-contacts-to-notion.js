#!/usr/bin/env node
/**
 * sync-contacts-to-notion.js
 *
 * Pushes contact info (POC Name / Phone / Email / Notes) from intel_supplement.json
 * into the Notion restaurants DB. Idempotent — safe to re-run.
 *
 * Usage:
 *   export NOTION_TOKEN=ntn_xxx
 *   export NOTION_DB_ID=33e29928-6a52-80aa-bcf0-f9c636968450   # optional, has default
 *   node scripts/sync-contacts-to-notion.js
 *
 * Flags:
 *   --dry    Print what would change without calling Notion's PATCH endpoint.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID || '33e29928-6a52-80aa-bcf0-f9c636968450';
const DRY = process.argv.includes('--dry');

if (!TOKEN) {
  console.error('ERROR: NOTION_TOKEN env var is required.');
  process.exit(1);
}

// Supplement keys to sync. Maps the intel_supplement.json key to the Notion
// Name (or Brand Name) we should match on. If the Notion Name differs from
// the supplement key, put the Notion-side name in `notionName`.
const TARGETS = [
  { key: 'bosnian house',       notionName: 'Bosnian House' },
  { key: 'smk',                 notionName: 'SMK' },
  { key: 'orto cafe',           notionName: 'Orto Cafe' },
  { key: 'friends avenue',      notionName: 'Friends Avenue' },
  { key: 'friends avenue cafe', notionName: 'Friends Avenue Cafe' },
  { key: 'saddle',              notionName: 'Saddle' },
  { key: 'saddle cafe',         notionName: 'Saddle Cafe' },
];

// Which fields in the supplement we push to Notion.
const FIELDS = ['poc', 'phone', 'email', 'notes'];

function notionReq(method, notionPath, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.notion.com',
      path: notionPath,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

// Build a property value in the shape Notion expects for the given type.
function buildValue(type, value) {
  if (value == null || value === '') return null;
  switch (type) {
    case 'rich_text':    return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
    case 'title':        return { title:     [{ type: 'text', text: { content: String(value) } }] };
    case 'phone_number': return { phone_number: String(value) };
    case 'email':        return { email: String(value) };
    case 'url':          return { url: String(value) };
    case 'select':       return { select: { name: String(value) } };
    default: return null; // unsupported — skip silently
  }
}

async function main() {
  console.log(`→ Notion DB: ${DB_ID}`);
  console.log(`→ Mode: ${DRY ? 'DRY RUN' : 'LIVE'}`);

  // 1. Load supplement
  const supPath = path.join(__dirname, '..', 'intel_supplement.json');
  const supplement = JSON.parse(fs.readFileSync(supPath, 'utf8'));

  // 2. Fetch DB schema so we know property types and which ones actually exist.
  const schema = await notionReq('GET', `/v1/databases/${DB_ID}`);
  if (schema.status !== 200) {
    console.error('Failed to read DB schema:', schema.status, schema.body);
    process.exit(1);
  }
  const props = schema.body.properties;
  const titleProp = Object.entries(props).find(([, v]) => v.type === 'title')?.[0];
  if (!titleProp) { console.error('No title property found on DB'); process.exit(1); }
  console.log(`→ Title property: "${titleProp}"`);

  // Map our logical field names to actual Notion property names + types.
  // Adjust the right-hand side if your Notion column names differ.
  const FIELD_MAP = {
    poc:   'POC Name',
    phone: 'Phone',
    email: 'Email',
    notes: 'Notes',
  };
  for (const [logical, notionName] of Object.entries(FIELD_MAP)) {
    if (!props[notionName]) {
      console.warn(`  ! Notion property "${notionName}" not found — "${logical}" will be skipped.`);
    } else {
      console.log(`  ✓ ${logical} → "${notionName}" (${props[notionName].type})`);
    }
  }
  console.log('');

  // 3. For each target, query for the page by title and PATCH its properties.
  let updated = 0, skipped = 0, notFound = 0;
  for (const t of TARGETS) {
    const sup = supplement[t.key];
    if (!sup) { console.log(`• ${t.key} — not in supplement, skip`); skipped++; continue; }

    // Only push fields the supplement actually has.
    const pushable = FIELDS.filter(f => sup[f] != null && sup[f] !== '');
    if (pushable.length === 0) { console.log(`• ${t.key} — no contact fields to push, skip`); skipped++; continue; }

    // Find the Notion page whose title equals t.notionName (case-insensitive).
    const q = await notionReq('POST', `/v1/databases/${DB_ID}/query`, {
      filter: { property: titleProp, title: { equals: t.notionName } },
      page_size: 5,
    });
    if (q.status !== 200) {
      console.log(`• ${t.key} — query failed (${q.status}):`, q.body?.message || q.body);
      skipped++; continue;
    }
    let results = q.body.results || [];

    // Fallback: case-insensitive contains search if exact didn't match.
    if (results.length === 0) {
      const q2 = await notionReq('POST', `/v1/databases/${DB_ID}/query`, {
        filter: { property: titleProp, title: { contains: t.notionName } },
        page_size: 10,
      });
      if (q2.status === 200) {
        results = (q2.body.results || []).filter(p => {
          const title = (p.properties[titleProp]?.title?.[0]?.plain_text || '').toLowerCase();
          return title === t.notionName.toLowerCase();
        });
      }
    }

    if (results.length === 0) {
      console.log(`• ${t.key} — no Notion page titled "${t.notionName}" found`);
      notFound++; continue;
    }
    if (results.length > 1) {
      console.log(`• ${t.key} — ${results.length} pages match "${t.notionName}", updating all`);
    }

    // Build the properties payload.
    const properties = {};
    for (const f of pushable) {
      const notionName = FIELD_MAP[f];
      const propDef = props[notionName];
      if (!propDef) continue;
      const v = buildValue(propDef.type, sup[f]);
      if (v) properties[notionName] = v;
    }
    if (Object.keys(properties).length === 0) {
      console.log(`• ${t.key} — nothing to push after mapping, skip`); skipped++; continue;
    }

    for (const page of results) {
      const title = page.properties[titleProp]?.title?.[0]?.plain_text || '(untitled)';
      if (DRY) {
        console.log(`• ${t.key} — WOULD update "${title}" (${page.id}):`, Object.keys(properties).join(', '));
        updated++;
      } else {
        const r = await notionReq('PATCH', `/v1/pages/${page.id}`, { properties });
        if (r.status === 200) {
          console.log(`✓ ${t.key} — updated "${title}" (${Object.keys(properties).join(', ')})`);
          updated++;
        } else {
          console.log(`✗ ${t.key} — PATCH failed (${r.status}):`, r.body?.message || r.body);
          skipped++;
        }
      }
    }
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} notFound=${notFound}`);
}

main().catch(e => { console.error(e); process.exit(1); });
