export class IntentRouter {
  classify(text, context) {
    if (!text) return { type: 'reply', confidence: 0, source: context.source };

    const lower = text.toLowerCase();

    // Interrupts / cancellations
    if (/\b(stop|cancel|abort|enough|quiet|shut up|never mind)\b/.test(lower)) {
      return { type: 'cancel', confidence: 0.99, source: context.source };
    }

    // Conversational - no execution needed
    if (/^(what time|what's the time|good morning|hello|hi there|thank you|thanks)/.test(lower)) {
      return { type: 'local_action', confidence: 0.95, source: context.source };
    }

    // Delegation signals - clearly need execution
    // Explicit delegation signals (e.g., "fire agent vision <task>")
    const match = text.match(/^(?:fire|activate|launch|call|use|engage|deploy|assign)\s+(?:\d+\s+)?agents?\s+(\w+)\s+(.+)$/i);
    
    if (match) {
      return {
        type: 'delegate',
        goal: text,
        agentId: match[1].toLowerCase(),
        task: match[2],
        confidence: 0.95,
        source: context.source,
      };
    }

    // Default: let the LLM handle it as a direct reply
    return { type: 'reply', confidence: 0.6, source: context.source };
  }
}
