import {readFile,writeFile,rename} from 'node:fs/promises';
import {join,normalize} from 'node:path';
import {randomUUID} from 'node:crypto';

export const t3Tools=[{type:'function',name:'t3_workspace',description:'Connected T3 control, independent of the UI connection. Look up real project/thread IDs by title, inspect this companion connection, or move a thread into a project for its existing folder. A busy thread can queue its move until idle. Never invent IDs. Moving to a different folder is not supported by T3; this tool preserves files and conversation history.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['lookup','move_thread','operation_status']},query:{type:'string'},threadId:{type:'string'},projectId:{type:'string'},projectTitle:{type:'string'},deferUntilIdle:{type:'boolean'}},required:['action'],additionalProperties:false}}];
const samePath=(a,b)=>a&&b&&normalize(a).toLowerCase()===normalize(b).toLowerCase();
const activeStatuses=new Set(['preparing','queued','starting','running','waiting']);
const busy=t=>!!t.activeRunId||!!t.pendingRuntimeRequest||activeStatuses.has(t.status);
const compact=t=>({threadId:t.id??t.threadId,projectId:t.projectId,title:t.title,status:t.status,activeRunId:t.activeRunId,worktreePath:t.worktreePath});

export class T3Workspace {
 constructor({client,dataDir,context=()=>({}),onActivity=()=>{}}){Object.assign(this,{client,dataDir,context,onActivity});this.operations=[];}
 async start(){try{this.operations=JSON.parse(await readFile(join(this.dataDir,'t3-operations.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}let migrated=false;for(const op of this.operations){if(!op.apiVersion&&op.status==='failed'&&op.error?.includes('Expected')&&op.error.includes('thread.create')){Object.assign(op,{status:'queued',apiVersion:2,previousFailure:'Unsupported internal T3 promotion command'});delete op.error;delete op.completedAt;migrated=true;}}if(migrated)await this.save();this.timer=setInterval(()=>this.drain().catch(()=>{}),2000);this.timer.unref?.();await this.drain();return this;}
 close(){clearInterval(this.timer);}
 async snapshot(){return new Promise((resolve,reject)=>{let stop;const timer=setTimeout(()=>{stop?.();reject(new Error('T3 project lookup timed out. The desktop tools remain available.'));},10000);stop=this.client.subscribe('orchestration.subscribeShell',{},item=>{if(item.kind!=='snapshot')return;clearTimeout(timer);queueMicrotask(()=>stop?.());resolve(item.snapshot);},e=>{clearTimeout(timer);stop?.();reject(e);});});}
 async save(){const data=JSON.stringify(this.operations.slice(-100),null,2);this.saveQueue=(this.saveQueue??Promise.resolve()).catch(()=>{}).then(async()=>{const file=join(this.dataDir,'t3-operations.json');await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);});return this.saveQueue;}
 async execute(a,assertActive=()=>{}){
  if(a.action==='operation_status')return{connection:this.context(),operations:this.operations};
  const snapshot=await this.snapshot(),projects=snapshot.projects.filter(p=>!p.deletedAt),threads=[...snapshot.threads,...(snapshot.archivedThreads??[])].filter(t=>!t.deletedAt);
  if(a.action==='lookup'){
   const q=(a.query??'').trim().toLowerCase(),matches=threads.filter(t=>!q||t.title.toLowerCase().includes(q)||t.id===a.query),matchedProjectIds=new Set(matches.map(t=>t.projectId));
   return{connection:this.context(),projects:projects.filter(p=>!q||p.title.toLowerCase().includes(q)||matchedProjectIds.has(p.id)).map(p=>({projectId:p.id,title:p.title,workspaceRoot:p.workspaceRoot,archived:!!p.archivedAt})),threads:matches.slice(0,40).map(compact),threadCount:matches.length};
  }
  if(a.action!=='move_thread')throw new Error('Choose lookup, move_thread or operation_status');
  const thread=threads.find(t=>t.id===a.threadId);if(!thread)throw new Error('Thread not found. Call t3_workspace lookup by title first and use its exact threadId.');
  const current=projects.find(p=>p.id===thread.projectId),folder=thread.worktreePath??current?.workspaceRoot;if(!folder)throw new Error('This thread has no registered workspace folder.');
  let target;if(a.projectId){target=projects.find(p=>p.id===a.projectId);if(!target)throw new Error('Project not found. Use the exact projectId returned by lookup.');}
  else{
   const title=a.projectTitle?.trim();if(!title)throw new Error('Supply a discovered projectId or the name of a new project in projectTitle.');
   const matches=projects.filter(p=>p.title.toLowerCase()===title.toLowerCase());
   target=matches.find(p=>samePath(p.workspaceRoot,folder));
   if(!target&&matches.length)return{status:'needs_project_selection',message:'That project name belongs to another folder. Select a compatible project or use a distinct name to register this thread\'s existing folder.',workspaceRoot:folder,projects:matches.map(p=>({projectId:p.id,title:p.title,workspaceRoot:p.workspaceRoot}))};
   if(!target){target=projects.find(p=>samePath(p.workspaceRoot,folder));if(!target){assertActive();target=await this.client.call('projects.mutate',{type:'project.create',commandId:randomUUID(),projectId:randomUUID(),title,workspaceRoot:folder,scripts:[]});}}
  }
  if(!samePath(target.workspaceRoot,folder))return{status:'incompatible_workspace',message:'T3 can move this conversation only into a project registered to its current folder. Use projectTitle with a distinct name to register that folder. No files or messages were moved.',workspaceRoot:folder,target};
  if(thread.projectId===target.id)return{status:'already_in_project',threadId:thread.id,projectId:target.id,projectTitle:target.title};
  if(busy(thread)&&!a.deferUntilIdle)return{status:'busy',message:'This conversation is working. Retry with deferUntilIdle=true to queue the move without interrupting it.',threadId:thread.id};
  assertActive();
  let op=this.operations.find(o=>o.threadId===thread.id&&o.projectId===target.id&&o.status==='queued');
  if(!op){op={id:randomUUID(),apiVersion:2,threadId:thread.id,threadTitle:thread.title,projectId:target.id,projectTitle:target.title,workspaceRoot:folder,status:'queued',createdAt:new Date().toISOString()};this.operations.push(op);await this.save();}
  if(!busy(thread))await this.move(op);
  return{...op,message:op.status==='completed'?'Moved and verified.':op.status==='failed'?'Move failed: '+op.error:'Move queued until the conversation finishes its current work. Do not claim it is already moved.'};
 }
 async move(op){
  try{
   const p=await this.client.call('orchestration.getThreadProjection',{threadId:op.threadId});if(p.thread.projectId!==op.projectId){if(busy(p.thread)||p.runs.some(r=>activeStatuses.has(r.status))||p.runtimeRequests?.some(r=>r.status==='pending'))return;const result=await this.client.call('projects.createFromThread',{threadId:op.threadId});if(result.projectId!==op.projectId)throw new Error('T3 promoted the conversation into an unexpected project.');}
   const verified=await this.client.call('orchestration.getThreadProjection',{threadId:op.threadId});if(verified.thread.projectId!==op.projectId)throw new Error('T3 did not confirm the project change.');
   Object.assign(op,{status:'completed',completedAt:new Date().toISOString()});
  }catch(e){if(/work in progress|still working|disconnected|timed out|not connected/i.test(e.message)){op.lastError=e.message;await this.save();return;}Object.assign(op,{status:'failed',error:e.message,completedAt:new Date().toISOString()});}
  await this.save();this.onActivity({id:op.id,kind:'tool',title:'t3_workspace',status:op.status==='completed'?'completed':'failed',text:op.status==='completed'?`Moved ${op.threadTitle} into ${op.projectTitle}.`:op.error});
 }
 async drain(){if(this.draining)return;const pending=this.operations.filter(o=>o.status==='queued');if(!pending.length)return;this.draining=true;try{const s=await this.snapshot();for(const op of pending){const thread=[...s.threads,...(s.archivedThreads??[])].find(t=>t.id===op.threadId);if(thread&&!busy(thread))await this.move(op);}}finally{this.draining=false;}}
}
