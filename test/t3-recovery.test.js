import test from 'node:test';
import assert from 'node:assert/strict';
import { T3Companion } from '../src/t3-companion.js';
import { T3Client } from '../src/t3-client.js';

function companion() {
  const c = new T3Companion({ root: process.cwd(), dataDir: process.cwd() });
  Object.assign(c.state, { connection: 'connected', watching: false });
  c.t3ThreadId = 'thread';
  c.t3Runs = new Map();
  c.t3Attempts = new Map();
  c.t3Seen = new Map();
  c.providerNativeIds = new Map();
  c.providerContexts = new Map();
  c.save = async () => {};
  return c;
}

function event(c, payload, type = 'turn-item.updated') {
  c.t3Stream({ kind: 'event', event: { type, payload } });
}

test('reconnect restores a running request and permits its fresh observations', async () => {
  const c = companion();
  c.restoreProjection({
    thread: { activeRunId: 'run' },
    runs: [{ id: 'run', status: 'running', userMessageId: 'user' }],
    messages: [{ id: 'user', text: 'Read the screen' }],
  });
  assert.equal(c.state.busy, true);
  assert.equal(c.t3InFlight, true);
  assert.equal(c.t3RunId, 'run');
  c.bridge = { call: async () => [{ id: 'window' }] };
  const result = await c.invokeDesktopTool('screen_windows', {});
  assert.equal(result.success, true);
});

test('snapshot restores missing replies once without speaking historical answers', () => {
  const c = companion();
  let speech = 0;
  let restored;
  c.on('delta', () => speech++);
  c.on('speechFlush', () => speech++);
  c.on('messagesRestored', messages => { restored = messages; });
  const projection = {
    runs: [{ id: 'run', status: 'completed' }],
    turnItems: [
      { id: 'u', type: 'user_message', messageId: 'user', text: 'Question' },
      { id: 'a', type: 'assistant_message', runId: 'run', text: 'Answer' },
    ],
  };
  c.restoreProjection(projection);
  c.restoreProjection(projection);
  assert.deepEqual(restored.map(m => m.text), ['Question', 'Answer']);
  assert.equal(speech, 0);
});

test('final-only T3 replies reach speech exactly once', () => {
  const c = companion();
  c.t3TurnStart = Date.now();
  const deltas = [];
  let flushes = 0;
  c.on('delta', delta => deltas.push(delta.text));
  c.on('speechFlush', () => flushes++);
  const reply = { id: 'a', type: 'assistant_message', runId: 'run', text: 'A complete answer.', streaming: false };
  event(c, reply);
  event(c, reply);
  assert.deepEqual(deltas, ['A complete answer.']);
  assert.equal(flushes, 1);
});

test('the final suffix is spoken without repeating already streamed text', () => {
  const c = companion();
  c.t3TurnStart = Date.now();
  const deltas = [];
  c.on('delta', delta => deltas.push(delta.text));
  event(c, { id: 'a', type: 'assistant_message', text: 'A short ', streaming: true });
  event(c, { id: 'a', type: 'assistant_message', text: 'A short answer.', streaming: false });
  assert.equal(deltas.join(''), 'A short answer.');
});

test('failed cancellation closes local approval and never claims Ready', async () => {
  const c = companion();
  c.beginExternalRun({ id: 'run', userMessageId: 'user', status: 'running' });
  let declined = false;
  c.confirmation = { reject: () => { declined = true; } };
  c.t3 = { call: async () => { throw new Error('Transport unavailable'); } };
  await assert.rejects(c.interrupt(), /Stop could not be confirmed/);
  assert.equal(declined, true);
  assert.equal(c.confirmation, null);
  assert.equal(c.state.busy, true);
  assert.equal(c.state.activity, 'Stop not confirmed');
  assert.equal(c.desktopActionsRevoked, true);
  await assert.rejects(c.invokeDesktopTool('screen_windows', {}), /No active/);
  await assert.rejects(c.turn('Another request'), /not stopped/);
});

test('acknowledged cancellation remains Stopping until the runtime confirms it', async () => {
  const c = companion();
  c.beginExternalRun({ id: 'run', userMessageId: 'user', status: 'running' });
  c.t3 = { call: async tag => tag === 'orchestration.getThreadProjection'
    ? { thread: { activeRunId: 'run' }, runs: [{ id: 'run', status: 'running' }] }
    : {} };
  assert.deepEqual(await c.interrupt(), { confirmed: false });
  assert.equal(c.state.stopping, true);
  assert.equal(c.state.busy, true);
  event(c, { id: 'run', status: 'interrupted' }, 'run.updated');
  assert.equal(c.state.stopping, false);
  assert.equal(c.state.busy, false);
});

test('a completed runtime snapshot confirms Stop even after a transport error', async () => {
  const c = companion();
  c.beginExternalRun({ id: 'run', userMessageId: 'user', status: 'running' });
  c.t3 = { call: async tag => {
    if (tag === 'orchestration.getThreadProjection') return { thread: {}, runs: [{ id: 'run', status: 'completed' }] };
    throw new Error('Stop acknowledgement lost');
  } };
  assert.deepEqual(await c.interrupt(), { confirmed: true });
  assert.equal(c.state.busy, false);
  assert.equal(c.state.error, null);
});

test('a failed dispatch rejects rather than acknowledging lost input', async () => {
  const c = companion();
  let accepted = false;
  c.t3 = { call: async () => { throw new Error('Dispatch unavailable'); } };
  await assert.rejects(c.turn('Question', { onAccepted: () => { accepted = true; } }), /Dispatch unavailable/);
  assert.equal(accepted, false);
  assert.equal(c.state.busy, false);
});

test('a privacy-blocked foreground app permits a text-only request', async () => {
  const c = companion();
  c.state.watching = true;
  c.hasT3History = true;
  c.observe = async () => { throw Object.assign(new Error('Excluded app'), { code: 'SCREEN_PRIVACY_BLOCKED' }); };
  let request;
  c.t3 = { call: async (_tag, payload) => {
    request = payload;
    queueMicrotask(() => c.t3Finish?.());
    return {};
  } };
  let accepted = false;
  await c.turn('A text question', { onAccepted: () => { accepted = true; } });
  assert.equal(accepted, true);
  assert.deepEqual(request.attachments, []);
  assert.match(request.text, /privacy settings/);
});

test('a disconnected T3 call and subscription do not retain pending handles', async () => {
  const client = new T3Client();
  await assert.rejects(client.call('server.getConfig'), /not connected/);
  assert.equal(client.pending.size, 0);
  assert.throws(() => client.subscribe('updates', {}, () => {}), /not connected/);
  assert.equal(client.pending.size, 0);
});

test('a confirmed runtime event acknowledges delivery even when the dispatch reply is lost', async () => {
  const c = companion();
  let accepted = 0;
  c.t3 = { call: async (_tag, payload) => {
    event(c, { id: 'run', status: 'running', userMessageId: payload.messageId }, 'run.created');
    event(c, { id: 'run', status: 'completed' }, 'run.updated');
    throw new Error('Dispatch reply lost');
  } };
  await c.turn('Keep this exactly once', { onAccepted: () => accepted++ });
  assert.equal(accepted, 1);
  assert.equal(c.state.error, null);
});

test('a reconnect confirms a previously uncertain user message without duplication', () => {
  const c = companion();
  c.messages = [{ id: 'local', role: 'user', text: 'Question', t3MessageId: 'user', delivery: 'failed' }];
  c.restoreProjection({ runs: [], turnItems: [{ id: 'u', type: 'user_message', messageId: 'user', text: 'Question' }] });
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0].delivery, 'sent');
});

test('events from a stopped request cannot speak into a newer reply', () => {
  const c = companion();
  c.ignoredT3Runs = new Set(['old-run']);
  let spoken = 0;
  c.on('delta', () => spoken++);
  event(c, { id: 'old-answer', type: 'assistant_message', runId: 'old-run', text: 'Stale answer', streaming: false });
  assert.equal(spoken, 0);
  assert.equal(c.messages.length, 0);
});
