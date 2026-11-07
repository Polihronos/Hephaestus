import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const errorText=error=>String(error?.message??error).replace(/Bearer\s+[\w.-]+/gi,'Bearer [redacted]').slice(0,700);

// Real app windows and native focus; text insertion and the submission boundary
// are simulated. The stub never creates assistant replies or accepted history.
export async function wisprRouteCheck({dashboard,mascot,companion:c,root,wisprKey,showDashboard,app}){
 const out=join(root,'artifacts','route-check'),started=Date.now(),deadline=started+60000;
 const marker='ROUTE-'+randomUUID().slice(0,8).toUpperCase();
 const report={at:new Date(started).toISOString(),marker,success:false,checks:[],submissions:[],screenshots:[],
  simulation:{textInsertion:'Synthetic paste/input events in production editors',submission:'Stub at companion.submit, with explicit onAccepted on success and a deliberate rejection for failure recovery'},
  limitations:['No human speech, Wispr transcription engine, model response, or token-accounting behaviour is verified.','Successful stub submissions are captured only in this report; no assistant reply or accepted conversation message is fabricated.'],nativeFocus:[]};
 let isolated=false,phase='isolation',previous,originalSubmit,releaseHold=null,activeCalls=0,mode='hold';
 const calls=[],newMessages=[];
 const messageListener=message=>newMessages.push({id:message.id,role:message.role,source:message.source,delivery:message.delivery});
 function check(id,name,ok,evidence={}){report.checks.push({id,name,passed:!!ok,evidence});assert.ok(ok,name);console.log('ROUTE_CHECK '+id+' passed');}
 async function bounded(promise,timeout,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{const remaining=Math.min(timeout,deadline-Date.now());if(remaining<=0)return reject(new Error('Route verification exceeded its deadline'));timer=setTimeout(()=>reject(new Error(label)),remaining);})]);}finally{clearTimeout(timer);}}
 async function until(condition,timeout,label){const end=Math.min(deadline,Date.now()+timeout);while(Date.now()<end){const value=await condition();if(value)return value;await sleep(Math.min(50,Math.max(1,end-Date.now())));}throw new Error(label);}
 async function stable(condition,duration,label){const end=Math.min(deadline,Date.now()+duration);while(Date.now()<end){assert.ok(await condition(),label);await sleep(Math.min(50,Math.max(1,end-Date.now())));}}
 const exec=(window,code)=>bounded(window.webContents.executeJavaScript(code),4000,'A verification window did not answer during '+phase);
 const sprite=()=>exec(mascot,'window.hephaestusSpriteInspect()');
 const dash=()=>exec(dashboard,'window.hephaestusDashboardInspect()');
 const windowId=window=>{const handle=window.getNativeWindowHandle();return(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();};
 async function focus(window){window.showInactive();window.focus();const id=windowId(window);const result=await c.bridge.call('focus-own',{windowId:id});assert.equal(result.focused,true,'Windows did not focus the app-owned verification window');return id;}
 async function nativeEditorFocus(window,editorId){
  const expected=windowId(window),at=Date.now();
  const diagnostic={phase,editorId,expectedWindowId:expected,timeoutMs:2000,nativeCacheMs:180,settled:false,observations:[]};
  report.nativeFocus.push(diagnostic);
  try{
   const native=await until(async()=>{
    const probe=await bounded(c.bridge.call('focus-probe',{},600),700,'The native focus probe did not answer');
    diagnostic.observations.push({elapsedMs:Date.now()-at,windowId:probe.windowId,nativeWindowMatches:probe.windowId===expected,editable:probe.editable});
    return probe.windowId===expected&&probe.editable===true?probe:false;
   },2000,'The native '+editorId+' editor did not receive editable focus within two seconds');
   diagnostic.settled=true;diagnostic.settledMs=Date.now()-at;return native;
  }catch(error){diagnostic.failure=errorText(error);throw error;}
 }
 async function insert(window,id,text){return exec(window,`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.dispatchEvent(new Event('paste',{bubbles:true}));input.value=${JSON.stringify(text)};input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:${JSON.stringify(text)}}));return {active:document.activeElement?.id,value:input.value};})()`);}
 async function armHidden(){await wisprKey({phase:'cancel'});await exec(mascot,`document.getElementById('wispr-input').value=''`);await focus(mascot);await wisprKey({phase:'start',at:Date.now()});await until(async()=>{const view=await sprite();return view.input.armed&&await exec(mascot,`document.activeElement?.id==='wispr-input'`);},4000,'The real hidden editor did not arm');await nativeEditorFocus(mascot,'wispr-input');}
 async function capture(name){assert.equal(c.state.watching,false);assert.equal(c.state.backgroundVision,false);await exec(dashboard,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await writeFile(join(out,name),(await dashboard.webContents.capturePage()).toPNG());report.screenshots.push(name);}
 try{
  const expected=await realpath(resolve(root,'runtime','route-verification'));
  const actual=await realpath(c.dataDir),same=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
  assert.ok(same(actual,expected),'Route verification requires runtime/route-verification; no normal profile may be modified');
  if(app)assert.ok(same(await realpath(app.getPath('userData')),expected),'The production windows must also use the isolated route profile');
  isolated=true;await mkdir(out,{recursive:true});
  check('isolated-profile','Settings, failed input, and window storage use only the dedicated verification profile',true,{directory:'runtime/route-verification'});
  previous=Object.fromEntries(['inputMode','running','autoSend','watching','backgroundVision','proactive','spokenReplies','control'].map(key=>[key,c.state[key]]));
  assert.equal(previous.inputMode,'wispr','The route profile must start with microphone capture disabled');
  assert.equal(previous.watching,false,'The route profile must start without sharing');
  assert.equal(previous.backgroundVision,false,'The route profile must start without background vision');
  assert.equal(previous.proactive,false,'The route profile must start without proactive requests');
  assert.equal(previous.spokenReplies,false,'The route profile must start without speech playback');
  assert.ok(!c.state.busy&&!c.t3InFlight,'The isolated route profile must start idle');
  await c.configure({inputMode:'wispr',running:true,autoSend:true,watching:false,backgroundVision:false,proactive:false,spokenReplies:false,control:false});
  originalSubmit=c.submit;c.on('message',messageListener);
  c.submit=async(text,options={})=>{
   activeCalls++;const call={text,source:options.source,mode,onAccepted:typeof options.onAccepted==='function',acknowledged:false};calls.push(call);
   try{if(mode==='failure')throw new Error('Simulated route-check submission failure');if(mode==='hold')await new Promise(resolve=>{releaseHold=resolve;});assert.equal(typeof options.onAccepted,'function','The actual IPC must supply the dispatch acknowledgement');options.onAccepted();call.acknowledged=true;}
   finally{activeCalls--;}
  };
  assert.equal((await sprite()).voice.microphoneActive,false,'The microphone was open before route verification');

  phase='armed-hidden-insertion';
  const acceptedText=`  Simulated route-check insertion ${marker}.\nSecond line: точен текст.  \n`;
  await armHidden();await insert(mascot,'wispr-input',acceptedText);
  await until(()=>calls.length===1,4000,'Armed insertion did not reach the submission boundary');
  check('hidden-exact-once','Native hidden input dispatches exact simulated text once and waits for acknowledgement',calls[0].text===acceptedText&&calls[0].source==='wispr'&&calls[0].onAccepted&&c.state.sendPending===true&&activeCalls===1,{nativeEditableFocus:true,characters:acceptedText.length,sha256:hash(acceptedText),source:calls[0].source});
  await insert(mascot,'wispr-input',acceptedText);await insert(mascot,'wispr-input',acceptedText);
  await stable(()=>calls.length===1,400,'Duplicate insertion dispatched another submission');
  releaseHold();releaseHold=null;
  await until(async()=>{const view=await sprite();return !c.state.sendPending&&!view.input.submitting&&!view.input.armed&&view.input.value==='';},4000,'Acknowledged input did not clear and disarm');
  check('acknowledged-once','The stub acknowledges the actual IPC and clears only the accepted hidden input',calls.length===1&&calls[0].acknowledged&&newMessages.length===0,{acceptedHistoryCreated:0,assistantRepliesCreated:0});
  const unarmedText='Simulated unarmed insertion '+marker;
  await insert(mascot,'wispr-input',unarmedText);await stable(()=>calls.length===1,400,'Unarmed insertion reached submit');
  const guard=await exec(mascot,`window.companion.request('send',{source:'wispr',text:${JSON.stringify(unarmedText)}}).then(()=>({rejected:false}),()=>({rejected:true}))`);
  check('unarmed-blocked','Unarmed editor events and direct Wispr IPC cannot dispatch',guard.rejected&&calls.length===1&&newMessages.length===0);

  phase='failed-hidden-recovery';mode='failure';
  const failedText=`  Simulated failed dictation ${marker}.\nKeep every character: Ω, текст, and trailing spaces.  \n`;
  await armHidden();await insert(mascot,'wispr-input',failedText);
  const failed=await until(()=>c.messages.find(message=>message.role==='user'&&message.source==='wispr'&&message.text===failedText&&message.delivery==='failed'),4000,'The production error path did not retain the exact intentional input');
  await until(async()=>{const view=await sprite();return view.input.value===''&&!view.input.armed&&!view.input.submitting&&!c.state.sendPending;},4000,'The persisted recovery did not clear the hidden input');
  await until(()=>exec(dashboard,`(()=>{const rows=[...document.querySelectorAll('[data-message-id]')].filter(row=>row.dataset.messageId===${JSON.stringify(failed.id)});return rows.length===1&&rows[0].classList.contains('delivery-failed')&&rows[0].textContent.includes('Not sent')&&!!rows[0].querySelector('.message-actions button');})()`),4000,'The recovered failed input did not appear once in the real dashboard');
  const saved=JSON.parse(await readFile(join(c.dataDir,'settings.json'),'utf8'));
  await insert(mascot,'wispr-input',failedText);await stable(()=>calls.length===2&&c.messages.filter(message=>message.text===failedText&&message.delivery==='failed').length===1,400,'Recovered input created a duplicate failed record');
  check('failure-recovered-once','Production IPC persists exact failed input once and exposes real dashboard recovery',calls.length===2&&calls[1].text===failedText&&!calls[1].acknowledged&&c.messages.filter(message=>message.text===failedText).length===1&&saved.messages.filter(message=>message.id===failed.id&&message.text===failedText&&message.delivery==='failed').length===1,{messageId:failed.id,characters:failedText.length,sha256:hash(failedText),delivery:'failed',dashboardRows:1});
  await capture('failed-input-recovery.png');

  phase='manual-review-route';mode='success';await wisprKey({phase:'cancel'});
  await c.configure({autoSend:false});await exec(dashboard,`(()=>{const input=document.getElementById('dashboard-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return window.companion.request('dismiss-error');})()`);
  await focus(mascot);await wisprKey({phase:'start',at:Date.now()});
  await until(async()=>{const view=await dash();return view.input.armed&&await exec(dashboard,`document.activeElement?.id==='dashboard-input'`);},4000,'Review-first dictation did not focus the real dashboard composer');
  const dashboardNative=await nativeEditorFocus(dashboard,'dashboard-input');
  assert.ok(dashboardNative.windowId===windowId(dashboard)&&dashboardNative.editable===true,'Review-first mode did not focus the native dashboard editor');
  const reviewText=`  Simulated review-first text ${marker}.\nReview before sending.  `;
  await insert(dashboard,'dashboard-input',reviewText);
  await stable(async()=>calls.length===2&&(await dash()).input.value===reviewText,400,'Review-first text submitted automatically or changed');
  check('review-before-send','Review-first mode focuses the real editor and preserves exact text without sending',calls.length===2&&(await dash()).input.value===reviewText,{nativeEditableFocus:true,characters:reviewText.length,sha256:hash(reviewText)});
  await capture('manual-review.png');
  await exec(dashboard,`(()=>{const button=document.getElementById('send');if(button.disabled)throw new Error('The real manual Send button is disabled');button.click();})()`);
  await until(async()=>calls.length===3&&calls[2].acknowledged&&!(await dash()).input.value&&!c.state.sendPending,4000,'The acknowledged manual submission did not finish');
  check('manual-send-once','The real Send button dispatches reviewed text once without fabricated history',calls[2].text===reviewText&&calls[2].source==='text'&&calls[2].acknowledged&&newMessages.length===1&&newMessages[0].id===failed.id&&newMessages.every(message=>message.role==='user'&&message.delivery==='failed'),{source:calls[2].source,acceptedHistoryCreated:0,newUserFailures:newMessages.length,newAssistantReplies:0});
  check('microphone-final','The real microphone stayed closed and replies stayed silent',!(await sprite()).voice.microphoneActive&&c.state.inputMode==='wispr'&&!c.state.spokenReplies);
  report.success=true;
 }catch(error){report.failure={phase,message:errorText(error)};console.error('ROUTE_CHECK failed: '+errorText(error));}
 finally{
  if(isolated){
   try{
    await wisprKey({phase:'cancel'});if(releaseHold){releaseHold();releaseHold=null;}
    const cleanupEnd=Date.now()+4000;while(Date.now()<cleanupEnd&&(activeCalls||c.state.sendPending))await sleep(50);
    await exec(mascot,`document.getElementById('wispr-input').value=''`);
    await exec(dashboard,`(()=>{const input=document.getElementById('dashboard-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    if(originalSubmit)c.submit=originalSubmit;
    c.off('message',messageListener);
    if(previous)await c.configure({...previous,inputMode:'wispr',watching:false,backgroundVision:false,proactive:false,spokenReplies:false});
    await wisprKey({phase:'cancel'});await showDashboard('companion');
    report.finalState={submitRestored:!originalSubmit||c.submit===originalSubmit,pending:c.state.sendPending===true,activeStubCalls:activeCalls,hiddenArmed:(await sprite()).input.armed,microphoneActive:(await sprite()).voice.microphoneActive,watching:c.state.watching,backgroundVision:c.state.backgroundVision,proactive:c.state.proactive};
    if(!report.finalState.submitRestored||report.finalState.pending||activeCalls||report.finalState.hiddenArmed||report.finalState.microphoneActive||report.finalState.watching||report.finalState.backgroundVision||report.finalState.proactive)throw new Error('The isolated verification did not finish cleanly');
   }catch(error){report.cleanupError=errorText(error);report.success=false;}
   finally{if(originalSubmit)c.submit=originalSubmit;c.off('message',messageListener);}
  }
  report.submissions=calls.map(call=>({mode:call.mode,source:call.source,characters:call.text.length,sha256:hash(call.text),acknowledged:call.acknowledged}));
  report.elapsedMs=Date.now()-started;
  await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  console.log('ROUTE_CHECK_RESULT '+JSON.stringify({success:report.success,checks:report.checks.map(({id,passed})=>({id,passed})),failure:report.failure,cleanupError:report.cleanupError,report:'artifacts/route-check/report.json'}));
 }
 return report.success;
}
