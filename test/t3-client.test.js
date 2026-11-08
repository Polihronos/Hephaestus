import test from 'node:test';
import assert from 'node:assert/strict';
import {T3Client} from '../src/t3-client.js';

const drain=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(onSend){
 const client=new T3Client(),sent=[],faults=[];
 client.on('fault',error=>faults.push(error));
 client.socket={readyState:1,send:json=>{const frame=JSON.parse(json);sent.push(frame);onSend?.(frame,client);}};
 const id=()=>sent.find(frame=>frame._tag==='Request').id;
 return{client,sent,faults,id,
  chunk:(...values)=>client.receive({_tag:'Chunk',requestId:id(),values}),
  exit:(success=false)=>client.receive({_tag:'Exit',requestId:id(),exit:success?{_tag:'Success',value:{}}:{_tag:'Failure',cause:[{error:{message:'Subscription rejected'}}]}})};
}
function clock(){
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,timers=new Set();
 globalThis.setTimeout=(callback,ms)=>{const timer={callback,ms};timers.add(timer);return timer;};
 globalThis.clearTimeout=timer=>timers.delete(timer);
 return{timers,fire(){const timer=[...timers][0];assert.ok(timer,'An active readiness timer is expected');timers.delete(timer);timer.callback();},restore(){globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}};
}

test('readiness waits for a snapshot and its asynchronous processing in frame order',async()=>{
 const f=fixture(),order=[];let release,entered;
 const blocked=new Promise(resolve=>{release=resolve;}),processing=new Promise(resolve=>{entered=resolve;});
 let ready=false;
 const starting=f.client.subscribeReady('thread',{},async value=>{
  order.push('start-'+value.kind);if(value.kind==='snapshot'){entered();await blocked;}order.push('done-'+value.kind);
 });
 starting.then(()=>{ready=true;});
 f.chunk({kind:'event'});await drain();assert.equal(ready,false);
 f.chunk({kind:'snapshot'},{kind:'event'});await processing;
 assert.equal(ready,false);assert.deepEqual(order,['start-event','done-event','start-snapshot']);
 release();const stop=await starting;await drain();
 assert.deepEqual(order,['start-event','done-event','start-snapshot','done-snapshot','start-event','done-event']);
 assert.equal(f.client.pending.size,1);stop();assert.equal(f.client.pending.size,0);
});

test('a custom readiness predicate still runs after successful value processing',async()=>{
 const f=fixture(),processed=[];let ready=false;
 const starting=f.client.subscribeReady('thread',{},value=>processed.push(value.kind),{isReady:value=>value.kind==='initial'});
 starting.then(()=>{ready=true;});f.chunk({kind:'snapshot'});await drain();assert.equal(ready,false);
 f.chunk({kind:'initial'});const stop=await starting;assert.deepEqual(processed,['snapshot','initial']);stop();
});

test('a ready subscription clears its timer and explicit unsubscribe is quiet and idempotent',async()=>{
 const time=clock();try{
  const f=fixture(),errors=[];
  const starting=f.client.subscribeReady('thread',{},()=>{},{onError:error=>errors.push(error),timeoutMs:30});
  assert.equal(time.timers.size,1);f.chunk({kind:'snapshot'});const stop=await starting;
  assert.equal(time.timers.size,0);stop();stop();f.exit();f.exit(true);await drain();
  assert.equal(errors.length,0);assert.equal(f.faults.length,0);assert.equal(f.client.pending.size,0);
  assert.equal(f.sent.filter(frame=>frame._tag==='Interrupt').length,1);
 }finally{time.restore();}
});

test('readiness timeout rejects and removes both its timer and subscription',async()=>{
 const time=clock();try{
  const f=fixture(),errors=[];
  const starting=f.client.subscribeReady('thread',{},()=>{},{onError:error=>errors.push(error),timeoutMs:25});
  const rejected=assert.rejects(starting,/snapshot timed out/);f.chunk({kind:'event'});await drain();
  assert.equal(time.timers.size,1);time.fire();await rejected;
  assert.equal(time.timers.size,0);assert.equal(f.client.pending.size,0);assert.equal(errors.length,0);
  assert.equal(f.sent.filter(frame=>frame._tag==='Interrupt').length,1);
  f.chunk({kind:'snapshot'});await drain();assert.equal(errors.length,0);
 }finally{time.restore();}
});

test('timeout also cancels readiness while snapshot processing is still pending',async()=>{
 const time=clock();let release;try{
  const f=fixture(),blocked=new Promise(resolve=>{release=resolve;});
  const starting=f.client.subscribeReady('thread',{},()=>blocked);
  const rejected=assert.rejects(starting,/snapshot timed out/);f.chunk({kind:'snapshot'});await drain();
  time.fire();await rejected;release();await drain();assert.equal(f.client.pending.size,0);assert.equal(time.timers.size,0);
 }finally{release?.();time.restore();}
});

test('a rejected initial subscription rejects readiness without an after-ready error callback',async()=>{
 const time=clock();try{
  const f=fixture(),errors=[];
  const starting=f.client.subscribeReady('thread',{},()=>{},{onError:error=>errors.push(error)});
  const rejected=assert.rejects(starting,/Subscription rejected/);f.exit();await rejected;
  assert.equal(time.timers.size,0);assert.equal(f.client.pending.size,0);assert.equal(errors.length,0);
 }finally{time.restore();}
});

test('an unexpected successful subscription Exit rejects initial readiness',async()=>{
 const f=fixture(),starting=f.client.subscribeReady('thread',{},()=>{});
 const rejected=assert.rejects(starting,/subscription ended unexpectedly/);f.exit(true);await rejected;
 assert.equal(f.client.pending.size,0);
});

test('failed and successful terminal Exits after readiness notify onError exactly once',async()=>{
 for(const success of[false,true]){
  const f=fixture(),errors=[],starting=f.client.subscribeReady('thread',{},()=>{},{onError:error=>errors.push(error)});
  f.chunk({kind:'snapshot'});const stop=await starting;f.exit(success);f.exit(!success);await drain();stop();
  assert.equal(errors.length,1);assert.match(errors[0].message,success?/ended unexpectedly/:/Subscription rejected/);
  assert.equal(f.client.pending.size,0);
 }
});

test('synchronous and asynchronous snapshot callback failures reject and unsubscribe',async()=>{
 for(const callback of[()=>{throw new Error('Snapshot failed');},async()=>{throw new Error('Snapshot failed');}]){
  const f=fixture(),starting=f.client.subscribeReady('thread',{},callback);
  const rejected=assert.rejects(starting,/Snapshot failed/);assert.doesNotThrow(()=>f.chunk({kind:'snapshot'}));await rejected;
  assert.equal(f.client.pending.size,0);assert.equal(f.sent.filter(frame=>frame._tag==='Interrupt').length,1);
 }
});

test('a readiness predicate failure rejects and unsubscribes',async()=>{
 const f=fixture(),starting=f.client.subscribeReady('thread',{},()=>{},{isReady:()=>{throw new Error('Invalid snapshot');}});
 const rejected=assert.rejects(starting,/Invalid snapshot/);f.chunk({kind:'snapshot'});await rejected;assert.equal(f.client.pending.size,0);
});

test('an event processing error after readiness notifies once and stops queued callbacks',async()=>{
 const f=fixture(),errors=[],processed=[];
 const starting=f.client.subscribeReady('thread',{},value=>{processed.push(value.kind);if(value.kind==='event')throw new Error('Event failed');},{onError:error=>errors.push(error)});
 f.chunk({kind:'snapshot'});await starting;f.chunk({kind:'event'},{kind:'ignored'});await drain();
 assert.deepEqual(processed,['snapshot','event']);assert.equal(errors.length,1);assert.match(errors[0].message,/Event failed/);assert.equal(f.client.pending.size,0);
});

test('explicit unsubscribe ignores a later rejection from processing already in progress',async()=>{
 const f=fixture(),errors=[];let reject;
 const blocked=new Promise((_resolve,rejection)=>{reject=rejection;});
 const starting=f.client.subscribeReady('thread',{},value=>value.kind==='event'?blocked:undefined,{onError:error=>errors.push(error)});
 f.chunk({kind:'snapshot'});const stop=await starting;f.chunk({kind:'event'});await drain();stop();reject(new Error('Late failure'));await drain();
 assert.equal(errors.length,0);assert.equal(f.faults.length,0);assert.equal(f.client.pending.size,0);
});

test('a synchronous fake first snapshot resolves only after processing and returns real cleanup',async()=>{
 const client=new T3Client();let stopped=0,processed=false;
 client.subscribe=(_tag,_payload,onValue)=>{onValue({kind:'snapshot'});return()=>{stopped++;};};
 const stop=await client.subscribeReady('thread',{},()=>{processed=true;});
 assert.equal(processed,true);stop();stop();assert.equal(stopped,1);
});

test('a synchronous fake initial failure still cleans up the subsequently returned subscription',async()=>{
 const time=clock();try{
  const client=new T3Client();let stopped=0;
  client.subscribe=(_tag,_payload,_onValue,onError)=>{onError(new Error('Immediate rejection'));return()=>{stopped++;};};
  await assert.rejects(client.subscribeReady('thread',{},()=>{}),/Immediate rejection/);
  assert.equal(stopped,1);assert.equal(time.timers.size,0);
 }finally{time.restore();}
});

test('synchronous fake frames delivered from send do not lose the pending subscription',async()=>{
 const f=fixture((frame,client)=>{if(frame._tag==='Request')client.receive({_tag:'Chunk',requestId:frame.id,values:[{kind:'snapshot'}]});});
 const processed=[];const stop=await f.client.subscribeReady('thread',{},value=>processed.push(value.kind));
 assert.deepEqual(processed,['snapshot']);assert.equal(f.client.pending.size,1);stop();assert.equal(f.client.pending.size,0);
});

test('a synchronous failed Exit from send rejects and leaves no subscription handle',async()=>{
 const f=fixture((frame,client)=>{if(frame._tag==='Request')client.receive({_tag:'Exit',requestId:frame.id,exit:{_tag:'Success'}});});
 await assert.rejects(f.client.subscribeReady('thread',{},()=>{}),/ended unexpectedly/);assert.equal(f.client.pending.size,0);
});

test('initial transport failure rejects readiness and clears the readiness timer',async()=>{
 const time=clock();try{
  const client=new T3Client();await assert.rejects(client.subscribeReady('thread',{},()=>{}),/not connected/);
  assert.equal(client.pending.size,0);assert.equal(time.timers.size,0);
 }finally{time.restore();}
});

test('throwing or rejected after-ready onError callbacks become handled client faults',async()=>{
 for(const onError of[()=>{throw new Error('Error callback failed');},async()=>{throw new Error('Error callback failed');}]){
  const f=fixture(),starting=f.client.subscribeReady('thread',{},()=>{},{onError});f.chunk({kind:'snapshot'});await starting;
  assert.doesNotThrow(()=>f.exit());await drain();assert.equal(f.faults.length,1);assert.match(f.faults[0].message,/Error callback failed/);
 }
});

test('base subscriptions handle callback rejection and successful terminal Exit as faults',async()=>{
 const f=fixture();f.client.subscribe('thread',{},async()=>{throw new Error('Callback rejected');});f.chunk({kind:'event'});await drain();
 assert.equal(f.client.pending.size,0);assert.equal(f.faults.length,1);assert.match(f.faults[0].message,/Callback rejected/);
 const g=fixture();g.client.subscribe('thread',{},()=>{});g.exit(true);assert.equal(g.faults.length,1);assert.match(g.faults[0].message,/ended unexpectedly/);
});

test('ordinary successful call Exits still resolve rather than becoming subscription failures',async()=>{
 const f=fixture(),result=f.client.call('config');f.client.receive({_tag:'Exit',requestId:f.id(),exit:{_tag:'Success',value:{ready:true}}});
 assert.deepEqual(await result,{ready:true});assert.equal(f.client.pending.size,0);assert.equal(f.faults.length,0);
});
