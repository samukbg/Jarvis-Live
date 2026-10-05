import { spawn } from 'child_process';
import fs from 'fs';
import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, shellArg } from '../../shared/osUtils.js';
import { splitHermesModel } from '../../agents/hermesModel.js';

export class HermesCLIWorker {
  constructor(context) {
    this.id = 'hermes';
    this.ctx = context;
  }

  async *execute(goal, task) {
    let output = '';

    const promise = new Promise((resolve, reject) => {
      let providerName = null;
      
      const model = this.ctx.getSelectedModel('hermes');
      providerName = this.getProviderForModel(model);

      const args = [
        'chat',
        '-q', shellArg(goal),
        '-m', shellArg(splitHermesModel(this.ctx.getSelectedModel('hermes')).model),
        '--resume', this.ctx.getAgentSession('jarvis')
      ];

      if (providerName) {
        args.push('--provider', providerName);
      }

      const HERMES_BIN = getCrossPlatformCommand('hermes', false);
      
      const proc = spawn(HERMES_BIN, args, getSpawnOptions());

      this.ctx.registerProcess(proc);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        const strippedToken = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/^session_id:.*$/gm, '');
        if (task.onStream) task.onStream(strippedToken);
        
        // Emitting token directly to event bus for streaming via the generator
        this.ctx.eventBus?.emitEvent({ type: 'core_output_token', taskId: task.taskId, token: strippedToken });
        
        const match = chunk.match(/session_id:\s*([^\s]+)/);
        if (match) {
          const sid = match[1].trim();
          this.ctx.setAgentSession('jarvis', sid);
        }
      });

      proc.stderr?.on('data', (data) => {
        const line = data.toString().trim();
        const match = line.match(/session_id:\s*([^\s]+)/);
        if (match) {
          const sid = match[1].trim();
          this.ctx.setAgentSession('jarvis', sid);
        }
      });

      proc.on('close', (code) => {
        this.ctx.unregisterProcess(proc);
        if (proc.killedByUser || task.cancelToken?.signal.aborted) {
          return resolve('Cancelled');
        }

        const cleanOut = this.ctx.cleanHermesOutput(output);
        resolve(cleanOut);
      });

      proc.on('error', reject);
    });

    const result = await promise;
    yield { type: 'PartialResult', payload: { result } };
  }

  // Maps model strings back to their providers as in the original monolithic logic.
  getProviderForModel(selection) {
    return splitHermesModel(selection).provider;
  }

  spawnHermes(agentId, prompt, task, options = {}) {
    return new Promise((resolve, reject) => {
      this.ctx.broadcastAgentStatus(agentId, 'THINKING');
      this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: '' });
      this.ctx.broadcastLog(`[${agentId.toUpperCase()}] Assigned: "${task}"`);
      
      // Acknowledgement is now handled centrally by ConversationRuntime -> DialogueManager
      // to support multi-language voice interactions.
      let providerName = null;
      
      const model = this.ctx.getSelectedModel('hermes');
      providerName = this.getProviderForModel(model);

      this.ctx.broadcastLog(`[${agentId.toUpperCase()}] Using provider: ${providerName || 'default'}`);

      const args = [
        'chat',
        '-q', shellArg(prompt),
        '-Q',
        '-m', shellArg(splitHermesModel(this.ctx.getSelectedModel('hermes')).model),
        '--resume', this.ctx.getAgentSession(agentId)
      ];

      if (providerName) {
        args.push('--provider', providerName);
      }

      const HERMES_BIN = getCrossPlatformCommand('hermes', false);
      
      const proc = spawn(HERMES_BIN, args, getSpawnOptions());

      this.ctx.registerProcess(proc);
      let output = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        // Strip out any potential ANSI or session_id from the streaming token
        const strippedToken = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/^session_id:.*$/gm, '');
        this.ctx.broadcast({ type: 'core_output_token', agentId, token: strippedToken });

        // Check for session ID
        const match = chunk.match(/session_id:\s*([^\s]+)/);
        if (match) {
          const sid = match[1].trim();
          this.ctx.setAgentSession(agentId, sid);
          this.ctx.broadcastLog(`[${agentId.toUpperCase()}] Resumed session: ${sid}`);
        }
      });

      proc.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.error(`[HERMES STDERR] ${line}`);
      });

      proc.on('close', (code) => {
        this.ctx.unregisterProcess(proc);
        if (proc.killedByUser) {
          this.ctx.broadcastAgentStatus(agentId, 'IDLE');
          return resolve('Task cancelled by user.');
        }

        const cleanOut = this.ctx.cleanHermesOutput(output);
        this.ctx.broadcastLog(`[${agentId.toUpperCase()}] Task completed`);

        if (cleanOut) {
          this.ctx.broadcast({
            type: 'agent_result',
            agentId,
            agentName: agentId.toUpperCase(),
            result: cleanOut,
            prompt: task,
            isDelegated: true,
          });
          if (!options?.isLiveDelegation) {
            this.ctx.speakAgentResult(agentId, cleanOut);
          }
        }

        this.ctx.broadcastAgentStatus(agentId, 'IDLE');
        resolve(cleanOut);
      });

      proc.on('error', (err) => {
        this.ctx.broadcastLog(`[${agentId.toUpperCase()}] Error: ${err.message}`);
        this.ctx.broadcastAgentStatus(agentId, 'IDLE');
        resolve('Error: ' + err.message);
      });
    });
  }

  runAgent(agentId, command, options = {}) {
    const task = this.ctx.cleanAgentTask(command);
    const role = this.ctx.getAgentRole(agentId) || 'specialist agent';
    const isResearcher = ['athena', 'vision', 'steve'].includes(agentId.toLowerCase());
    
    const query = `You are ${agentId.toUpperCase()}, a ${role} in the JARVIS AI system.
You are running directly on the user's macOS machine. You have FULL ACCESS to the system via your terminal tool. Use commands like \`osascript\` (AppleScript) or \`open\` to control apps (like Spotify), change settings, open URLs, etc. NEVER say you lack access to the OS, APIs, or hardware.
If asked to play specific music/artists on Spotify, ALWAYS first use your web search tool to find their exact Spotify URI (e.g. spotify:artist:... or spotify:track:...), then use AppleScript to play that specific URI via osascript.

## Task
${task}

## Response Format
${isResearcher ? 
`- Lead immediately with the key findings (title, source, date, summary)
- Use clean markdown: ## for sections, **bold** for key data, bullet lists for multiple items
- Be specific: real titles, real sources, real dates — no placeholders
- Keep procedural notes ("What I Did") at the end and brief` : 
`- Directly confirm what actions you performed on the system.
- Keep it brief and conversational.`}
- No filler phrases or padding`;

    return this.spawnHermes(agentId, query, task, options);
  }
}
