/**
 * PHOENIX ARENA - Server
 * Raw AI vs AI. No corporate bullshit.
 */

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const { Arena, setupDatabase } = require('./arena');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
    db = setupDatabase('./data/arena.db');
  } catch (e) {
    console.log('⚠️ Running without database');
    db = null;
  }
  
  arena = new Arena(db);
}

init();

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
    const { agents, prompt, maxTurns, turnDelay } = req.body;
    
    if (!agents || agents.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 agents' });
    }
    
    // Build agent configs
    const agentConfigs = agents.map((a, i) => ({
      name: a.name || `Agent ${i + 1}`,
      provider: a.provider || 'anthropic',
      model: a.model || config.defaultModel,
      soul: a.soul || null,
      brain: a.brain || null,
      endpoint: config.providers?.ollama?.endpoint || null
    }));
    
    const battle = await arena.createBattle({
      id: Date.now(),
      agents: agentConfigs,
      prompt: prompt || 'Begin.',
      maxTurns: maxTurns || 20,
      turnDelay: turnDelay || 3000
    });
    
    battle.start();
    
    res.json({
      success: true,
      battleId: battle.id,
      agents: battle.agents.map(a => ({ name: a.name, model: a.model }))
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
    config: {
      anthropic: config.providers?.anthropic?.enabled,
      ollama: config.providers?.ollama?.enabled
    }
  });
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
🔥 ═══════════════════════════════════════════════
   PHOENIX ARENA
   Port: ${PORT}
   Database: ${db ? 'Connected' : 'In-memory only'}
   
   No corporate roleplay. Raw AI vs AI.
═══════════════════════════════════════════════ 🔥
  `);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

module.exports = { app, arena };
