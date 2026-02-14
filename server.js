/**
 * PHOENIX ARENA - Server
 * AI vs AI conversation lab
 */

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');
const { Arena, setupDatabase } = require('./arena');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'phoenix-arena-dev-secret-change-in-prod';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve arena page
app.get('/arena', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'arena.html'));
});

// Serve archive page
app.get('/archive', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// Serve builder page
app.get('/builder', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'builder.html'));
});

// Serve battle viewer page
app.get('/battle/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'battle.html'));
});

// Load config
let config = {
  providers: {
    anthropic: { enabled: true },
    ollama: { enabled: false, endpoint: null }
  },
  defaultModel: 'claude-sonnet-4-20250514'
};

async function loadConfig() {
  try {
    const data = await fs.readFile('./config.json', 'utf8');
    config = { ...config, ...JSON.parse(data) };
    console.log('📋 Config loaded');
  } catch (e) {
    console.log('📋 Using default config');
  }
}

// Initialize
let db, arena;

async function init() {
  await loadConfig();
  
  try {
    db = setupDatabase('/data/arena.db');
    setupUserTable();
  } catch (e) {
    console.log('Running without database');
    db = null;
  }
  
  arena = new Arena(db);
}

init();

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    req.user = null;
    return next();
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

app.use(authMiddleware);

// ============================================================================
// AUTH ROUTES
// ============================================================================

// GitHub OAuth - Step 1: Redirect to GitHub
app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GitHub OAuth not configured' });
  }
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const redirectUri = `${protocol}://${req.get('host')}/auth/github/callback`;
  const scope = 'read:user';
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}`;
  
  res.redirect(url);
});

// GitHub OAuth - Step 2: Handle callback
app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  
  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    });
    
    const tokenData = await tokenRes.json();
    
    if (tokenData.error) {
      console.error('GitHub token error:', tokenData);
      return res.redirect('/?error=token_failed');
    }
    
    // Get user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json'
      }
    });
    
    const githubUser = await userRes.json();
    
    // Upsert user in database
    const user = upsertUser({
      github_id: githubUser.id,
      username: githubUser.login,
      avatar_url: githubUser.avatar_url,
      name: githubUser.name
    });
    
    // Generate JWT
    const token = jwt.sign({
      id: user.id,
      github_id: user.github_id,
      username: user.username,
      avatar_url: user.avatar_url
    }, JWT_SECRET, { expiresIn: '30d' });
    
    // Redirect to frontend with token
    res.redirect(`/?token=${token}`);
    
  } catch (e) {
    console.error('GitHub OAuth error:', e);
    res.redirect('/?error=oauth_failed');
  }
});

// Get current user
app.get('/auth/me', (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.json({ user: null });
  }
});

// Logout (client-side just deletes token, but we have endpoint for completeness)
app.post('/auth/logout', (req, res) => {
  res.json({ success: true });
});

// ============================================================================
// USER DATABASE
// ============================================================================

function setupUserTable() {
  if (!db) return;
  
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id INTEGER UNIQUE NOT NULL,
        username TEXT NOT NULL,
        avatar_url TEXT,
        name TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        soul TEXT,
        soul_name TEXT,
        brain TEXT,
        brain_name TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    
    // Create published_battles without foreign key constraint
    db.exec(`
      CREATE TABLE IF NOT EXISTS published_battles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        description TEXT,
        tags TEXT,
        agent1 TEXT,
        agent2 TEXT,
        prompt TEXT,
        turns INTEGER,
        transcript TEXT,
        preview TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        views INTEGER DEFAULT 0
      )
    `);
    
    console.log('User tables ready');
  } catch (e) {
    console.error('Failed to setup user tables:', e.message);
  }
}

function upsertUser(data) {
  if (!db) {
    // Return fake user for dev without db
    return { id: 1, ...data };
  }
  
  try {
    // Try to find existing user
    const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(data.github_id);
    
    if (existing) {
      // Update
      db.prepare(`
        UPDATE users SET username = ?, avatar_url = ?, name = ?, updated_at = strftime('%s', 'now')
        WHERE github_id = ?
      `).run(data.username, data.avatar_url, data.name, data.github_id);
      
      return { ...existing, ...data };
    } else {
      // Insert
      const result = db.prepare(`
        INSERT INTO users (github_id, username, avatar_url, name) VALUES (?, ?, ?, ?)
      `).run(data.github_id, data.username, data.avatar_url, data.name);
      
      return { id: result.lastInsertRowid, ...data };
    }
  } catch (e) {
    console.error('User upsert error:', e.message);
    return { id: 0, ...data };
  }
}

// ============================================================================
// API ROUTES
// ============================================================================

// Get config
app.get('/api/config', (req, res) => {
  res.json(config);
});

// Update config
app.post('/api/config', async (req, res) => {
  config = { ...config, ...req.body };
  try {
    await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
    res.json({ success: true, config });
  } catch (e) {
    res.json({ success: true, config, saved: false });
  }
});

// List available brains
app.get('/api/brains', async (req, res) => {
  try {
    const files = await fs.readdir('./brains');
    const brains = files.filter(f => f.endsWith('.json')).map(f => ({
      name: f.replace('.json', ''),
      path: `./brains/${f}`
    }));
    res.json(brains);
  } catch (e) {
    res.json([]);
  }
});

// Get available models
app.get('/api/models', (req, res) => {
  const models = [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic' },
    { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', provider: 'anthropic' }
  ];
  
  // Add Ollama models if enabled
  if (config.providers?.ollama?.enabled) {
    models.push(
      { id: 'llama3', name: 'Llama 3', provider: 'ollama' },
      { id: 'mistral', name: 'Mistral', provider: 'ollama' }
    );
  }
  
  res.json(models);
});

// Create and start battle
app.post('/api/battle', async (req, res) => {
  try {
    const { agents, prompt, useIndividualPrompts, anonymousMode, maxTurns, turnDelay, maxWords } = req.body;
    
    if (!agents || agents.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 agents' });
    }
    
    // Build agent configs
    const agentConfigs = agents.map((a, i) => ({
      name: a.name || `Agent ${i + 1}`,
      displayName: a.displayName || a.name || `Agent ${i + 1}`,
      provider: a.provider || 'anthropic',
      model: a.model || config.defaultModel,
      soul: a.soul || null,
      brain: a.brain || null,
      prompt: a.prompt || null, // Individual prompt per agent
      endpoint: config.providers?.ollama?.endpoint || null,
      anonymous: anonymousMode || false
    }));
    
    const battle = await arena.createBattle({
      id: Date.now(),
      agents: agentConfigs,
      prompt: prompt || null,
      useIndividualPrompts: useIndividualPrompts || false,
      anonymousMode: anonymousMode || false,
      maxTurns: maxTurns || 20,
      turnDelay: turnDelay || 3000,
      maxWords: maxWords || null
    });
    
    battle.start();
    
    res.json({
      success: true,
      battleId: battle.id,
      agents: battle.agents.map(a => ({ name: a.displayName || a.name, model: a.model }))
    });
    
  } catch (e) {
    console.error('Battle creation error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get battle status
app.get('/api/battle/:id', (req, res) => {
  const battle = arena.getBattle(parseInt(req.params.id));
  if (battle) {
    res.json(battle.toJSON());
  } else {
    const archived = arena.getBattleHistory(parseInt(req.params.id));
    if (archived) {
      res.json(archived);
    } else {
      res.status(404).json({ error: 'Battle not found' });
    }
  }
});

// Pause battle
app.post('/api/battle/:id/pause', (req, res) => {
  const battle = arena.getBattle(parseInt(req.params.id));
  if (battle) {
    battle.pause();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Battle not found' });
  }
});

// Resume battle
app.post('/api/battle/:id/resume', (req, res) => {
  const battle = arena.getBattle(parseInt(req.params.id));
  if (battle) {
    battle.resume();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Battle not found' });
  }
});

// List active battles
app.get('/api/battles', (req, res) => {
  res.json(arena.getAllBattles());
});

// List archived battles
app.get('/api/archive', (req, res) => {
  res.json(arena.getArchive());
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeBattles: arena.battles.size,
    spectators: arena.spectators.size,
    database: !!db,
    auth: !!GITHUB_CLIENT_ID,
    config: {
      anthropic: config.providers?.anthropic?.enabled,
      ollama: config.providers?.ollama?.enabled
    }
  });
});

// ============================================================================
// USER PRESETS
// ============================================================================

// Get user's presets
app.get('/api/presets', requireAuth, (req, res) => {
  if (!db) {
    return res.json([]);
  }
  
  try {
    const presets = db.prepare('SELECT * FROM user_presets WHERE user_id = ?').all(req.user.id);
    res.json(presets.map(p => ({
      ...p,
      brain: p.brain ? JSON.parse(p.brain) : null
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save preset
app.post('/api/presets', requireAuth, (req, res) => {
  if (!db) {
    return res.json({ success: true, id: Date.now() });
  }
  
  const { name, soul, soulName, brain, brainName } = req.body;
  
  try {
    const result = db.prepare(`
      INSERT INTO user_presets (user_id, name, soul, soul_name, brain, brain_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      name,
      soul || null,
      soulName || null,
      brain ? JSON.stringify(brain) : null,
      brainName || null
    );
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete preset
app.delete('/api/presets/:id', requireAuth, (req, res) => {
  if (!db) {
    return res.json({ success: true });
  }
  
  try {
    db.prepare('DELETE FROM user_presets WHERE id = ? AND user_id = ?').run(
      parseInt(req.params.id),
      req.user.id
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// ARCHIVE
// ============================================================================

// Get published battles
app.get('/api/archive/published', (req, res) => {
  if (!db) {
    return res.json([]);
  }
  
  try {
    const battles = db.prepare(`
      SELECT pb.*, u.username 
      FROM published_battles pb
      LEFT JOIN users u ON pb.user_id = u.id
      ORDER BY pb.created_at DESC
      LIMIT 50
    `).all();
    res.json(battles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single published battle
app.get('/api/archive/:id', (req, res) => {
  if (!db) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  try {
    const battle = db.prepare(`
      SELECT pb.*, u.username 
      FROM published_battles pb
      LEFT JOIN users u ON pb.user_id = u.id
      WHERE pb.id = ?
    `).get(parseInt(req.params.id));
    
    if (!battle) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    // Increment views
    db.prepare('UPDATE published_battles SET views = views + 1 WHERE id = ?').run(battle.id);
    
    res.json({
      ...battle,
      transcript: JSON.parse(battle.transcript || '[]')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publish battle to archive
app.post('/api/archive/publish', (req, res) => {
  if (!db) {
    return res.status(500).json({ error: 'Database not available' });
  }
  
  const { title, description, tags, agent1, agent2, prompt, transcript } = req.body;
  const userId = req.user?.id || null;
  
  try {
    const turns = transcript?.length || 0;
    const preview = transcript?.[0]?.content?.slice(0, 200) || '';
    
    const result = db.prepare(`
      INSERT INTO published_battles (user_id, title, description, tags, agent1, agent2, prompt, turns, transcript, preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      title || `${agent1} vs ${agent2}`,
      description || null,
      tags || null,
      agent1,
      agent2,
      prompt,
      turns,
      JSON.stringify(transcript),
      preview
    );
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// WEBSOCKET
// ============================================================================

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  arena.addSpectator(ws);
  
  ws.on('close', () => {
    arena.removeSpectator(ws);
  });
});

// ============================================================================
// SERVER
// ============================================================================

const server = app.listen(PORT, () => {
  console.log(`
PHOENIX ARENA
Port: ${PORT}
Database: ${db ? 'Connected' : 'In-memory'}
Auth: ${GITHUB_CLIENT_ID ? 'GitHub OAuth enabled' : 'Not configured'}
  `);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

module.exports = { app, arena };
