import pg from 'pg';
import { createClient } from 'redis';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

const STREAM_NAME = 'clicks';
const GROUP_NAME = 'analytics-group';
const WORKER_NAME = process.env.WORKER_NAME || 'worker-1';

// 1. Micro HTTP Health Check Server
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(3001, () => {
    console.log(`Worker health check server listening on port 3001`);
  });
}

// 2. Setup Redis Consumer Group
async function setupConsumerGroup() {
  try {
    // Create the stream and group. MKSTREAM option creates the stream if it doesn't exist
    await redisClient.xGroupCreate(STREAM_NAME, GROUP_NAME, '$', { MKSTREAM: true });
    console.log(`Consumer group ${GROUP_NAME} created successfully`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`Consumer group ${GROUP_NAME} already exists`);
    } else {
      console.error('Error creating consumer group:', err);
      throw err;
    }
  }
}

// 3. Process a Batch of Click Events
async function processBatch(messages) {
  if (!messages || messages.length === 0) return;

  const aggregates = {};
  const messageIds = [];

  for (const item of messages) {
    const { id, message } = item;
    const { short_code, timestamp } = message;

    if (!short_code || !timestamp) {
      console.warn(`Skipping invalid message format:`, item);
      messageIds.push(id); // Acknowledge to clear it out
      continue;
    }

    // Truncate timestamp to hour
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.warn(`Skipping invalid timestamp: ${timestamp}`);
      messageIds.push(id);
      continue;
    }
    
    date.setUTCMinutes(0, 0, 0);
    const hourStr = date.toISOString();

    const key = `${short_code}_${hourStr}`;
    if (!aggregates[key]) {
      aggregates[key] = {
        short_code,
        hour: hourStr,
        count: 0
      };
    }
    aggregates[key].count += 1;
    messageIds.push(id);
  }

  // Perform SQL UPSERT within a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of Object.keys(aggregates)) {
      const { short_code, hour, count } = aggregates[key];
      await client.query(
        `INSERT INTO analytics_hourly (short_code, hour, click_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (short_code, hour)
         DO UPDATE SET click_count = analytics_hourly.click_count + EXCLUDED.click_count`,
        [short_code, hour, count]
      );
    }
    await client.query('COMMIT');
    console.log(`Worker processed batch of ${messages.length} messages and committed updates`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error committing database transactions, batch will NOT be acknowledged:', err);
    throw err; // Throwing avoids acknowledging the messages, leaving them in the PEL
  } finally {
    client.release();
  }

  // Acknowledge messages in Redis Stream to clear them from Pending Entries List (PEL)
  if (messageIds.length > 0) {
    try {
      await redisClient.xAck(STREAM_NAME, GROUP_NAME, messageIds);
    } catch (err) {
      console.error('Failed to acknowledge messages in Redis:', err);
    }
  }
}

// 4. Main Event Loop
async function run() {
  let running = true;
  let readPending = true;

  console.log(`Starting worker event loop: consumer = ${WORKER_NAME}`);

  while (running) {
    try {
      // Read pending messages first (id = '0') then read new messages (id = '>')
      const streamId = readPending ? '0' : '>';
      
      const result = await redisClient.xReadGroup(
        GROUP_NAME,
        WORKER_NAME,
        [{ key: STREAM_NAME, id: streamId }],
        { COUNT: 100, BLOCK: 2000 }
      );

      if (!result || result.length === 0 || result[0].messages.length === 0) {
        if (readPending) {
          // Finished processing historical pending messages, transition to listening for new messages
          readPending = false;
          console.log('Finished processing pending messages. Listening for new events...');
        }
        continue;
      }

      const messages = result[0].messages;
      await processBatch(messages);

    } catch (err) {
      console.error('Error in event loop:', err);
      readPending = true;
      if (err.message && err.message.includes('NOGROUP')) {
        console.log('Consumer group or stream missing (possibly due to Redis flush). Recreating group...');
        try {
          await setupConsumerGroup();
          readPending = true; // Reset pending state to re-evaluate
        } catch (recreateErr) {
          console.error('Failed to recreate consumer group:', recreateErr);
        }
      }
      // Wait a moment before retrying to prevent hot loop on connection errors
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

// Initialize and Start
async function start() {
  // Connect DB
  let dbConnected = false;
  for (let i = 0; i < 5; i++) {
    try {
      const client = await pool.connect();
      client.release();
      dbConnected = true;
      console.log('Worker connected to PostgreSQL');
      break;
    } catch (err) {
      console.warn(`Worker failed to connect to PG (attempt ${i + 1}/5):`, err.message);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  if (!dbConnected) {
    console.error('Worker could not connect to PostgreSQL');
    process.exit(1);
  }

  // Connect Redis
  try {
    await redisClient.connect();
    console.log('Worker connected to Redis');
  } catch (err) {
    console.error('Worker failed to connect to Redis:', err);
    process.exit(1);
  }

  // Setup stream and group
  await setupConsumerGroup();

  // Start healthcheck server
  startHealthServer();

  // Run the loop
  run();
}

start();
