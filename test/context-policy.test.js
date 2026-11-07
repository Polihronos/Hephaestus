import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Companion,PrivacyBlockedError,dynamicTools} from '../src/companion.js';
import {evaluateNotice,equivalentNotices,normalizeNoticeText} from '../src/notice-policy.js';

const now=Date.now();
const notice={text:'Migration P2022 names User.timezone as missing. Add the timezone column before retrying the migration.',kind:'problem',subject:'Migration P2022 User.timezone',task:'Fix the Prisma migration',taskSource:'conversation',evidence:'Migration P2022 reports missing User.timezone column',action:'Add the timezone column before retrying the migration',rationale:'The Prisma migration is blocked by a schema mismatch',benefit:'Unblocks database migration without retrying a failing command',observationId:'fresh'};
const context={lastUserMessage:{at:now-1000,text:'Fix the Prisma migration'}};
const observation={id:'fresh',capturedAt:now-500};
const evaluate=options=>evaluateNotice({notice,context,observation,now,...options});
const frame=(process='editor',extra={})=>({width:100,height:100,bounds:{x:0,y:0,width:100,height:100},image:'private-image',fingerprint:Buffer.alloc(16).toString('base64'),window:{id:'app',process,title:'Work'},cursor:{x:10,y:10},capturedAt:Date.now(),captureSource:'window',...extra});
function companion(){const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.save=async()=>{};return c;}

test('fresh evidence plus task, action, rationale and benefit permits a useful notice',()=>{
 assert.deepEqual(evaluate(),{status:'shown'});
 const schema=dynamicTools.find(t=>t.name==='companion_notice').inputSchema;
 for(const field of ['rationale','benefit','action','evidence','taskSource'])assert.ok(schema.required.includes(field));
});

test('generic status, hidden actions and ungrounded claims are suppressed',()=>{
 assert.equal(evaluate({notice:{text:'The build completed successfully.'}}).reason,'status-only');
 assert.equal(evaluate({notice:{...notice,text:'The build completed successfully.'}}).reason,'missing-visible-action');
 assert.equal(evaluate({notice:{...notice,benefit:notice.evidence}}).reason,'status-only');
 assert.equal(evaluate({notice:{...notice,action:'Check it'}}).reason,'too-vague');
 assert.equal(evaluate({notice:{...notice,task:'Plan a holiday',rationale:'Flights are cheaper today'}}).reason,'unrelated-task');
});

test('independent work can yield a grounded actionable notice without prior chat',()=>{
 const independent={...notice,taskSource:'screen',task:'Migration User.timezone column'};
 assert.equal(evaluate({notice:independent,context:{}}).status,'shown');
 assert.equal(evaluate({notice:{...independent,task:'Find holiday flights'},context:{}}).reason,'ungrounded-screen-task');
 assert.equal(evaluate({context:{}}).reason,'no-current-task');
});

test('old or replaced observations and stale conversation tasks cannot justify a notice',()=>{
 assert.equal(evaluate({observation:{...observation,capturedAt:now-60000}}).reason,'stale-observation');
 assert.equal(evaluate({notice:{...notice,observationId:'old'}}).reason,'stale-observation');
 assert.equal(evaluate({context:{lastUserMessage:{...context.lastUserMessage,at:now-3*60*60*1000}}}).reason,'no-current-task');
});

test('Unicode normalization and overlap catch repeated meaning beyond English',()=>{
 assert.equal(normalizeNoticeText('  ГРЕШКА: „Миграция“!  '),'грешка миграция');
 assert.equal(equivalentNotices('Η μετανάστευση απέτυχε: λείπει η στήλη timezone. Προσθέστε τη στήλη πριν επαναλάβετε.', 'Η μετανάστευση απέτυχε, λείπει η στήλη timezone — προσθέστε τη στήλη πριν επαναλάβετε!'),true);
 assert.equal(equivalentNotices('Миграцията Prisma блокира: липсва колоната timezone. Добавете колоната преди повторен опит.', 'Добавете колоната timezone преди повторен опит: миграцията Prisma блокира, защото липсва колоната.'),true);
 assert.equal(evaluate({recentNotices:[{text:notice.text.replace('names','reports'),at:now-100000}]}).reason,'repeated-meaning');
 assert.equal(equivalentNotices('Prisma schema migration reports error P2022', 'Prisma schema migration reports error P2002'),false);
});

test('user feedback suppresses disliked subjects and timing controls require no inference',()=>{
 const feedback=[{id:'old',value:'dismiss',subject:notice.subject,text:'Earlier wording',at:now-100000}];
 assert.equal(evaluate({feedback}).reason,'dismissed-subject');
 assert.equal(evaluate({feedback:[{...feedback[0],value:'useful'}]}).status,'shown');
 assert.equal(evaluate({feedback:[...feedback,{...feedback[0],id:'newer',value:'useful',at:now-1000}]}).status,'shown');
 assert.equal(evaluate({snoozeUntil:now+1000}).reason,'snoozed');
 assert.equal(evaluate({enabled:false}).reason,'paused');
 assert.equal(evaluate({lastNoticeAt:now-1000}).reason,'cooldown');
 assert.equal(evaluate({notice:{text:'Please remember to save this result.'},background:false}).status,'shown');
});

test('notice feedback and snooze survive the real settings persistence path',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hephaestus-notice-policy-'));
 try{
  const c=new Companion({root:process.cwd(),dataDir:dir});c.state.watching=false;
  const message=c.message('assistant',notice.text,{source:'noticed',notice});
  await c.configure({excludedApps:['Chrome.EXE','chrome'],noticeSnoozeUntil:now+10000});
  await c.noticeFeedback(message.id,'dismiss');
  let saved=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));
  assert.deepEqual(saved.excludedApps,['chrome']);assert.equal(saved.noticeSnoozeUntil,now+10000);assert.equal(saved.noticeFeedback[0].id,message.id);assert.equal(saved.messages[0].noticeFeedback,'dismiss');
  await c.noticeFeedback(message.id,'useful');saved=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));assert.equal(saved.noticeFeedback.length,1);assert.equal(saved.noticeFeedback[0].value,'useful');
  await assert.rejects(c.noticeFeedback('missing','dismiss'),/not found/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('excluded foreground apps block before capture and remove every previous preview',async()=>{
 const c=companion(),frames=[];c.state.excludedApps=['passwords'];c.latest=frame();c.frames=[c.latest];c.observations.set('old',c.latest);c.on('frame',f=>frames.push(f));c.on('visionFrame',f=>frames.push(f));let captured=0;
 c.bridge={call:async method=>{if(method==='target-info')return{id:'secret',process:'Passwords.exe'};if(method==='capture')captured++;}};
 await assert.rejects(c.observe(),PrivacyBlockedError);assert.equal(captured,0);assert.equal(c.latest,null);assert.equal(c.frames.length,0);assert.equal(c.observations.size,0);assert.ok(frames.every(f=>f===null));assert.equal(c.state.screenPrivacyBlocked,true);assert.match(c.state.screenPrivacyReason,/passwords/);
});

test('a focus change during capture cannot publish an excluded frame',async()=>{
 const c=companion();c.state.excludedApps=['passwords'];let active={id:'app',process:'editor'},captured=0;const seen=[];c.on('visionFrame',f=>seen.push(f));
 c.bridge={call:async method=>{if(method==='target-info')return active;if(method==='capture'){captured++;active={id:'secret',process:'passwords'};return frame();}}};
 await assert.rejects(c.observe(),PrivacyBlockedError);assert.equal(captured,1);assert.equal(seen.filter(Boolean).length,0);assert.equal(c.latest,null);
});

test('monitor capture blocks visible excluded apps and window fallback never reaches a preview',async()=>{
 for(const mode of ['monitor','window']){
  const c=companion();c.state.excludedApps=['passwords'];c.state.captureMode=mode;let captured=0;const seen=[];c.on('frame',f=>seen.push(f));
  c.bridge={call:async method=>{if(method==='target-info')return{id:'app',process:'editor'};if(method==='windows')return[{id:'secret',process:'passwords'}];if(method==='capture'){captured++;return frame('editor',{captureSource:'monitor-fallback'});}}};
  await c.sample();assert.equal(captured,mode==='monitor'?0:1);assert.equal(seen.filter(Boolean).length,0);assert.equal(c.state.screenPrivacyBlocked,true);
 }
});

test('a valid allowed app clears privacy blocking while unknown app identity fails closed',async()=>{
 const c=companion();c.state.excludedApps=['passwords'];let active={id:'unknown',process:''},captured=0;
 c.bridge={call:async method=>{if(method==='target-info')return active;if(method==='capture'){captured++;return frame();}}};
 await assert.rejects(c.observe(),PrivacyBlockedError);assert.equal(captured,0);
 active={id:'app',process:'editor'};const f=await c.safeObservation();assert.equal(f.window.process,'editor');assert.equal(c.state.screenPrivacyBlocked,false);assert.equal(c.state.screenPrivacyReason,null);
});

test('a blocked app permits text-only core requests and sends no image to the model transport',async()=>{
 const c=companion();c.state.connection='connected';c.state.excludedApps=['passwords'];c.threadId='thread';let input,accepted=0;
 c.bridge={call:async method=>{assert.equal(method,'target-info');return{id:'secret',process:'passwords'};}};
 c.rpc={call:async(method,params)=>{assert.equal(method,'turn/start');input=params.input;setImmediate(()=>c.finishTurn?.());return{turn:{id:'turn'}};}};
 await c.turn('Explain database migrations',{onAccepted:()=>accepted++});assert.equal(accepted,1);assert.ok(input.every(item=>item.type!=='image'));assert.equal(c.state.screenPrivacyBlocked,true);
});

test('watching remains available without prior chat but skips excluded apps and snooze before inference',async()=>{
 const c=companion();c.state.connection='connected';c.lastWatchAt=0;c.latest=frame();let turns=0;c.turn=async()=>turns++;c.bridge={call:async()=>({id:'app',process:'editor'})};
 await c.watch();assert.equal(turns,1);c.lastWatchAt=0;await c.watch();assert.equal(turns,1);
 c.lastWatchFingerprint=null;c.state.noticeSnoozeUntil=Date.now()+10000;await c.watch();assert.equal(turns,1);
 c.state.noticeSnoozeUntil=0;c.state.excludedApps=['editor'];await c.watch();assert.equal(turns,1);assert.equal(c.latest,null);
});

test('pausing or snoozing during a pending watcher target check prevents inference',async()=>{
 const c=companion();c.state.connection='connected';c.lastWatchAt=0;c.latest=frame();let resolve,turns=0;c.turn=async()=>turns++;c.bridge={call:()=>new Promise(r=>resolve=r)};
 const pending=c.watch();c.state.noticeSnoozeUntil=Date.now()+10000;resolve({id:'app',process:'editor'});await pending;assert.equal(turns,0);
});

function noticeCompanion({capturedAt=Date.now()}={}){
 const c=companion();Object.assign(c.state,{busy:true,connection:'connected'});c.background=true;c.threadId='thread';c.activeThreadId='thread';c.turnId='turn';c.messages=[{role:'user',text:context.lastUserMessage.text,at:Date.now()}];let captures=0;
 c.bridge={call:async command=>{if(command==='target-info')return{id:'app',process:'editor'};if(command==='capture')return frame('editor',{capturedAt:captures++===0?capturedAt:Date.now()});throw Error(command);}};
 return c;
}
async function submitNotice(c,args){
 let response;await c.onTool({id:'notice-call',method:'item/tool/call',params:{threadId:c.activeThreadId,turnId:c.turnId,tool:'companion_notice',arguments:args}},{reply:(_id,result)=>response=result});
 assert.equal(response.success,true);return JSON.parse(response.contentItems[0].text);
}

test('a notice uses its model-delivered observation despite intervening local previews',async()=>{
 const c=noticeCompanion(),delivered=await c.observe();c.shareModelObservation(delivered);await c.sample();
 assert.notEqual(c.latest.id,delivered.id);assert.equal(c.observations.get(delivered.id),delivered);
 const result=await submitNotice(c,{...notice,observationId:delivered.id});assert.equal(result.status,'shown');assert.equal(c.messages.at(-1).source,'noticed');
});

test('notice without an ID selects the last model-visible image rather than the newest preview',async()=>{
 const c=noticeCompanion(),delivered=await c.observe();c.shareModelObservation(delivered);await c.sample();const{observationId,...withoutId}=notice;
 assert.equal(c.modelObservation().id,delivered.id);assert.notEqual(c.modelObservation().id,c.latest.id);
 assert.equal((await submitNotice(c,withoutId)).status,'shown');
});

test('a fresh local preview never renews expired model evidence with or without an observation ID',async()=>{
 for(const includeId of[true,false]){
  const c=noticeCompanion({capturedAt:Date.now()-60000}),expired=await c.observe();c.shareModelObservation(expired);await c.sample();
  const{observationId,...withoutId}=notice;const args=includeId?{...notice,observationId:expired.id}:withoutId;
  assert.ok(Date.now()-c.latest.capturedAt<1000);assert.equal((await submitNotice(c,args)).reason,'stale-observation');assert.equal(c.messages.filter(m=>m.source==='noticed').length,0);
 }
});

test('unknown, preview-only and captured-but-undelivered IDs cannot justify a notice',async()=>{
 for(const source of['unknown','preview','unseen-observation']){
  const c=noticeCompanion(),delivered=await c.observe();c.shareModelObservation(delivered);await c.sample();
  const id=source==='unknown'?'unknown':source==='preview'?c.latest.id:(await c.observe()).id;
  assert.equal((await submitNotice(c,{...notice,observationId:id})).reason,'stale-observation');
 }
 const c=noticeCompanion();await c.sample();const{observationId,...withoutId}=notice;
 assert.equal((await submitNotice(c,withoutId)).reason,'stale-observation');
});

test('previous-generation model images cannot support either explicit or implicit notice evidence',async()=>{
 for(const includeId of[true,false]){
  const c=noticeCompanion(),delivered=await c.observe();c.shareModelObservation(delivered);c.generation++;c.turnId='new-turn';await c.sample();
  const{observationId,...withoutId}=notice;assert.equal((await submitNotice(c,includeId?{...notice,observationId:delivered.id}:withoutId)).reason,'stale-observation');
 }
});

test('model observation registration requires the retained frame and current generation',async()=>{
 const c=noticeCompanion(),delivered=await c.observe(),generation=c.generation;c.markModelObservation(delivered,{generation});
 assert.equal(c.modelObservation(delivered.id).capturedAt,delivered.capturedAt);
 assert.throws(()=>c.markModelObservation({...delivered}),/no longer available/);
 c.generation++;assert.throws(()=>c.markModelObservation(delivered,{generation}),/interrupted/);assert.equal(c.modelObservation(delivered.id),null);
 c.markModelObservation(delivered);assert.equal(c.modelObservation().id,delivered.id);c.observations.delete(delivered.id);assert.equal(c.modelObservation(delivered.id),null);
});

test('privacy clearing invalidates delivered-image evidence until another image is delivered',async()=>{
 const c=noticeCompanion(),delivered=await c.observe();c.shareModelObservation(delivered);c.clearScreen();await c.sample();const{observationId,...withoutId}=notice;
 assert.equal(c.modelObservation(),null);assert.equal((await submitNotice(c,withoutId)).reason,'stale-observation');
});

test('initial core turn image becomes shared only after acceptance and stays distinct from preview',async()=>{
 const c=noticeCompanion();let dispatched=false,observationId;
 c.rpc={call:async(method,params)=>{
  assert.equal(method,'turn/start');const metadata=JSON.parse(params.input.find(item=>item.type==='text'&&item.text.includes('screen_observation')).text);
  observationId=metadata.observationId;assert.equal(c.modelObservation(),null);await c.sample();assert.notEqual(c.latest.id,metadata.observationId);dispatched=true;setImmediate(()=>c.finishTurn?.());return{turn:{id:'model-turn'}};
 }};
 await c.turn('Fix the Prisma migration');assert.equal(dispatched,true);assert.equal(c.modelObservation().id,observationId);
});

test('capturing or building a payload never changes the last shared image',async()=>{
 const c=noticeCompanion(),shared=[];c.on('visionFrame',frame=>shared.push(frame));
 const first=await c.observe();assert.equal(c.state.lastVisionAt,undefined);assert.equal(shared.length,0);
 c.shareModelObservation(first);const next=await c.observe();c.frameContent(next);
 assert.deepEqual(shared,[first]);assert.equal(c.modelObservation().id,first.id);
});

test('failed direct transport leaves the prior shared image and evidence intact',async()=>{
 const c=noticeCompanion(),first=await c.observe(),shared=[];c.shareModelObservation(first);c.on('visionFrame',frame=>shared.push(frame));
 c.rpc={call:async()=>{throw new Error('Transport rejected the turn');}};
 await assert.rejects(c.turn('Read this screen'),/Transport rejected/);
 assert.equal(shared.length,0);assert.equal(c.modelObservations.has(first.id),true);
 assert.equal(c.lastModelObservationId,first.id);
});

test('paused, excluded or interrupted delivery never restores a hidden shared image',async()=>{
 for(const block of[c=>c.generation++,c=>c.state.watching=false,c=>c.state.excludedApps=['editor'],c=>c.clearScreen()]){
  const c=noticeCompanion(),frame=await c.observe(),generation=c.generation,shared=[];block(c);c.on('visionFrame',frame=>shared.push(frame));
  assert.equal(c.shareModelObservation(frame,{generation}),false);assert.equal(shared.length,0);assert.equal(c.modelObservation(frame.id),null);
 }
});

test('tool images become shared only after their result reaches the reply transport',async()=>{
 for(const fail of[false,true]){
  const c=noticeCompanion(),shared=[];c.on('visionFrame',frame=>shared.push(frame));
  await c.onTool({id:'observe',method:'item/tool/call',params:{threadId:c.threadId,turnId:c.turnId,tool:'screen_observe',arguments:{}}},{reply:()=>{assert.equal(shared.length,0);if(fail)throw new Error('Transport closed');}});
  assert.equal(shared.length,fail?0:1);assert.equal(c.modelObservation()?.id??null,fail?null:shared[0].id);
 }
});
