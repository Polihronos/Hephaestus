import test from 'node:test';
import assert from 'node:assert/strict';
import {T3Companion} from '../src/t3-companion.js';
import {signToolOrigin,verifyToolOrigin} from '../src/tool-origin.js';

const secret='local-unit-test-origin-secret-with-at-least-32-bytes';
function origin({tool='screen_windows',args={},...identity}={}){
 const proof=signToolOrigin({secret,tool,args,nativeSessionId:'native-session',nativeTurnId:'native-turn',toolUseId:'native-tool-use',...identity});
 return verifyToolOrigin({secret,tool,args,proof});
}
function projection(){return{
 thread:{id:'current-thread',activeRunId:'current-run'},
 providerThreads:[{id:'provider-thread',threadId:'current-thread',nativeThreadRef:{nativeId:'native-session'}}],
 providerTurns:[{id:'provider-turn',providerThreadId:'provider-thread',runAttemptId:'attempt',nativeTurnRef:{nativeId:'native-turn'},status:'running'}],
 attempts:[{id:'attempt',runId:'current-run'}],
 runs:[{id:'current-run',threadId:'current-thread',userMessageId:'current-message',status:'running'}]
};}
function companion({indexed=true}={}){
 const c=new T3Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',busy:true,watching:true});c.t3InFlight=true;c.t3TransportReady=true;c.background=false;c.t3ThreadId='current-thread';c.t3RunId='current-run';c.t3MessageId='current-message';
 c.providerNativeIds=new Map();c.providerContexts=new Map();c.t3ProviderTurns=new Map();c.t3Attempts=new Map();c.t3Runs=new Map();c.t3Seen=new Map();c.save=async()=>{};c.saveT3=async()=>{};
 c.t3={socket:{readyState:1},call:async()=>{throw new Error('Unexpected runtime projection fetch');}};
 const actions=[];c.bridge={call:async(command,args)=>{if(command==='target-info')return{id:'window',process:'editor'};if(command==='windows')return[{id:'window',process:'editor'}];if(command==='capture')return{width:100,height:100,bounds:{x:0,y:0,width:100,height:100},window:{id:'window',process:'editor'},capturedAt:Date.now(),image:'YQ==',fingerprint:'',captureSource:'window'};if(command==='action'){actions.push(args);return{ok:true};}throw new Error(command);}};
 if(indexed)c.indexToolOriginProjection(projection());return{c,actions};
}

test('exact native session and turn IDs join the provider attempt to the current runtime request',async()=>{
 const{c,actions}=companion(),lease=await c.authorizeToolOrigin(origin());assert.equal(Object.isFrozen(lease),true);assert.equal(lease.runId,'current-run');assert.equal(lease.messageId,'current-message');assert.equal(lease.providerTurnId,'provider-turn');assert.equal(lease.nativeTurnId,'native-turn');
 assert.equal((await c.invokeDesktopTool('screen_windows',{},{lease})).success,true);assert.equal(actions.length,0);
});

test('provider turns are cached before missing-native or absent-usage early returns',()=>{
 const{c}=companion({indexed:false});c.providerNativeIds.clear();
 c.providerTurnUpdate(projection().providerTurns[0]);assert.equal(c.t3ProviderTurns.get('provider-turn').nativeTurnRef.nativeId,'native-turn');assert.equal(c.t3ProviderTurns.get('provider-turn').runAttemptId,'attempt');
 c.providerTurnUpdate({id:'provider-turn',status:'waiting'});assert.equal(c.t3ProviderTurns.get('provider-turn').nativeTurnRef.nativeId,'native-turn');assert.equal(c.t3ProviderTurns.get('provider-turn').status,'waiting');
});

test('missing mappings fetch only the actual current projection and never restore transcript or usage',async()=>{
 const{c}=companion({indexed:false});let reads=0,restored=0,usage=0;c.on('messagesRestored',()=>restored++);c.ledger={record:()=>usage++,recordTurn:()=>usage++};
 c.t3.call=async(tag,args)=>{reads++;assert.equal(tag,'orchestration.getThreadProjection');assert.deepEqual(args,{threadId:'current-thread'});return{...projection(),turnItems:[{id:'not-to-restore',type:'assistant_message',text:'Not a live response'}],providerThreads:[{...projection().providerThreads[0],contextUsage:{inputTokens:50,usedTokens:50}}]};};
 const lease=await c.authorizeToolOrigin(origin());assert.equal(lease.runId,'current-run');assert.equal(reads,1);assert.equal(restored,0);assert.equal(usage,0);assert.equal(c.messages.length,0);assert.equal(c.activities.length,0);assert.equal(c.t3Seen.size,0);assert.equal(c.t3RunId,'current-run');
});

test('an unknown native identity cannot borrow the current run after projection refresh',async()=>{
 for(const identity of[{nativeSessionId:'unknown-session'},{nativeTurnId:'unknown-turn'}]){
  const{c}=companion();let reads=0;c.t3.call=async()=>{reads++;return projection();};
  await assert.rejects(c.authorizeToolOrigin(origin(identity)),/origin could not be joined/);assert.equal(reads,1);assert.equal(c.t3RunId,'current-run');assert.equal(c.messages.length,0);
 }
});

test('partial provider-turn joins are completed from runtime data without substituting IDs',async()=>{
 const{c}=companion();c.t3Attempts.clear();let reads=0;c.t3.call=async()=>{reads++;return projection();};
 const lease=await c.authorizeToolOrigin(origin());assert.equal(lease.attemptId,'attempt');assert.equal(lease.runId,'current-run');assert.equal(reads,1);
});

test('foreign projection responses are rejected before they can poison runtime indexes',async()=>{
 const{c}=companion({indexed:false});c.t3.call=async()=>({...projection(),thread:{id:'another-thread'}});
 await assert.rejects(c.authorizeToolOrigin(origin()),/another conversation/);assert.equal(c.t3Runs.size,0);assert.equal(c.t3ProviderTurns.size,0);assert.equal(c.t3ThreadId,'current-thread');
});

test('a completed native turn or a different run or user message cannot authorize current desktop tools',async()=>{
 for(const change of[
  c=>c.t3ProviderTurns.set('provider-turn',{...c.t3ProviderTurns.get('provider-turn'),status:'completed'}),
  c=>c.t3Attempts.set('attempt','older-run'),
  c=>c.t3Runs.set('current-run',{...c.t3Runs.get('current-run'),userMessageId:'another-message'}),
  c=>c.t3Runs.set('current-run',{...c.t3Runs.get('current-run'),threadId:'another-thread'}),
  c=>c.t3Runs.set('current-run',{...c.t3Runs.get('current-run'),status:'completed'})
 ]){
  const{c}=companion();c.t3Runs.set('older-run',{id:'older-run',threadId:'current-thread',userMessageId:'current-message',status:'running'});change(c);
  await assert.rejects(c.authorizeToolOrigin(origin()),/does not belong to the active request/);
 }
});

test('stable message identity can bind a proven runtime join before run.created arrives',async()=>{
 const{c}=companion();c.t3RunId=null;const lease=await c.authorizeToolOrigin(origin());assert.equal(lease.runId,'current-run');assert.equal(c.t3RunId,null);
 assert.equal((await c.invokeDesktopTool('screen_windows',{},{lease})).success,true);c.t3RunId='different-run';await assert.rejects(c.invokeDesktopTool('screen_windows',{},{lease}),/does not belong/);
});

test('missing, forged, cross-companion and wrong-tool leases are rejected before native work',async()=>{
 const{c,actions}=companion(),lease=await c.authorizeToolOrigin(origin());
 await assert.rejects(c.invokeDesktopTool('screen_windows',{}),/lease is required/);
 await assert.rejects(c.invokeDesktopTool('screen_windows',{},{lease:Object.freeze({...lease})}),/lease is required/);
 const other=companion().c;await assert.rejects(other.invokeDesktopTool('screen_windows',{},{lease}),/lease is required/);
 await assert.rejects(c.invokeDesktopTool('screen_action',{kind:'key',key:'Enter'},{lease}),/belongs to another tool/);assert.equal(actions.length,0);
});

test('stop, ignored runs, recovery and instruction transactions reject origin authorization',async()=>{
 for(const change of[
  c=>c.state.connection='reconnecting',c=>c.t3TransportReady=false,c=>c.t3.socket.readyState=3,c=>c.t3InFlight=false,c=>c.state.busy=false,c=>c.state.running=false,
  c=>c.desktopActionsRevoked=true,c=>c.t3StopIntent={runId:'current-run'},c=>c.state.stopping=true,c=>c.state.instructionsSaving=true,c=>c.updatingPrompt=true,c=>c.promptRecoveryBlocked=true,c=>c.background=true,c=>c.closed=true,c=>c.ignoredT3Runs=new Set(['current-run'])
 ]){const{c,actions}=companion();change(c);await assert.rejects(c.authorizeToolOrigin(origin()),/No active|does not belong/);assert.equal(actions.length,0);}
});

test('an origin projection arriving after cancellation or identity replacement cannot authorize or reindex',async()=>{
 for(const change of[c=>c.generation++,c=>c.t3ThreadId='new-thread',c=>c.t3MessageId='new-message',c=>c.t3={socket:{readyState:1}}]){
  const{c}=companion({indexed:false});let resolve;c.t3.call=()=>new Promise(done=>resolve=done);const pending=c.authorizeToolOrigin(origin()),rejected=assert.rejects(pending,/no longer active/);change(c);resolve(projection());await rejected;assert.equal(c.t3Runs.size,0);assert.equal(c.t3ProviderTurns.size,0);
 }
});

test('workspace authorization is rechecked at every executor guard and after asynchronous completion',async()=>{
 const{c}=companion(),args={action:'lookup',query:'current'},lease=await c.authorizeToolOrigin(origin({tool:'t3_workspace',args}));let release,entered,mutations=0;const gate=new Promise(done=>release=done),waiting=new Promise(done=>entered=done);
 c.workspace={execute:async(_args,guard)=>{guard();entered();await gate;guard();mutations++;return{status:'completed'};}};
 const pending=c.invokeDesktopTool('t3_workspace',args,{lease}),rejected=assert.rejects(pending,/No active|no longer active/);await waiting;c.desktopActionsRevoked=true;c.generation++;release();await rejected;assert.equal(mutations,0);
});

test('workspace results cannot report success after the run becomes terminal',async()=>{
 const{c}=companion(),args={action:'lookup'},lease=await c.authorizeToolOrigin(origin({tool:'t3_workspace',args}));let release,entered;const gate=new Promise(done=>release=done),waiting=new Promise(done=>entered=done);
 c.workspace={execute:async()=>{entered();await gate;return{status:'completed'};}};const pending=c.invokeDesktopTool('t3_workspace',args,{lease}),rejected=assert.rejects(pending,/does not belong/);await waiting;c.t3Runs.get('current-run').status='completed';release();await rejected;
});

test('native input sequences stop before the next step when their originating generation is revoked',async()=>{
 const{c,actions}=companion(),frame=await c.observe(),args={kind:'sequence',observationId:frame.id,steps:[{kind:'type',text:'Hello'},{kind:'key',key:'Enter'}]},lease=await c.authorizeToolOrigin(origin({tool:'screen_action',args})),call=c.bridge.call;
 c.bridge.call=async(command,request)=>{const result=await call(command,request);if(command==='action'){c.desktopActionsRevoked=true;c.generation++;}return result;};
 await assert.rejects(c.invokeDesktopTool('screen_action',args,{lease}),/No active|no longer active/);assert.equal(actions.length,1);assert.equal(actions[0].kind,'type');
});

test('a native sequence cannot continue after canonical run completion without a generation change',async()=>{
 const{c,actions}=companion(),frame=await c.observe(),args={kind:'sequence',observationId:frame.id,steps:[{kind:'type',text:'Hello'},{kind:'key',key:'Enter'}]},lease=await c.authorizeToolOrigin(origin({tool:'screen_action',args})),generation=c.generation,call=c.bridge.call;
 c.bridge.call=async(command,request)=>{const result=await call(command,request);if(command==='action')c.t3Runs.get('current-run').status='completed';return result;};
 await assert.rejects(c.invokeDesktopTool('screen_action',args,{lease}),/does not belong to the active request/);assert.equal(c.generation,generation);assert.equal(actions.length,1);assert.equal(actions[0].kind,'type');
});

test('a lease cannot send native input after its current thread changes during a target check',async()=>{
 const{c,actions}=companion(),frame=await c.observe(),args={kind:'key',observationId:frame.id,key:'Enter'},lease=await c.authorizeToolOrigin(origin({tool:'screen_action',args})),generation=c.generation;let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),call=c.bridge.call;
 c.bridge.call=async(command,request)=>{if(command==='target-info'){entered();await gate;}return call(command,request);};
 const pending=c.invokeDesktopTool('screen_action',args,{lease}),rejected=assert.rejects(pending,/no longer active/);await waiting;c.t3ThreadId='new-thread';release();await rejected;assert.equal(c.generation,generation);assert.equal(actions.length,0);
});

test('model images stay deferred until the delivery callback commits them',async()=>{
 const{c}=companion(),lease=await c.authorizeToolOrigin(origin({tool:'screen_observe'})),queued=[],shared=[];c.on('visionFrame',frame=>shared.push(frame));
 const result=await c.invokeDesktopTool('screen_observe',{},{lease,onDelivered:commit=>queued.push(commit)});assert.equal(result.success,true);assert.equal(queued.length,1);assert.equal(shared.length,0);assert.equal(c.modelObservation(),null);
 assert.equal(queued[0](),true);assert.equal(shared.length,1);assert.equal(c.modelObservation().id,shared[0].id);
});

test('a delayed MCP delivery cannot revive revoked, paused or private image evidence',async()=>{
 for(const change of[c=>c.generation++,c=>c.desktopActionsRevoked=true,c=>c.state.watching=false,c=>c.state.screenPrivacyBlocked=true,c=>c.state.excludedApps=['editor'],c=>c.state.instructionsSaving=true]){
  const{c}=companion(),lease=await c.authorizeToolOrigin(origin({tool:'screen_observe'})),queued=[],shared=[];c.on('visionFrame',frame=>shared.push(frame));
  await c.invokeDesktopTool('screen_observe',{},{lease,onDelivered:commit=>queued.push(commit)});change(c);assert.equal(queued[0](),false);assert.equal(shared.length,0);assert.equal(c.modelObservation(),null);
 }
});

test('an authorized direct caller without deferred delivery still commits its returned frame',async()=>{
 const{c}=companion(),lease=await c.authorizeToolOrigin(origin({tool:'screen_observe'})),shared=[];c.on('visionFrame',frame=>shared.push(frame));
 assert.equal((await c.invokeDesktopTool('screen_observe',{},{lease})).success,true);assert.equal(shared.length,1);assert.equal(c.modelObservation().id,shared[0].id);
});
