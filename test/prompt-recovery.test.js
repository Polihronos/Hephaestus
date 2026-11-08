import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {T3Companion} from '../src/t3-companion.js';
import {T3Client} from '../src/t3-client.js';
import {promptHash,writePromptTransaction,readPromptTransaction,clearPromptTransaction} from '../src/prompt-recovery.js';

const oldPrompt='  Previous instructions.\r\nΠαλιές οδηγίες.  ',newPrompt='  New instructions.\r\nЗапази формата.\t ';
const transaction={oldThread:'old-thread',newThread:'new-thread',oldPromptHash:promptHash(oldPrompt),newPromptHash:promptHash(newPrompt)};
async function temporary(run){const dir=await mkdtemp(join(tmpdir(),'hephaestus-prompt-commit-'));try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('prompt recovery chooses the committed new thread, the original thread, or a fresh thread from durable text',()=>temporary(async dir=>{
 await writePromptTransaction(dir,transaction);
 for(const[prompt,selected,threadId]of[[newPrompt,'new','new-thread'],[oldPrompt,'old','old-thread'],['Manual custom instructions','fresh',null],[newPrompt+' ','fresh',null]]){
  const recovered=await readPromptTransaction(dir,prompt);assert.equal(recovered.selected,selected);assert.equal(recovered.threadId,threadId);
 }
 const saved=await readFile(join(dir,'prompt-transaction.json'),'utf8');assert.equal(saved.includes(oldPrompt),false);assert.equal(saved.includes(newPrompt),false);
 await clearPromptTransaction(dir);assert.equal(await readPromptTransaction(dir,newPrompt),null);await clearPromptTransaction(dir);
}));

test('interrupted journal writes do not override the last committed journal',()=>temporary(async dir=>{
 await writePromptTransaction(dir,transaction);const before=await readFile(join(dir,'prompt-transaction.json'),'utf8');
 await writeFile(join(dir,'prompt-transaction.json.tmp'),'{interrupted');assert.equal((await readPromptTransaction(dir,oldPrompt)).selected,'old');
 await rm(join(dir,'prompt-transaction.json.tmp'));await mkdir(join(dir,'prompt-transaction.json.tmp'));
 await assert.rejects(writePromptTransaction(dir,{...transaction,newThread:'another-thread'}));assert.equal(await readFile(join(dir,'prompt-transaction.json'),'utf8'),before);assert.equal((await readPromptTransaction(dir,newPrompt)).threadId,'new-thread');
}));

test('invalid recovery journals fail visibly without rewriting durable instructions',()=>temporary(async dir=>{
 for(const contents of['{broken',JSON.stringify({version:1,oldThread:'old-thread'}),JSON.stringify({...transaction,version:2})]){
  await writeFile(join(dir,'prompt-transaction.json'),contents);await assert.rejects(readPromptTransaction(dir,newPrompt),/interrupted instruction update/);assert.equal(await readFile(join(dir,'prompt-transaction.json'),'utf8'),contents);
 }
}));

async function promptFixture(run){
 return temporary(async dir=>{
  await mkdir(join(dir,'context'));await writeFile(join(dir,'context','AGENTS.md'),oldPrompt+'\n');
  const c=new T3Companion({root:process.cwd(),dataDir:dir});Object.assign(c.state,{connection:'connected',watching:false,running:false,prompt:oldPrompt,spokenReplies:false});c.threadId='native-thread';c.t3ThreadId='old-thread';c.t3ProjectId='project';c.t3TransportReady=true;
  c.t3Runs=new Map();c.t3Attempts=new Map();c.t3Seen=new Map();c.providerNativeIds=new Map();c.providerContexts=new Map();c.interrupt=async()=>({confirmed:true});
  const controls={archives:[],oldStopped:0,newStopped:0,snapshotProcessed:false};c.stopT3Subscription=()=>controls.oldStopped++;
  const client=c.t3=new T3Client();client.socket={readyState:1};
  client.subscribe=(_tag,payload,onValue,onError)=>{
   controls.subscriptionThread=payload.threadId;controls.onValue=onValue;controls.onError=onError;
   queueMicrotask(()=>{if(controls.failSubscription){onError(new Error('New stream unavailable'));return;}onValue({kind:'snapshot',projection:{thread:{id:'new-thread'},runs:[],turnItems:[]}}).then(()=>controls.snapshotProcessed=true);});
   return()=>controls.newStopped++;
  };
  client.call=async(tag,payload)=>{
   if(tag==='orchestration.launchThread'){assert.equal(c.t3ThreadId,'old-thread');return{threadId:'new-thread'};}
   if(payload.type==='thread.archive'){controls.archives.push(payload.threadId);await controls.onArchive?.(payload.threadId);return{};}
   throw new Error('Unexpected fixture transport operation: '+tag);
  };
  await c.save();await c.saveT3();
  try{await run(c,dir,controls);}finally{c.closed=true;clearTimeout(c.reconnectTimer);c.stopT3Subscription?.();await c.saveQueue?.catch(()=>{});await c.t3SaveQueue?.catch(()=>{});}
 });
}

test('a real settings.tmp failure preserves saved settings, old instructions and the active subscription',()=>promptFixture(async(c,dir,controls)=>{
 const settingsPath=join(dir,'settings.json'),before=await readFile(settingsPath,'utf8');await mkdir(join(dir,'settings.tmp'));
 const save=c.save.bind(c);let attempted=false;c.save=async options=>{attempted=true;assert.equal(c.t3ThreadId,'old-thread');assert.equal(controls.oldStopped,0);assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),newPrompt+'\n');return save(options);};
 await assert.rejects(c.configure({prompt:newPrompt,spokenReplies:true}),error=>['EISDIR','EACCES','EPERM'].includes(error.code));
 assert.equal(attempted,true);assert.equal(controls.snapshotProcessed,true);assert.equal(await readFile(settingsPath,'utf8'),before);assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),oldPrompt+'\n');assert.equal(c.state.prompt,oldPrompt);assert.equal(c.state.spokenReplies,false);assert.equal(c.t3ThreadId,'old-thread');assert.equal(controls.oldStopped,0);assert.equal(controls.newStopped,1);assert.deepEqual(controls.archives,['new-thread']);assert.equal(c.state.instructionsSaving,false);assert.equal(await readPromptTransaction(dir,oldPrompt),null);
}));

test('durable settings commit precedes activation and old-thread archival, then the new stream processes its next snapshot',()=>promptFixture(async(c,dir,controls)=>{
 const save=c.save.bind(c),saveT3=c.saveT3.bind(c);let committed=false,metadataAfterCommit=false;
 c.save=async options=>{assert.equal(c.t3ThreadId,'old-thread');assert.equal(controls.oldStopped,0);assert.equal(c.state.prompt,oldPrompt);assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),newPrompt+'\n');await save(options);assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,newPrompt);committed=true;};
 c.saveT3=async()=>{assert.equal(committed,true);assert.equal(c.t3ThreadId,'new-thread');metadataAfterCommit=true;return saveT3();};
 controls.onArchive=async threadId=>{assert.equal(threadId,'old-thread');assert.equal(committed,true);assert.equal(metadataAfterCommit,true);assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,newPrompt);};
 await c.configure({prompt:newPrompt,spokenReplies:true});
 const durable=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));assert.equal(durable.prompt,newPrompt);assert.equal(durable.spokenReplies,true);assert.equal(c.state.prompt,newPrompt);assert.equal(c.t3ThreadId,'new-thread');assert.equal(controls.oldStopped,1);assert.equal(controls.newStopped,0);assert.deepEqual(controls.archives,['old-thread']);assert.equal(await readPromptTransaction(dir,newPrompt),null);
 await controls.onValue({kind:'snapshot',projection:{thread:{id:'new-thread'},runs:[{id:'next-run',status:'completed'}],turnItems:[{id:'next-answer',type:'assistant_message',runId:'next-run',text:'The new conversation is available.',completedAt:'2026-11-08T10:00:00Z'}]}});
 assert.equal(c.messages.at(-1).text,'The new conversation is available.');assert.equal(c.messages.at(-1).at,Date.parse('2026-11-08T10:00:00Z'));assert.equal(c.t3ThreadId,'new-thread');assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,newPrompt);
}));

test('runtime-cache failure after commit retains a journal selecting the durable new prompt and thread',()=>promptFixture(async(c,dir,controls)=>{
 c.saveT3=async()=>{throw new Error('Runtime metadata could not be written');};
 await c.configure({prompt:newPrompt,spokenReplies:true});
 const durable=JSON.parse(await readFile(join(dir,'settings.json'),'utf8')),cache=JSON.parse(await readFile(join(dir,'t3-runtime.json'),'utf8')),recovered=await readPromptTransaction(dir,durable.prompt);
 assert.equal(durable.prompt,newPrompt);assert.equal(durable.spokenReplies,true);assert.equal(c.state.prompt,newPrompt);assert.equal(c.t3ThreadId,'new-thread');assert.equal(cache.threadId,'old-thread');assert.equal(recovered.selected,'new');assert.equal(recovered.threadId,'new-thread');assert.equal(recovered.oldPromptHash,promptHash(oldPrompt));assert.equal(recovered.newPromptHash,promptHash(newPrompt));assert.deepEqual(controls.archives,['old-thread']);assert.equal(controls.oldStopped,1);assert.ok(c.activities.some(item=>item.title==='Instruction recovery'&&/were saved/.test(item.text)));assert.equal(c.state.instructionsSaving,false);
}));

test('a failed new subscription leaves the old prompt, file, settings and subscription untouched',()=>promptFixture(async(c,dir,controls)=>{
 controls.failSubscription=true;const before=await readFile(join(dir,'settings.json'),'utf8');
 await assert.rejects(c.configure({prompt:newPrompt}),/New stream unavailable/);
 assert.equal(await readFile(join(dir,'settings.json'),'utf8'),before);assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),oldPrompt+'\n');assert.equal(c.state.prompt,oldPrompt);assert.equal(c.t3ThreadId,'old-thread');assert.equal(controls.oldStopped,0);assert.equal(controls.newStopped,1);assert.deepEqual(controls.archives,['new-thread']);assert.equal(await readPromptTransaction(dir,oldPrompt),null);assert.equal(c.state.instructionsSaving,false);
}));

test('messages cannot interrupt a prepared instruction transaction while its actual settings commit is pending',()=>promptFixture(async(c,dir,controls)=>{
 const save=c.save.bind(c);let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let interrupted=0;c.interrupt=async()=>{interrupted++;return{confirmed:true};};
 c.save=async options=>{entered();await gate;return save(options);};const update=c.configure({prompt:newPrompt});
 try{
  await waiting;assert.equal(c.state.instructionsSaving,true);assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),newPrompt+'\n');assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,oldPrompt);assert.equal(c.t3ThreadId,'old-thread');
  await assert.rejects(c.submit('A new message'),/Instructions are still being saved/);assert.equal(c.messages.length,0);assert.equal(interrupted,1);assert.equal(controls.oldStopped,0);assert.deepEqual(controls.archives,[]);
 }finally{release();await update;}
 assert.equal(c.state.prompt,newPrompt);assert.equal(c.state.instructionsSaving,false);assert.deepEqual(controls.archives,['old-thread']);
}));
