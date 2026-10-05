import { spawn } from 'child_process';

import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, escapeArg } from '../../shared/osUtils.js';

export class ClaudeWorker {
  constructor(context) {
    this.id = 'claude';
    this.ctx = context;
  }

  async *execute(goal, task) {
    let output = '';
    
    const promise = new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'text', '--model', escapeArg(this.ctx.getSelectedModel('claude'))];
      
      const proc = spawn(getCrossPlatformCommand('claude'), args, getSpawnOptions());
      
      this.ctx.registerProcess(proc);
      proc.stdin?.on('error', () => {});
      proc.stdin?.write(this.ctx.buildTaskQuery(goal) + '\n');
      proc.stdin?.end();

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        if (task.onStream) task.onStream(chunk);
      });
      
      proc.on('close', (code) => {
        this.ctx.unregisterProcess(proc);
        if (proc.killedByUser || task.cancelToken?.signal.aborted) {
          resolve('Cancelled');
          return;
        }
        resolve(output);
      });
      
      proc.on('error', reject);
    });

    const result = await promise;
    yield { type: 'PartialResult', payload: { result } };
  }

  handleCommand(command, source = 'text') {
    return new Promise((resolve) => {
      this.ctx.broadcastLog(`>>> [CLAUDE] ${command}`);
      this.ctx.broadcastAgentStatus('claude', 'THINKING');
      this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: '' });

      const args = ['-p', '--output-format', 'text', '--model', escapeArg(this.ctx.getSelectedModel('claude'))];
      
      const proc = spawn(getCrossPlatformCommand('claude'), args, getSpawnOptions());
      
      this.ctx.registerProcess(proc);
      proc.stdin?.on('error', () => {});
      proc.stdin?.write(this.ctx.buildTaskQuery(command) + '\n');
      proc.stdin?.end();

      let output = '';
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: chunk });
      });
      
      proc.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) this.ctx.broadcastLog(`[CLAUDE][err] ${line}`);
      });
      
      proc.on('close', (code) => {
        this.ctx.unregisterProcess(proc);
        if (proc.killedByUser) {
          this.ctx.broadcastLog(`[CLAUDE] Cancelled`);
          return resolve('Cancelled');
        }
        if (code !== 0 && !output) {
          this.ctx.broadcastAlert('Claude CLI failed. Make sure `claude` is installed and logged in.');
        }
        this.ctx.broadcastLog(`[CLAUDE] Done (exit ${code})`);
        
        if (output) {
          this.ctx.broadcast({
            type: 'agent_result',
            agentId: 'claude',
            agentName: 'CLAUDE',
            result: output,
            isDelegated: true,
          });
          this.ctx.queueVoiceTTS(output.slice(0, 500));
        }
        this.ctx.broadcastAgentStatus('claude', 'IDLE');
        this.ctx.resumeSTTMode(source);
        resolve(output);
      });
      
      proc.on('error', () => {
        this.ctx.broadcastAlert('Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code');
        this.ctx.broadcastAgentStatus('claude', 'IDLE');
        resolve('Error: Claude CLI not found');
      });
    });
  }
}
