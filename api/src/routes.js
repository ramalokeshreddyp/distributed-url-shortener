import express from 'express';
import path from 'path';
import { pool, redisClient } from './db.js';
import { generateHashId, generateSnowflakeId } from './idGenerator.js';

const router = express.Router();

// Helper to determine TTL for Redis caching
function getCacheTTL(expiresAt) {
  const defaultTTL = 86400; // 24 hours in seconds
  if (!expiresAt) {
    return defaultTTL;
  }
  const remainingTime = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (remainingTime <= 0) {
    return 0;
  }
  return Math.min(defaultTTL, remainingTime);
}

// 1. Healthcheck Endpoint
router.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    return res.status(200).json({ status: 'healthy' });
  } catch (err) {
    console.error('Healthcheck failed:', err);
    return res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// 2. Shorten URL Endpoint
router.post('/api/shorten', async (req, res) => {
  const { url, strategy, expires_at } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!strategy || (strategy !== 'hash' && strategy !== 'snowflake')) {
    return res.status(400).json({ error: 'strategy must be either "hash" or "snowflake"' });
  }

  const expiresAtVal = expires_at ? new Date(expires_at) : null;
  if (expiresAtVal && isNaN(expiresAtVal.getTime())) {
    return res.status(400).json({ error: 'invalid expires_at timestamp' });
  }

  let shortCode;
  let attempt = 0;
  const maxAttempts = 5;
  let success = false;

  while (attempt < maxAttempts && !success) {
    try {
      if (strategy === 'hash') {
        shortCode = generateHashId(url, attempt);
      } else {
        shortCode = generateSnowflakeId();
      }

      await pool.query(
        'INSERT INTO urls (short_code, original_url, strategy, expires_at) VALUES ($1, $2, $3, $4)',
        [shortCode, url, strategy, expiresAtVal]
      );

      success = true;
    } catch (err) {
      // 23505 is PostgreSQL unique_violation error code
      if (err.code === '23505') {
        attempt++;
        console.warn(`Collision detected for short_code: ${shortCode}, retrying... (Attempt ${attempt}/${maxAttempts})`);
      } else {
        console.error('Database insertion error:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  if (!success) {
    return res.status(500).json({ error: 'Failed to generate a unique short code. Please try again.' });
  }

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return res.status(201).json({
    short_url: `${baseUrl}/${shortCode}`
  });
});

// 3. Analytics Endpoint
router.get('/api/analytics/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const urlCheck = await pool.query('SELECT 1 FROM urls WHERE short_code = $1', [shortCode]);
    if (urlCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    const result = await pool.query(
      'SELECT hour, click_count as clicks FROM analytics_hourly WHERE short_code = $1 ORDER BY hour ASC',
      [shortCode]
    );

    const history = result.rows.map(row => ({
      hour: row.hour.toISOString(),
      clicks: parseInt(row.clicks, 10)
    }));

    const total_clicks = history.reduce((sum, item) => sum + item.clicks, 0);

    return res.status(200).json({
      total_clicks,
      history
    });
  } catch (err) {
    console.error('Analytics retrieval error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. Redirect Endpoint
router.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  const cacheKey = `url:${shortCode}`;

  try {
    // A. Check Redis Cache
    const cachedData = await redisClient.get(cacheKey);

    if (cachedData) {
      const data = JSON.parse(cachedData);
      
      // Check if expired in cache
      if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
        return res.status(404).send('Not Found: This link has expired');
      }

      // Publish click event asynchronously (fire and forget)
      redisClient.xAdd('clicks', '*', {
        short_code: shortCode,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Redis Streams publish error:', err));

      res.setHeader('X-Cache-Status', 'HIT');
      return res.redirect(302, data.original_url);
    }

    // B. Cache Miss: Query Postgres
    const dbResult = await pool.query(
      'SELECT original_url, expires_at FROM urls WHERE short_code = $1',
      [shortCode]
    );

    if (dbResult.rowCount === 0) {
      return res.status(404).send('Not Found');
    }

    const { original_url, expires_at } = dbResult.rows[0];

    // Check if expired
    if (expires_at && new Date(expires_at).getTime() < Date.now()) {
      return res.status(404).send('Not Found: This link has expired');
    }

    // C. Cache in Redis
    const ttl = getCacheTTL(expires_at);
    if (ttl > 0) {
      await redisClient.set(cacheKey, JSON.stringify({ original_url, expires_at }), {
        EX: ttl
      });
    }

    // D. Publish click event
    redisClient.xAdd('clicks', '*', {
      short_code: shortCode,
      timestamp: new Date().toISOString()
    }).catch(err => console.error('Redis Streams publish error:', err));

    res.setHeader('X-Cache-Status', 'MISS');
    return res.redirect(302, original_url);

  } catch (err) {
    console.error('Redirect handler error:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// 5. Catch-all for Frontend Analytics Routing
router.get('/analytics/:shortCode', (req, res) => {
  res.sendFile(path.resolve('public/index.html'));
});

export default router;
