import fs from 'fs';
import path from 'path';

export class ConversationMemory {
  constructor(memoryFilePath, maxTurns = 100) {
    this.memoryFilePath = memoryFilePath;
    this.maxTurns = maxTurns;
  }

  writeTurn(role, text) {
    if (!text?.trim()) return;
    try {
      let data = { turns: [] };
      if (fs.existsSync(this.memoryFilePath)) {
        data = JSON.parse(fs.readFileSync(this.memoryFilePath, 'utf8'));
      }
      data.turns.push({ ts: new Date().toISOString(), role, text: text.trim() });
      if (data.turns.length > this.maxTurns) {
        data.turns = data.turns.slice(-this.maxTurns);
      }
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[MEMORY] Write error:', e.message);
      if (e instanceof SyntaxError) {
        try { fs.writeFileSync(this.memoryFilePath, JSON.stringify({ turns: [] })); } catch (_) {}
      }
    }
  }
}
