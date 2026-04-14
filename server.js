const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '10mb' }));

const dbUrl = process.env.DATABASE_URL || '';
const isRemoteDb = dbUrl.includes('neon.tech') || dbUrl.includes('sslmode=') || dbUrl.includes('amazonaws.com');
const poolConfig = {
  connectionString: dbUrl,
  connectionTimeoutMillis: 15000,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false
};
const pool = new Pool(poolConfig);

async function initDatabase() {
  console.log('Connecting to database...', dbUrl ? `(host: ${dbUrl.split('@')[1]?.split('/')[0] || 'unknown'}, ssl: ${isRemoteDb})` : '(no DATABASE_URL)');
  const client = await pool.connect();
  console.log('Database connected successfully');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS scorecards (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS use_cases (
        id VARCHAR(20) PRIMARY KEY,
        scorecard VARCHAR(100) NOT NULL REFERENCES scorecards(id) ON DELETE CASCADE,
        scorecard_name VARCHAR(255) NOT NULL,
        title VARCHAR(500) NOT NULL,
        type VARCHAR(50) DEFAULT 'single-turn',
        status VARCHAR(50) DEFAULT 'active',
        user_message TEXT NOT NULL,
        expected_behavior TEXT DEFAULT '',
        criteria JSONB DEFAULT '[]',
        rules JSONB DEFAULT '[]',
        tags JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS use_case_cache (
        use_case_id VARCHAR(20) PRIMARY KEY,
        cache_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS seed_exclusions (
        id VARCHAR(20) PRIMARY KEY,
        excluded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await seedFromJson(client);
  } finally {
    client.release();
  }
}

async function seedFromJson(client) {
  const filePath = path.join(__dirname, 'use-cases.json');
  if (!fs.existsSync(filePath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    const { rows: exclusions } = await client.query('SELECT id FROM seed_exclusions');
    const excludedIds = new Set(exclusions.map(r => r.id));

    const { rows: existingUc } = await client.query('SELECT id FROM use_cases');
    const existingIds = new Set(existingUc.map(r => r.id));

    let inserted = 0;
    let skippedExcluded = 0;
    let skippedExisting = 0;
    const neededScorecards = new Set();

    for (const uc of data.useCases) {
      if (excludedIds.has(uc.id)) {
        skippedExcluded++;
        continue;
      }
      if (existingIds.has(uc.id)) {
        skippedExisting++;
        continue;
      }
      neededScorecards.add(uc.scorecard);
    }

    for (const sc of data.meta.scorecards) {
      if (!neededScorecards.has(sc.id)) continue;
      await client.query(
        'INSERT INTO scorecards (id, name, description) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [sc.id, sc.name, sc.description || '']
      );
    }

    for (const uc of data.useCases) {
      if (excludedIds.has(uc.id) || existingIds.has(uc.id)) continue;
      await client.query(
        `INSERT INTO use_cases (id, scorecard, scorecard_name, title, type, status, user_message, expected_behavior, criteria, rules, tags, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [uc.id, uc.scorecard, uc.scorecardName, uc.title, uc.type, uc.status, uc.userMessage, uc.expectedBehavior || '', JSON.stringify(uc.criteria || []), JSON.stringify(uc.rules || []), JSON.stringify(uc.tags || []), uc.notes]
      );
      inserted++;
    }

    console.log(`Seed sync: ${inserted} new, ${skippedExisting} existing (untouched), ${skippedExcluded} excluded (previously deleted)`);
  } catch (err) {
    console.error('Failed to seed from JSON:', err.message);
  }
}

async function getUseCasesJson() {
  const client = await pool.connect();
  try {
    const scResult = await client.query('SELECT * FROM scorecards ORDER BY id');
    const ucResult = await client.query('SELECT * FROM use_cases ORDER BY id');

    const scorecards = scResult.rows.map(sc => ({
      id: sc.id,
      name: sc.name,
      description: sc.description,
      count: ucResult.rows.filter(uc => uc.scorecard === sc.id).length
    }));

    const useCases = ucResult.rows.map(uc => ({
      id: uc.id,
      scorecard: uc.scorecard,
      scorecardName: uc.scorecard_name,
      title: uc.title,
      type: uc.type,
      status: uc.status,
      userMessage: uc.user_message,
      expectedBehavior: uc.expected_behavior,
      criteria: uc.criteria || [],
      rules: uc.rules || [],
      tags: uc.tags || [],
      notes: uc.notes
    }));

    return {
      meta: {
        title: 'Bryte AI Eval Use Cases',
        version: '2.0.0',
        totalCases: useCases.length,
        scorecards
      },
      useCases
    };
  } finally {
    client.release();
  }
}

app.get('/eval', (req, res) => {
  res.sendFile(path.join(__dirname, 'eval.html'));
});

app.get('/use-cases.json', async (req, res) => {
  try {
    const data = await getUseCasesJson();
    res.json(data);
  } catch (err) {
    console.error('Failed to load use cases:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/use-case-cache', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT use_case_id, cache_data FROM use_case_cache');
      const cache = {};
      rows.forEach(row => {
        cache[row.use_case_id] = row.cache_data;
      });
      res.json(cache);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to load cache:', err.message);
    res.json({});
  }
});

app.post('/api/use-case-cache', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cacheData = req.body;
      const incomingIds = Object.keys(cacheData);

      if (incomingIds.length > 0) {
        await client.query(
          'DELETE FROM use_case_cache WHERE use_case_id != ALL($1::text[])',
          [incomingIds]
        );
      } else {
        await client.query('DELETE FROM use_case_cache');
      }

      for (const [ucId, data] of Object.entries(cacheData)) {
        await client.query(
          `INSERT INTO use_case_cache (use_case_id, cache_data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (use_case_id) DO UPDATE SET cache_data = $2, updated_at = NOW()`,
          [ucId, JSON.stringify(data)]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  res.json({ configured: hasKey });
});

app.post('/api/gemini', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
    }

    if (!req.body || !req.body.body) {
      return res.status(400).json({ error: 'Missing request body' });
    }

    const { body: geminiBody, model } = req.body;
    const modelName = model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Gemini API error:', err.message);
    res.status(502).json({ error: 'Failed to reach Gemini API: ' + err.message });
  }
});

app.post('/api/use-cases', async (req, res) => {
  try {
    const { scorecard, scorecardName, title, userMessage } = req.body;
    if (!scorecard || !title || !userMessage) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    try {
      const scId = scorecard.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      const prefix = scId.substring(0, 4).toUpperCase();

      const { rows: existing } = await client.query(
        "SELECT id FROM use_cases WHERE id LIKE $1 ORDER BY id",
        [prefix + '-%']
      );
      const existingNums = existing.map(r => parseInt(r.id.split('-')[1]) || 0);
      const next = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
      const id = prefix + '-' + String(next).padStart(2, '0');

      const { rows: conflict } = await client.query('SELECT id FROM use_cases WHERE id = $1', [id]);
      if (conflict.length > 0) {
        return res.status(409).json({ error: 'ID conflict, please try again' });
      }

      await client.query(
        'INSERT INTO scorecards (id, name, description) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [scId, scorecardName || scorecard, '']
      );

      await client.query(
        `INSERT INTO use_cases (id, scorecard, scorecard_name, title, type, status, user_message, expected_behavior, criteria, rules, tags, notes)
         VALUES ($1, $2, $3, $4, 'single-turn', 'active', $5, '', '[]', '[]', '[]', NULL)`,
        [id, scId, scorecardName || scorecard, title, userMessage]
      );

      res.json({ success: true, id });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/use-cases/:id', async (req, res) => {
  try {
    const ucId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query('DELETE FROM use_cases WHERE id = $1', [ucId]);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Use case not found' });
      }

      await client.query(
        'INSERT INTO seed_exclusions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [ucId]
      );

      await client.query(`
        DELETE FROM scorecards WHERE id NOT IN (SELECT DISTINCT scorecard FROM use_cases)
      `);

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/export-use-cases', async (req, res) => {
  try {
    const data = await getUseCasesJson();
    const filePath = path.join(__dirname, 'use-cases.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Exported ${data.useCases.length} use cases to use-cases.json`);
    res.json({ success: true, count: data.useCases.length });
  } catch (err) {
    console.error('Failed to export use cases:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname)));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

let dbReady = false;

async function initWithRetry(retries = 8, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initDatabase();
      dbReady = true;
      console.log('Database initialized successfully');
      return;
    } catch (err) {
      console.error(`Database init attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) {
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error('All database init attempts failed. Server running without database.');
}

initWithRetry();
