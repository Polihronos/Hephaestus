import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {T3Companion} from '../src/t3-companion.js';

const THREAD='empty-reply-thread',RUN='empty-reply-run',USER='empty-reply-user';
const run=(patch={})=>({id:RUN,userMessageId:USER,status:'completed',...patch});
const item=(patch={})=>({id:'empty-reply-item',runId:RUN,type:'assistant_message',streaming:false,text:'',...patch});
const event=(c,payload,type='turn-item.updated')=>c.t3Stream({kind:'event',event:{type,payload}});
const assistant=c=>c.messages.filter(message=>message.role==='assistant');
const user=c=>c.messages.find(message=>message.t3MessageId===USER);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function flush(c){for(let i=0;i<3;i++){await Promise.all([c.saveQueue,c.t3SaveQueue,c.t3StopPersistencePromise].filter(Boolean));await tick();}}
async function fixture(body){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-empty-replies-'));
 const c=new T3Companion({root:process.cwd(),dataDir:directory}),events=[];
 Object.assign(c.state,{connection:'connected',prompt:'Temporary unit-test instructions',watching:false,busy:true});
 Object.assign(c,{defaultPrompt:c.state.prompt,threadId:'unit-native-thread',t3ThreadId:THREAD,t3ProjectId:'unit-project',t3RunId:RUN,t3MessageId:USER,t3InFlight:true,externalT3Run:true,t3FirstText:false,t3TurnStart:Date.now(),
  t3Runs:new Map([[RUN,run({status:'running'})]]),t3Attempts:new Map(),t3Seen:new Map(),t3ProviderTurns:new Map(),providerNativeIds:new Map(),providerContexts:new Map()});
 c.messages=[{id:'original-local-user',role:'user',text:'Explain the next step.',at:1,t3MessageId:USER,delivery:'sent'}];
 c.t3={call:async()=>{throw new Error('Empty-reply unit tests must not dispatch or infer');}};
 for(const name of['message','messageUpdated','messagesRestored','delta','speechFlush','speak'])c.on(name,data=>events.push({name,data:structuredClone(data)}));
 try{await c.save();await body(c,directory,events);}finally{c.closed=true;clearTimeout(c.reconnectTimer);await flush(c).catch(()=>{});await rm(directory,{recursive:true,force:true});}
}
const saved=async directory=>JSON.parse(await readFile(join(directory,'settings.json'),'utf8'));
function assertNoTextError(c){assert.match(c.state.error??'',/text|reply|response/i);assert.match(c.state.error??'',/follow.?up|again|retry|workspace|ask/i);}
function assertNoAssistantEvents(events){assert.deepEqual(events.filter(event=>['message','delta','speechFlush','speak'].includes(event.name)),[]);}

test('empty and Unicode-whitespace assistant items remain silent and never count as first text',()=>fixture(async(c,_directory,events)=>{
 c.state.lastReplyMs=731;
 for(const [index,text]of['',' \r\n\t ','\u00a0\u2003\n'].entries())for(const streaming of[true,false])event(c,item({id:`blank-${index}-${streaming}`,text,streaming}));
 assert.equal(assistant(c).length,0);assert.equal(c.t3FirstText,false);assert.equal(c.state.lastReplyMs,731);assertNoAssistantEvents(events);
 assert.equal(user(c).replyStatus,undefined,'An active request is not prematurely labelled empty');assert.equal(c.state.error,null);
}));

test('completed empty final marks the original sent request, publishes guidance and durably preserves delivery',()=>fixture(async(c,directory,events)=>{
 const originalId=user(c).id;event(c,item());event(c,run(),'run.updated');await flush(c);
 assert.equal(assistant(c).length,0);assertNoAssistantEvents(events);assert.equal(c.t3FirstText,false);
 assert.equal(user(c).id,originalId);assert.equal(user(c).delivery,'sent');assert.equal(user(c).replyStatus,'empty');assertNoTextError(c);
 const updates=events.filter(event=>event.name==='messageUpdated'&&event.data.id===originalId);assert.ok(updates.some(event=>event.data.replyStatus==='empty'&&event.data.delivery==='sent'));
 const durable=(await saved(directory)).messages.find(message=>message.id===originalId);assert.equal(durable.replyStatus,'empty');assert.equal(durable.delivery,'sent');
 assert.equal(c.state.busy,false);assert.equal(c.t3InFlight,false);
}));

test('completion without any assistant item receives the same empty-reply recovery state once',()=>fixture(async(c,directory,events)=>{
 event(c,run(),'run.updated');event(c,run(),'run.updated');await flush(c);
 assert.equal(user(c).replyStatus,'empty');assert.equal(user(c).delivery,'sent');assertNoTextError(c);assert.equal(assistant(c).length,0);
 assert.equal(events.filter(event=>event.name==='messageUpdated'&&event.data.replyStatus==='empty').length,1);
 assert.equal((await saved(directory)).messages[0].replyStatus,'empty');
}));

test('a successful local Stop clears ephemeral no-text guidance but retains the older durable empty-reply marker',()=>fixture(async(c,directory)=>{
 event(c,run(),'run.updated');await flush(c);
 assert.equal(user(c).replyStatus,'empty');assert.ok(c.state.replyIssue);
 // Match the actual idle state after canonical completion: this local command
 // must not dispatch a model request or attempt any native cancellation.
 assert.equal(c.t3InFlight,false);assert.equal(c.t3Outstanding,null);assert.equal(c.turnId,null);
 let accepted=0;await c.submit('stop',{source:'text',onAccepted:()=>accepted++});await flush(c);
 assert.equal(accepted,1);assert.equal(c.state.replyIssue,null);assert.equal(user(c).replyStatus,'empty');assert.equal(user(c).delivery,'sent');
 const local=c.messages.at(-1);assert.equal(local.role,'assistant');assert.equal(local.source,'local');assert.match(local.text,/stopped/i);
 const durable=(await saved(directory)).messages;assert.equal(durable.find(message=>message.id===user(c).id).replyStatus,'empty');
 assert.ok(durable.some(message=>message.role==='user'&&message.text==='stop'&&message.delivery==='sent'));
}));

test('foreign completed runs cannot mark the current request as empty or overwrite its error',()=>fixture(async(c,_directory,events)=>{
 c.publish({error:'An unrelated current warning'});event(c,run({id:'foreign-run',userMessageId:'foreign-user'}),'run.updated');
 assert.equal(user(c).replyStatus,undefined);assert.equal(c.state.error,'An unrelated current warning');assert.equal(events.filter(event=>event.name==='messageUpdated').length,0);
}));

test('a stopped or ignored completed run is excluded from no-text recovery',()=>fixture(async(c,_directory,events)=>{
 c.ignoredT3Runs=new Set([RUN]);c.desktopActionsRevoked=true;c.state.stopping=true;
 c.t3StopIntent={threadId:THREAD,messageId:USER,runId:RUN,accepted:true,requestedAt:Date.now()};
 event(c,item());event(c,run(),'run.updated');await flush(c);
 assert.equal(user(c).replyStatus,undefined);assert.equal(user(c).delivery,'sent');assert.equal(c.state.error,null);assertNoAssistantEvents(events);
 assert.equal(c.t3StopIntent,null);assert.equal(c.desktopActionsRevoked,true);
}));

test('real streamed text prevents a later blank final from falsely labelling the request empty',()=>fixture(async(c,_directory,events)=>{
 event(c,item({text:'Действителен отговор с полезна следваща стъпка.',streaming:true}));
 event(c,item({text:' \n\t ',streaming:false}));event(c,run(),'run.updated');
 assert.equal(c.t3FirstText,true);assert.equal(user(c).replyStatus,undefined);assert.equal(c.state.error,null);
 assert.equal(events.filter(event=>event.name==='delta').length,1);assert.equal(events.find(event=>event.name==='delta').data.full,'Действителен отговор с полезна следваща стъпка.');
 assert.ok(assistant(c).every(message=>message.text.trim()),'A blank final must never create a blank saved row');
}));

test('a nonempty final remains a normal answer even when empty items preceded it',()=>fixture(async(c,_directory,events)=>{
 event(c,item({id:'empty-prefix'}));const answer=item({id:'real-answer',text:'A specific next step.'});event(c,answer);event(c,answer);event(c,run(),'run.updated');
 assert.deepEqual(assistant(c).map(message=>message.text),['A specific next step.']);assert.equal(c.t3FirstText,true);assert.equal(user(c).replyStatus,undefined);assert.equal(c.state.error,null);
 assert.equal(events.filter(event=>event.name==='delta').length,1);assert.equal(events.filter(event=>event.name==='speechFlush').length,1);
}));

test('late genuine text repairs the matching empty user and only its owned error, including durable state',()=>fixture(async(c,directory,events)=>{
 event(c,run(),'run.updated');assert.equal(user(c).replyStatus,'empty');assertNoTextError(c);events.length=0;
 const answer=item({id:'late-real-answer',text:'The delayed substantive reply.'});event(c,answer);event(c,answer);await flush(c);
 assert.notEqual(user(c).replyStatus,'empty');assert.equal(user(c).delivery,'sent');assert.equal(c.state.error,null);
 assert.equal(assistant(c).length,1);assert.equal(events.filter(event=>event.name==='messageUpdated'&&event.data.id===user(c).id).length,1);
 assert.notEqual((await saved(directory)).messages.find(message=>message.id===user(c).id).replyStatus,'empty');
}));

test('late text clears its empty flag while preserving a newer unrelated error',()=>fixture(async(c,_directory)=>{
 event(c,run(),'run.updated');assert.equal(user(c).replyStatus,'empty');
 c.publish({error:'The local screen helper needs reconnecting'});event(c,item({text:'The real answer eventually arrived.'}));
 assert.notEqual(user(c).replyStatus,'empty');assert.equal(c.state.error,'The local screen helper needs reconnecting');
}));

test('late text for an older user cannot clear the newer request empty status or error',()=>fixture(async(c,_directory)=>{
 event(c,run(),'run.updated');assert.equal(user(c).replyStatus,'empty');
 c.messages.push({id:'new-local-user',role:'user',text:'A newer question.',t3MessageId:'new-user',delivery:'sent',at:2});
 event(c,run({id:'new-run',userMessageId:'new-user',status:'running'}),'run.created');event(c,run({id:'new-run',userMessageId:'new-user'}),'run.updated');
 const newer=c.messages.find(message=>message.t3MessageId==='new-user'),newError=c.state.error;assert.equal(newer.replyStatus,'empty');assertNoTextError(c);
 event(c,item({id:'old-late-answer',text:'The older reply arrives after the newer empty result.'}));
 assert.notEqual(user(c).replyStatus,'empty');assert.equal(newer.replyStatus,'empty');assert.equal(newer.delivery,'sent');assert.equal(c.state.error,newError);
}));

test('snapshot restoration skips blank assistant records and silently restores a real final once',()=>fixture(async(c,_directory,events)=>{
 const p={thread:{id:THREAD,activeRunId:null},runs:[run()],messages:[],turnItems:[item({id:'blank-snapshot',text:''}),item({id:'whitespace-snapshot',text:'\u00a0\n\t'}),item({id:'real-snapshot',text:'A restored substantive answer.'})]};
 c.restoreProjection(p);c.restoreProjection(p);
 assert.deepEqual(assistant(c).map(message=>message.text),['A restored substantive answer.']);assert.equal(user(c).replyStatus,undefined);assert.equal(c.state.error,null);
 assert.deepEqual(events.filter(event=>['message','delta','speechFlush','speak'].includes(event.name)),[]);assert.equal(c.t3FirstText,false,'Historical restoration must not claim a fresh first-text latency');
}));

test('a blank completed snapshot preserves the real text already observed streaming for that same item',()=>fixture(async(c,directory,events)=>{
 const actual='  Actual streamed text: Ω and текст.\nA concrete next step.  ';
 event(c,item({text:actual,streaming:true}));assert.equal(c.t3FirstText,true);events.length=0;
 const p={thread:{id:THREAD,activeRunId:null},runs:[run()],messages:[],turnItems:[item({text:' \n\t ',streaming:false})]};
 c.restoreProjection(p);c.restoreProjection(p);
 assert.equal(assistant(c).length,1);assert.equal(assistant(c)[0].providerItemId,'empty-reply-item');assert.equal(assistant(c)[0].text,actual);
 assert.equal(user(c).replyStatus,undefined);assert.equal(user(c).delivery,'sent');assert.equal(c.state.error,null);assertNoAssistantEvents(events);
 await c.save();assert.equal((await saved(directory)).messages.find(message=>message.role==='assistant').text,actual);
}));

test('a current completed no-text snapshot persists recovery status without adding or speaking blank rows',()=>fixture(async(c,directory,events)=>{
 const p={thread:{id:THREAD,activeRunId:null},runs:[run()],messages:[],turnItems:[item({text:' \n '})]};
 c.restoreProjection(p);await flush(c);
 assert.equal(assistant(c).length,0);assert.equal(user(c).replyStatus,'empty');assert.equal(user(c).delivery,'sent');assertNoTextError(c);assertNoAssistantEvents(events);
 assert.equal((await saved(directory)).messages.find(message=>message.id===user(c).id).replyStatus,'empty');
}));
