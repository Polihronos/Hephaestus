import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {T3Companion} from '../src/t3-companion.js';

const THREAD='isolated-thread',RUN='isolated-stopped-run',USER='isolated-user';
const PARTIAL='  Synthetic stopped reply: Ω and текст.\nAn unfinished thought…  ';
const timestamp='2026-01-01T00:00:00.000Z';
const run=(status='interrupted',id=RUN)=>({id,userMessageId:USER,status,requestedAt:timestamp,...(status==='running'?{}:{completedAt:'2026-01-01T00:00:01.000Z'})});
const item=(patch={})=>({id:'isolated-provider-item',runId:RUN,type:'assistant_message',streaming:true,status:'running',text:PARTIAL,startedAt:timestamp,...patch});
const projection=(items=[],runs=[run()])=>({thread:{id:THREAD,activeRunId:null},runs,turnItems:items,messages:[],attempts:[],providerThreads:[],providerTurns:[]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function flush(c){for(let i=0;i<3;i++){await Promise.all([c.saveQueue,c.t3SaveQueue,c.t3StopPersistencePromise].filter(Boolean));await tick();}}
function initialize(directory){
 const c=new T3Companion({root:directory,dataDir:directory});
 Object.assign(c.state,{connection:'connected',prompt:'Isolated fixture instructions',running:true,watching:false,busy:true});
 Object.assign(c,{defaultPrompt:'Isolated fixture instructions',threadId:'isolated-native-thread',t3ThreadId:THREAD,t3ProjectId:'isolated-project',t3RunId:RUN,t3MessageId:USER,t3InFlight:true,t3TurnStart:Date.now(),
  t3Runs:new Map([[RUN,run('running')]]),t3Attempts:new Map(),t3Seen:new Map(),t3ProviderTurns:new Map(),providerNativeIds:new Map(),providerContexts:new Map()});
 c.t3={call:async()=>{throw new Error('Stopped transcript retention must not call a transport');}};
 return c;
}
function armStop(c){
 c.t3StopIntent={threadId:THREAD,runId:RUN,messageId:USER,accepted:true,requestedAt:Date.now()};
 c.ignoredT3Runs=new Set([RUN]);c.desktopActionsRevoked=true;c.state.stopping=true;
}
async function fixture(body){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-stopped-replies-')),c=initialize(directory),events=[];
 // Observe production events. No app, speech worker, provider, or native process
 // is started; the labelled fixture text is not human or model evidence.
 for(const name of ['messagesRestored','message','messageUpdated','delta','speak','speechFlush','responseStart'])c.on(name,data=>events.push({name,data:structuredClone(data)}));
 try{await c.save();await c.saveT3();await body(c,directory,events);}
 finally{c.closed=true;clearTimeout(c.reconnectTimer);await flush(c).catch(()=>{});await rm(directory,{recursive:true,force:true});}
}
const assistant=c=>c.messages.filter(message=>message.role==='assistant');
function retained(c,expected=PARTIAL){
 assert.equal(assistant(c).length,1);const message=assistant(c)[0];
 assert.equal(message.providerItemId,'isolated-provider-item');assert.equal(message.turnId,RUN);assert.equal(message.text,expected);assert.equal(message.interrupted,true);
 return message;
}
function silent(events){
 assert.ok(events.some(event=>event.name==='messagesRestored'),'The existing transcript must be rendered immediately through its restoration path.');
 assert.deepEqual(events.filter(event=>event.name!=='messagesRestored'),[],'Retaining stopped text must not announce, reopen a reply, or enqueue speech.');
}
const saved=async directory=>JSON.parse(await readFile(join(directory,'settings.json'),'utf8'));

test('confirmed Stop silently persists the actual seen streaming text before another request can clear its draft',()=>fixture(async(c,directory,events)=>{
 const partial=item();c.t3Stream({kind:'event',event:{type:'turn-item.updated',payload:partial}});
 assert.equal(assistant(c).length,0);assert.equal(events.filter(event=>event.name==='delta').length,1);
 armStop(c);events.length=0;
 c.t3Stream({kind:'event',event:{type:'run.updated',payload:run()}});
 const message=retained(c);silent(events);assert.equal(c.t3StopIntent,null);await flush(c);
 const stored=(await saved(directory)).messages.find(value=>value.providerItemId===partial.id);assert.deepEqual(stored,message);
 const id=message.id;assert.equal(c.beginExternalRun(run('running','isolated-next-run')),true);
 assert.equal(events.filter(event=>event.name==='responseStart').length,1);
 assert.equal(retained(c).id,id);assert.deepEqual((await saved(directory)).messages.find(value=>value.id===id),stored);
}));

test('an interrupted run retains its completed provider item immediately without waiting for a reconnect snapshot',()=>fixture(async(c,directory,events)=>{
 const completed=item({streaming:false,status:'completed',completedAt:'2026-01-01T00:00:00.900Z'});armStop(c);
 assert.equal(c.t3Seen.size,0);assert.equal(c.reconcilePendingStop(projection([completed])),true);
 const message=retained(c);silent(events);await flush(c);
 assert.deepEqual((await saved(directory)).messages.find(value=>value.providerItemId===completed.id),message);
}));

test('terminal reconciliation ignores other runs, users, reasoning and empty text',()=>fixture(async(c,directory,events)=>{
 const entries=[item(),item({id:'other-run',runId:'unrelated-run'}),item({id:'user-item',type:'user_message'}),item({id:'reasoning-item',type:'reasoning'}),item({id:'empty-item',text:''}),item({id:'whitespace-item',text:' \n\t '}),item({id:'missing-text',text:undefined})];
 for(const value of entries)c.t3Seen.set(value.id,value);armStop(c);
 assert.equal(c.reconcilePendingStop(projection(entries)),true);retained(c);silent(events);await flush(c);
 assert.equal((await saved(directory)).messages.length,1);
}));

test('pending Stop does not materialize or label text until the matching run is canonically terminal',()=>fixture(async(c,directory,events)=>{
 c.t3Seen.set('isolated-provider-item',item());armStop(c);
 assert.equal(c.reconcilePendingStop(projection([item()],[run('completed','unrelated-run')])),false);
 assert.equal(c.reconcilePendingStop(projection([item()],[run('running')])),false);
 assert.equal(assistant(c).length,0);assert.equal(events.length,0);await flush(c);assert.equal((await saved(directory)).messages.length,0);
 assert.equal(c.reconcilePendingStop(projection([item()])),true);retained(c);silent(events);
}));

test('repeated terminal events, ignored late items and reconnect snapshots preserve one stable interrupted row',()=>fixture(async(c,directory,events)=>{
 const partial=item();c.t3Seen.set(partial.id,partial);armStop(c);assert.equal(c.reconcilePendingStop(projection()),true);
 const original=retained(c);await flush(c);events.length=0;
 c.t3Stream({kind:'event',event:{type:'run.updated',payload:run()}});
 c.t3Stream({kind:'event',event:{type:'turn-item.updated',payload:{...partial,streaming:false,status:'completed'}}});
 c.restoreProjection(projection([{...partial,streaming:false,status:'completed'}]));c.restoreProjection(projection([{...partial,streaming:false,status:'completed'}]));
 assert.equal(retained(c).id,original.id);silent(events);await flush(c);
 const settings=await saved(directory),reloaded=initialize(directory);reloaded.messages=settings.messages;reloaded.t3InFlight=false;
 reloaded.restoreProjection(projection([partial]));reloaded.restoreProjection(projection([partial]));
 assert.equal(retained(reloaded).id,original.id);assert.deepEqual(retained(reloaded),original);
}));

test('an already finalized regular message remains unchanged when its run is later interrupted',()=>fixture(async(c,directory,events)=>{
 const final=item({id:'earlier-final-item',streaming:false,status:'completed',text:'Synthetic completed paragraph.'});
 const existing={id:'existing-message',role:'assistant',providerItemId:final.id,turnId:RUN,text:final.text,at:Date.parse(timestamp)};
 c.messages.push(existing);c.t3Seen.set(final.id,final);armStop(c);await c.save();
 assert.equal(c.reconcilePendingStop(projection([final])),true);await flush(c);
 assert.equal(assistant(c).length,1);assert.deepEqual(assistant(c)[0],existing);assert.equal(assistant(c)[0].interrupted,undefined);
 assert.deepEqual((await saved(directory)).messages,[existing]);
 assert.deepEqual(events.filter(event=>event.name!=='messagesRestored'),[]);
}));

test('a naturally completed run does not mislabel a recovered completed answer as interrupted',()=>fixture(async(c,directory,events)=>{
 const final=item({streaming:false,status:'completed',text:'Synthetic complete answer.',completedAt:'2026-01-01T00:00:00.900Z'});armStop(c);
 assert.equal(c.reconcilePendingStop(projection([final],[run('completed')])),true);await flush(c);
 assert.equal(assistant(c).length,1);assert.equal(assistant(c)[0].text,final.text);assert.notEqual(assistant(c)[0].interrupted,true);
 assert.equal(assistant(c)[0].providerItemId,final.id);assert.equal(assistant(c)[0].turnId,RUN);silent(events);
 assert.deepEqual((await saved(directory)).messages,assistant(c));
}));
