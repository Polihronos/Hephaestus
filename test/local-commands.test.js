import test from 'node:test';
import assert from 'node:assert/strict';
import {Companion,MAX_MESSAGE_LENGTH} from '../src/companion.js';
import {fastCommand} from '../src/commands.js';

function companion(){
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{runtime:'t3',connection:'connected'});c.save=async()=>{};
 let active={id:'browser',process:'chrome'},windows=[active],captures=0,inferences=0;const actions=[];
 c.bridge={call:async(method,args)=>{if(method==='target-info')return active;if(method==='windows')return windows;if(method==='capture'){captures++;return{window:active,cursor:{x:20,y:30},width:100,height:100,bounds:{x:100,y:200,width:200,height:200},image:'',fingerprint:'',capturedAt:Date.now()};}if(method==='action'){actions.push(args);if(args.kind==='focus')active=windows.find(w=>w.id===args.query);return{ok:true};}throw Error(method);}};
 c.turn=async()=>{inferences++;throw Error('Unexpected inference');};
 return{c,actions,get captures(){return captures;},get inferences(){return inferences;},set active(value){active=value;},set windows(value){windows=value;}};
}

test('exact next, previous and new tab commands work locally in T3 without inference or screenshots',async()=>{
 for(const [text,key]of[['Next tab.','Ctrl+Tab'],['Previous tab','Ctrl+Shift+Tab'],['New tab, please','Ctrl+T']]){
  const f=companion();let accepted=0;await f.c.submit(text,{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.deepEqual(f.actions.map(a=>[a.kind,a.key,a.windowId]),[['key',key,'browser']]);assert.equal(f.captures,0);assert.equal(f.inferences,0);assert.equal(f.c.messages[0].delivery,'sent');assert.equal(f.c.messages[0].localCommand,true);assert.equal(f.c.messages.at(-1).source,'local');
 }
});

test('ambiguous phrases, negation and ordinary chat do not become local actions',()=>{
 for(const text of['Explain the next tab','Do not click here','Click this','Click there','Last tab','Go down','Can you describe a new tab?','Next tab and then close it'])assert.equal(fastCommand(text),null,text);
});

test('the active browser wins over enumeration order and only a unique background browser can be focused',async()=>{
 const f=companion();f.active={id:'active',process:'firefox'};f.windows=[{id:'first',process:'chrome'},{id:'active',process:'firefox'}];await f.c.submit('next tab');assert.equal(f.actions[0].windowId,'active');assert.equal(f.actions.length,1);
 const g=companion();g.active={id:'editor',process:'code'};g.windows=[{id:'only',process:'msedge'}];await g.c.submit('next tab');assert.deepEqual(g.actions.map(a=>a.kind),['focus','key']);assert.equal(g.actions[0].query,'only');assert.equal(g.actions[1].windowId,'only');
});

test('multiple background browsers do not cause an arbitrary focus switch',async()=>{
 const f=companion();f.active={id:'editor',process:'code'};f.windows=[{id:'one',process:'chrome'},{id:'two',process:'firefox'}];let accepted=0;
 await assert.rejects(f.c.submit('next tab',{onAccepted:()=>accepted++}),/Several browser windows/);assert.equal(f.actions.length,0);assert.equal(f.inferences,0);assert.equal(accepted,0);assert.equal(f.c.messages[0].delivery,'failed');
});

test('native commands respect control, screen pause and explicit app privacy',async()=>{
 for(const setting of[{control:false},{watching:false},{excludedApps:['chrome.exe']}]){
  const f=companion();Object.assign(f.c.state,setting);await assert.rejects(f.c.submit('next tab'),/turned off|paused|blocked/);assert.equal(f.actions.length,0);assert.equal(f.inferences,0);
 }
});

test('stale targets and failed focus never receive a later keypress or acknowledgement',async()=>{
 const f=companion();let checks=0,accepted=0;const original=f.c.bridge.call;f.c.bridge.call=async(method,args)=>method==='target-info'?(++checks<3?{id:'browser',process:'chrome'}:{id:'other',process:'chrome'}):original(method,args);
 await assert.rejects(f.c.submit('next tab',{onAccepted:()=>accepted++}),/target changed/);assert.equal(f.actions.length,0);assert.equal(accepted,0);
 const g=companion();g.active={id:'editor',process:'code'};g.windows=[{id:'only',process:'chrome'}];const originalCall=g.c.bridge.call;g.c.bridge.call=async(method,args)=>{if(method==='action'&&args.kind==='focus')throw Error('Windows refused focus');return originalCall(method,args);};
 await assert.rejects(g.c.submit('next tab'),/refused focus/);assert.equal(g.actions.length,0);
});

test('scroll uses the current target and pointer clicks use a fresh scaled observation',async()=>{
 const f=companion();await f.c.submit('scroll down');assert.deepEqual(f.actions[0],{kind:'scroll',key:undefined,delta:-480,windowId:'browser'});assert.equal(f.captures,0);
 const g=companion();await g.c.submit('click here');assert.equal(g.actions[0].screenX,140);assert.equal(g.actions[0].screenY,260);assert.equal(g.captures,1);
});

test('Stop cancels a pending target check before any native input is sent',async()=>{
 const f=companion();let resolve;f.c.bridge.call=()=>new Promise(r=>resolve=r);const pending=f.c.submit('next tab');const rejected=assert.rejects(pending,/interrupted/);await new Promise(r=>setImmediate(r));
 let accepted=0;await f.c.submit('stop',{onAccepted:()=>accepted++});resolve({id:'browser',process:'chrome'});await rejected;assert.equal(f.actions.length,0);assert.equal(accepted,1);assert.ok(f.c.messages.every(m=>m.text!=='Next tab.'));
});

test('a native action finishing after Stop cannot publish success or send more input',async()=>{
 const f=companion();const original=f.c.bridge.call;let resolve,called;const entered=new Promise(r=>called=r);f.c.bridge.call=async(method,args)=>{if(method==='action'){f.actions.push(args);called();return new Promise(r=>resolve=r);}return original(method,args);};
 const pending=f.c.submit('next tab');const rejected=assert.rejects(pending,/interrupted/);await entered;await f.c.submit('stop');resolve({ok:true});await rejected;assert.equal(f.actions.length,1);assert.ok(f.c.messages.every(m=>m.text!=='Next tab.'));
});

test('ordinary chat preflights before recording while safe local commands work offline',async()=>{
 const f=companion();f.c.state.connection='reconnecting';await assert.rejects(f.c.submit('Explain migrations'),/reconnecting/);assert.equal(f.c.messages.length,0);await f.c.submit('next tab');assert.equal(f.actions.length,1);assert.equal(f.inferences,0);
 const g=companion();g.c.state.usage={primary:{usedPercent:100}};await assert.rejects(g.c.submit('Explain migrations'),/allowance/);assert.equal(g.c.messages.length,0);await g.c.submit('stop');assert.equal(g.inferences,0);
});

test('unconfirmed remote cancellation reports Stopping and blocks subsequent native input',async()=>{
 const f=companion();f.c.interrupt=async()=>({confirmed:false});let accepted=0;
 await f.c.submit('stop',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.equal(f.c.messages.at(-1).text,'Stopping the request.');
 await assert.rejects(f.c.submit('next tab'),/not stopped yet/);assert.equal(f.actions.length,0);
 f.c.state.stopping=true;const before=f.c.messages.length;await assert.rejects(f.c.submit('Explain migrations'),/not stopped yet/);assert.equal(f.c.messages.length,before);
});

test('dispatch rejection marks provisional history failed and never acknowledges acceptance',async()=>{
 const f=companion();let accepted=0;const updates=[];f.c.on('messageUpdated',m=>updates.push(m));f.c.turn=async()=>{throw Error('Dispatch transport disconnected');};
 await assert.rejects(f.c.submit('Explain migrations',{onAccepted:()=>accepted++}),/disconnected/);assert.equal(accepted,0);assert.equal(f.c.messages[0].delivery,'failed');assert.equal(updates.at(-1).delivery,'failed');
});

test('model acceptance releases the caller before the full reply finishes',async()=>{
 const f=companion();let finish,accepted;const acknowledged=new Promise(r=>accepted=r);f.c.turn=async(_text,{onAccepted})=>{onAccepted();await new Promise(r=>finish=r);};
 let completed=false;const pending=f.c.submit('Explain migrations',{onAccepted:accepted}).then(()=>completed=true);await acknowledged;assert.equal(completed,false);assert.equal(f.c.messages[0].delivery,'sent');finish();await pending;
});

test('core dispatch failures propagate and a pending start cannot hold Stop indefinitely',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',watching:false});c.threadId='thread';c.save=async()=>{};c.rpc={call:async()=>{throw Error('Dispatch failed');}};let accepted=0;
 await assert.rejects(c.turn('Explain migrations',{onAccepted:()=>accepted++}),/Dispatch failed/);assert.equal(accepted,0);assert.equal(c.state.busy,false);
 let resolve;const cancelled=[];c.starting=new Promise(r=>resolve=r);c.rpc={call:async(method,args)=>cancelled.push([method,args.turnId])};
 await c.interrupt();assert.deepEqual(cancelled,[]);resolve({turn:{id:'late'}});await new Promise(r=>setImmediate(r));assert.deepEqual(cancelled,[['turn/interrupt','late']]);
});

test('messages at the supported limit are delivered completely, including non-English text and whitespace',async()=>{
 for(const text of['a'.repeat(MAX_MESSAGE_LENGTH),' '+ 'Б'.repeat(MAX_MESSAGE_LENGTH-2)+'\n','😀'.repeat(MAX_MESSAGE_LENGTH/2)]){
  const f=companion();let dispatched,accepted=0;f.c.turn=async(input,{onAccepted})=>{dispatched=input;onAccepted();};
  await f.c.submit(text,{source:'wispr',onAccepted:()=>accepted++});assert.equal(dispatched,text);assert.equal(f.c.messages[0].text,text);assert.equal(f.c.messages[0].delivery,'sent');assert.equal(accepted,1);assert.equal(f.actions.length,0);
 }
});

test('oversized input is rejected visibly before recording, interruption, wakeup or dispatch',async()=>{
 for(const text of['a'.repeat(MAX_MESSAGE_LENGTH+1),'Б'.repeat(MAX_MESSAGE_LENGTH+1),'😀'.repeat(MAX_MESSAGE_LENGTH/2)+'x','stop'+' '.repeat(MAX_MESSAGE_LENGTH-3)]){
  const f=companion();Object.assign(f.c.state,{running:false,connection:'reconnecting'});f.c.submitSequence=7;f.c.generation=23;let interrupted=0,configured=0,accepted=0,recorded=0;
  f.c.interrupt=async()=>interrupted++;f.c.configure=async()=>configured++;f.c.on('message',()=>recorded++);
  await assert.rejects(f.c.submit(text,{source:'wispr',onAccepted:()=>accepted++}),error=>error.code==='MESSAGE_TOO_LONG'&&error.limit===MAX_MESSAGE_LENGTH&&error.length===MAX_MESSAGE_LENGTH+1&&/16,000.*16,001.*nothing was sent/.test(error.message));
  assert.equal(f.c.messages.length,0);assert.equal(recorded,0);assert.equal(interrupted,0);assert.equal(configured,0);assert.equal(accepted,0);assert.equal(f.inferences,0);assert.equal(f.actions.length,0);assert.equal(f.c.submitSequence,7);assert.equal(f.c.generation,23);assert.equal(f.c.state.running,false);
 }
});
