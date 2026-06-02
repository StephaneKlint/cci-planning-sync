const express = require('express');
const { createServer } = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test DB connection
if (process.env.DATABASE_URL) {
  pool.query('SELECT NOW()', (err) => {
    if (err) {
      console.error('[DB] Connection failed:', err.message);
    } else {
      console.log('[DB] Connected successfully');
      initDatabase();
    }
  });
}

// Initialize Database Tables
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
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_backups_planning ON backups(planning_id, version);
    `);

    // Collaborators table
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

// WebSocket Connection Management
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  socket.on('join-planning', ({ planningId, deviceId }) => {
    socket.join(`planning-${planningId}`);
    connectedUsers.set(socket.id, { planningId, deviceId });
    io.to(`planning-${planningId}`).emit('collaborator-joined', { 
      deviceId, 
      count: connectedUsers.size 
    });
    console.log(`[WS] ${deviceId} joined planning ${planningId}`);
  });

  socket.on('planning-modified', async ({ planningId, version, device, data }) => {
    try {
      if (process.env.DATABASE_URL) {
        // Save backup to PostgreSQL
        await pool.query(
          `INSERT INTO backups (planning_id, version, device, data)
           VALUES ($1, $2, $3, $4)`,
          [planningId, version, device, JSON.stringify(data)]
        );

        // Update planning
        await pool.query(
          `UPDATE plannings SET data = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(data), planningId]
        );
      }

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

  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    connectedUsers.delete(socket.id);
    if (user) {
      io.to(`planning-${user.planningId}`).emit('collaborator-left', { 
        deviceId: user.deviceId 
      });
      console.log(`[WS] ${user.deviceId} left planning ${user.planningId}`);
    }
  });
});

// API Routes

// Get all plannings
app.get('/api/plannings', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json([]);
    }
    const result = await pool.query(
      'SELECT id, name, updated_at FROM plannings ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get planning data
app.get('/api/planning/:id', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(404).json({ error: 'No database configured' });
    }
    const result = await pool.query(
      'SELECT * FROM plannings WHERE id = $1',
      [req.params.id]
    );
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
    if (!id || !name) {
      return res.status(400).json({ error: 'id and name required' });
    }

    if (process.env.DATABASE_URL) {
      await pool.query(
        'INSERT INTO plannings (id, name, data) VALUES ($1, $2, $3)',
        [id, name, JSON.stringify(data || {})]
      );
    }

    res.json({ success: true, id, message: 'Planning created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get planning history
app.get('/api/planning/:id/history', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json([]);
    }
    const result = await pool.query(
      `SELECT version, device, created_at FROM backups 
       WHERE planning_id = $1 ORDER BY version DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: process.env.DATABASE_URL ? 'configured' : 'not configured',
    websocket: 'ready'
  });
});

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>CCI Planning - Ready!</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 40px;
            text-align: center;
            background: #f5f5f5;
          }
          h1 { color: #10b981; margin: 0; }
          p { color: #666; margin: 20px 0; }
          code {
            background: #f0f0f0;
            padding: 10px;
            display: block;
            margin: 20px 0;
            border-radius: 4px;
            font-family: monospace;
            text-align: left;
          }
          .status { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
          .endpoints { text-align: left; margin-top: 20px; }
          .endpoints h3 { margin-top: 15px; }
          .endpoints ul { margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="status">
          <h1>✅ CCI Planning Server is Ready!</h1>
          <p>Express + Socket.IO + PostgreSQL</p>
          <code>https://cci-planning-sync.vercel.app</code>
          
          <div class="endpoints">
            <h3>📡 WebSocket Events</h3>
            <ul>
              <li><code>socket.emit('join-planning', {planningId, deviceId})</code></li>
              <li><code>socket.emit('planning-modified', {planningId, version, device, data})</code></li>
              <li><code>socket.on('planning-updated', data)</code></li>
            </ul>
            
            <h3>🔌 API Endpoints</h3>
            <ul>
              <li><code>GET /api/plannings</code></li>
              <li><code>POST /api/planning</code></li>
              <li><code>GET /api/planning/:id</code></li>
              <li><code>GET /api/planning/:id/history</code></li>
              <li><code>GET /health</code></li>
            </ul>
            
            <p style="margin-top: 30px; font-size: 14px; color: #999;">
              Status: <strong style="color: #10b981;">LIVE</strong><br>
              Database: <strong>${process.env.DATABASE_URL ? '✅ Connected' : '⚠️ Not configured'}</strong><br>
              WebSocket: <strong style="color: #10b981;">✅ Ready</strong>
            </p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Server startup (only in development)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
    console.log(`[Server] WebSocket: ws://localhost:${PORT}`);
  });
}

module.exports = app;
