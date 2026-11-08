import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Companion} from '../src/companion.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function drain(){for(let i=0;i<8;i++)await tick();}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}

async function fixture(run){
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()}),recognized=[],submitted=[],pending=new Map();
 Object.assign(c.state,{connection:'connected',inputMode:'always',running:true,watching:false,speech:'ready',dictating:false});
 c.speech={call:async(method,{audio})=>{
  assert.equal(method,'transcribe');recognized.push(audio);
  if(audio==='A'){const result=deferred();pending.set(audio,result);return result.promise;}
  return{text:'recognized '+audio,elapsedMs:1};
 },close(){}};
 c.submit=async(text,{source})=>submitted.push({text,source});
 c.save=async()=>{};c.sample=async()=>{};c.interrupt=async()=>{};c.startSpeech=async()=>{};
 const finish=audio=>{const result=pending.get(audio);assert.ok(result,'The labelled recognition must be pending.');pending.delete(audio);result.resolve({text:'recognized '+audio,elapsedMs:1});};
 try{await run({c,recognized,submitted,finish});}
 finally{c.closed=true;for(const[audio,result]of pending)result.resolve({text:'recognized '+audio,elapsedMs:1});await drain();}
}

function assertSubmitted(submitted,labels){assert.deepEqual(submitted,labels.map(label=>({text:'recognized '+label,source:'voice'})));}

test('pause and resume before the active recognition finishes discard every pre-pause segment',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');await c.transcribe('D');
 await c.configure({running:false});await c.configure({running:true});finish('A');await active;await drain();
 assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);
 await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','E']);assertSubmitted(submitted,['E']);
}));

test('switching from always-on to Wispr and back cannot reauthorize queued old audio',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');
 await c.configure({inputMode:'wispr'});await c.configure({inputMode:'always'});finish('A');await active;await drain();
 assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);
 await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','E']);assertSubmitted(submitted,['E']);
}));

for(const [name,disable,enable]of[['paused',{running:false},{running:true}],['Wispr mode',{inputMode:'wispr'},{inputMode:'always'}]]){
 test(`finishing recognition while ${name} cannot leave stale segments for a later fresh request`,()=>fixture(async({c,recognized,submitted,finish})=>{
  const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');await c.transcribe('D');
  await c.configure(disable);finish('A');await active;await drain();assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);
  await c.configure(enable);await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','E']);assertSubmitted(submitted,['E']);
 }));
}

test('an already-shifted scheduled segment keeps its original epoch after pause clears the queue',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');finish('A');await active;
 // The active call has completed, but its setImmediate callback has not run.
 assert.deepEqual(recognized,['A']);assertSubmitted(submitted,['A']);
 await c.configure({running:false});await c.configure({running:true});await drain();
 assert.deepEqual(recognized,['A']);assertSubmitted(submitted,['A']);
 await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','E']);assertSubmitted(submitted,['A','E']);
}));

test('fresh queued segments retain FIFO order within one listening epoch and preserve the queue limit',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');await c.transcribe('D');await c.transcribe('over-capacity');
 assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);finish('A');await active;await drain();
 assert.deepEqual(recognized,['A','B','C','D']);assertSubmitted(submitted,['A','B','C','D']);
 await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','B','C','D','E']);assertSubmitted(submitted,['A','B','C','D','E']);
}));

test('a fresh segment arriving before the scheduled queue handoff cannot overtake earlier segments',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');finish('A');await active;
 await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','B','C','E']);assertSubmitted(submitted,['A','B','C','E']);
}));

test('closing invalidates active and queued recognition and rejects later segments',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');await c.close();finish('A');await active;await drain();
 await c.transcribe('after-close');await drain();assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);
}));

test('pause invalidates queued audio immediately while an earlier settings save is pending',()=>fixture(async({c,recognized,submitted,finish})=>{
 const active=c.transcribe('A');await c.transcribe('B');await c.transcribe('C');
 const entered=deferred(),gate=deferred();let saves=0;
 c.save=async()=>{if(++saves===1){entered.resolve();await gate.promise;}};
 const changing=c.configure({opacity:.8});let pausing;
 try{
  await entered.promise;pausing=c.configure({running:false});finish('A');await active;await drain();
  assert.deepEqual(recognized,['A']);assertSubmitted(submitted,[]);
 }finally{gate.resolve();await Promise.allSettled([changing,pausing]);}
 await c.configure({running:true});await c.transcribe('E');await drain();assert.deepEqual(recognized,['A','E']);assertSubmitted(submitted,['E']);
}));

async function audioIpc(c){
 const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
 const branch=source.split('\n').find(line=>line.includes("if(command==='audio'&&sender===mascot)"));
 assert.ok(branch,'The isolated audio IPC fixture must execute the current production route.');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const handle=new AsyncFunction('command','sender','mascot','params','safe','companion',branch),mascot={};
 return async params=>{const pending=[];try{await handle('audio',mascot,mascot,params,promise=>{pending.push(promise);Promise.resolve(promise).catch(()=>{});},c);}catch{}await Promise.allSettled(pending);await drain();};
}

test('audio IPC retains its capture epoch across delayed delivery after pause and resume',()=>fixture(async({c,recognized,submitted})=>{
 const deliver=await audioIpc(c),audio=new Uint8Array([1,2,3,4]).buffer;
 // Emission belongs to the old listener; delivery happens after the main process resumes.
 const queued={audio,epoch:c.voiceEpoch??0};await c.configure({running:false});await c.configure({running:true});
 await deliver(queued);assert.deepEqual(recognized,[]);assertSubmitted(submitted,[]);
 await deliver({audio,epoch:c.voiceEpoch??0});assert.deepEqual(recognized,[Buffer.from(audio).toString('base64')]);assert.equal(submitted.length,1);assert.equal(submitted[0].source,'voice');
}));

test('audio IPC without captured-origin metadata cannot default to the current listening epoch',()=>fixture(async({c,recognized,submitted})=>{
 const deliver=await audioIpc(c);await deliver({audio:new Uint8Array([1,2,3,4]).buffer});assert.deepEqual(recognized,[]);assertSubmitted(submitted,[]);
}));
