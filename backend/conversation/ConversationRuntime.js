import { IntentRouter } from './IntentRouter.js';
import { DialogueManager } from './DialogueManager.js';

export class ConversationRuntime {
  constructor(options) {
    this.hermesRuntime = options.hermesRuntime;
    this.intentRouter = new IntentRouter();
    this.dialogueManager = new DialogueManager({
      speak: options.speak
    });
    this.broadcast = options.broadcast;
    this.broadcastLog = options.broadcastLog;
    this.broadcastAgentStatus = options.broadcastAgentStatus;
    
    // Fallback simple orchestrator
    this.executeFallbackOrchestration = options.executeFallbackOrchestration;
    this.runHermesAgent = options.runHermesAgent;
  }

  async handleInput(text, context) {
    this.broadcastLog(`>>> ${text}`);
    this.broadcastAgentStatus('jarvis', 'THINKING');
    
    const intent = this.intentRouter.classify(text, context);
    
    switch (intent.type) {
      case 'cancel':
        this.broadcastLog('[SYSTEM] Canceling...');
        // Should cancel running HermesRuntime task, but right now we lack the current taskId.
        // For fallback, we'll cancel everything.
        if (context.cancelAll) context.cancelAll();
        this.broadcastAgentStatus('jarvis', 'IDLE');
        break;

      case 'delegate':
        if (context.source === 'voice') this.dialogueManager.acknowledgeTask(context.language);
        this.broadcastAgentStatus('jarvis', 'WORKING');
        
        try {
          if (intent.agentId && this.runHermesAgent) {
            await this.runHermesAgent(intent.agentId, intent.task);
            return;
          }
          
          const task = await this.hermesRuntime.submitTask(intent.goal, 'HIGH');
          
          this.hermesRuntime.subscribe(task.taskId, (event) => {
            if (event.type === 'TaskCompleted') {
              this.broadcast({
                type: 'agent_result',
                agentId: 'jarvis',
                agentName: 'JARVIS',
                result: event.payload.result,
                isDelegated: true,
              });
              this.dialogueManager.presentResult(event.payload.result);
              this.broadcastAgentStatus('jarvis', 'IDLE');
            } else if (event.type === 'TaskFailed' || event.type === 'TaskCancelled') {
              this.broadcastAgentStatus('jarvis', 'IDLE');
            } else if (event.type === 'Progress') {
              this.dialogueManager.onProgress(event.payload.progress, context.language);
            } else if (event.type === 'core_output_token') {
               // Stream intermediate output to UI
               this.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: event.token });
            }
          });
        } catch (e) {
          this.broadcastLog(`[ERROR] ${e.message}`);
          this.broadcastAgentStatus('jarvis', 'IDLE');
        }
        break;

      case 'local_action':
      case 'reply':
      default:
        // For direct replies without delegation, we can use the old fallback executor for now,
        // which will stream the text directly via Ollama/HermesCLI.
        await this.executeFallbackOrchestration(text, context.source);
        break;
    }
  }
}
