/**
 * noon DineOut — Command Center Server
 * - Serves static files
 * - Proxies individual Notion API calls (PATCH, single queries)
 * - /api/all-restaurants: fetches ALL Notion pages server-side in one shot
 *   so mobile doesn't have to make 38 sequential requests
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const DIR  = __dirname;

// ── Notion helper: make one HTTPS request to Notion, return parsed JSON ──
function notionRequest(method, notionPath, authToken, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const options = {
      hostname: 'api.notion.com',
      path: notionPath,
      method,
      headers: {
        'Authorization':  'Bearer ' + authToken,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, res2 => {
      let data = '';
      res2.on('data', c => data += c);
      res2.on('end', () => {
        try { resolve({ status: res2.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res2.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Field order for columnar format (keys stored once, not per row) ──
const SLIM_KEYS = [
  'id','name','am','pipelineStatus','priority','outlets',
  'groupName','cuisine','priceForTwo','website','phone',
  'notes','email','pocName','discountAgreed','isLive',
  'confirmedForOut','resCode','lat','lng','nextFollowUp','lastActivity',
];

// ── Extract one slim value array from a raw Notion page ──
function slimRow(p) {
  const props = p.properties || {};
  function g(key) {
    const v = props[key];
    if (!v) return null;
    if (v.title)        return v.title[0]?.plain_text || null;
    if (v.rich_text)    return v.rich_text[0]?.plain_text || null;
    if (v.select)       return v.select?.name || null;
    if (v.number !== undefined && v.number !== null) return v.number;
    if (v.checkbox !== undefined) return v.checkbox;
    if (v.url)          return v.url;
    if (v.email)        return v.email;
    if (v.phone_number) return v.phone_number;
    if (v.date)         return v.date?.start || null;
    return null;
  }
  // Return values in SLIM_KEYS order; nulls kept sparse-friendly
  return [
    p.id,
    g('Name') || g('Brand Name') || '(no name)',
    g('AM') || null,
    g('Pipeline Status') || null,
    g('Priority') || null,
    g('# of Outlets') || null,
    g('Group Name') || null,
    g('Cuisine') || null,
    g('Price for Two AED') || null,
    g('Web Page') || null,
    g('Phone') || null,
    g('Notes') || null,
    g('Email') || null,
    g('POC Name') || null,
    g('Discount Agreed %') || null,
    g('Is Live') || null,
    g('Confirmed for OUT') || null,
    g('Res Code') || null,
    g('Latitude') || null,
    g('Longitude') || null,
    g('Next Follow-up Date') || null,
    g('Last Activity Date') || null,
  ];
}

// ── Server-side in-memory cache — survives across requests on same dyno ──
// Key: dbId. Value: { payload (pre-serialised JSON string), ts }
const SERVER_CACHE = {};
const SERVER_CACHE_TTL = 25 * 60 * 1000; // 25 minutes

// ── /api/all-restaurants: streams NDJSON so Render proxy never times out ──
//
// Protocol (NDJSON — one JSON value per line):
//   Line 0: {"keys":[...22 field names...]}     ← sent immediately, keeps conn alive
//   Line 1: [[row],[row],...,[row]]              ← batch 1 (100 restaurants)
//   Line 2: [[row],...]                          ← batch 2, etc.
//   Last:   {"total":N}                          ← sentinel, marks end
//
// Client reads the full text, splits on \n, reassembles.
async function handleAllRestaurants(req, res) {
  let authToken = '';
  let dbId = '';

  await new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { const b = JSON.parse(raw); authToken = b.token||''; dbId = b.dbId||''; } catch(e){}
      resolve();
    });
  });

  if (!authToken || !dbId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token and dbId required' }));
    return;
  }

  // ── Serve from server-side cache if fresh ──
  const cached = SERVER_CACHE[dbId];
  if (cached && (Date.now() - cached.ts) < SERVER_CACHE_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' });
    res.end(cached.payload);
    return;
  }

  // ── Stream NDJSON — first line sent immediately so Render proxy doesn't time out ──
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  // Line 0: keys — sent right away (keeps Render's 30s proxy alive)
  res.write(JSON.stringify({ keys: SLIM_KEYS }) + '\n');

  const allRows = [];
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 150;

  try {
    do {
      const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const r = await notionRequest('POST', `/v1/databases/${dbId}/query`, authToken, body);
      if (r.status !== 200) {
        res.end(JSON.stringify({ error: 'Notion error', status: r.status }) + '\n');
        return;
      }
      const batch = (r.body.results || []).map(slimRow);
      allRows.push(...batch);
      // Write each batch as it arrives — client gets data progressively
      res.write(JSON.stringify(batch) + '\n');
      cursor = r.body.has_more ? r.body.next_cursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);

    // Sentinel line — tells client we're done
    res.end(JSON.stringify({ total: allRows.length }) + '\n');

    // Cache the full payload (regular JSON format) for next request
    SERVER_CACHE[dbId] = {
      payload: JSON.stringify({ keys: SLIM_KEYS, rows: allRows, total: allRows.length }),
      ts: Date.now(),
    };
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }) + '\n');
  }
}

// ── Proxy individual Notion API calls (PATCH etc.) ──
function proxyToNotion(req, res, notionPath) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: 'api.notion.com',
      path: notionPath,
      method: req.method,
      headers: {
        'Authorization':   req.headers['authorization'] || '',
        'Notion-Version':  '2022-06-28',
        'Content-Type':    'application/json',
      },
    };
    const notionReq = https.request(options, notionRes => {
      res.writeHead(notionRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      notionRes.pipe(res);
    });
    notionReq.on('error', e => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    if (body) notionReq.write(body);
    notionReq.end();
  });
}

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Notion-Version');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Server-side bulk fetch endpoint
  if (parsed.pathname === '/api/all-restaurants' && req.method === 'POST') {
    handleAllRestaurants(req, res).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Notion proxy for individual calls
  if (parsed.pathname.startsWith('/notion/')) {
    const notionPath = parsed.pathname.replace('/notion', '') + (parsed.search || '');
    proxyToNotion(req, res, notionPath);
    return;
  }

  // Static files
  const filePath = path.join(DIR, parsed.pathname === '/' ? 'command_center.html' : parsed.pathname);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   noon DineOut — Command Center          ║');
  console.log('  ║   http://localhost:' + PORT + '                   ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
});
