import fs from 'fs';
import path from 'path';
import os from 'os';

export class AgentMemory {
  constructor(agentId) {
    this.agentId = agentId;
    this.memoryFilePath = path.join(os.homedir(), '.hermes', 'memory', `${agentId}_memory.json`);
    this.ensureDirectory();
  }

  ensureDirectory() {
    const dir = path.dirname(this.memoryFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load() {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        return JSON.parse(fs.readFileSync(this.memoryFilePath, 'utf8'));
      }
    } catch (e) {
      console.error(`[MEMORY] Failed to load agent memory for ${this.agentId}:`, e.message);
    }
    return { facts: [], preferences: {} };
  }

  save(data) {
    try {
      this.ensureDirectory();
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[MEMORY] Failed to save agent memory for ${this.agentId}:`, e.message);
    }
  }

  addFact(fact) {
    const data = this.load();
    data.facts.push({ fact, timestamp: Date.now() });
    this.save(data);
  }
}
