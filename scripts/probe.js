import { CodexRpc } from '../src/rpc.js';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const rpc = new CodexRpc();
const started = Date.now();
let audioBytes = 0;
let firstAudioMs = null;
const events = [];
let ended;
const done = new Promise(resolve => { ended = resolve; });
rpc.on('notification', m => {
  if (!m.method.startsWith('thread/realtime') && m.method !== 'error') return;
  if (m.params?.audio) {
    audioBytes += Buffer.from(m.params.audio.data, 'base64').length;
    firstAudioMs ??= Date.now() - started;
  }
  const safe = structuredClone(m);
  if (safe.params?.audio) safe.params.audio.data = `<${safe.params.audio.data.length} base64 characters>`;
  events.push({ ms: Date.now() - started, ...safe });
  console.log(JSON.stringify(events.at(-1)));
  if (m.method === 'thread/realtime/error' || m.method === 'thread/realtime/closed') ended();
});
rpc.on('request', m => rpc.reply(m.id, { contentItems: [{ type: 'inputText', text: 'This is an audio connectivity check. No computer actions are available.' }], success: false }));
rpc.on('fault', e => console.error(e.message));
try {
  await rpc.start();
  const a = await rpc.call('account/read', { refreshToken: false });
  console.log(JSON.stringify({ auth: a.account?.type, plan: a.account?.planType }));
  const thread = await rpc.call('thread/start', {
    model: 'gpt-6.1-sol', cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never',
    config: { model_reasoning_effort: 'low' }, ephemeral: true,
    baseInstructions: 'You are a concise conversational screen companion. This session is testing audio connectivity only. Do not run commands or tools.',
  }, 60000);
  console.log(JSON.stringify({ threadCreated: true }));
  const threadId = thread.thread.id;
  console.log(JSON.stringify({ voices: await rpc.call('thread/realtime/listVoices', {}) }));
  await rpc.call('thread/realtime/start', {
    threadId, outputModality: 'audio', transport: { type: 'websocket' },
    prompt: 'You are a friendly, concise voice companion. Briefly respond to the user. Do not delegate tasks in this connectivity check.',
  }, 45000);
  await rpc.call('thread/realtime/appendText', { threadId, text: 'Say: The live voice connection is working. Then wait.' });
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 12000))]);
  await rpc.call('thread/realtime/stop', { threadId }).catch(() => {});
} catch (error) {
  events.push({ error: error.message, details: error.details });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({ audioBytes, firstAudioMs }));
  await writeFile('artifacts/voice-probe.json', JSON.stringify({ audioBytes, firstAudioMs, events }, null, 2));
  rpc.close();
}
