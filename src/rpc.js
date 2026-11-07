import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexRpc extends EventEmitter {
  constructor({ command = 'codex', args = [], cwd = process.cwd() } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.sequence = 0;
    this.pending = new Map();
  }

  async start() {
    const env={...process.env};
    for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','AZURE_OPENAI_API_KEY','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','T3CODE_THREAD_ID'])delete env[name];
    this.process = spawn(this.command, ['app-server', ...this.args], {
      cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.on('error', error => this.emit('fault', error));
    this.process.stdin.on('error', error => this.emit('fault', error));
    this.process.stderr.on('data', data => this.emit('diagnostic', data.toString()));
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit(message.id != null ? 'request' : 'notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { details: message.error }));
        else pending.resolve(message.result);
      }
    });
    this.process.on('exit', (code, signal) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed')); }
      this.pending.clear();
      this.emit('disconnected', { code, signal });
    });
    await this.call('initialize', {
      clientInfo: { name: 'screen_companion', title: 'Screen Companion', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return this;
  }

  send(message) {
    if (!this.process || this.process.stdin.destroyed) throw new Error('Codex is not connected');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params = {}, timeout = 30000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id, result) { this.send({ id, result }); }

  close() {
    this.lines?.close();
    this.process?.stdin.end();
    this.process?.kill();
  }
}
