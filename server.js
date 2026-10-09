const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const RSVP_FILE = path.join(DATA_DIR, 'wedding-rsvp-entries.csv');

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(RSVP_FILE)) {
    const header = [
      'Full Name',
      'Email',
      'Attendance',
      'Number of Guests',
      'Submitted At'
    ].join(',');
    fs.writeFileSync(RSVP_FILE, `${header}\n`, 'utf8');
  }
}

function escapeCsv(value) {
  const stringValue = String(value ?? '');
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function appendRsvpEntry(entry) {
  ensureDataFile();

  const row = [
    entry.fullName,
    entry.email,
    entry.attendance,
    entry.guests,
    entry.submittedAt
  ].map(escapeCsv).join(',');

  fs.appendFileSync(RSVP_FILE, `${row}\n`, 'utf8');
}

function readCsvRows() {
  ensureDataFile();

  const content = fs.readFileSync(RSVP_FILE, 'utf8').trim();
  if (!content) return [];

  const lines = content.split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const row = {};
    header.forEach((key, index) => { row[key] = values[index]?.replace(/^"|"$/g, '').replace(/""/g, '"'); });
    return row;
  });
}

function serveStaticFile(filePath, res) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm'
    };

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === '/api/rsvp' && req.method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const entry = JSON.parse(body || '{}');

        const payload = {
          fullName: String(entry.fullName || '').trim(),
          email: String(entry.email || '').trim(),
          attendance: String(entry.attendance || '').trim(),
          guests: String(entry.guests || '1'),
          submittedAt: entry.submittedAt || new Date().toISOString()
        };

        if (!payload.fullName || !payload.email) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: 'Full name and email are required.' }));
          return;
        }

        appendRsvpEntry(payload);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, saved: payload }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid RSVP payload' }));
      }
    });

    return;
  }

  if (requestUrl.pathname === '/api/rsvp' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ entries: readCsvRows() }));
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch (error) {
    decodedPath = requestUrl.pathname;
  }

  let filePath = decodedPath === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, decodedPath.replace(/^\//, ''));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!error && stats && stats.isFile()) {
      serveStaticFile(filePath, res);
      return;
    }

    serveStaticFile(path.join(ROOT, 'index.html'), res);
  });
});

ensureDataFile();

server.listen(PORT, () => {
  console.log(`Wedding RSVP server running at http://localhost:${PORT}`);
  console.log(`CSV database: ${RSVP_FILE}`);
});
