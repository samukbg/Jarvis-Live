import { spawn } from 'child_process';
import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, escapeArg } from '../../shared/osUtils.js';

export class AgyWorker {
  constructor(context) {
    this.id = 'agy';
    this.ctx = context;
  }

  async *execute(goal, task) {
    let output = '';
    // The selected model, valid for this agy (no --effort clash: agents/agyModel.js).
    const modelArgs = await this.ctx.agyModelArgs();

    const promise = new Promise((resolve, reject) => {
      const proc = spawn(getCrossPlatformCommand('agy'), ['--dangerously-skip-permissions', ...modelArgs], getSpawnOptions());
      
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

  async handleCommand(command, source = 'text') {
    const modelArgs = await this.ctx.agyModelArgs();
    return new Promise((resolve) => {
      this.ctx.broadcastLog(`>>> [GEMINI] ${command}`);
      this.ctx.broadcastAgentStatus('agy', 'THINKING');
      this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: '' });

      const proc = spawn(getCrossPlatformCommand('agy'), ['--dangerously-skip-permissions', ...modelArgs], getSpawnOptions());
      
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
