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

// ── /api/all-restaurants: server fetches ALL pages, returns flat array ──
// Phone makes ONE request, server does all the pagination to Notion
async function handleAllRestaurants(req, res) {
  let authToken = '';
  let dbId = '';

  // Read body for token + dbId
  await new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(raw);
        authToken = b.token || '';
        dbId      = b.dbId  || '';
      } catch(e) {}
      resolve();
    });
  });

  if (!authToken || !dbId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token and dbId required' }));
    return;
  }

  const all = [];
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 100; // 10,000 restaurants max — adjust if needed

  try {
    do {
      const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const r = await notionRequest('POST', `/v1/databases/${dbId}/query`, authToken, body);
      if (r.status !== 200) {
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Notion error', status: r.status }));
        return;
      }
      all.push(...(r.body.results || []));
      cursor = r.body.has_more ? r.body.next_cursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ results: all, total: all.length }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
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
