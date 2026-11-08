import test from 'node:test';
import assert from 'node:assert/strict';
import { T3Companion } from '../src/t3-companion.js';
import { T3Client } from '../src/t3-client.js';
import {Companion} from '../src/companion.js';
import {T3Workspace} from '../src/t3-workspace.js';
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
  c.saveT3 = async () => {};
  return c;
}

function event(c, payload, type = 'turn-item.updated') {
  c.t3Stream({ kind: 'event', event: { type, payload } });
}
async function currentToolLease(c,tool='screen_windows'){
 const runId=c.t3RunId,providerThreadId='provider-'+runId,attemptId='attempt-'+runId,nativeSessionId='native-session-'+runId,nativeTurnId='native-turn-'+runId;
 c.t3??={call:async()=>{throw new Error('Unexpected projection fetch');}};c.t3TransportReady=true;c.providerNativeIds.set(providerThreadId,nativeSessionId);c.t3Attempts.set(attemptId,runId);c.providerTurnUpdate({id:'provider-turn-'+runId,providerThreadId,runAttemptId:attemptId,nativeTurnRef:{nativeId:nativeTurnId},status:'running'});
 return c.authorizeToolOrigin(Object.freeze({nativeSessionId,nativeTurnId,toolUseId:'tool-use-'+runId,nonce:'fixture-nonce-'+runId,tool}));
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
  const result = await c.invokeDesktopTool('screen_windows', {},{lease:await currentToolLease(c)});
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

test('recovered history uses canonical message time and repairs previously restored timestamps',()=>{
 const c=companion(),sent='2026-11-07T10:00:00Z',answered='2026-11-07T10:00:05Z';
 c.messages=[{id:'local',role:'user',text:'Question',at:Date.now(),t3MessageId:'user',delivery:'failed'}];
 c.restoreProjection({messages:[{id:'user',createdAt:sent}],turnItems:[
  {id:'u',type:'user_message',messageId:'user',text:'Question',startedAt:'2026-11-07T10:00:01Z'},
  {id:'a',type:'assistant_message',text:'Answer',startedAt:'2026-11-07T10:00:02Z',completedAt:answered}
 ]});
 assert.deepEqual(c.messages.map(m=>[m.text,m.at]),[['Question',Date.parse(sent)],['Answer',Date.parse(answered)]]);
 assert.equal(c.messages[0].id,'local');assert.equal(c.messages[0].delivery,'sent');
});

test('historical recovery retains the newest messages and most recent user context',()=>{
 const c=companion(),start=Date.parse('2026-11-07T10:00:00Z');
 c.messages=[{id:'recent',role:'user',text:'My current task',at:start+200000}];
 const turnItems=Array.from({length:125},(_,i)=>({id:'u'+i,type:'user_message',messageId:'m'+i,text:'Earlier task '+i,startedAt:new Date(start+i*1000).toISOString()}));
 c.restoreProjection({turnItems});c.restoreProjection({turnItems});
 assert.equal(c.messages.length,120);assert.equal(c.messages.at(-1).id,'recent');assert.equal(c.messages[0].text,'Earlier task 6');
 assert.equal(c.messages.filter(m=>m.id==='recent').length,1);
});

test('undated recovery never invents a new timestamp or matches an unrelated legacy user',()=>{
 const c=companion();c.messages=[{id:'legacy',role:'user',text:'Existing task',at:123}];
 const projection={turnItems:[{id:'undated',type:'user_message',text:'Undated history'}]};
 c.restoreProjection(projection);c.restoreProjection(projection);
 assert.equal(c.messages.length,2);assert.equal(c.messages[0].text,'Undated history');assert.equal(c.messages[0].at,null);
 assert.equal(c.messages.at(-1).id,'legacy');assert.equal(c.messages.at(-1).delivery,undefined);
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
  event(c, { id: 'run', runId: 'run', status: 'interrupted' }, 'run.updated');
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

test('losing the connection during a request keeps recovery status until the runtime reconciles it',async()=>{
 const c=companion();
 c.t3={call:async()=>{queueMicrotask(()=>{c.t3Finish?.();c.scheduleReconnect();clearTimeout(c.reconnectTimer);c.reconnectTimer=null;});return{};}};
 await c.turn('Keep working');
 assert.equal(c.state.activity,'Reconnecting to Codex');assert.equal(c.state.busy,true);
 c.restoreProjection({thread:{activeRunId:'run'},runs:[{id:'run',status:'running',userMessageId:'user'}]});
 assert.equal(c.t3InFlight,true);assert.equal(c.state.busy,true);assert.equal(c.state.activity,'Continuing your request');
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
    event(c, { id: 'accepted-answer', runId: 'run', type: 'assistant_message', text: 'The acknowledged request completed.', streaming: false });
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
async function readyPromptSnapshot(_tag,_payload,onValue){await onValue({kind:'snapshot',projection:{thread:{},runs:[],turnItems:[]}});return()=>{};}

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
  c.t3={subscribeReady:readyPromptSnapshot,call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};if(p.type==='message.dispatch')queueMicrotask(()=>c.t3Finish?.());return{};}};
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
  c.interrupt=async()=>({confirmed:true});c.t3={subscribeReady:readyPromptSnapshot,call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};archived=p.threadId;return{};}};
  await assert.rejects(c.replacePrompt('New instructions.'));
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'Previous instructions.\n');
  assert.equal(c.t3ThreadId,'old');assert.equal(archived,'new');
}));

test('archiving failure does not misreport successfully activated instructions as unsaved',async()=>promptFixture(async(c,dir)=>{
  c.interrupt=async()=>({confirmed:true});c.t3={subscribeReady:readyPromptSnapshot,call:async(tag,p)=>{if(tag==='orchestration.launchThread')return{threadId:'new'};if(p.type==='thread.archive')throw new Error('Archive unavailable');return{};}};
  await c.replacePrompt('New instructions.');
  assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'New instructions.\n');assert.equal(c.t3ThreadId,'new');
  assert.equal(c.activities.at(-1).title,'Conversation history');assert.equal(c.activities.at(-1).status,'failed');
}));

test('disconnect then Stop preserves revocation, replays cancellation and only permits a new terminal-confirmed request',async()=>{
 const c=companion();c.scheduleReconnect=()=>c.publish({connection:'reconnecting',busy:true,activity:'Reconnecting to T3'});let accepted=0;
 c.t3={call:async(_tag,p)=>{event(c,{id:'stopped-run',userMessageId:p.messageId,status:'running'},'run.created');queueMicrotask(()=>c.t3Disconnected());return{};}};
 await c.turn('Keep working',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.equal(c.state.connection,'reconnecting');assert.equal(c.state.busy,true);
 // A settled local waiter must not erase the remote request's identity.
 c.t3InFlight=false;let declined=false;c.confirmation={reject:()=>declined=true};
 assert.deepEqual(await c.interrupt(),{confirmed:false});assert.equal(declined,true);assert.equal(c.desktopActionsRevoked,true);assert.equal(c.t3StopIntent.runId,'stopped-run');assert.notEqual(c.state.activity,'Ready');
 const active={thread:{activeRunId:'stopped-run'},runs:[{id:'stopped-run',userMessageId:c.t3MessageId,status:'running'}]};let stops=0;
 c.t3={call:async(tag,p)=>{if(tag==='orchestration.getThreadProjection')return active;if(p.type==='thread.stop')stops++;return{};}};c.t3TransportReady=true;c.state.connection='connecting';
 c.restoreProjection(active);c.restoreProjection(active);await c.t3StopReplay.promise;
 assert.equal(stops,1);assert.equal(c.t3StopIntent.runId,'stopped-run');assert.equal(c.desktopActionsRevoked,true);
 const generation=c.generation;c.beginExternalRun(active.runs[0]);assert.equal(c.generation,generation);assert.equal(c.desktopActionsRevoked,true);
 c.state.connection='connected';await assert.rejects(c.invokeDesktopTool('screen_windows',{}),/No active/);await assert.rejects(c.turn('Too early'),/not stopped/);
 c.restoreProjection({thread:{},runs:[{...active.runs[0],status:'interrupted'}]});assert.equal(c.t3StopIntent,null);assert.equal(c.state.activity,'Ready');assert.equal(c.state.busy,false);
 event(c,active.runs[0],'run.created');await assert.rejects(c.invokeDesktopTool('screen_windows',{}),/No active/);
 c.bridge={call:async()=>[{id:'allowed-window'}]};let toolAccepted=false;
 c.t3={call:async(_tag,p)=>{event(c,{id:'new-run',userMessageId:p.messageId,status:'running'},'run.created');toolAccepted=(await c.invokeDesktopTool('screen_windows',{},{lease:await currentToolLease(c)})).success;event(c,{id:'new-run',status:'completed'},'run.updated');return{};}};
 await c.turn('A new request',{onAccepted:()=>accepted++});assert.equal(accepted,2);assert.equal(toolAccepted,true);assert.equal(c.state.busy,false);
});

test('Stop retains an accepted message without a known run ID and learns it on reconnect',async()=>{
 const c=companion();c.scheduleReconnect=()=>c.publish({connection:'reconnecting',busy:true});c.t3={call:async()=>({})};
 await c.turn('Accepted before its run event',{onAccepted:()=>c.t3Disconnected()});const messageId=c.t3MessageId;
 await c.interrupt();assert.equal(c.t3StopIntent.messageId,messageId);assert.equal(c.t3StopIntent.runId,null);
 let stops=0;c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?{thread:{activeRunId:'recovered'},runs:[{id:'recovered',userMessageId:messageId,status:'running'}]}:{};}};c.t3TransportReady=true;
 c.restoreProjection({thread:{activeRunId:'recovered'},runs:[{id:'recovered',userMessageId:messageId,status:'running'}]});await c.t3StopReplay.promise;
 assert.equal(stops,1);assert.equal(c.t3StopIntent.runId,'recovered');assert.equal(c.ignoredT3Runs.has('recovered'),true);assert.equal(c.desktopActionsRevoked,true);
});

test('a pending disconnected Stop is saved and removed only by confirmed terminal state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hephaestus-stop-recovery-'));
 try{
  const c=companion();c.dataDir=dir;c.saveT3=T3Companion.prototype.saveT3.bind(c);c.state.connection='reconnecting';c.t3Outstanding={threadId:'thread',messageId:'user',runId:'run'};
  await c.interrupt();let saved=JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8'));assert.equal(saved.stopIntent.runId,'run');assert.equal(saved.stopIntent.messageId,'user');
  c.restoreProjection({runs:[{id:'run',status:'interrupted'}]});await c.t3SaveQueue;saved=JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8'));assert.equal(saved.stopIntent,undefined);assert.equal(c.desktopActionsRevoked,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

async function connectFixture(run,{stopIntent,withholdSnapshot=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'hephaestus-readiness-'));
 const originals={connect:Companion.prototype.connect,start:T3Client.prototype.start,call:T3Client.prototype.call,subscribe:T3Client.prototype.subscribe,close:T3Client.prototype.close,workspaceStart:T3Workspace.prototype.start,fetch:globalThis.fetch};
 let entered,release,subscriptionEntered,c;const controls={baseOptions:[],states:[],subscribed:false,snapshotProcessed:false,unsubscribed:0,usageCalls:0,stopCalls:0,projection:stopIntent?{thread:{activeRunId:stopIntent.runId},runs:[{id:stopIntent.runId,userMessageId:stopIntent.messageId,status:'running'}]}:{thread:{},runs:[]},entered:new Promise(r=>entered=r),gate:new Promise(r=>release=r),subscriptionEntered:new Promise(r=>subscriptionEntered=r),release:()=>release()};
 try{
  await writeFile(join(dir,'t3-runtime.json'),JSON.stringify({adapterVersion:5,projectId:'project',threadId:'thread',...(stopIntent?{stopIntent}:{})}));
  Companion.prototype.connect=async function(options){controls.baseOptions.push(options);this.publish({connection:'connecting',activity:'Connecting to Codex'});if(options?.publishReady!==false)this.publish({connection:'connected',activity:'Ready'});};
  T3Client.prototype.start=async function(){this.origin='http://127.0.0.1:12345';this.token='test-session';this.socket={readyState:1,close(){}};entered();await controls.gate;return this;};
  T3Client.prototype.call=async function(tag,p={}){if(tag==='server.getConfig')return{providers:[{instanceId:'codex',status:'ready',auth:{type:'chatgpt'},models:[{slug:'gpt-6-luna',name:'Luna'}]}],settings:{}};if(tag==='orchestration.getThreadProjection')return structuredClone(controls.projection);if(p.type==='thread.stop'){controls.stopCalls++;controls.projection={thread:{},runs:[{id:stopIntent.runId,status:'interrupted'}]};}return{};};
  T3Client.prototype.subscribe=function(_tag,_payload,onValue,onError){controls.subscribed=true;controls.sendSnapshot=()=>onValue({kind:'snapshot',projection:structuredClone(controls.projection)});controls.failSubscription=onError;subscriptionEntered();if(!withholdSnapshot)queueMicrotask(()=>controls.sendSnapshot());return()=>controls.unsubscribed++;};T3Client.prototype.close=async()=>{};T3Workspace.prototype.start=async function(){return this;};
  globalThis.fetch=async()=>({json:async()=>[{id:'project',workspaceRoot:join(dir,'context')}]});
  c=companion();c.dataDir=dir;c.desktopServer={};c.prepareWorkspace=async()=>{};c.updateUsage=async()=>{assert.equal(c.state.connection,'connected');controls.usageCalls++;};c.on('messagesRestored',()=>{if(controls.subscribed)controls.snapshotProcessed=true;});c.on('state',state=>controls.states.push({...state,subscribed:controls.subscribed,snapshotProcessed:controls.snapshotProcessed}));
  await run(c,controls);
 }finally{
  if(c){c.closed=true;clearTimeout(c.reconnectTimer);c.reconnectTimer=null;c.stopT3Subscription?.();c.workspace?.close();}controls.release();if(controls.sendSnapshot&&!controls.snapshotProcessed)await controls.sendSnapshot();
  Companion.prototype.connect=originals.connect;T3Client.prototype.start=originals.start;T3Client.prototype.call=originals.call;T3Client.prototype.subscribe=originals.subscribe;T3Client.prototype.close=originals.close;T3Workspace.prototype.start=originals.workspaceStart;globalThis.fetch=originals.fetch;
  await rm(dir,{recursive:true,force:true});
 }
}

test('startup does not announce connected or Ready until T3 and its subscription are reconciled',async()=>connectFixture(async(c,controls)=>{
 c.state.connection='connecting';const starting=c.connect();await controls.entered;
 assert.deepEqual(controls.baseOptions,[{publishReady:false}]);assert.equal(controls.states.some(s=>s.connection==='connected'||s.activity==='Ready'),false);
 controls.release();await starting;const connected=controls.states.filter(s=>s.connection==='connected');assert.equal(connected.length,1);assert.equal(connected[0].subscribed,true);assert.equal(connected[0].snapshotProcessed,true);assert.equal(c.state.activity,'Ready');assert.equal(controls.usageCalls,1);
}));

test('an open subscription without its initial snapshot cannot make startup Ready',async()=>connectFixture(async(c,controls)=>{
 c.state.connection='connecting';const starting=c.connect();await controls.entered;controls.release();await controls.subscriptionEntered;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(c.t3.socket.readyState,1);assert.equal(controls.subscribed,true);assert.equal(controls.snapshotProcessed,false);assert.equal(controls.states.some(state=>state.connection==='connected'||state.activity==='Ready'),false);assert.equal(controls.usageCalls,0);
 await controls.sendSnapshot();await starting;assert.equal(c.state.connection,'connected');assert.equal(controls.snapshotProcessed,true);assert.equal(controls.usageCalls,1);
},{withholdSnapshot:true}));

test('startup replays a saved Stop before announcing readiness and cannot resurrect that run',async()=>connectFixture(async(c,controls)=>{
 c.state.connection='connecting';const starting=c.connect();await controls.entered;controls.release();await starting;
 assert.equal(controls.stopCalls,1);assert.equal(c.t3StopIntent,null);assert.equal(c.desktopActionsRevoked,true);assert.equal(c.ignoredT3Runs.has('saved-run'),true);assert.equal(c.state.activity,'Ready');
 c.restoreProjection({thread:{activeRunId:'saved-run'},runs:[{id:'saved-run',userMessageId:'saved-user',status:'running'}]});assert.equal(c.t3InFlight,false);await assert.rejects(c.invokeDesktopTool('screen_windows',{}),/No active/);
},{stopIntent:{threadId:'thread',runId:'saved-run',messageId:'saved-user',requestedAt:1}}));

test('subscription faults from a closed socket leave connected state before publishing the error',async()=>connectFixture(async(c,controls)=>{
 c.state.connection='connecting';const starting=c.connect();await controls.entered;controls.release();await starting;
 c.scheduleReconnect=()=>{};c.t3.socket={readyState:3};const transitions=[];c.on('state',state=>transitions.push({connection:state.connection,socketState:c.t3.socket.readyState}));
 c.t3.emit('fault',new Error('Subscription disconnected'));const generation=c.generation;c.t3.emit('disconnected');
 assert.equal(c.generation,generation);assert.ok(transitions.every(s=>s.connection!=='connected'));assert.equal(c.state.connection,'reconnecting');assert.equal(c.state.error,'Subscription disconnected');
}));

test('a post-initialization subscription failure revokes desktop actions and reconnects even with an open socket',async()=>connectFixture(async(c,controls)=>{
 c.state.connection='connecting';const starting=c.connect();await controls.entered;controls.release();await starting;
 c.beginExternalRun({id:'stream-run',userMessageId:'stream-user',status:'running'});let declined=false;c.confirmation={reject:()=>declined=true};const generation=c.generation;
 controls.failSubscription(new Error('Stream failed while socket remained open'));
 assert.equal(c.t3.socket.readyState,1);assert.equal(c.state.connection,'reconnecting');assert.equal(c.desktopActionsRevoked,true);assert.equal(c.confirmation,null);assert.equal(declined,true);assert.ok(c.generation>generation);assert.ok(c.reconnectTimer);assert.match(c.state.error,/stream disconnected/);
 await assert.rejects(c.invokeDesktopTool('screen_windows',{}),/No active/);assert.equal(controls.unsubscribed,1);
}));

async function sharedFrameFixture(){
 const c=companion();c.state.watching=true;c.hasT3History=true;
 c.bridge={call:async command=>{if(command==='target-info')return{id:'window',process:'editor'};if(command==='capture')return{width:100,height:100,bounds:{x:0,y:0,width:100,height:100},image:'YQ==',window:{id:'window',process:'editor',title:'Editor'},capturedAt:Date.now(),captureSource:'window',fingerprint:''};throw Error(command);}};
 const previous=await c.observe();c.shareModelObservation(previous);const shared=[];c.on('visionFrame',frame=>shared.push(frame));return{c,previous,shared};
}

test('upload and dispatch failures never replace the previously shared image or register unseen evidence',async()=>{
 for(const failure of['upload','dispatch']){
  const{c,previous,shared}=await sharedFrameFixture();let dispatched=0;
  c.t3={call:async tag=>{if(tag==='assets.persistChatAttachments'){if(failure==='upload')throw Error('Upload failed');return{attachments:[{id:'asset'}]};}dispatched++;throw Error('Dispatch failed');}};
  await assert.rejects(c.turn('Read this image'),/failed/);assert.equal(dispatched,failure==='upload'?0:1);assert.equal(shared.length,0);assert.equal(c.lastModelObservationId,previous.id);assert.equal(c.modelObservations.size,1);
 }
});

test('a successful dispatch shares its image only when the request is acknowledged',async()=>{
 const{c,previous,shared}=await sharedFrameFixture();let accepted=0;
 c.t3={call:async(tag,p)=>{if(tag==='assets.persistChatAttachments'){assert.equal(shared.length,0);return{attachments:[{id:'asset'}]};}assert.equal(shared.length,0);assert.equal(c.lastModelObservationId,previous.id);queueMicrotask(()=>c.t3Finish?.());return{};}};
 await c.turn('Read this image',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.equal(shared.length,1);assert.notEqual(shared[0].id,previous.id);assert.equal(c.modelObservation().id,shared[0].id);
});

test('run.created acknowledgement shares an accepted image once even if its dispatch reply is lost',async()=>{
 const{c,shared}=await sharedFrameFixture();let accepted=0;
 c.t3={call:async(tag,p)=>{if(tag==='assets.persistChatAttachments')return{attachments:[{id:'asset'}]};event(c,{id:'run',userMessageId:p.messageId,status:'running'},'run.created');assert.equal(shared.length,1);event(c,{id:'image-answer',runId:'run',type:'assistant_message',text:'The accepted image was received.',streaming:false});event(c,{id:'run',status:'completed'},'run.updated');throw Error('Reply lost');}};
 await c.turn('Read this image',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.equal(shared.length,1);assert.equal(c.state.error,null);
});

test('privacy blocking at acknowledgement suppresses image sharing while retaining accepted text',async()=>{
 const{c,previous,shared}=await sharedFrameFixture();let accepted=0;
 c.t3={call:async tag=>{if(tag==='assets.persistChatAttachments')return{attachments:[{id:'asset'}]};c.state.screenPrivacyBlocked=true;queueMicrotask(()=>c.t3Finish?.());return{};}};
 await c.turn('A text request',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.equal(shared.length,0);assert.equal(c.lastModelObservationId,previous.id);assert.equal(c.state.error,null);
});

test('recovery without a Stop restores the continuing request after a real disconnect',async()=>{
 const c=companion();c.scheduleReconnect=()=>c.publish({connection:'reconnecting',busy:true});c.t3={call:async(_tag,p)=>{event(c,{id:'run',userMessageId:p.messageId,status:'running'},'run.created');queueMicrotask(()=>c.t3Disconnected());return{};}};
 await c.turn('Continue this request');assert.equal(c.desktopActionsRevoked,true);assert.equal(c.t3InFlight,true);
 c.restoreProjection({thread:{activeRunId:'run'},runs:[{id:'run',userMessageId:c.t3MessageId,status:'running'}]});assert.equal(c.desktopActionsRevoked,false);c.state.connection='connected';c.bridge={call:async()=>[{id:'window'}]};assert.equal((await c.invokeDesktopTool('screen_windows',{},{lease:await currentToolLease(c)})).success,true);
});

test('an accepted but not-yet-projected message cannot be declared stopped from an empty snapshot',async()=>{
 const c=companion();c.t3Outstanding={threadId:'thread',messageId:'accepted-user',runId:null,accepted:true};c.t3={call:async()=>({thread:{},runs:[]})};
 assert.deepEqual(await c.interrupt(),{confirmed:false});assert.equal(c.state.stopping,true);assert.equal(c.desktopActionsRevoked,true);assert.notEqual(c.state.activity,'Ready');
 c.restoreProjection({runs:[{id:'late-run',userMessageId:'accepted-user',status:'interrupted'}]});assert.equal(c.t3StopIntent,null);assert.equal(c.state.activity,'Ready');
});

test('closing revokes reconnection before waiting for a delayed T3 session close',async()=>{
 const c=companion();let release,entered,reconnects=0;const waiting=new Promise(resolve=>entered=resolve),closed=new Promise(resolve=>release=resolve);
 c.scheduleReconnect=()=>reconnects++;c.t3={close:async()=>{c.t3Disconnected();entered();await closed;}};
 const closing=c.close();await waiting;assert.equal(c.closed,true);assert.equal(reconnects,0);release();await closing;assert.equal(reconnects,0);
});
