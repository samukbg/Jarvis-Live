import { spawn } from 'child_process';
import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, escapeArg } from '../../shared/osUtils.js';

function normalizeGeminiModel(m) {
  if (!m) return 'gemini-3.6-flash';
  const clean = m.toLowerCase().trim();
  if (clean.includes('3.6') || clean === 'flash') return 'gemini-3.6-flash';
  if (clean.includes('3.5')) return 'gemini-3.5-flash';
  if (clean.includes('3.1') || clean.includes('pro')) return 'gemini-3.1-pro';
  if (clean.includes('2.0')) return 'gemini-2.0-flash';
  if (clean.startsWith('gemini')) return clean.split(' ')[0];
  return 'gemini-3.6-flash';
}

export class AgyWorker {
  constructor(context) {
    this.id = 'agy';
    this.ctx = context;
  }

  async *execute(goal, task) {
    let output = '';
    const model = normalizeGeminiModel(this.ctx.getSelectedModel('gemini'));
    
    const promise = new Promise((resolve, reject) => {
      const proc = spawn(getCrossPlatformCommand('agy'), [
        '--dangerously-skip-permissions', 
        '--model', model,
        '--effort', 'medium'
      ], getSpawnOptions());
      
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
      this.ctx.broadcastLog(`>>> [GEMINI] ${command}`);
      this.ctx.broadcastAgentStatus('agy', 'THINKING');
      this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: '' });

      const model = normalizeGeminiModel(this.ctx.getSelectedModel('gemini'));
      const proc = spawn(getCrossPlatformCommand('agy'), [
        '--dangerously-skip-permissions', 
        '--model', model,
        '--effort', 'medium'
      ], getSpawnOptions());
      
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
        if (line) this.ctx.broadcastLog(`[GEMINI][err] ${line}`);
      });
      
      proc.on('close', (code) => {
        this.ctx.unregisterProcess(proc);
        if (proc.killedByUser) {
          this.ctx.broadcastLog(`[GEMINI] Cancelled`);
          return resolve('Cancelled');
        }
        if (code !== 0 && !output) {
          this.ctx.broadcastAlert('Antigravity CLI failed. Make sure `agy` is installed.');
          resolve(`Execution failed with exit code ${code}`);
          return;
        }
        this.ctx.broadcastLog(`[GEMINI] Done (exit ${code})`);
        
        let result = output;
        if (output) {
          this.ctx.broadcast({
            type: 'agent_result',
            agentId: 'agy',
            agentName: 'AGY',
            result: output,
            isDelegated: true,
          });
        }
        this.ctx.broadcastAgentStatus('agy', 'IDLE');
        resolve(result);
      });

      proc.on('error', (e) => {
        this.ctx.broadcastAlert('Antigravity CLI not found. Make sure `agy` is installed in your PATH.');
        this.ctx.broadcastAgentStatus('agy', 'IDLE');
        resolve(`Error: ${e.message}`);
      });
    });
  }
}
