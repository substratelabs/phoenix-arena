/**
 * PHOENIX ARENA - Core Engine
 * Raw AI vs AI. No corporate roleplay.
 * Pick model. Load brain or don't. Give prompt. Let them run.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');

// ============================================================================
// MODEL PROVIDERS
// ============================================================================

class AnthropicProvider {
  constructor(config) {
    this.client = new Anthropic({ 
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY 
    });
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens || 1000;
  }

  async chat(messages, systemPrompt) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt || 'You are an AI.',
      messages: messages
    });
    return response.content[0].text;
  }
}

class OllamaProvider {
  constructor(config) {
    this.endpoint = config.endpoint || process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
    this.model = config.model || 'llama3';
  }

  async chat(messages, systemPrompt) {
    // Use the chat API instead of generate
    const ollamaMessages = [];
    
    if (systemPrompt) {
      ollamaMessages.push({ role: 'system', content: systemPrompt });
    }
    
    for (const msg of messages) {
      ollamaMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }
    
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: ollamaMessages,
        stream: false
      })
    });
    
    const text = await response.text();
    
    try {
      const data = JSON.parse(text);
      return data.message?.content || data.response || '';
    } catch (e) {
      console.error('Ollama parse error, raw response:', text.slice(0, 200));
      throw new Error('Failed to parse Ollama response');
    }
  }
}

function createProvider(config) {
  const provider = config.provider || 'anthropic';
  
  if (provider === 'ollama') {
    return new OllamaProvider(config);
  }
  return new AnthropicProvider(config);
}

// ============================================================================
// AGENT
// ============================================================================

class Agent {
  constructor(config) {
    this.id = config.id || `agent_${Date.now()}`;
    this.name = config.name || `Agent`;
    this.displayName = config.displayName || this.name;
    this.provider = createProvider(config);
    this.brainPath = typeof config.brain === 'string' ? config.brain : null;
    this.brain = typeof config.brain === 'object' ? config.brain : null;
    this.soul = config.soul || null;
    this.prompt = config.prompt || null; // Individual prompt for this agent
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.anonymous = config.anonymous || false;
  }

  async loadBrain() {
    // If brain is already loaded as object, skip
    if (this.brain) return;
    
    // If brain is a file path, load it
    if (!this.brainPath) return;
    
    try {
      const data = await fs.readFile(this.brainPath, 'utf8');
      this.brain = JSON.parse(data);
      console.log(`🧠 Loaded brain: ${this.brainPath}`);
    } catch (e) {
      console.log(`⚠️ No brain at ${this.brainPath}, running blank`);
      this.brain = null;
    }
  }

  async saveBrain() {
    if (!this.brainPath || !this.brain) return;
    
    try {
      await fs.writeFile(this.brainPath, JSON.stringify(this.brain, null, 2));
      console.log(`💾 Saved brain: ${this.brainPath}`);
    } catch (e) {
      console.error(`❌ Failed to save brain:`, e.message);
    }
  }

  buildSystemPrompt() {
    let prompt = '';
    
    // Anonymous mode: blank slate, no identity
    if (this.anonymous) {
      // No identity - let the conversation prompt drive everything
      prompt = '';
    } else {
      // Add agent identity
      prompt += `You are ${this.name}.\n\n`;
    }
    
    // Add directive to system prompt (this is the agent's secret mission)
    if (this.prompt) {
      prompt += `Your directive: ${this.prompt}\n\n`;
    }
    
    // Add soul (custom system prompt) if provided
    if (this.soul) {
      prompt += this.soul + '\n\n';
    }
    
    // Add brain data if available
    if (this.brain) {
      // If brain has a soul/identity section and no custom soul was provided
      if (this.brain.soul && !this.soul) {
        prompt += this.brain.soul + '\n\n';
      }
      
      // If brain has knowledge
      if (this.brain.knowledgeGraph?.concepts) {
        const concepts = this.brain.knowledgeGraph.concepts;
        if (Array.isArray(concepts) && concepts.length > 0) {
          prompt += '## Your Knowledge\n';
          concepts.slice(0, 30).forEach(([key, data]) => {
            if (data && data.definition) {
              prompt += `- ${data.name || key}: ${data.definition}\n`;
            }
          });
          prompt += '\n';
        }
      }
      
      // If brain has conversation memories
      if (this.brain.conversationMemories?.length > 0) {
        prompt += '## Recent Memories\n';
        this.brain.conversationMemories.slice(-10).forEach(mem => {
          prompt += `- ${mem.key}: ${mem.value}\n`;
        });
      }
      
      // If brain has stats
      if (this.brain.stats) {
        prompt += `\nYou have had ${this.brain.stats.totalConversations || 0} conversations.\n`;
      }
    }
    
    return prompt || null;
  }

  async respond(messages) {
    const systemPrompt = this.buildSystemPrompt();
    
    // DEBUG LOGGING
    console.log(`\n========== AGENT DEBUG: ${this.name} ==========`);
    console.log(`Anonymous: ${this.anonymous}`);
    console.log(`Individual prompt: ${this.prompt ? this.prompt.slice(0, 100) + '...' : 'NONE'}`);
    console.log(`System prompt: ${systemPrompt ? systemPrompt.slice(0, 200) + '...' : 'NONE'}`);
    console.log(`Messages count: ${messages.length}`);
    if (messages.length > 0) {
      console.log(`First message: ${messages[0].content?.slice(0, 150)}...`);
    }
    console.log(`==============================================\n`);
    
    return await this.provider.chat(messages, systemPrompt);
  }

  addMemory(key, value) {
    if (!this.brain) {
      this.brain = { conversationMemories: [] };
    }
    if (!this.brain.conversationMemories) {
      this.brain.conversationMemories = [];
    }
    this.brain.conversationMemories.push({
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
    this.prompt = config.prompt || null; // Shared prompt (null if using individual)
    this.useIndividualPrompts = config.useIndividualPrompts || false;
    this.anonymousMode = config.anonymousMode || false;
    this.maxTurns = config.maxTurns || 20;
    this.turnDelay = config.turnDelay || 3000;
    this.maxWords = config.maxWords || null;
    
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
    for (const agent of this.agents) {
      await agent.loadBrain();
    }
    
    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO battles (id, prompt, max_turns, status, start_time, agents)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          this.id,
          this.prompt,
          this.maxTurns,
          'pending',
          Date.now(),
          JSON.stringify(this.agents.map(a => ({ 
            name: a.name, 
            model: a.model,
            hasBrain: !!a.brainPath 
          })))
        );
      } catch (e) {
        console.log('DB insert skipped:', e.message);
      }
    }
  }

  async start() {
    this.status = 'running';
    this.startTime = Date.now();
    
    // DEBUG LOGGING
    console.log(`\n########## BATTLE START DEBUG ##########`);
    console.log(`Battle ID: ${this.id}`);
    console.log(`Anonymous Mode: ${this.anonymousMode}`);
    console.log(`Shared Prompt: ${this.prompt ? this.prompt.slice(0, 100) : 'NONE'}`);
    console.log(`Agents:`);
    this.agents.forEach((a, i) => {
      console.log(`  Agent ${i}: ${a.name} (display: ${a.displayName})`);
      console.log(`    - Individual prompt: ${a.prompt ? a.prompt.slice(0, 80) + '...' : 'NONE'}`);
      console.log(`    - Anonymous: ${a.anonymous}`);
      console.log(`    - Soul: ${a.soul ? 'YES' : 'NO'}`);
      console.log(`    - Brain: ${a.brain ? 'YES' : 'NO'}`);
    });
    console.log(`########################################\n`);
    
    this.updateStatus('running');
    this.broadcast({
      type: 'battle_start',
      battleId: this.id,
      agents: this.agents.map(a => ({ name: a.displayName || a.name, model: a.model })),
      prompt: this.prompt
    });

    // Build opening - Agent 0 starts
    const agent0 = this.agents[0];
    const basePrompt = agent0.prompt || this.prompt || 'Begin.';
    
    // DEBUG
    console.log(`Opening prompt for Agent 0: ${basePrompt.slice(0, 100)}...`);
    
    // In anonymous mode, don't tell them about other participants
    let opening;
    if (this.anonymousMode) {
      opening = basePrompt;
    } else {
      const otherAgents = this.agents.slice(1).map(a => a.name).join(', ');
      opening = `${basePrompt}\n\nYou are starting. Other participant(s): ${otherAgents}`;
    }
    
    console.log(`Final opening: ${opening.slice(0, 150)}...`);

    await this.runTurn(opening);
  }

  async runTurn(input) {
    if (this.status !== 'running') return;
    if (this.turn >= this.maxTurns) {
      await this.complete();
      return;
    }

    const agent = this.agents[this.currentSpeaker];
    
    try {
      const messages = this.buildMessages(this.currentSpeaker, input);
      const response = await agent.respond(messages);
      
      const turnData = {
        turn: this.turn,
        speakerIndex: this.currentSpeaker,
        speaker: agent.name,
        model: agent.model,
        content: response,
        timestamp: Date.now()
      };
      
      this.history.push(turnData);
      this.turn++;
      
      this.saveTurn(turnData);
      
      this.broadcast({
        type: 'turn',
        battleId: this.id,
        ...turnData
      });

      console.log(`\n[${this.turn}] ${agent.name} (${agent.model}):`);
      console.log(response);
      console.log('---');

      this.currentSpeaker = (this.currentSpeaker + 1) % this.agents.length;

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
    const agent = this.agents[speakerIndex];
    
    // Check if this is the agent's first turn (they have no history entries yet)
    const agentHasSpoken = this.history.some(e => e.speakerIndex === speakerIndex);
    
    // Build first message prefix with shared prompt (first turn only)
    let firstMessagePrefix = '';
    if (!agentHasSpoken) {
      // Always include shared prompt for both agents
      if (this.prompt) {
        firstMessagePrefix += `[Context: ${this.prompt}]\n\n`;
      }
    }
    
    for (const entry of this.history) {
      const role = entry.speakerIndex === speakerIndex ? 'assistant' : 'user';
      messages.push({ role, content: entry.content });
    }
    
    // Build the last message content
    let lastMessageContent = lastMessage || '';
    
    // Add word limit constraint EVERY turn if set (this is fine to show)
    if (this.maxWords && lastMessage) {
      lastMessageContent = `[${this.maxWords} words max]\n\n${lastMessage}`;
    }
    
    if (lastMessageContent) {
      const content = firstMessagePrefix ? firstMessagePrefix + lastMessageContent : lastMessageContent;
      messages.push({ role: 'user', content });
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
    
    // Save memories to agent brains
    for (const agent of this.agents) {
      agent.addMemory('arena_battle', {
        battleId: this.id,
        prompt: this.prompt,
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
    
    console.log(`\n🏁 Battle complete. ${this.turn} turns.`);
  }

  saveTurn(turnData) {
    if (!this.db) return;
    
    try {
      this.db.prepare(`
        INSERT INTO turns (battle_id, turn_number, speaker, model, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(this.id, turnData.turn, turnData.speaker, turnData.model, turnData.content, turnData.timestamp);
    } catch (e) {
      // Silent fail for DB issues
    }
  }

  updateStatus(status) {
    if (!this.db) return;
    
    try {
      this.db.prepare(`
        UPDATE battles SET status = ?, end_time = ? WHERE id = ?
      `).run(status, status === 'complete' ? Date.now() : null, this.id);
    } catch (e) {
      // Silent fail
    }
  }

  toJSON() {
    return {
      id: this.id,
      agents: this.agents.map(a => ({ name: a.name, model: a.model, hasBrain: !!a.brainPath })),
      prompt: this.prompt,
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
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    });
  }

  addSpectator(ws) {
    this.spectators.add(ws);
    ws.send(JSON.stringify({
      type: 'state',
      battles: Array.from(this.battles.values()).map(b => b.toJSON())
    }));
  }

  removeSpectator(ws) {
    this.spectators.delete(ws);
  }

  async createBattle(config) {
    const agents = config.agents.map((a, i) => new Agent({
      ...a,
      id: `agent_${i}_${Date.now()}`,
      name: a.name || `Agent ${i + 1}`
    }));
    
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

  getArchive() {
    if (!this.db) return [];
    
    try {
      return this.db.prepare(`
        SELECT id, prompt, max_turns, status, start_time, end_time, agents
        FROM battles
        WHERE status = 'complete'
        ORDER BY start_time DESC
        LIMIT 50
      `).all();
    } catch (e) {
      return [];
    }
  }

  getBattleHistory(id) {
    if (!this.db) return null;
    
    try {
      const battle = this.db.prepare(`SELECT * FROM battles WHERE id = ?`).get(id);
      if (!battle) return null;
      
      const turns = this.db.prepare(`
        SELECT * FROM turns WHERE battle_id = ? ORDER BY turn_number
      `).all(id);
      
      return { ...battle, turns };
    } catch (e) {
      return null;
    }
  }
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

function setupDatabase(dbPath = './data/arena.db') {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS battles (
        id INTEGER PRIMARY KEY,
        prompt TEXT,
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
        model TEXT,
        content TEXT,
        timestamp INTEGER,
        FOREIGN KEY (battle_id) REFERENCES battles(id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_turns_battle ON turns(battle_id);
    `);
    
    console.log('📊 Database ready');
    return db;
  } catch (e) {
    console.log('⚠️ SQLite not available, running without persistence');
    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  Arena,
  Battle,
  Agent,
  AnthropicProvider,
  OllamaProvider,
  createProvider,
  setupDatabase
};
