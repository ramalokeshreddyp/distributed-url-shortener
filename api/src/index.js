import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { connectServices } from './db.js';
import router from './routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static('public'));

// Setup Routes
app.use(router);

// Main Server Startup
async function startServer() {
  try {
    await connectServices();
    app.listen(PORT, () => {
      console.log(`API Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Server failed to start:', err);
    process.exit(1);
  }
}

startServer();
