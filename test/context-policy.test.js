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
