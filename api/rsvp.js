const KEY = 'rsvp:entries';

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
    if (!config) {
      res.status(200).json({ entries: memoryStore, persistent: false });
      return;
    }

    try {
      const raw = (await redisCommand(config, ['LRANGE', KEY, '0', '-1'])) || [];
      const entries = raw.map((item) => {
        if (typeof item !== 'string') return item;
        try {
          return JSON.parse(item);
        } catch (error) {
          return { value: item };
        }
      });
      res.status(200).json({ entries });
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
      res.status(200).json({ ok: true, saved: entry });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
    return;
  }

  res.status(405).json({ ok: false, message: 'Method not allowed' });
};