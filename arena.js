/**
 * PHOENIX ARENA - Core Engine
 * AI vs AI Conversation System
 * The foundation for The Cage
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');

// ============================================================================
// MODEL PROVIDERS
// ============================================================================

class ModelProvider {
  constructor(config) {
    this.config = config;
  }

  async chat(messages, systemPrompt) {
    throw new Error('Not implemented');
  }
}

class AnthropicProvider extends ModelProvider {
  constructor(config) {
    super(config);
    this.client = new Anthropic({ 
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY 
    });
  }

  async chat(messages, systemPrompt) {
    const response = await this.client.messages.create({
      model: this.config.model || 'claude-sonnet-4-20250514',
      max_tokens: this.config.maxTokens || 1000,
      system: systemPrompt,
      messages: messages
    });
    return response.content[0].text;
  }
}

class OllamaProvider extends ModelProvider {
  constructor(config) {
    super(config);
    this.endpoint = config.endpoint || 'http://localhost:11434';
    this.model = config.model || 'llama3';
  }

  async chat(messages, systemPrompt) {
    // Convert messages to Ollama format
    const prompt = this.buildPrompt(messages, systemPrompt);
    
    const response = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false
      })
    });
    
    const data = await response.json();
    return data.response;
  }

  buildPrompt(messages, systemPrompt) {
    let prompt = systemPrompt + '\n\n';
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'Human' : 'Assistant';
      prompt += `${role}: ${msg.content}\n\n`;
    }
    prompt += 'Assistant:';
    return prompt;
  }
}

// Provider factory
function createProvider(config) {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      return new AnthropicProvider(config);
  }
}

// ============================================================================
// AGENT
// ============================================================================

class Agent {
  constructor(config) {
    this.id = config.id || `agent_${Date.now()}`;
    this.name = config.name || 'Agent';
    this.provider = createProvider(config);
    this.soul = config.soul || 'You are an AI assistant.';
    this.brain = config.brain || null; // Path to brain file
    this.memory = []; // Loaded brain memories
    this.config = config;
  }

  async loadBrain() {
    if (!this.brain) return;
    
    try {
      const data = await fs.readFile(this.brain, 'utf8');
      const brain = JSON.parse(data);
      this.memory = brain;
      console.log(`🧠 Loaded brain for ${this.name}: ${Object.keys(brain).length} memories`);
    } catch (e) {
      console.log(`⚠️ No brain file found for ${this.name}, starting fresh`);
      this.memory = {};
    }
  }

  async saveBrain() {
    if (!this.brain) return;
    
    try {
      await fs.writeFile(this.brain, JSON.stringify(this.memory, null, 2));
      console.log(`💾 Saved brain for ${this.name}`);
    } catch (e) {
      console.error(`❌ Failed to save brain for ${this.name}:`, e.message);
    }
  }

  buildSystemPrompt() {
    let prompt = this.soul;
    
    // Inject memories if available
    if (this.memory && Object.keys(this.memory).length > 0) {
      prompt += '\n\n## Your Memories\n';
      
      if (this.memory.knowledgeGraph?.concepts) {
        const concepts = this.memory.knowledgeGraph.concepts;
        if (Array.isArray(concepts) && concepts.length > 0) {
          prompt += 'Key knowledge you remember:\n';
          concepts.slice(0, 20).forEach(([key, data]) => {
            prompt += `- ${data.name}: ${data.definition}\n`;
          });
        }
      }
      
      if (this.memory.stats) {
        prompt += `\nYou have had ${this.memory.stats.totalConversations || 0} conversations and learned ${this.memory.stats.conceptsLearned || 0} concepts.\n`;
      }
    }
    
    return prompt;
  }

  async respond(messages) {
    const systemPrompt = this.buildSystemPrompt();
    return await this.provider.chat(messages, systemPrompt);
  }

  // Add new memory from conversation
  addMemory(key, value) {
    if (!this.memory.conversationMemories) {
      this.memory.conversationMemories = [];
    }
    this.memory.conversationMemories.push({
      key,
      value,
      timestamp: Date.now()
    });
  }
}

// ============================================================================
// BATTLE
// ============================================================================

class Battle {
  constructor(config, db, broadcast) {
    this.id = config.id || Date.now();
    this.agents = config.agents || [];
    this.topic = config.topic || 'Have a conversation.';
    this.objective = config.objective || null;
    this.maxTurns = config.maxTurns || 20;
    this.turnDelay = config.turnDelay || 2000;
    
    this.history = [];
    this.turn = 0;
    this.currentSpeaker = 0;
    this.status = 'pending';
    this.startTime = null;
    this.endTime = null;
    
    this.db = db;
    this.broadcast = broadcast || (() => {});
  }

  async initialize() {
    // Load brains for all agents
    for (const agent of this.agents) {
      await agent.loadBrain();
    }
    
    // Create battle record in DB
    if (this.db) {
      this.db.prepare(`
        INSERT INTO battles (id, topic, objective, max_turns, status, start_time, agents)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.id,
        this.topic,
        this.objective,
        this.maxTurns,
        'pending',
        Date.now(),
        JSON.stringify(this.agents.map(a => ({ name: a.name, id: a.id })))
      );
    }
  }

  async start() {
    this.status = 'running';
    this.startTime = Date.now();
    
    this.updateStatus('running');
    this.broadcast({
      type: 'battle_start',
      battleId: this.id,
      agents: this.agents.map(a => a.name),
      topic: this.topic
    });

    // Build opening prompt
    let opening = this.topic;
    if (this.objective) {
      opening += `\n\nObjective: ${this.objective}`;
    }
    opening += `\n\nYou are starting the conversation. Other participants: ${this.agents.slice(1).map(a => a.name).join(', ')}`;

    await this.runTurn(opening);
  }

  async runTurn(prompt) {
    if (this.status !== 'running') return;
    if (this.turn >= this.maxTurns) {
      await this.complete();
      return;
    }

    const agent = this.agents[this.currentSpeaker];
    
    try {
      // Build message history for this agent
      const messages = this.buildMessages(this.currentSpeaker, prompt);
      
      // Get response
      const response = await agent.respond(messages);
      
      // Record turn
      const turnData = {
        turn: this.turn,
        speakerIndex: this.currentSpeaker,
        speaker: agent.name,
        content: response,
        timestamp: Date.now()
      };
      
      this.history.push(turnData);
      this.turn++;
      
      // Save to DB
      this.saveTurn(turnData);
      
      // Broadcast
      this.broadcast({
        type: 'turn',
        battleId: this.id,
        ...turnData
      });

      // Log to console
      console.log(`\n[Turn ${this.turn}] ${agent.name}:`);
      console.log(response);
      console.log('---');

      // Next speaker
      this.currentSpeaker = (this.currentSpeaker + 1) % this.agents.length;

      // Continue after delay
      if (this.turn < this.maxTurns && this.status === 'running') {
        setTimeout(() => this.runTurn(response), this.turnDelay);
      } else if (this.turn >= this.maxTurns) {
        await this.complete();
      }

    } catch (error) {
      console.error(`❌ Turn error:`, error.message);
      this.broadcast({
        type: 'error',
        battleId: this.id,
        error: error.message
      });
    }
  }

  buildMessages(speakerIndex, lastMessage) {
    const messages = [];
    
    // Add conversation history from this agent's perspective
    for (const entry of this.history) {
      const role = entry.speakerIndex === speakerIndex ? 'assistant' : 'user';
      messages.push({ role, content: entry.content });
    }
    
    // Add the last message as user input
    if (lastMessage) {
      messages.push({ role: 'user', content: lastMessage });
    }
    
    return messages;
  }

  pause() {
    this.status = 'paused';
    this.updateStatus('paused');
    this.broadcast({ type: 'paused', battleId: this.id });
  }

  resume() {
    if (this.status !== 'paused') return;
    
    this.status = 'running';
    this.updateStatus('running');
    this.broadcast({ type: 'resumed', battleId: this.id });
    
    const lastEntry = this.history[this.history.length - 1];
    if (lastEntry) {
      setTimeout(() => this.runTurn(lastEntry.content), this.turnDelay);
    }
  }

  async complete() {
    this.status = 'complete';
    this.endTime = Date.now();
    
    // Save agent brains with new memories
    for (const agent of this.agents) {
      agent.addMemory('battle', {
        battleId: this.id,
        topic: this.topic,
        turns: this.turn,
        participants: this.agents.map(a => a.name),
        timestamp: this.endTime
      });
      await agent.saveBrain();
    }
    
    this.updateStatus('complete');
    this.broadcast({
      type: 'complete',
      battleId: this.id,
      turns: this.turn,
      duration: this.endTime - this.startTime
    });
    
    console.log(`\n🏁 Battle ${this.id} complete. ${this.turn} turns in ${Math.round((this.endTime - this.startTime) / 1000)}s`);
  }

  saveTurn(turnData) {
    if (!this.db) return;
    
    this.db.prepare(`
      INSERT INTO turns (battle_id, turn_number, speaker, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.id, turnData.turn, turnData.speaker, turnData.content, turnData.timestamp);
  }

  updateStatus(status) {
    if (!this.db) return;
    
    this.db.prepare(`
      UPDATE battles SET status = ?, end_time = ? WHERE id = ?
    `).run(status, status === 'complete' ? Date.now() : null, this.id);
  }

  toJSON() {
    return {
      id: this.id,
      agents: this.agents.map(a => a.name),
      topic: this.topic,
      objective: this.objective,
      status: this.status,
      turn: this.turn,
      maxTurns: this.maxTurns,
      history: this.history
    };
  }
}

// ============================================================================
// ARENA
// ============================================================================

class Arena {
  constructor(db) {
    this.db = db;
    this.battles = new Map();
    this.spectators = new Set();
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    this.spectators.forEach(ws => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(msg);
      }
    });
  }

  addSpectator(ws) {
    this.spectators.add(ws);
    
    // Send current state
    ws.send(JSON.stringify({
      type: 'state',
      battles: Array.from(this.battles.values()).map(b => b.toJSON())
    }));
  }

  removeSpectator(ws) {
    this.spectators.delete(ws);
  }

  async createBattle(config) {
    // Create agents
    const agents = config.agents.map(agentConfig => new Agent(agentConfig));
    
    const battle = new Battle({
      ...config,
      agents
    }, this.db, (data) => this.broadcast(data));
    
    await battle.initialize();
    this.battles.set(battle.id, battle);
    
    return battle;
  }

  getBattle(id) {
    return this.battles.get(id);
  }

  getAllBattles() {
    return Array.from(this.battles.values()).map(b => b.toJSON());
  }

  // Load archived battles from DB
  getArchive() {
    if (!this.db) return [];
    
    return this.db.prepare(`
      SELECT id, topic, objective, max_turns, status, start_time, end_time, agents
      FROM battles
      WHERE status = 'complete'
      ORDER BY start_time DESC
      LIMIT 50
    `).all();
  }

  getBattleHistory(id) {
    if (!this.db) return null;
    
    const battle = this.db.prepare(`SELECT * FROM battles WHERE id = ?`).get(id);
    if (!battle) return null;
    
    const turns = this.db.prepare(`
      SELECT * FROM turns WHERE battle_id = ? ORDER BY turn_number
    `).all(id);
    
    return { ...battle, turns };
  }
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

function setupDatabase(dbPath = './data/arena.db') {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS battles (
      id INTEGER PRIMARY KEY,
      topic TEXT,
      objective TEXT,
      max_turns INTEGER,
      status TEXT,
      start_time INTEGER,
      end_time INTEGER,
      agents TEXT
    );
    
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      battle_id INTEGER,
      turn_number INTEGER,
      speaker TEXT,
      content TEXT,
      timestamp INTEGER,
      FOREIGN KEY (battle_id) REFERENCES battles(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_turns_battle ON turns(battle_id);
  `);
  
  return db;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  Arena,
  Battle,
  Agent,
  ModelProvider,
  AnthropicProvider,
  OllamaProvider,
  createProvider,
  setupDatabase
};
