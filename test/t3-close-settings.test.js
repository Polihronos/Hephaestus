import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {T3Companion} from '../src/t3-companion.js';
import {T3Client} from '../src/t3-client.js';
import {readPromptTransaction} from '../src/prompt-recovery.js';

const OLD='Original isolated instructions',NEW='Accepted isolated instructions';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function drain(){for(let i=0;i<4;i++)await tick();}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Isolated shutdown did not settle.')),5000);})]);}finally{clearTimeout(timer);}}
const outcome=promise=>promise.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
const projection=id=>({thread:{id,activeRunId:null},runs:[],messages:[],turnItems:[],attempts:[],providerThreads:[],providerTurns:[]});
const fileFailure=error=>['EISDIR','EACCES','EPERM'].includes(error?.code);

async function fixture(options,run){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-close-settings-'));
 const events=[],operations=[],launchEntered=deferred(),snapshotEntered=deferred(),persistEntered=deferred(),persistGate=deferred();
 const c=new T3Companion({root:process.cwd(),dataDir:directory}),client=new T3Client();
 let launchId,snapshotId;
 const deliver=(id,message)=>{if(client.pending.has(String(id)))client.receive({...message,requestId:String(id)});};
 const success=(id,value)=>deliver(id,{_tag:'Exit',exit:{_tag:'Success',value}});
 const snapshot=id=>deliver(id,{_tag:'Chunk',values:[{kind:'snapshot',projection:projection('new-thread')}]});
 const controls={events,client,launchEntered,snapshotEntered,persistEntered,
  releaseLaunch:()=>success(launchId,{threadId:'new-thread'}),releaseSnapshot:()=>snapshot(snapshotId),releasePersist:()=>persistGate.resolve(),
  update:()=>{const result=outcome(c.configure({prompt:NEW,spokenReplies:true}));operations.push(result);return result;},
  close:()=>{const result=outcome(c.close());operations.push(result);return result;}};
 // Exercise production call/receive/subscribeReady over an in-memory socket.
 // No local server, account, native process, or model is contacted.
 client.socket={readyState:1,send(raw){
  const frame=JSON.parse(raw);
  if(frame._tag==='Interrupt'){events.push('unsubscribe:'+frame.requestId);return;}
  if(frame._tag!=='Request')return;
  if(frame.tag==='orchestration.launchThread'){
   events.push('launch');launchId=frame.id;launchEntered.resolve();
   if(!options.holdLaunch)queueMicrotask(()=>controls.releaseLaunch());return;
  }
  if(frame.tag==='orchestration.subscribeThread'){
   events.push('subscribe:'+frame.payload.threadId);
   if(frame.payload.threadId==='new-thread'){
    snapshotId=frame.id;snapshotEntered.resolve();if(!options.holdSnapshot)queueMicrotask(()=>controls.releaseSnapshot());
   }else queueMicrotask(()=>deliver(frame.id,{_tag:'Chunk',values:[{kind:'snapshot',projection:projection('old-thread')}]}));
   return;
  }
  if(frame.tag==='orchestration.dispatchCommand'&&frame.payload.type==='thread.archive'){
   events.push('archive:'+frame.payload.threadId);queueMicrotask(()=>success(frame.id,{}));return;
  }
  throw new Error('Unexpected isolated T3 request: '+frame.tag);
 },close(){
  if(this.readyState===0)return;this.readyState=0;events.push('t3-close');
  for(const pending of [...client.pending.values()]){clearTimeout(pending.timer);pending.reject?.(new Error('Isolated T3 transport closed'));}client.pending.clear();
 }};
 try{
  await mkdir(join(directory,'context'));await writeFile(join(directory,'context','AGENTS.md'),OLD+'\n');
  Object.assign(c.state,{connection:'connected',prompt:OLD,running:true,watching:false,inputMode:'wispr'});
  Object.assign(c,{defaultPrompt:OLD,threadId:'native-thread',t3:client,t3ThreadId:'old-thread',t3ProjectId:'project',desktopToolVersion:6,t3TransportReady:true,
   t3Runs:new Map(),t3Attempts:new Map(),t3Seen:new Map(),t3ProviderTurns:new Map(),providerNativeIds:new Map(),providerContexts:new Map()});
  c.rpc={close:()=>events.push('rpc-close'),call:async()=>{throw new Error('No native request belongs in this isolated fixture');}};
  c.speech={close:()=>events.push('speech-close')};c.bridge={close:()=>events.push('bridge-close')};
  c.workspace={operations:[],close:()=>events.push('workspace-close')};c.desktopServer={close:()=>events.push('desktop-close')};
  c.scheduleReconnect=()=>{throw new Error('Shutdown must not schedule reconnect');};
  c.stopT3Subscription=await client.subscribeReady('orchestration.subscribeThread',{threadId:'old-thread'},()=>{});
  await c.save();await c.saveT3();
  const save=c.save.bind(c);
  c.save=async options=>{
   if(options?.settings?.prompt!==NEW)return save(options);
   events.push('persist-entered');persistEntered.resolve();if(options&&controls.holdPersist)await persistGate.promise;
   try{const result=await save(options);events.push('persist-committed');return result;}
   catch(error){events.push('persist-failed');throw error;}
  };
  controls.holdPersist=options.holdPersist;
  await run(c,directory,controls);
 }finally{
  controls.releaseLaunch();controls.releaseSnapshot();controls.releasePersist();
  await bounded(Promise.all(operations)).catch(()=>{});c.closed=true;clearTimeout(c.reconnectTimer);c.stopT3Subscription?.();await client.close();
  await c.saveQueue?.catch(()=>{});await c.t3SaveQueue?.catch(()=>{});await rm(directory,{recursive:true,force:true});
 }
}

function resourcesHeld(c,{events,client}){
 assert.equal(c.closed,true);assert.equal(c.state.running,false);assert.equal(c.state.instructionsSaving,true);
 assert.equal(client.socket.readyState,1);assert.equal(events.filter(event=>event.endsWith('-close')).length,0);
}
function resourcesClosed(c,{events,client}){
 for(const resource of ['workspace','t3','rpc','speech','bridge','desktop'])assert.equal(events.filter(event=>event===resource+'-close').length,1,resource+' must close exactly once.');
 assert.equal(client.pending.size,0);assert.equal(c.t3,null);assert.equal(c.state.instructionsSaving,false);
}
async function identity(c,directory,prompt,threadId){
 assert.equal(c.state.prompt,prompt);assert.equal(c.t3ThreadId,threadId);
 assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,prompt);
 assert.equal(JSON.parse(await readFile(join(directory,'t3-runtime.json'),'utf8')).threadId,threadId);
 assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),prompt+'\n');
 assert.equal(await readPromptTransaction(directory,prompt),null);
}

for(const phase of ['launch','snapshot']){
 test(`quit drains an accepted instruction save while its ${phase} is pending before closing transports`,()=>fixture({holdLaunch:phase==='launch',holdSnapshot:phase==='snapshot'},async(c,directory,controls)=>{
  const updating=controls.update();await bounded(phase==='launch'?controls.launchEntered.promise:controls.snapshotEntered.promise);
  const closing=controls.close();await drain();resourcesHeld(c,controls);
  assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).prompt,OLD);
  if(phase==='launch')controls.releaseLaunch();else controls.releaseSnapshot();
  assert.equal((await bounded(updating)).status,'fulfilled');assert.equal((await bounded(closing)).status,'fulfilled');
  await identity(c,directory,NEW,'new-thread');assert.equal(c.state.spokenReplies,true);assert.ok(controls.events.includes('archive:old-thread'));resourcesClosed(c,controls);
 }));
}

test('a settings-write failure during quit rolls the accepted instruction transaction back and still closes every resource',()=>fixture({holdPersist:true},async(c,directory,controls)=>{
 const updating=controls.update();await bounded(controls.persistEntered.promise);
 assert.equal(await readFile(join(directory,'context','AGENTS.md'),'utf8'),NEW+'\n');
 const closing=controls.close();await drain();resourcesHeld(c,controls);
 await mkdir(join(directory,'settings.tmp'));controls.releasePersist();
 const updated=await bounded(updating),closed=await bounded(closing);
 assert.equal(updated.status,'rejected');assert.ok(fileFailure(updated.reason));
 assert.equal(closed.status,'rejected');assert.ok(fileFailure(closed.reason));
 await identity(c,directory,OLD,'old-thread');assert.equal(c.state.spokenReplies,false);assert.ok(controls.events.includes('archive:new-thread'));
 resourcesClosed(c,controls);assert.ok(controls.events.indexOf('persist-failed')<controls.events.indexOf('workspace-close'));
}));

test('quit rejects new settings and message calls while an earlier accepted save finishes',()=>fixture({holdLaunch:true},async(c,directory,controls)=>{
 const updating=controls.update();await bounded(controls.launchEntered.promise);const closing=controls.close();await drain();resourcesHeld(c,controls);
 const before={messages:c.messages.length,events:controls.events.length,voiceEpoch:c.voiceEpoch};
 for(const patch of [{running:false},{spokenReplies:true},{prompt:'Unaccepted later instructions'}])await assert.rejects(c.configure(patch),/clos|shut|quit/i);
 for(const text of ['A later ordinary request','stop','mute'])await assert.rejects(c.submit(text),/clos|shut|quit/i);
 assert.equal(c.messages.length,before.messages);assert.equal(controls.events.length,before.events);assert.equal(c.voiceEpoch,before.voiceEpoch);
 controls.releaseLaunch();assert.equal((await bounded(updating)).status,'fulfilled');assert.equal((await bounded(closing)).status,'fulfilled');
 await identity(c,directory,NEW,'new-thread');resourcesClosed(c,controls);
}));
