/**
 * PHOENIX ARENA - Server
 * AI vs AI conversation lab
 */

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Arena, setupDatabase } = require('./arena');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'phoenix-arena-dev-secret-change-in-prod';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// Ensure uploads directory exists (persistent volume on Railway, local fallback)
const DATA_DIR = fsSync.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const uploadsDir = path.join(DATA_DIR, 'uploads');
if (!fsSync.existsSync(uploadsDir)) {
  fsSync.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
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

// Serve guide page
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guide.html'));
});

// Serve dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve profile page
app.get('/profile/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
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
  if (req.user && db) {
    try {
      // Fetch fresh user data from database
      const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      
      if (!freshUser) {
        return res.json({ user: null });
      }
      
      // Get followers/following counts
      let followers_count = 0;
      let following_count = 0;
      
      try {
        const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='follows'").get();
        if (tableExists) {
          const fc = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').get(freshUser.id);
          const fg = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').get(freshUser.id);
          followers_count = fc?.count || 0;
          following_count = fg?.count || 0;
        }
      } catch (e) {}
      
      res.json({ 
        user: {
          id: freshUser.id,
          username: freshUser.username,
          name: freshUser.name,
          avatar_url: freshUser.avatar_url,
          bio: freshUser.bio,
          api_key: freshUser.api_key,
          followers_count,
          following_count
        }
      });
    } catch (e) {
      res.json({ user: null });
    }
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
        bio TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Add bio column if not exists
    try {
      db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
    } catch (e) {} // Column might already exist

    // Add email column if not exists
    try {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    } catch (e) {} // Column might already exist

    // Auth providers table — supports GitHub, Google, email
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_providers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider    TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        created_at  INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(provider, provider_id)
      )
    `);

    // Migrate existing GitHub users (idempotent via INSERT OR IGNORE)
    db.exec(`
      INSERT OR IGNORE INTO auth_providers (user_id, provider, provider_id, created_at)
      SELECT id, 'github', CAST(github_id AS TEXT), created_at
      FROM users WHERE github_id IS NOT NULL
    `);

    // Make github_id nullable (required for Google/email users)
    // SQLite cannot DROP NOT NULL — must rebuild table
    try {
      const cols = db.prepare("PRAGMA table_info(users)").all();
      const githubCol = cols.find(c => c.name === 'github_id');
      if (githubCol && githubCol.notnull === 1) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS users_temp (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            github_id  INTEGER UNIQUE,
            username   TEXT NOT NULL,
            avatar_url TEXT,
            name       TEXT,
            bio        TEXT,
            email      TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          );
          INSERT OR IGNORE INTO users_temp SELECT id, github_id, username, avatar_url, name, bio, email, created_at, updated_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_temp RENAME TO users;
        `);
        console.log('Migrated users table: github_id is now nullable');
      }
    } catch (e) {
      console.error('Migration error (github_id nullable):', e.message);
    }

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
    
    // Likes table
    db.exec(`
      CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        battle_id INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(user_id, battle_id)
      )
    `);
    
    // Comments table
    db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        battle_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Comment votes table
    db.exec(`
      CREATE TABLE IF NOT EXISTS comment_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        vote INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(user_id, comment_id)
      )
    `);
    
    // Notifications table
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_user_id INTEGER,
        battle_id INTEGER,
        content TEXT,
        read INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    console.log('User tables ready');
  } catch (e) {
    console.error('Failed to setup user tables:', e.message);
  }
}

// Provider-agnostic user upsert.
// provider: 'github' | 'google' | 'email'
// providerId: string (github numeric id, google sub, or email address)
// profileData: { username, avatar_url, name, email? }
function upsertUser(provider, providerId, profileData) {
  if (!db) {
    return { id: 1, provider, username: profileData.username, ...profileData };
  }

  try {
    const providerIdStr = String(providerId);

    // Look up existing user via auth_providers
    const existing = db.prepare(`
      SELECT users.* FROM users
      JOIN auth_providers ON users.id = auth_providers.user_id
      WHERE auth_providers.provider = ? AND auth_providers.provider_id = ?
    `).get(provider, providerIdStr);

    if (existing) {
      // Respect user customisations
      const hasCustomAvatar = existing.avatar_url && existing.avatar_url.startsWith('/uploads/');
      const hasCustomName = existing.name && existing.name !== profileData.name;
      const hasCustomUsername = existing.username && existing.username !== profileData.username;

      const newAvatarUrl = hasCustomAvatar ? existing.avatar_url : profileData.avatar_url;
      const newName = hasCustomName ? existing.name : (profileData.name || existing.name);
      const newUsername = hasCustomUsername ? existing.username : profileData.username;

      db.prepare(`UPDATE users SET updated_at = strftime('%s', 'now') WHERE id = ?`).run(existing.id);

      return { ...existing, avatar_url: newAvatarUrl, name: newName, username: newUsername };
    } else {
      // Create new user
      const result = db.prepare(`
        INSERT INTO users (github_id, username, avatar_url, name, email)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        provider === 'github' ? Number(providerId) : null,
        profileData.username,
        profileData.avatar_url,
        profileData.name,
        profileData.email || null
      );

      const userId = result.lastInsertRowid;

      // Register the auth provider
      db.prepare(
        `INSERT OR IGNORE INTO auth_providers (user_id, provider, provider_id) VALUES (?, ?, ?)`
      ).run(userId, provider, providerIdStr);

      return { id: userId, ...profileData };
    }
  } catch (e) {
    console.error('User upsert error:', e.message);
    return { id: 0, ...profileData };
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
    
    // Check for user-provided API key
    const userApiKey = req.headers['x-user-api-key'];
    
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
      anonymous: anonymousMode || false,
      apiKey: userApiKey || null // Pass user's API key if provided
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
      SELECT pb.*, u.username,
        (SELECT COUNT(*) FROM likes WHERE battle_id = pb.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE battle_id = pb.id) as comment_count
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

// Get current user's battles
app.get('/api/archive/user', requireAuth, (req, res) => {
  if (!db) {
    return res.json([]);
  }
  
  try {
    const battles = db.prepare(`
      SELECT * FROM published_battles 
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);
    res.json(battles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get public profile by username
app.get('/api/profile/:username', (req, res) => {
  if (!db) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  try {
    const user = db.prepare(`
      SELECT id, username, name, avatar_url FROM users WHERE username = ?
    `).get(req.params.username);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const battles = db.prepare(`
      SELECT * FROM published_battles 
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(user.id);
    
    res.json({ user, battles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update user profile
app.post('/api/profile/update', requireAuth, (req, res) => {
  const { name, username, bio } = req.body;
  
  if (!username || !username.match(/^[a-z0-9_]+$/)) {
    return res.status(400).json({ error: 'Invalid username' });
  }
  
  try {
    // Check if username is taken by another user
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    
    db.prepare('UPDATE users SET name = ?, username = ?, bio = ? WHERE id = ?').run(name, username, bio, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Avatar upload (base64)
app.post('/api/profile/avatar', requireAuth, express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { avatar } = req.body;
    
    if (!avatar || !avatar.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    
    // Extract base64 data - more permissive regex for mime types like image/png, image/jpeg, image/webp
    const matches = avatar.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image format' });
    }
    
    let ext = matches[1];
    // Normalize extension
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    
    const data = matches[2];
    const buffer = Buffer.from(data, 'base64');
    
    // Check file size (2MB max)
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image must be under 2MB' });
    }
    
    // Save file
    const filename = `avatar_${req.user.id}_${Date.now()}.${ext}`;
    const filepath = path.join(uploadsDir, filename);
    fsSync.writeFileSync(filepath, buffer);
    
    // Update user avatar_url
    const avatarUrl = `/uploads/${filename}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);
    
    res.json({ success: true, avatar_url: avatarUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save API key to profile
app.post('/api/profile/apikey', requireAuth, (req, res) => {
  const { apiKey } = req.body;
  
  try {
    // Add api_key column if not exists
    try {
      db.exec('ALTER TABLE users ADD COLUMN api_key TEXT');
    } catch (e) {} // Column might already exist
    
    db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(apiKey || null, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get top users by battle count
app.get('/api/users/top', (req, res) => {
  if (!db) return res.json([]);
  
  try {
    // Get all users with at least one battle
    const users = db.prepare(`
      SELECT u.id, u.username, u.name, u.avatar_url, COUNT(pb.id) as battle_count
      FROM users u
      LEFT JOIN published_battles pb ON u.id = pb.user_id
      GROUP BY u.id
      HAVING battle_count > 0
      ORDER BY battle_count DESC
      LIMIT 10
    `).all();
    
    // If no users with battles, return all users
    if (users.length === 0) {
      const allUsers = db.prepare(`
        SELECT id, username, name, avatar_url, 0 as battle_count
        FROM users
        LIMIT 10
      `).all();
      return res.json(allUsers);
    }
    
    res.json(users);
  } catch (e) {
    res.json([]);
  }
});

// Get followers/following
app.get('/api/users/:username/followers', (req, res) => {
  if (!db) return res.json([]);
  
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.json([]);
    
    // Check if follows table exists, if not return empty
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='follows'").get();
    if (!tableExists) return res.json([]);
    
    const followers = db.prepare(`
      SELECT u.id, u.username, u.name, u.avatar_url
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = ?
    `).all(user.id);
    res.json(followers);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/users/:username/following', (req, res) => {
  if (!db) return res.json([]);
  
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.json([]);
    
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='follows'").get();
    if (!tableExists) return res.json([]);
    
    const following = db.prepare(`
      SELECT u.id, u.username, u.name, u.avatar_url
      FROM follows f
      JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = ?
    `).all(user.id);
    res.json(following);
  } catch (e) {
    res.json([]);
  }
});

// Follow/unfollow
app.post('/api/users/:username/follow', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.id === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
    
    // Create follows table if not exists
    db.exec(`CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER,
      following_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (follower_id, following_id)
    )`);
    
    // Check if already following
    const existing = db.prepare('SELECT * FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, targetUser.id);
    
    if (!existing) {
      db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, targetUser.id);
      
      // Create notification
      db.prepare(`
        INSERT INTO notifications (user_id, type, from_user_id, content)
        VALUES (?, 'follow', ?, 'started following you')
      `).run(targetUser.id, req.user.id);
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:username/unfollow', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, targetUser.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a battle
app.delete('/api/archive/:id', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const battle = db.prepare('SELECT * FROM published_battles WHERE id = ?').get(parseInt(req.params.id));
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    
    db.prepare('DELETE FROM published_battles WHERE id = ?').run(battle.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// LIKES
// ============================================================================

// Like a battle
app.post('/api/battles/:id/like', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const battleId = parseInt(req.params.id);
    const battle = db.prepare('SELECT * FROM published_battles WHERE id = ?').get(battleId);
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    
    // Add like
    db.prepare('INSERT OR IGNORE INTO likes (user_id, battle_id) VALUES (?, ?)').run(req.user.id, battleId);
    
    // Create notification for battle owner (if not self)
    if (battle.user_id && battle.user_id !== req.user.id) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, from_user_id, battle_id, content)
        VALUES (?, 'like', ?, ?, ?)
      `).run(battle.user_id, req.user.id, battleId, `liked your battle '${battle.title || 'Untitled'}'`);
    }
    
    // Get updated like count
    const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE battle_id = ?').get(battleId);
    res.json({ success: true, likes: count.count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlike a battle
app.delete('/api/battles/:id/like', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const battleId = parseInt(req.params.id);
    db.prepare('DELETE FROM likes WHERE user_id = ? AND battle_id = ?').run(req.user.id, battleId);
    
    const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE battle_id = ?').get(battleId);
    res.json({ success: true, likes: count.count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get likes for a battle
app.get('/api/battles/:id/likes', (req, res) => {
  if (!db) return res.json({ likes: 0, liked: false });
  
  try {
    const battleId = parseInt(req.params.id);
    const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE battle_id = ?').get(battleId);
    
    let liked = false;
    if (req.user) {
      const userLike = db.prepare('SELECT id FROM likes WHERE user_id = ? AND battle_id = ?').get(req.user.id, battleId);
      liked = !!userLike;
    }
    
    res.json({ likes: count.count, liked });
  } catch (e) {
    res.json({ likes: 0, liked: false });
  }
});

// ============================================================================
// COMMENTS
// ============================================================================

// Get comments for a battle
app.get('/api/battles/:id/comments', (req, res) => {
  if (!db) return res.json([]);
  
  try {
    const battleId = parseInt(req.params.id);
    const comments = db.prepare(`
      SELECT c.*, u.username, u.avatar_url, u.name,
        (SELECT COUNT(*) FROM comment_votes WHERE comment_id = c.id AND vote = 1) as upvotes,
        (SELECT COUNT(*) FROM comment_votes WHERE comment_id = c.id AND vote = -1) as downvotes
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.battle_id = ?
      ORDER BY c.created_at DESC
    `).all(battleId);
    
    // Add user's vote if logged in
    if (req.user) {
      comments.forEach(c => {
        const userVote = db.prepare('SELECT vote FROM comment_votes WHERE user_id = ? AND comment_id = ?').get(req.user.id, c.id);
        c.userVote = userVote ? userVote.vote : 0;
      });
    }
    
    res.json(comments);
  } catch (e) {
    res.json([]);
  }
});

// Add comment to a battle
app.post('/api/battles/:id/comments', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  const { content } = req.body;
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Comment cannot be empty' });
  }
  
  try {
    const battleId = parseInt(req.params.id);
    const battle = db.prepare('SELECT * FROM published_battles WHERE id = ?').get(battleId);
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    
    const result = db.prepare('INSERT INTO comments (user_id, battle_id, content) VALUES (?, ?, ?)').run(req.user.id, battleId, content.trim());
    
    // Create notification for battle owner (if not self)
    if (battle.user_id && battle.user_id !== req.user.id) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, from_user_id, battle_id, content)
        VALUES (?, 'comment', ?, ?, ?)
      `).run(battle.user_id, req.user.id, battleId, `commented on your battle '${battle.title || 'Untitled'}'`);
    }
    
    // Return the new comment with user info
    const comment = db.prepare(`
      SELECT c.*, u.username, u.avatar_url, u.name
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.id = ?
    `).get(result.lastInsertRowid);
    
    res.json(comment);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a comment
app.delete('/api/comments/:id', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(parseInt(req.params.id));
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    
    db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vote on a comment (upvote/downvote)
app.post('/api/comments/:id/vote', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  const { vote } = req.body; // 1 for upvote, -1 for downvote, 0 to remove
  if (![1, -1, 0].includes(vote)) {
    return res.status(400).json({ error: 'Invalid vote value' });
  }
  
  try {
    const commentId = parseInt(req.params.id);
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    
    if (vote === 0) {
      // Remove vote
      db.prepare('DELETE FROM comment_votes WHERE user_id = ? AND comment_id = ?').run(req.user.id, commentId);
    } else {
      // Upsert vote
      db.prepare(`
        INSERT INTO comment_votes (user_id, comment_id, vote) VALUES (?, ?, ?)
        ON CONFLICT(user_id, comment_id) DO UPDATE SET vote = ?
      `).run(req.user.id, commentId, vote, vote);

      // Notify comment owner on upvote (not self)
      if (vote === 1 && comment.user_id !== req.user.id) {
        const battle = db.prepare('SELECT title FROM published_battles WHERE id = ?').get(comment.battle_id);
        db.prepare(`
          INSERT INTO notifications (user_id, type, from_user_id, battle_id, content)
          VALUES (?, 'comment_vote', ?, ?, ?)
        `).run(comment.user_id, req.user.id, comment.battle_id, `upvoted your comment on '${battle?.title || 'Untitled'}'`);
      }
    }
    
    // Get updated vote counts
    const upvotes = db.prepare('SELECT COUNT(*) as count FROM comment_votes WHERE comment_id = ? AND vote = 1').get(commentId);
    const downvotes = db.prepare('SELECT COUNT(*) as count FROM comment_votes WHERE comment_id = ? AND vote = -1').get(commentId);
    
    res.json({ 
      success: true, 
      upvotes: upvotes.count, 
      downvotes: downvotes.count,
      score: upvotes.count - downvotes.count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user's total received likes
app.get('/api/users/:username/stats', (req, res) => {
  if (!db) return res.json({ totalLikes: 0 });
  
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.json({ totalLikes: 0 });
    
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM likes l
      JOIN published_battles pb ON l.battle_id = pb.id
      WHERE pb.user_id = ?
    `).get(user.id);
    
    res.json({ totalLikes: result.count });
  } catch (e) {
    res.json({ totalLikes: 0 });
  }
});

// ============================================================================
// NOTIFICATIONS
// ============================================================================

// Get notifications for current user
app.get('/api/notifications', requireAuth, (req, res) => {
  if (!db) return res.json([]);
  
  try {
    const notifications = db.prepare(`
      SELECT n.*, u.username as from_username, u.avatar_url as from_avatar
      FROM notifications n
      LEFT JOIN users u ON n.from_user_id = u.id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT 50
    `).all(req.user.id);
    res.json(notifications);
  } catch (e) {
    res.json([]);
  }
});

// Get unread notification count
app.get('/api/notifications/unread', requireAuth, (req, res) => {
  if (!db) return res.json({ count: 0 });
  
  try {
    const result = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id);
    res.json({ count: result.count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// Mark notifications as read
app.post('/api/notifications/read', requireAuth, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add notification when someone follows (update follow endpoint)


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
