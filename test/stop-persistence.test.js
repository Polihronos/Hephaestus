import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {Companion} from '../src/companion.js';
import {T3Companion} from '../src/t3-companion.js';
import {T3Client} from '../src/t3-client.js';
import {T3Workspace} from '../src/t3-workspace.js';
import {promptHash,writePromptTransaction} from '../src/prompt-recovery.js';

const active={id:'run',userMessageId:'user',status:'running'};
const projection=status=>({thread:status==='running'?{activeRunId:'run'}:{},runs:[{...active,status}]});
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'hephaestus-stop-persistence-'));
 const c=new T3Companion({root:process.cwd(),dataDir:dir});
 Object.assign(c.state,{connection:'connected',watching:false});
 Object.assign(c,{t3ThreadId:'thread',t3ProjectId:'project',t3Runs:new Map([['run',active]]),t3Attempts:new Map(),t3Seen:new Map(),providerNativeIds:new Map(),providerContexts:new Map(),t3TransportReady:true});
 c.save=async()=>{};c.scheduleReconnect=()=>{};c.beginExternalRun(active);
 try{await c.saveT3();await run(c,dir);}finally{c.closed=true;clearTimeout(c.reconnectTimer);await c.t3SaveQueue?.catch(()=>{});await rm(dir,{recursive:true,force:true});}
}
async function blockCache(dir){const path=join(dir,'t3-runtime.json.tmp');await mkdir(path);return()=>rmdir(path);}
async function lease(c){
 c.providerNativeIds.set('provider','native-session');c.t3Attempts.set('attempt','run');
 c.providerTurnUpdate({id:'provider-turn',providerThreadId:'provider',runAttemptId:'attempt',nativeTurnRef:{nativeId:'native-turn'},status:'running'});
 return c.authorizeToolOrigin(Object.freeze({nativeSessionId:'native-session',nativeTurnId:'native-turn',toolUseId:'tool',nonce:'nonce',tool:'screen_windows'}));
}

test('a real cache write fault cannot prevent connected Stop or terminal confirmation',async()=>fixture(async(c,dir)=>{
 const before=await readFile(join(dir,'t3-runtime.json'),'utf8'),unblock=await blockCache(dir);let stops=0,inputs=0;
 c.t3={call:async(tag,p)=>{if(p.type==='thread.stop'){stops++;assert.equal(c.desktopActionsRevoked,true);}return tag==='orchestration.getThreadProjection'?projection('interrupted'):{};}};
 c.bridge={call:async()=>{inputs++;return[];}};const oldLease=await lease(c);
 assert.deepEqual(await c.interrupt(),{confirmed:true});
 assert.equal(stops,1);assert.equal(c.state.busy,false);assert.equal(c.state.stopping,false);assert.equal(c.state.error,null);
 assert.match(c.state.stopPersistenceError,/request stopped.*recovery state could not be updated/);assert.equal(c.state.stopRetryAvailable,true);assert.equal(c.t3StopPersistenceDirty,true);
 assert.equal(await readFile(join(dir,'t3-runtime.json'),'utf8'),before);
 await assert.rejects(c.invokeDesktopTool('screen_windows',{},{lease:oldLease}),/No active/);assert.equal(inputs,0);
 c.t3Stream({kind:'event',event:{type:'run.created',payload:active}});assert.equal(c.t3InFlight,false);assert.equal(c.desktopActionsRevoked,true);
 await unblock();assert.deepEqual(await c.interrupt(),{confirmed:true});
 assert.equal(stops,1);assert.equal(c.state.stopPersistenceError,null);assert.equal(c.state.stopRetryAvailable,false);assert.equal(c.t3StopPersistenceDirty,false);
 assert.equal(JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')).stopIntent,undefined);
}));

test('combined transport and cache faults retain intent and permit a successful explicit retry',async()=>fixture(async(c,dir)=>{
 const unblock=await blockCache(dir);let unavailable=true,stops=0;const states=[];c.on('state',s=>states.push(s));
 c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;if(unavailable)throw new Error('Transport unavailable');return tag==='orchestration.getThreadProjection'?projection('cancelled'):{};}};
 const oldLease=await lease(c);
 await assert.rejects(c.interrupt(),/Stop could not be confirmed/);
 assert.equal(stops,1);assert.equal(c.t3StopIntent.runId,'run');assert.equal(c.state.stopping,true);assert.equal(c.state.stopRequestPending,false);assert.equal(c.state.stopRetryAvailable,true);
 assert.match(c.state.stopPersistenceError,/may not survive restarting/);assert.match(c.state.error,/Stop could not be confirmed/);assert.equal(states.some(s=>s.activity==='Ready'),false);
 await assert.rejects(c.invokeDesktopTool('screen_windows',{},{lease:oldLease}),/No active/);await assert.rejects(c.turn('New work'),/not stopped/);
 await unblock();unavailable=false;assert.deepEqual(await c.interrupt(),{confirmed:true});
 assert.equal(stops,2);assert.equal(c.t3StopIntent,null);assert.equal(c.state.activity,'Ready');assert.equal(c.state.stopPersistenceError,null);assert.equal(c.state.stopRetryAvailable,false);
}));

test('terminal confirmation with a failed cleanup retains the durable intent until recovery saving is retried',async()=>fixture(async(c,dir)=>{
 let unblock,stops=0;
 c.t3={call:async(tag,p)=>{
  if(p.type==='thread.stop'){stops++;await c.t3StopPersistencePromise;unblock=await blockCache(dir);}
  return tag==='orchestration.getThreadProjection'?projection('interrupted'):{};
 }};
 assert.deepEqual(await c.interrupt(),{confirmed:true});
 assert.equal(JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')).stopIntent.runId,'run');
 assert.equal(c.state.stopping,false);assert.equal(c.state.busy,false);assert.match(c.state.stopPersistenceError,/request stopped/);assert.equal(c.state.stopRetryAvailable,true);
 await unblock();await c.interrupt();assert.equal(stops,1);assert.equal(c.state.stopPersistenceError,null);
 assert.equal(JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')).stopIntent,undefined);
}));

test('Stop dispatch starts while its recovery write is still pending',async()=>fixture(async(c)=>{
 let release,stops=0;const blocked=new Promise(resolve=>release=resolve);c.saveT3=()=>blocked;
 c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?projection('running'):{};}};
 const stopping=c.interrupt();await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);assert.equal(c.desktopActionsRevoked,true);
 release();assert.deepEqual(await stopping,{confirmed:false});assert.equal(c.state.stopRetryAvailable,true);
}));

test('offline cache failure retains the in-memory Stop and replays it after reconnect',async()=>fixture(async(c,dir)=>{
 const unblock=await blockCache(dir);c.state.connection='reconnecting';c.t3TransportReady=false;c.t3=null;
 assert.deepEqual(await c.interrupt(),{confirmed:false});assert.equal(c.t3StopIntent.runId,'run');assert.equal(c.desktopActionsRevoked,true);assert.equal(c.state.stopRetryAvailable,true);assert.match(c.state.stopPersistenceError,/may not survive restarting/);
 let stops=0;c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?projection('interrupted'):{};}};c.t3TransportReady=true;
 c.restoreProjection(projection('running'));await c.t3StopReplay.promise;
 assert.equal(stops,1);assert.equal(c.t3StopIntent,null);assert.equal(c.desktopActionsRevoked,true);assert.match(c.state.stopPersistenceError,/request stopped/);
 c.restoreProjection(projection('running'));assert.equal(c.t3InFlight,false);assert.equal(c.desktopActionsRevoked,true);
 await unblock();await c.interrupt();assert.equal(c.state.stopPersistenceError,null);
}));

test('reconnect with a blocked cache waits for its snapshot and preserves a prompt recovery journal',async()=>fixture(async(c,dir)=>{
 const unblock=await blockCache(dir);c.state.connection='reconnecting';c.t3TransportReady=false;c.t3=null;await c.interrupt();
 c.state.prompt='Original instructions';const journal=await writePromptTransaction(dir,{oldThread:'thread',newThread:'orphan',oldPromptHash:promptHash(c.state.prompt),newPromptHash:promptHash('New instructions')});
 const originals={connect:Companion.prototype.connect,start:T3Client.prototype.start,call:T3Client.prototype.call,subscribe:T3Client.prototype.subscribe,close:T3Client.prototype.close,workspace:T3Workspace.prototype.start,fetch:globalThis.fetch};
 let status='running',stops=0,sendSnapshot,subscribed;const subscription=new Promise(resolve=>subscribed=resolve);const states=[];c.on('state',s=>states.push(s));
 try{
  Companion.prototype.connect=async function(options){assert.equal(options.publishReady,false);this.publish({connection:'connecting'});};
  T3Client.prototype.start=async function(){this.origin='http://127.0.0.1:1';this.token='fixture';this.socket={readyState:1};return this;};
  T3Client.prototype.close=async()=>{};
  T3Client.prototype.call=async function(tag,p={}){
   if(tag==='server.getConfig')return{providers:[{instanceId:'codex',status:'ready',auth:{type:'chatgpt'},models:[{slug:'gpt-6-luna'}]}],settings:{}};
   if(p.type==='thread.stop'){stops++;status='interrupted';}
   if(tag==='orchestration.getThreadProjection')return projection(status);
   if(p.type==='thread.archive')throw new Error('A recovery journal must not be finalized while the identity cannot be saved');
   return{};
  };
  T3Client.prototype.subscribe=function(_tag,_args,onValue){sendSnapshot=()=>onValue({kind:'snapshot',projection:projection(status)});subscribed();return()=>{};};
  T3Workspace.prototype.start=async function(){return this;};globalThis.fetch=async()=>({json:async()=>[{id:'project',workspaceRoot:join(dir,'context')}]});
  c.desktopServer={};c.prepareWorkspace=async()=>{};c.updateUsage=async()=>{};
  const connecting=c.connect();await subscription;
  assert.equal(states.some(s=>s.connection==='connected'||s.activity==='Ready'),false);
  await sendSnapshot();await connecting;assert.equal(stops,1);assert.equal(c.state.connection,'connected');assert.equal(c.state.activity,'Ready');assert.equal(c.desktopActionsRevoked,true);
  assert.match(c.state.stopPersistenceError,/request stopped/);assert.equal(c.t3StopPersistenceDirty,true);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'prompt-transaction.json'),'utf8')),journal);
  await unblock();await c.interrupt();assert.equal(c.state.stopPersistenceError,null);
 }finally{
  c.stopT3Subscription?.();c.workspace?.close();
  Companion.prototype.connect=originals.connect;T3Client.prototype.start=originals.start;T3Client.prototype.call=originals.call;T3Client.prototype.subscribe=originals.subscribe;T3Client.prototype.close=originals.close;T3Workspace.prototype.start=originals.workspace;globalThis.fetch=originals.fetch;
 }
}));

async function dashboardFixture(){
 const source=await readFile(new URL('../ui/dashboard.js',import.meta.url),'utf8'),html=await readFile(new URL('../ui/dashboard.html',import.meta.url),'utf8'),elements=new Map();
 class Element{
  constructor(){this.value='';this.hidden=true;this.dataset={};this.style={};this.children=[];this.attributes=new Map();this.classList={toggle(){},add(){},remove(){}};}
  setAttribute(k,v){this.attributes.set(k,v);}removeAttribute(k){this.attributes.delete(k);}addEventListener(){}scrollIntoView(){}focus(){}replaceChildren(){}add(){}remove(){}
  querySelector(){return new Element();}querySelectorAll(){return[];}before(el){elements.set(el.id,el);}append(...els){this.children.push(...els);}
 }
 for(const match of html.matchAll(/\bid="([^"]+)"/g))elements.set(match[1],new Element());
 const document={getElementById:id=>elements.get(id)??null,createElement:()=>new Element(),querySelector:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},activeElement:null};
 let events,dispatch=async()=>({confirmed:true});const initial={connection:'connected',running:true,watching:false,busy:false};
 const context={document,window:{companion:{request:async(command,params)=>command==='init'?{state:initial}:dispatch(command,params),onEvent:fn=>events=fn}},localStorage:{getItem(){return null;}},requestAnimationFrame:()=>1,ResizeObserver:class{observe(){}},Option:class{},speechSynthesis:{getVoices:()=>[]},navigator:{mediaDevices:{enumerateDevices:async()=>[],addEventListener(){}}},createDictation:()=>({event(){},inspect(){}}),createTelemetry:()=>({updateState(){},capabilities(){},usage:{refresh(){}}}),createWorkspace:()=>({updateState(){},navigate(){}}),fastCommand:()=>null,userErrorMessage:error=>error.message,renderMarkdown(){},setTimeout,clearTimeout,console};
 vm.createContext(context);await vm.runInContext('(async()=>{'+source.replace(/^import .*;\r?\n/gm,'')+'\n})()',context);
 return{elements,state:s=>events('state',{...initial,...s}),dispatch:fn=>dispatch=fn};
}

test('the real Stop UI exposes retry and a separate unsaved-recovery warning without duplicate requests',async()=>{
 const ui=await dashboardFixture(),stop=ui.elements.get('stop');let attempts=0,finish;
 ui.state({busy:true,stopping:true,stopRetryAvailable:true,stopRetryId:'original-stop',stopPersistenceError:'Stop recovery could not be saved.',error:'Stop could not be confirmed',activity:'Stop not confirmed'});
 assert.equal(stop.disabled,false);assert.equal(stop.textContent,'Retry Stop');assert.equal(ui.elements.get('reply-state').textContent,'Stop not confirmed');assert.equal(ui.elements.get('stop-persistence-status').hidden,false);
 ui.dispatch(async()=>{attempts++;await new Promise(resolve=>finish=resolve);throw new Error('Transport unavailable');});
 const first=stop.onclick();await stop.onclick();assert.equal(attempts,1);assert.equal(stop.disabled,true);finish();await first;
 assert.equal(stop.disabled,false);assert.equal(stop.textContent,'Retry Stop');assert.equal(ui.elements.get('notice-retry').hidden,false);
 ui.state({stopRetryAvailable:true,stopPersistenceError:'The request stopped, but recovery could not be saved.'});
 assert.equal(stop.disabled,false);assert.equal(stop.textContent,'Save Stop recovery');
 ui.state({busy:true,stopRetryAvailable:true,stopPersistenceError:'The previous request stopped, but recovery could not be saved.'});assert.equal(stop.textContent,'■ Stop reply');
 ui.state({stopRetryAvailable:true,stopPersistenceError:'The request stopped, but recovery could not be saved.'});
 ui.dispatch(async()=>{attempts++;ui.state({stopRetryAvailable:false,stopPersistenceError:null});return{confirmed:true};});
 await ui.elements.get('notice-retry').onclick();assert.equal(attempts,2);assert.equal(stop.disabled,true);assert.equal(ui.elements.get('stop-persistence-status').hidden,true);
});

test('an old recovery-save notice retry only persists recovery and cannot cancel a newer active request',async()=>fixture(async(c,dir)=>{
 const ui=await dashboardFixture(),unblock=await blockCache(dir);let stops=0;
 c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?projection('interrupted'):{};}};
 c.on('state',s=>ui.state(s));ui.state(c.state);ui.dispatch((command,params)=>command==='retry-stop'?c.retryStop(params):c.interrupt());
 await ui.elements.get('stop').onclick();assert.equal(stops,1);assert.equal(c.t3StopPersistenceDirty,true);assert.equal(ui.elements.get('notice-retry').hidden,false);
 await unblock();const next={id:'new-run',userMessageId:'new-user',status:'running'};c.t3Runs.set(next.id,next);c.beginExternalRun(next);const generation=c.generation;
 assert.equal(ui.elements.get('stop').textContent,'■ Stop reply');
 await ui.elements.get('notice-retry').onclick();
 assert.equal(stops,1);assert.equal(c.t3RunId,'new-run');assert.equal(c.t3InFlight,true);assert.equal(c.state.busy,true);assert.equal(c.desktopActionsRevoked,false);assert.equal(c.generation,generation);assert.equal(c.state.stopPersistenceError,null);
 assert.equal(JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')).stopIntent,undefined);
}));

test('an acknowledged active Stop notice follows later terminal confirmation and promotes its retry to persistence only',async()=>fixture(async(c,dir)=>{
 const ui=await dashboardFixture(),unblock=await blockCache(dir);let stops=0;const retries=[];
 c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?projection('running'):{};}};
 c.on('state',s=>ui.state(s));ui.state(c.state);ui.dispatch((command,params)=>{if(command==='retry-stop'){retries.push(params);return c.retryStop(params);}return c.interrupt();});
 await ui.elements.get('stop').onclick();assert.equal(c.state.stopping,true);const pendingWarning=c.state.stopPersistenceError;
 assert.match(pendingWarning,/may not survive restarting/);assert.equal(ui.elements.get('notice-message').textContent,pendingWarning);
 c.reconcilePendingStop(projection('interrupted'));await c.t3StopPersistencePromise;
 assert.equal(c.state.stopping,false);assert.notEqual(c.state.stopPersistenceError,pendingWarning);assert.equal(ui.elements.get('notice-message').textContent,c.state.stopPersistenceError);
 assert.equal(ui.elements.get('notice').hidden,false);assert.equal(ui.elements.get('stop').textContent,'Save Stop recovery');
 await unblock();await ui.elements.get('notice-retry').onclick();
 assert.deepEqual(JSON.parse(JSON.stringify(retries)),[{kind:'recovery'}]);assert.equal(stops,1);assert.equal(c.state.stopPersistenceError,null);assert.equal(ui.elements.get('notice').hidden,true);
}));

test('an unresolved cancellation notice retry is bound to its original Stop and cannot target a newer request',async()=>fixture(async(c,dir)=>{
 const ui=await dashboardFixture(),unblock=await blockCache(dir);let stops=0;
 c.t3={call:async(_tag,p)=>{if(p.type==='thread.stop')stops++;throw new Error('Transport unavailable');}};
 c.on('state',s=>ui.state(s));ui.state(c.state);ui.dispatch((command,params)=>command==='retry-stop'?c.retryStop(params):c.interrupt());
 await ui.elements.get('stop').onclick();const stopId=c.t3StopIntent.retryId;assert.ok(stopId);assert.equal(stops,1);assert.equal(ui.elements.get('notice-retry').hidden,false);
 await unblock();c.reconcilePendingStop(projection('interrupted'));await c.t3StopPersistencePromise;
 const next={id:'new-run',userMessageId:'new-user',status:'running'};c.t3Runs.set(next.id,next);c.beginExternalRun(next);const generation=c.generation;
 await ui.elements.get('notice-retry').onclick();
 assert.equal(stops,1);assert.equal(c.t3RunId,'new-run');assert.equal(c.t3InFlight,true);assert.equal(c.desktopActionsRevoked,false);assert.equal(c.generation,generation);assert.equal(c.t3StopIntent,null);
 assert.deepEqual(await c.retryStop({kind:'cancel',stopId}),{stale:true});
}));

test('legacy restored Stop intents acquire and persist one stable retry identity before offline retry is exposed',async()=>fixture(async(c,dir)=>{
 c.t3=null;c.t3TransportReady=false;c.state.connection='reconnecting';c.desktopActionsRevoked=true;c.t3StopIntent={threadId:'thread',messageId:'user',runId:'run',requestedAt:1};
 const exposed=[];c.on('state',state=>{if(state.stopRetryAvailable)exposed.push(state.stopRetryId);});
 assert.deepEqual(await c.replayPendingStop(),{confirmed:false});const id=c.t3StopIntent.retryId;assert.ok(id);assert.equal(c.state.stopRetryId,id);
 assert.equal(JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')).stopIntent.retryId,id);
 await c.replayPendingStop();assert.equal(c.t3StopIntent.retryId,id);assert.ok(exposed.length>0&&exposed.every(value=>value===id));
 let stops=0;c.state.connection='connected';c.t3TransportReady=true;c.t3={call:async(tag,p)=>{if(p.type==='thread.stop')stops++;return tag==='orchestration.getThreadProjection'?projection('interrupted'):{};}};
 assert.deepEqual(await c.retryStop({kind:'cancel',stopId:id}),{confirmed:true});assert.equal(stops,1);assert.equal(c.t3StopIntent,null);
}));

test('a delayed stale cancellation retry preserves a newer visible Stop warning',async()=>{
 const ui=await dashboardFixture();ui.state({busy:true,stopping:true,stopRetryId:'old-stop',stopRetryAvailable:true,error:'Old Stop unconfirmed'});
 ui.dispatch(async()=>{throw new Error('Old transport failure');});await ui.elements.get('stop').onclick();
 let finish;ui.dispatch(async()=>new Promise(resolve=>finish=resolve));const pending=ui.elements.get('notice-retry').onclick();
 ui.state({busy:true,stopping:true,stopRetryId:'new-stop',stopRetryAvailable:true,error:'A newer Stop needs attention'});
 assert.equal(ui.elements.get('notice-message').textContent,'A newer Stop needs attention');assert.equal(ui.elements.get('notice').hidden,false);
 finish({stale:true});await pending;assert.equal(ui.elements.get('notice-message').textContent,'A newer Stop needs attention');assert.equal(ui.elements.get('notice').hidden,false);
});
