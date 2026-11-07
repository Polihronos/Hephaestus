import test from 'node:test';
import assert from 'node:assert/strict';
import {Companion} from '../src/companion.js';

test('Wispr mode cannot accidentally transcribe raw microphone audio',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  c.state.inputMode='wispr';let called=false;c.speech={call:()=>{called=true;}};await c.transcribe('');assert.equal(called,false);
});
test('an interrupted turn cannot perform late actions in a newer turn',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  Object.assign(c.state,{running:true,busy:true});c.threadId='same-thread';c.turnId='new-turn';c.ignoredTurns=new Set(['old-turn']);
  let response,called=false;c.rpc={reply:(_,r)=>response=r};c.bridge={call:()=>{called=true;}};
  await c.onTool({id:7,method:'item/tool/call',params:{threadId:'same-thread',turnId:'old-turn',tool:'screen_action',arguments:{kind:'click',observationId:'old'}}});
  assert.equal(response.success,false);assert.equal(called,false);
});
test('local preview updates cannot evict a tool observation',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  Object.assign(c.state,{running:true,watching:true});c.bridge={call:async()=>({capturedAt:Date.now(),window:{id:'test'},image:'',fingerprint:'',width:100,height:100,bounds:{x:0,y:0,width:100,height:100}})};
  const observation=await c.observe();for(let i=0;i<10;i++)await c.sample();
  assert.equal(c.observations.get(observation.id),observation);assert.ok(c.frames.length<=4);
});
test('stop waits for a starting turn and cancels its returned id',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.threadId='thread';
  c.starting=Promise.resolve({turn:{id:'starting-turn'}});let interrupted;
  c.rpc={call:async(method,params)=>{interrupted={method,params};}};
  await c.interrupt();assert.equal(interrupted.params.turnId,'starting-turn');assert.ok(c.ignoredTurns.has('starting-turn'));
});
test('an exhausted included allowance cannot start another model request',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  Object.assign(c.state,{connection:'connected',usage:{primary:{usedPercent:100}}});
  let called=false;c.rpc={call:()=>{called=true;}};
  await assert.rejects(c.turn('Hello'),/allowance/);assert.equal(called,false);assert.equal(c.state.backgroundVision,false);
});

test('a reconnect already in progress cannot publish errors or restart after close',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});let entered,release;
 const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
 c.rpc={removeAllListeners(){},close(){}};c.connect=async()=>{entered();await pending;throw new Error('Connection ended during close');};
 const states=[];c.on('state',state=>states.push(state));c.scheduleReconnect();await started;await c.close();
 const before=states.length;release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(states.length,before);assert.equal(c.reconnectTimer,null);assert.equal(c.closed,true);
});
