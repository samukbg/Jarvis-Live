import { spawn } from 'child_process';
import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, escapeArg } from '../../shared/osUtils.js';

// Voice delegations stop after this long (agy --print-timeout) and say so.
const VOICE_TIMEOUT_S = Number(process.env.JARVIS_VOICE_AGENT_TIMEOUT_S) || 240;

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

  async handleCommand(command, source = 'text', { isLiveDelegation = false } = {}) {
    // Spoken requests (phone, watch, avatar): low effort and a "be quick" brief.
    const voice = isLiveDelegation || source === 'voice';
    const modelArgs = await this.ctx.agyModelArgs({ voice });
    // …and a time limit: a runaway task (dozens of downloads) shouldn't run on for minutes
    // after the conversation has moved on.
    const limitArgs = voice ? ['--print-timeout', `${VOICE_TIMEOUT_S}s`] : [];
    return new Promise((resolve) => {
      this.ctx.broadcastLog(`>>> [GEMINI] ${command}`);
      this.ctx.broadcastAgentStatus('agy', 'THINKING');
      this.ctx.broadcast({ type: 'core_output_token', agentId: 'jarvis', token: '' });

      const proc = spawn(getCrossPlatformCommand('agy'), ['--dangerously-skip-permissions', ...modelArgs, ...limitArgs], getSpawnOptions());
      
      this.ctx.registerProcess(proc);
      proc.stdin?.on('error', () => {});
      proc.stdin?.write(this.ctx.buildTaskQuery(command, { voice }) + '\n');
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
        if (voice && !output.trim()) {
          // --print-timeout ends with exit 0 and no answer.
          result = `The agent did not finish within ${Math.round(VOICE_TIMEOUT_S / 60)} minutes and was stopped. Suggest a smaller task.`;
          this.ctx.broadcastAgentStatus('agy', 'IDLE');
          return resolve(result);
        }
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
