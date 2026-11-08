import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';
import {T3Companion} from '../src/t3-companion.js';
import {T3Client} from '../src/t3-client.js';
import {T3Workspace} from '../src/t3-workspace.js';
import {CodexRpc} from '../src/rpc.js';
import {readPromptTransaction} from '../src/prompt-recovery.js';

const OLD='Previous instructions. Preserve this text.';
const NEW='Updated instructions. Preserve the new text.';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Isolated reconnect did not settle.')),5000);})]);}finally{clearTimeout(timer);}}
const projection=threadId=>({thread:{id:threadId,activeRunId:null},runs:[],messages:[],turnItems:[],attempts:[],providerThreads:[],providerTurns:[]});

async function transactionFixture({failSettings=false,disconnectAfterCommit=false}={},run){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-prompt-reconnect-'));
 const original={connect:Companion.prototype.connect,start:T3Client.prototype.start,call:T3Client.prototype.call,close:T3Client.prototype.close,subscribeReady:T3Client.prototype.subscribeReady,workspaceStart:T3Workspace.prototype.start,fetch:globalThis.fetch};
 const controls={persistEntered:deferred(),persistGate:deferred(),subscriptions:[],archives:[],nativeConnects:0,clientCloses:0,workspaceCloses:0,workspacePrepares:0,transportStarts:0,scheduled:0};
 let companion,updating,reconnecting;
 const subscribe=(client,threadId)=>{const entry={client,threadId,active:true,stops:0};controls.subscriptions.push(entry);return()=>{if(!entry.active)return;entry.active=false;entry.stops++;};};
 try{
  await mkdir(join(directory,'context'));await writeFile(join(directory,'context','AGENTS.md'),OLD+'\n');
  const c=companion=new T3Companion({root:process.cwd(),dataDir:directory});Object.assign(c.state,{connection:'connected',prompt:OLD,running:false,watching:false});
  c.defaultPrompt=OLD;c.threadId='native-original';c.t3ThreadId='old-thread';c.t3ProjectId='project';c.desktopToolVersion=6;c.desktopServer={};c.t3TransportReady=true;
  c.t3Runs=new Map();c.t3Attempts=new Map();c.t3Seen=new Map();c.t3ProviderTurns=new Map();c.providerNativeIds=new Map();c.providerContexts=new Map();
  c.rpc={close(){}};c.interrupt=async()=>({confirmed:true});c.scheduleReconnect=()=>controls.scheduled++;c.updateUsage=async()=>{};
  c.workspace={close:()=>controls.workspaceCloses++};
  const oldClient=c.t3={socket:{readyState:1},close:async()=>{controls.clientCloses++;oldClient.socket.readyState=0;},
   subscribeReady:async(_tag,payload,onValue)=>{const stop=subscribe(oldClient,payload.threadId);await onValue({kind:'snapshot',projection:projection(payload.threadId)});return stop;},
   call:async(tag,payload)=>{if(tag==='orchestration.launchThread')return{threadId:'new-thread'};if(payload?.type==='thread.archive'){controls.archives.push(payload.threadId);return{};}throw new Error('Unexpected old transport operation: '+tag);}};
  c.stopT3Subscription=subscribe(oldClient,'old-thread');
  await c.save();await c.saveT3();
  if(failSettings)await mkdir(join(directory,'settings.tmp'));
  if(disconnectAfterCommit)await mkdir(join(directory,'t3-runtime.json.tmp'));

  Companion.prototype.connect=async function(){controls.nativeConnects++;this.publish({connection:'connecting'});this.threadId='native-reconnected';};
  T3Client.prototype.start=async function(){controls.transportStarts++;this.origin='http://127.0.0.1:12345';this.token='isolated-session';this.socket={readyState:1};return this;};
  T3Client.prototype.close=async function(){this.socket.readyState=0;};
  T3Client.prototype.call=async function(tag,payload={}){
   if(tag==='server.getConfig')return{providers:[{instanceId:'codex',status:'ready',auth:{type:'chatgpt'},models:[{slug:'gpt-6-luna',name:'Luna'}]}],settings:{projectSettingsOverrides:{}}};
   if(tag==='orchestration.getThreadProjection'){controls.reconnectedThread=payload.threadId;return projection(payload.threadId);}
   if(payload.type==='thread.archive'){controls.archives.push(payload.threadId);return{};}
   return{};
  };
  T3Client.prototype.subscribeReady=async function(_tag,payload,onValue){const stop=subscribe(this,payload.threadId);await onValue({kind:'snapshot',projection:projection(payload.threadId)});return stop;};
  T3Workspace.prototype.start=async function(){return this;};
  globalThis.fetch=async()=>({json:async()=>[{id:'project',workspaceRoot:join(directory,'context')}]});
  // Exercise the real instruction-file side effect without installing live MCP hooks.
  c.prepareWorkspace=async()=>{controls.workspacePrepares++;await writeFile(join(directory,'context','AGENTS.md'),c.state.prompt+'\n');};
  const save=c.save.bind(c),saveT3=c.saveT3.bind(c);
  c.save=async options=>{
   if(options?.settings?.prompt!==NEW)return save(options);
   controls.persistEntered.resolve();await controls.persistGate.promise;
   try{
    const result=await save(options);
    if(disconnectAfterCommit){
     assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,NEW);
     c.t3Disconnected(oldClient);reconnecting=c.connect();await tick();
     assert.equal(controls.nativeConnects,0);assert.equal(controls.clientCloses,0);assert.equal(controls.workspaceCloses,0);assert.equal(controls.workspacePrepares,0);
    }
    return result;
   }finally{if(failSettings)await rm(join(directory,'settings.tmp'),{recursive:true,force:true});}
  };
  c.saveT3=async()=>{
   if(disconnectAfterCommit&&c.t3===oldClient&&c.state.prompt===NEW){try{return await saveT3();}finally{await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true,force:true});}}
   return saveT3();
  };
  controls.start=()=>{updating=c.configure({prompt:NEW,spokenReplies:true});return updating;};
  controls.reconnect=()=>{c.t3Disconnected(oldClient);reconnecting=c.connect();return reconnecting;};
  controls.settleReconnect=()=>bounded(reconnecting);
  await run(c,directory,controls,oldClient);
 }finally{
  controls.persistGate.resolve();if(companion)companion.closed=true;
  await bounded(Promise.allSettled([updating,reconnecting])).catch(()=>{});
  if(companion){clearTimeout(companion.reconnectTimer);companion.workspace?.close();companion.stopT3Subscription?.();await companion.saveQueue?.catch(()=>{});await companion.t3SaveQueue?.catch(()=>{});}
  Companion.prototype.connect=original.connect;T3Client.prototype.start=original.start;T3Client.prototype.call=original.call;T3Client.prototype.close=original.close;T3Client.prototype.subscribeReady=original.subscribeReady;T3Workspace.prototype.start=original.workspaceStart;globalThis.fetch=original.fetch;
  await rm(directory,{recursive:true,force:true});
 }
}

function assertHeld(c,controls,oldClient){
 assert.equal(c.state.instructionsSaving,true);assert.equal(c.t3,oldClient);assert.equal(c.threadId,'native-original');assert.equal(c.t3ThreadId,'old-thread');
 assert.equal(controls.clientCloses,0);assert.equal(controls.workspaceCloses,0);assert.equal(controls.nativeConnects,0);assert.equal(controls.workspacePrepares,0);assert.equal(controls.transportStarts,0);
 assert.equal(controls.subscriptions[0].active,true);assert.equal(controls.subscriptions[0].stops,0);
}
async function assertCoherent(c,directory,controls,expectedPrompt,expectedThread){
 const settings=JSON.parse(await readFile(join(directory,'settings.json'),'utf8')),runtime=JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8'));
 assert.equal(settings.prompt,expectedPrompt);assert.equal(c.state.prompt,expectedPrompt);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),expectedPrompt+'\n');
 assert.equal(runtime.threadId,expectedThread);assert.equal(c.t3ThreadId,expectedThread);assert.equal(controls.reconnectedThread,expectedThread);assert.equal(c.state.connection,'connected');assert.equal(c.state.instructionsSaving,false);
 const active=controls.subscriptions.filter(entry=>entry.active);assert.equal(active.length,1);assert.equal(active[0].client,c.t3);assert.equal(active[0].threadId,expectedThread);
 assert.equal(await readPromptTransaction(directory,expectedPrompt),null);
}

test('reconnect waits for a successful durable instruction transaction before touching clients, files or subscriptions',()=>transactionFixture({},async(c,directory,controls,oldClient)=>{
 const updating=controls.start();await controls.persistEntered.promise;
 assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),NEW+'\n');assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,OLD);
 controls.reconnect();await tick();assertHeld(c,controls,oldClient);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),NEW+'\n');
 controls.persistGate.resolve();await bounded(updating);await controls.settleReconnect();await assertCoherent(c,directory,controls,NEW,'new-thread');assert.equal(c.state.spokenReplies,true);
}));

test('failed durable instruction persistence releases the waiting reconnect onto the original prompt and thread',()=>transactionFixture({failSettings:true},async(c,directory,controls,oldClient)=>{
 const rejected=assert.rejects(controls.start(),error=>['EISDIR','EACCES','EPERM'].includes(error.code));await controls.persistEntered.promise;
 controls.reconnect();await tick();assertHeld(c,controls,oldClient);controls.persistGate.resolve();await bounded(rejected);await controls.settleReconnect();
 await assertCoherent(c,directory,controls,OLD,'old-thread');assert.equal(c.state.spokenReplies,false);assert.ok(controls.archives.includes('new-thread'));
}));

test('a disconnect after the durable commit recovers the new identity through its journal without rolling instructions back',()=>transactionFixture({disconnectAfterCommit:true},async(c,directory,controls)=>{
 const updating=controls.start();await controls.persistEntered.promise;controls.persistGate.resolve();await bounded(updating);await controls.settleReconnect();
 await assertCoherent(c,directory,controls,NEW,'new-thread');assert.equal(c.state.spokenReplies,true);assert.ok(c.activities.some(item=>item.title==='Instruction recovery'&&/journal/.test(item.text)));
 assert.ok(controls.archives.includes('old-thread'));
}));

for(const [name,Type]of[['native',Companion],['T3',T3Companion]]){
 test(`${name} connect waits through a newer instruction barrier and aborts when closed while waiting`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hephaestus-connect-barrier-'));
  const originalNative=CodexRpc.prototype.start,originalT3=T3Client.prototype.start;
  const first=deferred(),second=deferred(),calls={native:0,t3:0,closed:0,workspace:0,subscription:0};let connecting,c;
  try{
   CodexRpc.prototype.start=async()=>{calls.native++;throw new Error('Unexpected native transport startup');};T3Client.prototype.start=async()=>{calls.t3++;throw new Error('Unexpected T3 transport startup');};
   c=new Type({root:directory,dataDir:directory});Object.assign(c.state,{connection:'connected',prompt:OLD});c.promptSaveBarrier=first.promise;c.desktopServer={};
   c.t3={close:async()=>calls.closed++};c.workspace={close:()=>calls.workspace++};c.stopT3Subscription=()=>calls.subscription++;
   const states=[];c.on('state',state=>states.push(state));let settled=false,error;connecting=c.connect().then(()=>settled=true,failure=>{error=failure;settled=true;});
   await tick();assert.equal(settled,false);assert.equal(states.length,0);assert.deepEqual(calls,{native:0,t3:0,closed:0,workspace:0,subscription:0});
   c.promptSaveBarrier=second.promise;first.resolve();await tick();assert.equal(settled,false);assert.equal(states.length,0);assert.deepEqual(calls,{native:0,t3:0,closed:0,workspace:0,subscription:0});
   c.closed=true;c.promptSaveBarrier=null;second.resolve();await bounded(connecting);assert.equal(error,undefined);assert.equal(states.length,0);assert.deepEqual(calls,{native:0,t3:0,closed:0,workspace:0,subscription:0});await assert.rejects(access(join(directory,'context')),{code:'ENOENT'});
  }finally{first.resolve();second.resolve();if(c){c.closed=true;c.promptSaveBarrier=null;}await bounded(connecting).catch(()=>{});CodexRpc.prototype.start=originalNative;T3Client.prototype.start=originalT3;await rm(directory,{recursive:true,force:true});}
 });

 test(`${name} connect returns immediately when already closed even with an unresolved instruction barrier`,async()=>{
  const originalNative=CodexRpc.prototype.start,originalT3=T3Client.prototype.start;
  try{
   CodexRpc.prototype.start=async()=>{throw new Error('Unexpected native transport startup');};T3Client.prototype.start=async()=>{throw new Error('Unexpected T3 transport startup');};
   const c=new Type({root:process.cwd(),dataDir:process.cwd()});c.closed=true;c.promptSaveBarrier=new Promise(()=>{});let published=0;c.on('state',()=>published++);
   await bounded(c.connect());assert.equal(published,0);
  }finally{CodexRpc.prototype.start=originalNative;T3Client.prototype.start=originalT3;}
 });
}
