import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from 'pg';
const { Pool } = pkg;

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.VITE_API_URL || '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('[DB] Connection failed:', err.message);
  } else {
    console.log('[DB] Connected successfully');
  }
});

// Initialize DB tables
async function initDatabase() {
  try {
    const client = await pool.connect();

    // Plannings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS plannings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data JSONB NOT NULL,
        owner TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Backups table
    await client.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id SERIAL PRIMARY KEY,
        planning_id TEXT REFERENCES plannings(id) ON DELETE CASCADE,
        version INT NOT NULL,
        device TEXT,
        data JSONB NOT NULL,
        created_at_iso TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_backups_planning ON backups(planning_id, version);
    `);

    // Merge logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS merge_logs (
        id SERIAL PRIMARY KEY,
        planning_id TEXT REFERENCES plannings(id),
        your_version INT,
        colleague_version INT,
        action TEXT,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Collaborators
    await client.query(`
      CREATE TABLE IF NOT EXISTS collaborators (
        id SERIAL PRIMARY KEY,
        planning_id TEXT REFERENCES plannings(id),
        device_id TEXT,
        last_seen TIMESTAMP DEFAULT NOW(),
        UNIQUE(planning_id, device_id)
      );
    `);

    client.release();
    console.log('[DB] Tables initialized successfully');
  } catch (err) {
    console.error('[DB] Init error:', err.message);
  }
}

initDatabase();

// WebSocket connections
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  socket.on('join-planning', ({ planningId, deviceId }) => {
    socket.join(`planning-${planningId}`);
    connectedUsers.set(socket.id, { planningId, deviceId });
    io.to(`planning-${planningId}`).emit('collaborator-joined', { deviceId, count: connectedUsers.size });
    console.log(`[WS] ${deviceId} joined planning ${planningId}`);
  });

  socket.on('planning-modified', async ({ planningId, version, device, data }) => {
    try {
      // Save backup to DB
      const result = await pool.query(
        `INSERT INTO backups (planning_id, version, device, data, created_at_iso)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [planningId, version, device, JSON.stringify(data), new Date().toISOString()]
      );

      // Update planning
      await pool.query(
        `UPDATE plannings SET data = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(data), planningId]
      );

      // Broadcast to all clients in this planning room
      io.to(`planning-${planningId}`).emit('planning-updated', {
        planningId,
        version,
        device,
        data,
        timestamp: new Date().toISOString()
      });

      console.log(`[Sync] Backup saved v${version} for ${planningId}`);
    } catch (err) {
      console.error('[Sync] Error:', err.message);
      socket.emit('sync-error', { error: err.message });
    }
  });

  socket.on('get-backups', async ({ planningId }) => {
    try {
      const result = await pool.query(
        `SELECT * FROM backups WHERE planning_id = $1 ORDER BY version DESC LIMIT 50`,
        [planningId]
      );
      socket.emit('backups-loaded', result.rows);
    } catch (err) {
      console.error('[Backups] Error:', err.message);
      socket.emit('error', { error: err.message });
    }
  });

  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    connectedUsers.delete(socket.id);
    if (user) {
      io.to(`planning-${user.planningId}`).emit('collaborator-left', { deviceId: user.deviceId });
      console.log(`[WS] ${user.deviceId} left planning ${user.planningId}`);
    }
  });
});

// API Routes

// Get all plannings
app.get('/api/plannings', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, updated_at FROM plannings ORDER BY updated_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get planning data
app.get('/api/planning/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plannings WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Planning not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create planning
app.post('/api/planning', async (req, res) => {
  try {
    const { id, name, data } = req.body;
    await pool.query(
      'INSERT INTO plannings (id, name, data) VALUES ($1, $2, $3)',
      [id, name, JSON.stringify(data)]
    );
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get planning history
app.get('/api/planning/:id/history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT version, device, created_at FROM backups WHERE planning_id = $1 ORDER BY version DESC LIMIT 100',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve index
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
});

export { app, io, pool };
