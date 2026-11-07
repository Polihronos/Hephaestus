import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {T3Workspace} from '../src/t3-workspace.js';
import {Companion} from '../src/companion.js';
import {T3Companion} from '../src/t3-companion.js';

async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'heph-workspace-')),thread={id:'real-thread',title:'Development',projectId:'scratch',status:'running',activeRunId:'run',worktreePath:'C:\\work\\app'},projects=[{id:'scratch',title:'No project',workspaceRoot:'C:\\scratch'},{id:'target',title:'App',workspaceRoot:'C:\\work\\app'},{id:'other',title:'App',workspaceRoot:'C:\\sprites'}],calls=[];
 const client={subscribe(_tag,_args,cb){queueMicrotask(()=>cb({kind:'snapshot',snapshot:{projects,threads:[thread],archivedThreads:[]}}));return()=>{};},async call(tag,p){calls.push({tag,p});if(tag==='orchestration.getThreadProjection')return{thread:{...thread},runs:thread.activeRunId?[{status:'running'}]:[]};if(tag==='projects.createFromThread'){thread.projectId='target';return{projectId:'target'};}if(tag==='orchestration.dispatchCommand')throw Error('Internal command is not in the public RPC schema');return{};}};
 const w=new T3Workspace({client,dataDir:dir});try{await fn({w,thread,projects,calls,dir});}finally{w.close();await rm(dir,{recursive:true,force:true});}
}
test('T3 lookup discovers exact IDs and distinguishes duplicate project names',()=>fixture(async({w})=>{const r=await w.execute({action:'lookup',query:'App'});assert.equal(r.projects.length,2);assert.deepEqual(r.projects.map(p=>p.projectId),['target','other']);assert.equal(r.threadCount,0);}));
test('placeholder thread IDs cannot reach a mutation',()=>fixture(async({w,calls})=>{await assert.rejects(w.execute({action:'move_thread',threadId:'?',projectId:'target'}),/lookup/);assert.equal(calls.length,0);}));
test('T3 moves reject another workspace before changing anything',()=>fixture(async({w,calls})=>{assert.equal((await w.execute({action:'move_thread',threadId:'real-thread',projectId:'other'})).status,'incompatible_workspace');assert.equal(calls.length,0);}));
test('a busy conversation is durably queued, restored and moved only when idle',()=>fixture(async({w,thread,dir,calls})=>{
 const first=await w.execute({action:'move_thread',threadId:'real-thread',projectTitle:'App',deferUntilIdle:true});assert.equal(first.status,'queued');assert.equal(calls.length,0);await w.drain();assert.equal(calls.length,0);
 const restored=new T3Workspace({client:w.client,dataDir:dir});try{await restored.start();assert.equal(restored.operations[0].status,'queued');thread.activeRunId=null;thread.status='completed';await restored.drain();assert.equal(restored.operations[0].status,'completed');assert.equal(thread.projectId,'target');assert.equal(JSON.parse(await readFile(join(dir,'t3-operations.json'),'utf8'))[0].status,'completed');assert.equal(calls.filter(c=>c.tag==='projects.createFromThread').length,1);}finally{restored.close();}
}));
test('interruption during lookup prevents later project mutations',()=>fixture(async({w,calls})=>{await assert.rejects(w.execute({action:'move_thread',threadId:'real-thread',projectId:'target',deferUntilIdle:true},()=>{throw Error('Interrupted');}),/Interrupted/);assert.equal(w.operations.length,0);assert.equal(calls.length,0);}));
test('a pending runtime question keeps an otherwise idle conversation queued',()=>fixture(async({w,thread,calls})=>{thread.activeRunId=null;thread.status='completed';thread.pendingRuntimeRequest={id:'question'};const r=await w.execute({action:'move_thread',threadId:'real-thread',projectId:'target',deferUntilIdle:true});assert.equal(r.status,'queued');await w.drain();assert.equal(calls.length,0);thread.pendingRuntimeRequest=null;await w.drain();assert.equal(w.operations[0].status,'completed');}));
test('legacy unsupported-command failures are recovered without duplicate operations',()=>fixture(async({w,dir,thread})=>{
 await writeFile(join(dir,'t3-operations.json'),JSON.stringify([{id:'pending',threadId:thread.id,projectId:'target',status:'failed',error:'Expected thread.stop | thread.create',completedAt:'old'}]));await w.start();assert.equal(w.operations.length,1);assert.equal(w.operations[0].status,'queued');assert.equal(w.operations[0].error,undefined);thread.activeRunId=null;thread.status='completed';await w.drain();assert.equal(w.operations[0].status,'completed');assert.equal(thread.projectId,'target');
}));
test('a failed promotion is reported as failed rather than queued',()=>fixture(async({w,thread})=>{
 thread.activeRunId=null;thread.status='completed';const call=w.client.call;w.client.call=async(tag,p)=>{if(tag==='projects.createFromThread')throw Error('Project promotion was refused');return call(tag,p);};const r=await w.execute({action:'move_thread',threadId:thread.id,projectId:'target'});assert.equal(r.status,'failed');assert.match(r.message,/Move failed/);assert.equal(thread.projectId,'scratch');
}));
test('notice cooldown and pause suppress normally, without speaking or errors',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{busy:true,spokenReplies:false});c.threadId='thread';c.turnId='turn';c.background=true;c.lastNoticeAt=Date.now();let result,spoken=0;c.on('speak',()=>spoken++);const errors=[];c.on('toolError',e=>errors.push(e));const request={id:1,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',tool:'companion_notice',arguments:{text:'An insight'}}};const rpc={reply:(_id,r)=>result=r};await c.onTool(request,rpc);assert.equal(result.success,true);assert.equal(JSON.parse(result.contentItems[0].text).reason,'cooldown');c.state.proactive=false;await c.onTool(request,rpc);assert.equal(JSON.parse(result.contentItems[0].text).reason,'paused');assert.equal(errors.length,0);assert.equal(c.messages.length,0);assert.equal(spoken,0);
});
test('cooldown avoids paying for another proactive inference',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.state.connection='connected';c.latest={fingerprint:Buffer.alloc(16,255).toString('base64')};c.lastWatchAt=0;c.lastNoticeAt=Date.now();let turns=0;c.turn=async()=>turns++;await c.watch();assert.equal(turns,0);
});
test('the watcher sends observation facts without a second hard-coded behavior prompt',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.state.connection='connected';c.latest={fingerprint:Buffer.alloc(16,255).toString('base64')};c.bridge={call:async command=>{assert.equal(command,'target-info');return{id:'external-window',process:'editor'};}};c.lastWatchAt=0;c.messages=[{role:'assistant',source:'noticed',text:'Previous insight',at:1}];let input;c.turn=async text=>input=JSON.parse(text);await c.watch();assert.equal(input.event,'screen_update');assert.equal(input.recentNotices[0].text,'Previous insight');assert.equal(input.request,undefined);assert.equal(input.instructions,undefined);
});
test('background context knows the user intent and actual pending T3 operations',()=>{
 const c=new T3Companion({root:process.cwd(),dataDir:process.cwd()});c.messages=[{role:'user',text:'Move this conversation',at:1},{role:'assistant',text:'Move queued',at:2},{role:'assistant',source:'noticed',text:'A screen recap',at:3}];c.workspace={operations:[{threadTitle:'Development',projectTitle:'App',status:'queued'}]};const data=c.observationContext();assert.equal(data.lastUserMessage.text,'Move this conversation');assert.equal(data.lastAssistantReply.text,'Move queued');assert.equal(data.workspaceOperations[0].status,'queued');
});
