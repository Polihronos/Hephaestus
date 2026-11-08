import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';
import {T3Companion} from '../src/t3-companion.js';
import {T3Client} from '../src/t3-client.js';
import {T3Workspace} from '../src/t3-workspace.js';
import {readPromptTransaction} from '../src/prompt-recovery.js';

const A='Instructions A',B='Instructions B',C='Instructions C';
const projection=id=>({thread:{id,activeRunId:null},runs:[],messages:[],turnItems:[],attempts:[],providerThreads:[],providerTurns:[]});
const filesystemFailure=error=>['EISDIR','EACCES','EPERM'].includes(error.code);

async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-prompt-chain-'));
 let companion;
 try{
  await mkdir(join(directory,'context'));await writeFile(join(directory,'context','AGENTS.md'),A+'\n');
  const c=companion=new T3Companion({root:process.cwd(),dataDir:directory});Object.assign(c.state,{connection:'connected',prompt:A,running:false,watching:false});
  c.defaultPrompt=A;c.threadId='native';c.t3ThreadId='thread-A';c.t3ProjectId='project';c.desktopToolVersion=6;c.desktopServer={};c.t3TransportReady=true;
  c.t3Runs=new Map();c.t3Attempts=new Map();c.t3Seen=new Map();c.t3ProviderTurns=new Map();c.providerNativeIds=new Map();c.providerContexts=new Map();
  c.interrupt=async()=>({confirmed:true});c.scheduleReconnect=()=>{};c.updateUsage=async()=>{};
  const controls={launches:0,archives:[],subscriptions:[]};
  controls.subscribe=(client,threadId)=>{const subscription={client,threadId,active:true};controls.subscriptions.push(subscription);return()=>subscription.active=false;};
  const client=c.t3={close:async()=>{},subscribeReady:async(_tag,payload,onValue)=>{const stop=controls.subscribe(client,payload.threadId);await onValue({kind:'snapshot',projection:projection(payload.threadId)});return stop;},call:async(tag,payload)=>{
   if(tag==='orchestration.launchThread')return{threadId:'thread-'+String.fromCharCode(66+controls.launches++)};
   if(payload?.type==='thread.archive'){controls.archives.push(payload.threadId);return{};}
   throw new Error('Unexpected isolated operation: '+tag);
  }};
  c.stopT3Subscription=controls.subscribe(client,'thread-A');await c.save();await c.saveT3();
  controls.commitB=async()=>{
   await mkdir(join(directory,'t3-runtime.json.tmp'));await c.configure({prompt:B,spokenReplies:true});
   assert.equal(c.state.prompt,B);assert.equal(c.t3ThreadId,'thread-B');assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,B);
   assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,'thread-A');assert.equal((await readPromptTransaction(directory,B)).threadId,'thread-B');assert.ok(controls.archives.includes('thread-A'));
   return readFile(join(directory,'prompt-transaction.json'),'utf8');
  };
  await run(c,directory,controls);
 }finally{if(companion){companion.closed=true;clearTimeout(companion.reconnectTimer);companion.workspace?.close();companion.stopT3Subscription?.();await companion.saveQueue?.catch(()=>{});await companion.t3SaveQueue?.catch(()=>{});}await rm(directory,{recursive:true,force:true});}
}

async function reconnect(c,directory,controls){
 const original={connect:Companion.prototype.connect,start:T3Client.prototype.start,call:T3Client.prototype.call,close:T3Client.prototype.close,subscribeReady:T3Client.prototype.subscribeReady,workspaceStart:T3Workspace.prototype.start,fetch:globalThis.fetch};
 try{
  Companion.prototype.connect=async function(){this.publish({connection:'connecting'});this.threadId='native-reconnected';};
  T3Client.prototype.start=async function(){this.origin='http://127.0.0.1:12345';this.token='isolated-session';this.socket={readyState:1};return this;};T3Client.prototype.close=async()=>{};
  T3Client.prototype.call=async function(tag,payload={}){
   if(tag==='server.getConfig')return{providers:[{instanceId:'codex',status:'ready',auth:{type:'chatgpt'},models:[{slug:'gpt-6-luna',name:'Luna'}]}],settings:{projectSettingsOverrides:{}}};
   if(tag==='orchestration.getThreadProjection'){controls.recoveredThread=payload.threadId;return projection(payload.threadId);}
   if(tag==='orchestration.launchThread'){controls.unexpectedFreshThread=true;return{threadId:'unexpected-fresh-thread'};}
   if(payload.type==='thread.archive')controls.archives.push(payload.threadId);
   return{};
  };
  T3Client.prototype.subscribeReady=async function(_tag,payload,onValue){const stop=controls.subscribe(this,payload.threadId);await onValue({kind:'snapshot',projection:projection(payload.threadId)});return stop;};
  T3Workspace.prototype.start=async function(){return this;};globalThis.fetch=async()=>({json:async()=>[{id:'project',workspaceRoot:join(directory,'context')}]});
  c.prepareWorkspace=async()=>writeFile(join(directory,'context','AGENTS.md'),c.state.prompt+'\n');
  await c.connect();
 }finally{Companion.prototype.connect=original.connect;T3Client.prototype.start=original.start;T3Client.prototype.call=original.call;T3Client.prototype.close=original.close;T3Client.prototype.subscribeReady=original.subscribeReady;T3Workspace.prototype.start=original.workspaceStart;globalThis.fetch=original.fetch;}
}

async function coherent(c,directory,controls,prompt,threadId){
 assert.equal(c.state.prompt,prompt);assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,prompt);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),prompt+'\n');
 assert.equal(c.t3ThreadId,threadId);assert.equal(controls.recoveredThread,threadId);assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,threadId);assert.equal(c.state.connection,'connected');assert.equal(controls.unexpectedFreshThread,undefined);
 const active=controls.subscriptions.filter(subscription=>subscription.active);assert.equal(active.length,1);assert.equal(active[0].threadId,threadId);assert.equal(active[0].client,c.t3);
}

test('A to B metadata failure followed by B to C settings failure reconnects to committed B',()=>fixture(async(c,directory,controls)=>{
 await controls.commitB();await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});await mkdir(join(directory,'settings.tmp'));
 await assert.rejects(c.configure({prompt:C,spokenReplies:false}),filesystemFailure);await rm(join(directory,'settings.tmp'),{recursive:true});
 assert.equal(c.state.prompt,B);assert.equal(c.t3ThreadId,'thread-B');assert.equal(c.state.spokenReplies,true);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),B+'\n');
 await reconnect(c,directory,controls);await coherent(c,directory,controls,B,'thread-B');assert.ok(controls.archives.includes('thread-C'));
}));

test('a still-failing metadata write rejects the next instruction edit without replacing its prior journal',()=>fixture(async(c,directory,controls)=>{
 const prior=await controls.commitB();
 await assert.rejects(c.configure({prompt:C}),error=>filesystemFailure(error)&&/previous instruction update could not be reconciled/.test(error.message));
 assert.equal(controls.launches,1);assert.equal(await readFile(join(directory,'prompt-transaction.json'),'utf8'),prior);assert.equal(c.state.prompt,B);assert.equal(c.t3ThreadId,'thread-B');
 assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,B);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),B+'\n');
 await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});await reconnect(c,directory,controls);await coherent(c,directory,controls,B,'thread-B');
}));

test('an interruption after reconciling the cache but before clearing its journal still recovers committed B',()=>fixture(async(c,directory,controls)=>{
 const prior=await controls.commitB();await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});
 const saveT3=c.saveT3.bind(c);c.saveT3=async()=>{await saveT3();throw new Error('Interrupted immediately after metadata commit');};
 await assert.rejects(c.configure({prompt:C}),/previous instruction update could not be reconciled/);c.saveT3=saveT3;
 assert.equal(controls.launches,1);assert.equal(await readFile(join(directory,'prompt-transaction.json'),'utf8'),prior);assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,'thread-B');
 await reconnect(c,directory,controls);await coherent(c,directory,controls,B,'thread-B');
}));

test('a failed next-journal write after reconciliation recovers B from its newly durable cache',()=>fixture(async(c,directory,controls)=>{
 await controls.commitB();await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});await mkdir(join(directory,'prompt-transaction.json.tmp'));
 await assert.rejects(c.configure({prompt:C}),filesystemFailure);assert.equal(await readPromptTransaction(directory,B),null);assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,'thread-B');
 assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,B);assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),B+'\n');assert.ok(controls.archives.includes('thread-C'));
 await reconnect(c,directory,controls);await coherent(c,directory,controls,B,'thread-B');
}));

test('a successful second instruction update reconciles B and then reconnects to committed C',()=>fixture(async(c,directory,controls)=>{
 await controls.commitB();await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});await c.configure({prompt:C,spokenReplies:false});
 assert.equal(await readPromptTransaction(directory,C),null);assert.equal(controls.launches,2);assert.ok(controls.archives.includes('thread-B'));
 await reconnect(c,directory,controls);await coherent(c,directory,controls,C,'thread-C');assert.equal(c.state.spokenReplies,false);
}));

test('another metadata failure after committing C retains a new journal that recovers C',()=>fixture(async(c,directory,controls)=>{
 await controls.commitB();await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});
 const save=c.save.bind(c);c.save=async options=>{const result=await save(options);if(options?.settings?.prompt===C)await mkdir(join(directory,'t3-runtime.json.tmp'));return result;};
 await c.configure({prompt:C});assert.equal((await readPromptTransaction(directory,C)).threadId,'thread-C');assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,'thread-B');
 await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});c.save=save;await reconnect(c,directory,controls);await coherent(c,directory,controls,C,'thread-C');
}));

test('delayed startup recovery cleanup cannot delete the newer B to C journal before a failed save',()=>fixture(async(c,directory,controls)=>{
 await controls.commitB();const prior=await readPromptTransaction(directory,B);await rm(join(directory,'t3-runtime.json.tmp'),{recursive:true});
 const save=c.save.bind(c);let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 c.save=async options=>{if(options?.settings?.prompt===C){entered();await gate;}return save(options);};
 const rejected=assert.rejects(c.configure({prompt:C}),filesystemFailure);
 try{
  await waiting;const prepared=await readPromptTransaction(directory,B);assert.equal(prepared.oldThread,'thread-B');assert.equal(prepared.newThread,'thread-C');
  c.promptRecovery=prior;await c.finishPromptRecovery();
  assert.equal((await readPromptTransaction(directory,B)).newThread,'thread-C');await mkdir(join(directory,'settings.tmp'));release();await rejected;
 }finally{release();}
 await rm(join(directory,'settings.tmp'),{recursive:true});await reconnect(c,directory,controls);await coherent(c,directory,controls,B,'thread-B');
}));
