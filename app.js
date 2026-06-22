const express = require('express');
const { createServer } = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : null;

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: ALLOWED_ORIGINS ?? '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,    // évite de casser les assets statiques (public/)
  crossOriginEmbedderPolicy: false // évite de casser Socket.IO
}));
app.use(cors({
  origin: ALLOWED_ORIGINS ?? '*',
  credentials: false
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes' }
});
const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de modifications, réessayez dans 15 minutes' }
});
app.use('/api', apiLimiter);
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    return mutationLimiter(req, res, next);
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Error logging to app_errors table (fire-and-forget)
async function logError({ source, message, details, userId, statusCode, level = 'error' }) {
  try {
    console.error(`[${source}] ${message}`, details ?? '');
    if (!process.env.DATABASE_URL) return;
    await pool.query(
      `INSERT INTO app_errors (source, level, message, details, user_id, status_code)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [source, level, message, details ? JSON.stringify(details) : null, userId ?? null, statusCode ?? null]
    );
  } catch {
    // never let logging break the app
  }
}

// Test DB connection and initialize tables
if (process.env.DATABASE_URL) {
  pool.query('SELECT NOW()', async (err) => {
    if (err) {
      console.error('[DB] Connection failed:', err.message);
    } else {
      console.log('[DB] Connected successfully');
      await initDatabase();
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

  socket.on('join-planning', ({ planningId, deviceId }) => {
    socket.join(`planning-${planningId}`);
    connectedUsers.set(socket.id, { planningId, deviceId });

    // Count users in this specific planning room
    const roomSockets = io.sockets.adapter.rooms.get(`planning-${planningId}`);
    const countInRoom = roomSockets ? roomSockets.size : 0;

    io.to(`planning-${planningId}`).emit('collaborator-joined', {
      deviceId,
      count: countInRoom
    });
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

// Update planning (collaborative sync)
app.patch('/api/planning/:id', async (req, res) => {
  try {
    const planningId = req.params.id;
    const { data, version, device } = req.body;

    if (!data || !version) {
      return res.status(400).json({ error: 'data and version required' });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    // Get current planning to check version
    const currentResult = await pool.query(
      'SELECT data FROM plannings WHERE id = $1',
      [planningId]
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Planning not found' });
    }

    const currentData = currentResult.rows[0].data;
    const currentVersion = currentData.__sync?.version || 0;

    // Check for conflicts (optimistic locking)
    if (version < currentVersion) {
      return res.status(409).json({
        error: 'Version conflict',
        message: 'Planning was modified by another user',
        currentVersion,
        yourVersion: version
      });
    }

    // Save backup before updating
    await pool.query(
      `INSERT INTO backups (planning_id, version, device, data)
       VALUES ($1, $2, $3, $4)`,
      [planningId, version, device, JSON.stringify(data)]
    );

    // Update planning with new version
    const newVersion = Math.max(version + 1, currentVersion + 1);
    const updatedData = {
      ...data,
      __sync: {
        ...data.__sync,
        version: newVersion,
        lastModified: Date.now(),
        device: device || 'unknown'
      }
    };

    await pool.query(
      `UPDATE plannings SET data = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedData), planningId]
    );

    // Broadcast update via WebSocket
    io.emit('planning-updated', {
      planningId,
      version: newVersion,
      device,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      version: newVersion,
      message: 'Planning updated successfully'
    });
  } catch (err) {
    console.error('[PATCH] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get planning changes since version (for polling sync)
app.get('/api/planning/:id/changes', async (req, res) => {
  try {
    const planningId = req.params.id;
    const sinceVersion = parseInt(req.query.since) || 0;

    if (!process.env.DATABASE_URL) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT version, device, created_at FROM backups
       WHERE planning_id = $1 AND version > $2
       ORDER BY version ASC LIMIT 50`,
      [planningId, sinceVersion]
    );

    res.json({
      changes: result.rows,
      count: result.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import planning from JSON backup
app.post('/api/planning/import', async (req, res) => {
  try {
    const planningData = req.body;

    // Validate structure
    if (!planningData || typeof planningData !== 'object') {
      return res.status(400).json({ error: 'Invalid planning data' });
    }

    // Generate or use existing ID
    const { v4: uuidv4 } = require('uuid');
    const planningId = planningData.id || `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const planningName = planningData.name || `Planning ${new Date().toLocaleDateString()}`;

    // Prepare data for storage
    const dataToStore = {
      id: planningId,
      name: planningName,
      domains: planningData.domains || [],
      projects: planningData.projects || [],
      roles: planningData.roles || [],
      responsables: planningData.responsables || [],
      users: planningData.users || [],
      hiddenProjects: planningData.hiddenProjects || [],
      closedPeriods: planningData.closedPeriods || [],
      holidaysEnabled: planningData.holidaysEnabled !== false,
      customPhaseTypes: planningData.customPhaseTypes || [],
      customMilestoneTypes: planningData.customMilestoneTypes || [],
      autoCloseAfterMepDays: planningData.autoCloseAfterMepDays || 30,
      __sync: {
        lastModified: Date.now(),
        lastSyncTime: null,
        syncStatus: 'synced',
        version: (planningData.__sync?.version || 0) + 1,
        device: 'import',
        sharePointUrl: null
      }
    };

    // Store in PostgreSQL
    if (process.env.DATABASE_URL) {
      await pool.query(
        'INSERT INTO plannings (id, name, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()',
        [planningId, planningName, JSON.stringify(dataToStore)]
      );
    }

    res.json({
      success: true,
      id: planningId,
      name: planningName,
      message: 'Planning imported successfully',
      projectCount: (planningData.projects || []).length,
      domainCount: (planningData.domains || []).length
    });
  } catch (err) {
    console.error('[Import] Error:', err.message);
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

// Initialize database tables — protégé par INIT_SECRET
app.post('/api/init-db', async (req, res) => {
  try {
    const secret = process.env.INIT_SECRET;
    if (!secret || req.headers['x-init-secret'] !== secret) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await initDatabase();
    res.json({ success: true, message: 'Database initialized' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track active collaborators (polling fallback for Vercel serverless)
const activeCollaborators = new Map(); // planningId -> Set of deviceIds

app.post('/api/planning/:id/join', (req, res) => {
  const { planningId, deviceId } = req.body;
  if (!activeCollaborators.has(planningId)) {
    activeCollaborators.set(planningId, new Set());
  }
  activeCollaborators.get(planningId).add(deviceId);

  // Auto-cleanup after 30 seconds of inactivity
  setTimeout(() => {
    if (activeCollaborators.has(planningId)) {
      activeCollaborators.get(planningId).delete(deviceId);
    }
  }, 30000);

  res.json({
    success: true,
    collaborators: Array.from(activeCollaborators.get(planningId)),
    count: activeCollaborators.get(planningId).size
  });
});

app.get('/api/planning/:id/collaborators', (req, res) => {
  const planningId = req.params.id;
  const collaborators = activeCollaborators.get(planningId);
  res.json({
    collaborators: collaborators ? Array.from(collaborators) : [],
    count: collaborators ? collaborators.size : 0
  });
});

// Home page - Frontend de test
app.get('/', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

// App intégrée - CCI Planning 2026
app.get('/app', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'app.html'));
});

// Global error handler — logs to app_errors then returns 500
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const source = `sync:${req.method}:${req.path}`;
  logError({
    source,
    message: err.message ?? 'Erreur interne',
    details: { stack: err.stack, body: req.body },
    statusCode: err.status ?? 500,
  }).catch(() => {});
  res.status(err.status ?? 500).json({ error: err.message ?? 'Erreur interne' });
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
