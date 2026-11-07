import test from 'node:test';
import assert from 'node:assert/strict';
import { T3Companion } from '../src/t3-companion.js';
import { T3Client } from '../src/t3-client.js';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

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

async function promptFixture(run){
  const dir=await mkdtemp(join(tmpdir(),'hephaestus-instructions-'));
  try{await mkdir(join(dir,'context'));await writeFile(join(dir,'context','AGENTS.md'),'Previous instructions.\n');const c=companion();c.dataDir=dir;c.t3ThreadId='old';c.t3ProjectId='project';c.state.prompt='Previous instructions.';await run(c,dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('instruction save waits for confirmed cancellation before changing files or subscriptions',async()=>promptFixture(async(c,dir)=>{
  let stoppedSubscriptions=0,launches=0;c.stopT3Subscription=()=>stoppedSubscriptions++;
  c.interrupt=async()=>{c.state.stopping=true;c.t3InFlight=true;return{confirmed:false};};
  c.t3={call:async()=>{launches++;return{threadId:'new'};}};
  await assert.rejects(c.replacePrompt('New instructions.'),/still stopping/);
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'Previous instructions.\n');
  assert.equal(c.t3ThreadId,'old');assert.equal(stoppedSubscriptions,0);assert.equal(launches,0);
}));

test('delayed cancellation can be followed by instruction save and another successful request',async()=>promptFixture(async(c,dir)=>{
  let confirmed=false;
  c.interrupt=async()=>{c.state.stopping=!confirmed;c.t3InFlight=!confirmed;return{confirmed};};
  c.t3={subscribe:()=>()=>{},call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};if(p.type==='message.dispatch')queueMicrotask(()=>c.t3Finish?.());return{};}};
  await assert.rejects(c.replacePrompt('New instructions.'),/still stopping/);
  confirmed=true;await c.replacePrompt('New instructions.');
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'New instructions.\n');
  assert.equal(c.t3ThreadId,'new');assert.equal(c.state.stopping,false);
  let accepted=false;await c.turn('Next request',{onAccepted:()=>{accepted=true;}});assert.equal(accepted,true);
}));

test('a failed replacement launch keeps the existing instructions and subscription',async()=>promptFixture(async(c,dir)=>{
  let unsubscribed=false;c.stopT3Subscription=()=>{unsubscribed=true;};c.interrupt=async()=>({confirmed:true});
  c.t3={call:async()=>{throw new Error('Launch unavailable');}};
  await assert.rejects(c.replacePrompt('New instructions.'),/Launch unavailable/);
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'Previous instructions.\n');
  assert.equal(c.t3ThreadId,'old');assert.equal(unsubscribed,false);
}));

test('an unsuccessful prompt-file write preserves the active thread and original text',async()=>promptFixture(async(c,dir)=>{
  await mkdir(join(dir,'context','AGENTS.md.tmp'));let archived;
  c.interrupt=async()=>({confirmed:true});c.t3={call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};archived=p.threadId;return{};}};
  await assert.rejects(c.replacePrompt('New instructions.'));
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'Previous instructions.\n');
  assert.equal(c.t3ThreadId,'old');assert.equal(archived,'new');
}));

test('archiving failure does not misreport successfully activated instructions as unsaved',async()=>promptFixture(async(c,dir)=>{
  c.interrupt=async()=>({confirmed:true});c.t3={subscribe:()=>()=>{},call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};if(p.type==='thread.archive')throw new Error('Archive unavailable');return{};}};
  await c.replacePrompt('New instructions.');
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'New instructions.\n');assert.equal(c.t3ThreadId,'new');
  assert.equal(c.activities.at(-1).title,'Conversation history');assert.equal(c.activities.at(-1).status,'failed');
}));
