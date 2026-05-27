import pg from 'pg';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// PostgreSQL pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Redis client
export const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

export async function connectServices() {
  // Retry database connection
  let dbConnected = false;
  for (let i = 0; i < 5; i++) {
    try {
      const client = await pool.connect();
      client.release();
      dbConnected = true;
      console.log('Connected to PostgreSQL database');
      break;
    } catch (err) {
      console.warn(`Failed to connect to PG (attempt ${i + 1}/5):`, err.message);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  if (!dbConnected) {
    throw new Error('Could not connect to PostgreSQL database after multiple attempts');
  }

  // Connect to Redis
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    throw err;
  }
}
