import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenLedger} from '../src/token-ledger.js';
import {Pricing} from '../src/pricing.js';
import {T3Companion} from '../src/t3-companion.js';
import {Companion} from '../src/companion.js';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Luna API value separates cached input and includes reasoning only within output',()=>{
 const p=new Pricing(),cost=p.cost({inputTokens:1000000,cachedInputTokens:800000,outputTokens:100000,reasoningOutputTokens:30000},'gpt-6-luna',100000);
 assert.ok(Math.abs(cost.usd-0.078)<1e-10);assert.ok(Math.abs(cost.cacheSavingsUsd-0.072)<1e-10);assert.equal(p.cost({inputTokens:1,outputTokens:1},'unknown'),null);
 const writes=p.cost({inputTokens:1000000,cachedInputTokens:800000,cacheCreationTokens:100000,outputTokens:100000},'gpt-6-luna',100000);assert.ok(Math.abs(writes.usd-0.0805)<1e-10);
});
test('app-server message history restores screen-check purpose and tool attribution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'heph-backfill-'));try{await mkdir(join(dir,'sessions'));const rows=[{type:'session_meta',payload:{id:'owned',originator:'screen_companion'}},{type:'turn_context',payload:{model:'gpt-6-luna'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'{"event":"screen_update","proactive":true}'}]}},{type:'response_item',payload:{type:'function_call',name:'companion_notice'}},{type:'event_msg',timestamp:'2026-11-07T10:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:40,total_tokens:1040}}}}];await writeFile(join(dir,'sessions/owned.jsonl'),rows.map(JSON.stringify).join('\n'));const l=new TokenLedger(join(dir,'data'));await l.importHistory(dir);const e=l.report().entries[0];assert.equal(e.purpose,'screen refresh');assert.equal(e.model,'gpt-6-luna');assert.deepEqual(e.tools,['companion_notice']);assert.equal(e.at,'2026-11-07T10:00:00Z');assert.equal(l.report().totals.totalTokens,1040);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a resumed token snapshot preserves the original model, time and purpose',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'heph-resume-'));try{const ledger=new TokenLedger(dir);const usage={inputTokens:1000,outputTokens:40,totalTokens:1040};ledger.record('thread',usage,{at:'2026-11-06T10:00:00Z',model:'gpt-6.1-sol',purpose:'conversation'});const c=new Companion({root:process.cwd(),dataDir:dir});c.ledger=ledger;c.state.model='gpt-6-luna';c.onNotification({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:usage}}});const e=ledger.report().entries[0];assert.equal(e.at,'2026-11-06T10:00:00Z');assert.equal(e.model,'gpt-6.1-sol');assert.equal(ledger.summary().totalTokens,1040);await ledger.flush();}finally{await rm(dir,{recursive:true,force:true});}
});
test('a T3 reply receives recent proactive observations from the lightweight watcher',async()=>{
 const c=new T3Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',watching:false});c.hasT3History=true;c.t3ThreadId='thread';c.messages=[{id:'notice',role:'assistant',source:'noticed',text:'The build finished.',at:1}];let sent;c.t3={call:async(_tag,p)=>{sent=p;queueMicrotask(()=>c.t3Finish?.());return{};}};await c.turn('What finished?');assert.ok(sent.text.startsWith('What finished?'));assert.ok(sent.text.includes('The build finished.'));assert.ok(sent.text.includes('recent_companion_observations'));
});
test('usage history keeps dates, purpose, tools and model without counting repeated turn updates twice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'heph-details-'));try{const ledger=new TokenLedger(dir);const first={inputTokens:1000,cachedInputTokens:800,outputTokens:100,totalTokens:1100},second={inputTokens:2000,cachedInputTokens:1000,outputTokens:200,totalTokens:2200};
 ledger.recordTurn('native','one',first,{at:'2026-11-06T12:00:00Z',ordinal:1,model:'gpt-6-luna',purpose:'conversation',request:'Open a tab',tools:['screen_action'],contextTokens:1000});ledger.recordTurn('native','one',first,{at:'2026-11-06T12:00:00Z',ordinal:1,model:'gpt-6-luna',purpose:'conversation'});ledger.recordTurn('native','two',second,{at:'2026-11-07T12:00:00Z',ordinal:2,model:'gpt-6-luna',purpose:'screen refresh'});
 assert.equal(ledger.summary().totalTokens,3300);assert.equal(ledger.report({purpose:'screen refresh'}).totals.totalTokens,2200);assert.equal(ledger.report({since:'2026-11-07T00:00:00Z'}).entries.length,1);assert.equal(ledger.report().byDay.length,2);
 await ledger.flush();const resumed=new TokenLedger(dir);await resumed.load();assert.equal(resumed.summary().totalTokens,3300);assert.equal(resumed.report().entries.length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('T3 preserves the subscription allowance guard before sending requests',async()=>{
 const c=new T3Companion({root:process.cwd(),dataDir:process.cwd()});c.state.usage={primary:{usedPercent:100}};let sent=false;c.t3={call:()=>{sent=true;}};await assert.rejects(()=>c.turn('Hello'),/allowance is used up/);assert.equal(sent,false);
});
test('proactive off keeps the local preview but does not start background inference',async()=>{
 const c=new T3Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{proactive:false,connection:'connected'});c.latest={fingerprint:Buffer.alloc(16).toString('base64')};c.lastWatchAt=0;let turns=0;c.turn=async()=>turns++;await c.watch();assert.equal(turns,0);assert.equal(c.state.watching,true);
});
test('editing the T3 prompt writes exactly one visible instruction and starts fresh context',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'heph-prompt-'));try{await mkdir(join(dir,'context'));const c=new T3Companion({root:process.cwd(),dataDir:dir});c.interrupt=async()=>{};c.t3ThreadId='old';c.t3ProjectId='project';c.state.prompt='Old prompt';const commands=[];c.t3={call:async(tag,p)=>{commands.push({tag,p});return{threadId:'new'};},subscribe:()=>()=>{}};await c.replacePrompt('My exact instructions.');assert.equal(await readFile(join(dir,'context','AGENTS.md'),'utf8'),'My exact instructions.\n');assert.equal(c.t3ThreadId,'new');assert.ok(commands.some(x=>x.p.type==='thread.archive'&&x.p.threadId==='old'));assert.equal(c.hasT3History,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
