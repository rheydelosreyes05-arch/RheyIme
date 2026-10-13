const KEY = 'rsvp:entries';
const CSV_PATH = 'data/wedding-rsvp-entries.csv';
const GITHUB_REPO = process.env.GITHUB_REPO || 'rheydelosreyes05-arch/RheyIme';
const GITHUB_BRANCH = 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCommand(config, command) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.error || `Redis command failed (${response.status})`);
  }

  return data.result;
}

// Best-effort fallback so the endpoint still works without Redis configured.
// Note: serverless instances are ephemeral, so entries here may not persist.
const memoryStore = (globalThis.__rsvpMemoryStore = globalThis.__rsvpMemoryStore || []);

function safeParse(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch (error) {
    return {};
  }
}

function normalizeEntry(body) {
  const entry = safeParse(body);
  return {
    fullName: String(entry.fullName || '').trim(),
    email: String(entry.email || '').trim(),
    attendance: String(entry.attendance || '').trim(),
    guests: String(entry.guests || '1'),
    submittedAt: entry.submittedAt || new Date().toISOString()
  };
}

async function readAllEntries(config) {
  if (!config) return memoryStore.slice();

  const raw = (await redisCommand(config, ['LRANGE', KEY, '0', '-1'])) || [];
  return raw.map((item) => {
    if (typeof item !== 'string') return item;
    try {
      return JSON.parse(item);
    } catch (error) {
      return { value: item, submittedAt: '' };
    }
  });
}

function entriesToCsv(entries) {
  const header = ['Full Name', 'Email', 'Attendance', 'Number of Guests', 'Submitted At'];
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

  const rows = entries.map((entry) =>
    [entry.fullName, entry.email, entry.attendance, entry.guests, entry.submittedAt]
      .map(escape)
      .join(',')
  );

  return [header.map(escape).join(',')].concat(rows).join('\n') + '\n';
}

function parseCsvRows(csv) {
  const text = String(csv || '').replace(/^\uFEFF/, '');
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];

  const header = lines[0].split(',').map((key) => key.replace(/^"|"$/g, ''));
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const values = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const row = {};
      header.forEach((key, index) => {
        const value = values[index];
        row[key] = value != null ? value.replace(/^"|"$/g, '').replace(/""/g, '"') : '';
      });
      return {
        fullName: row['Full Name'],
        email: row['Email'],
        attendance: row['Attendance'],
        guests: row['Number of Guests'],
        submittedAt: row['Submitted At']
      };
    });
}

function mergeEntries(...lists) {
  const byKey = new Map();
  lists.flat().forEach((entry) => {
    if (!entry || !entry.email) return;
    const key = `${String(entry.email).trim().toLowerCase()}|${String(entry.fullName).trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || (entry.submittedAt && (!existing.submittedAt || entry.submittedAt > existing.submittedAt))) {
      byKey.set(key, entry);
    }
  });

  return [...byKey.values()].sort((a, b) =>
    String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))
  );
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'rheyime-rsvp'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return response;
}

async function syncCsvToGitHub(entries) {
  if (!GITHUB_TOKEN) return;

  for (let attempt = 0; attempt < 5; attempt++) {
    const getResponse = await githubRequest(CSV_PATH);
    const file = await getResponse.json().catch(() => ({}));

    let merged = entries;
    let mergedCsv;
    if (getResponse.ok && file.content) {
      const remoteCsv = Buffer.from(file.content, 'base64').toString('utf8');
      merged = mergeEntries(parseCsvRows(remoteCsv), entries);
      mergedCsv = entriesToCsv(merged);
      if (remoteCsv === mergedCsv) return; // nothing changed
    } else {
      mergedCsv = entriesToCsv(merged);
    }

    const putResponse = await githubRequest(CSV_PATH, {
      method: 'PUT',
      body: {
        message: `Update RSVP entries (${merged.length} total)`,
        content: Buffer.from(mergedCsv, 'utf8').toString('base64'),
        branch: GITHUB_BRANCH,
        ...(file.sha ? { sha: file.sha } : {})
      }
    });

    if (putResponse.ok) return;

    const data = await putResponse.json().catch(() => ({}));
    if (putResponse.status === 409) {
      continue; // concurrent update, re-read and retry
    }

    throw new Error(data.message || `GitHub sync failed (${putResponse.status})`);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const config = getRedisConfig();

  if (req.method === 'GET') {
    try {
      const entries = await readAllEntries(config);
      res.status(200).json({ entries, persistent: Boolean(config) });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
    return;
  }

  if (req.method === 'POST') {
    const entry = normalizeEntry(req.body);

    if (!entry.fullName || !entry.email) {
      res.status(400).json({ ok: false, message: 'Full name and email are required.' });
      return;
    }

    try {
      if (config) {
        await redisCommand(config, ['LPUSH', KEY, JSON.stringify(entry)]);
      } else {
        memoryStore.push(entry);
      }

      const entries = await readAllEntries(config);
      await syncCsvToGitHub(entries).catch((error) => {
        console.error('GitHub sync failed (entry still saved):', error.message);
      });

      res.status(200).json({ ok: true, saved: entry });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
    return;
  }

  res.status(405).json({ ok: false, message: 'Method not allowed' });
};

module.exports.syncCsvToGitHub = syncCsvToGitHub;