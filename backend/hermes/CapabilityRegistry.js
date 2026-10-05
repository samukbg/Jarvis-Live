const CAPABILITIES = {
  Browser:    { keywords: ['browse', 'open', 'navigate', 'website', 'url', 'linkedin', 'google', 'youtube'] },
  Terminal:   { keywords: ['run', 'execute', 'bash', 'shell', 'command', 'script', 'install'] },
  Filesystem: { keywords: ['file', 'read', 'write', 'folder', 'directory', 'delete', 'move', 'copy'] },
  Git:        { keywords: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'repo'] },
  Vision:     { keywords: ['screenshot', 'see', 'look at', 'screen', 'image', 'visual'] },
  Coding:     { keywords: ['code', 'write a function', 'refactor', 'debug', 'typescript', 'python', 'rust'] },
  Research:   { keywords: ['search', 'find', 'look up', 'summarise', 'summarize', 'news', 'article'] },
  Email:      { keywords: ['email', 'send', 'mail', 'draft', 'message'] },
  Calendar:   { keywords: ['calendar', 'schedule', 'meeting', 'appointment', 'event'] },
  Docker:     { keywords: ['docker', 'container', 'kubernetes', 'k8s', 'deploy', 'image', 'compose'] },
  Memory:     { keywords: ['remember', 'recall', 'what did', 'last time', 'history'] },
};

export class CapabilityRegistry {
  constructor() {
    this.registry = new Map();
  }

  register(workerId, capabilityIds) {
    this.registry.set(workerId, capabilityIds);
  }

  findWorkers(goal) {
    if (!goal) return [];
    
    const lower = goal.toLowerCase();
    const scores = {};
    
    for (const [workerId, caps] of this.registry.entries()) {
      scores[workerId] = caps.reduce((acc, capId) => {
        const cap = CAPABILITIES[capId];
        if (!cap) return acc;
        const hits = cap.keywords.filter(k => lower.includes(k)).length;
        return acc + hits;
      }, 0);
    }
    
    return Object.entries(scores)
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  getAll() {
    return this.registry;
  }
}
