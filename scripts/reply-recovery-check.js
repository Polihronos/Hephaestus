import assert from 'node:assert/strict';
import {realpath,readFile,writeFile,lstat,open,rename,unlink} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=new Set(['completed','failed','cancelled','interrupted','rolled_back']);

// Deterministic synthetic controller/event replays in the real windows. These
// fixtures are not live model responses, provider cancellation, or human input.
export async function verifyReplyRecovery({root,companion:c,dashboard,bubble,app,showDashboard,out}){
 const deadline=Date.now()+30000;let phase='isolation',phaseDeadline=deadline-9000,original,failure,submitAttempts=0,dispatchAttempts=0,nativeAttempts=0,ownedWindowFocusCalls=0,nativeMetadataCalls=0;
 const checks=[],screenshots=[],hooks=[],events=[];const id='REPLY-REPLAY-'+randomUUID(),hash=b=>createHash('sha256').update(b).digest('hex');
 const bounded=async task=>{const ms=Math.min(4000,phaseDeadline-Date.now());assert.ok(ms>0,'Reply replay timed out during '+phase);let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Reply replay timed out during '+phase)),ms);})]);}finally{clearTimeout(timer);}};
 const until=async(predicate,message)=>{const end=Math.min(phaseDeadline,Date.now()+4000);while(Date.now()<end){const value=await bounded(predicate);if(value)return value;await delay(50);}throw new Error(message);};
 const ui=source=>bounded(()=>dashboard.webContents.executeJavaScript(source)),popup=source=>bounded(()=>bubble.webContents.executeJavaScript(source));
 const frames=()=>ui('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const rootReal=await bounded(()=>realpath(root)),expected=join(rootReal,'runtime','quality-verification');
 const [dataReal,expectedReal,userDataReal,outReal,artifactsReal]=await bounded(()=>Promise.all([realpath(c.dataDir),realpath(expected),realpath(app.getPath('userData')),realpath(out),realpath(join(rootReal,'artifacts'))]));
 assert.ok(samePath(expectedReal,expected)&&samePath(dataReal,expectedReal)&&samePath(userDataReal,expectedReal),'Reply replay requires the exact real quality profile and app userData');
 const artifactPath=relative(artifactsReal,outReal);assert.ok(!isAbsolute(artifactPath)&&artifactPath!=='..'&&!artifactPath.startsWith('..\\')&&!artifactPath.startsWith('../'),'Reply screenshots must remain inside owned artifacts');
 const guard=async()=>assert.ok(samePath(await realpath(c.dataDir),dataReal)&&samePath(await realpath(app.getPath('userData')),dataReal),'Reply replay profile changed identity');
 const flush=async()=>{for(let pass=0;pass<3;pass++){await bounded(()=>Promise.all([c.configureQueue,c.saveQueue,c.t3SaveQueue,c.t3StopPersistencePromise].filter(Boolean).map(p=>p.catch(()=>{}))));await new Promise(resolve=>setImmediate(resolve));}};
 const reload=async(window,ready)=>{
  let loaded,failed;try{await bounded(()=>new Promise((resolve,reject)=>{loaded=resolve;failed=(_event,code,description,_url,mainFrame)=>{if(mainFrame)reject(new Error('Owned renderer reload failed: '+code+' '+description));};window.webContents.once('did-finish-load',loaded);window.webContents.on('did-fail-load',failed);window.webContents.reload();}));}
  finally{if(loaded)window.webContents.off('did-finish-load',loaded);if(failed)window.webContents.off('did-fail-load',failed);}
  await until(()=>bounded(()=>window.webContents.executeJavaScript(ready)),'The owned reply renderer did not initialize');
 };
 const snapshot=async(name,window=dashboard)=>{const path=join(outReal,name);let prior;try{prior=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(!prior||prior.isFile()&&!prior.isSymbolicLink(),'Reply screenshot target is not a regular artifact');await bounded(()=>window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'));const image=await bounded(()=>window.webContents.capturePage());await bounded(()=>writeFile(path,image.toPNG()));screenshots.push(name);};
 const hook=(object,key,replacement)=>{const descriptor=Object.getOwnPropertyDescriptor(object,key);hooks.push(()=>{if(descriptor)Object.defineProperty(object,key,descriptor);else delete object[key];});object[key]=replacement;};
 const event=(type,payload)=>c.t3Stream({kind:'event',event:{type,payload}});
 const restoreFile=async file=>{
  await guard();const info=await lstat(file.path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&samePath(await realpath(file.path),file.path),'Reply restoration file is no longer a regular isolated file');
  if((await readFile(file.path)).equals(file.bytes))return;
  const tmp=file.path+'.'+id+'.tmp';let handle,identity;
  try{handle=await open(tmp,'wx');identity=await handle.stat();await handle.writeFile(file.bytes);await handle.close();handle=null;await rename(tmp,file.path);}
  finally{await handle?.close();let current;try{current=await lstat(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}if(current){assert.ok(identity&&current.isFile()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino,'Reply restoration temporary file changed identity');await unlink(tmp);}}
 };
 const listeners=[];for(const name of['delta','message','speechFlush','speak'])listeners.push([name,data=>events.push({name,data})]);
 try{
  phase='baseline';await flush();
  assert.ok(c.state.connection==='connected'&&!c.state.busy&&!c.state.stopping&&!c.state.sendPending&&!c.t3InFlight&&!c.t3Outstanding&&!c.t3StopIntent&&!c.state.instructionsSaving&&!c.updatingPrompt&&!c.confirmation&&![...c.t3Runs.values()].some(run=>!terminal.has(run.status)),'Reply replay requires a genuinely idle controller');
  assert.ok(c.state.watching===false&&c.state.backgroundVision===false&&c.state.proactive===false&&c.state.inputMode==='wispr'&&c.state.spokenReplies===false&&!c.state.listening&&!c.state.dictating,'Reply replay requires capture, proactivity, microphone and playback paused');
  const files=[];for(const name of['settings.json','t3-runtime.json']){const path=join(dataReal,name),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&samePath(await realpath(path),path),'Reply replay files must be regular owned files');files.push({path,bytes:await readFile(path)});}
  original={descriptors:Object.getOwnPropertyDescriptors(c),files,bubbleVisible:bubble.isVisible(),popup:await popup(`({mode:document.querySelector('#bubble-mode').textContent,text:window.hephaestusBubbleInspect().renderedText})`),view:await ui(`({page:window.hephaestusDashboardInspect().page,draft:document.querySelector('#dashboard-input').value,prompt:document.querySelector('#prompt').value,privacy:document.querySelector('#excluded-apps').value,expanded:document.querySelector('#toggle-screen').getAttribute('aria-expanded'),top:document.querySelector('#answers').scrollTop,following:window.hephaestusDashboardInspect().following,focus:document.activeElement.id})`)};
  c.state={...c.state};c.messages=structuredClone(c.messages);c.activities=structuredClone(c.activities);
  for(const key of['t3Runs','t3Seen','t3Attempts','t3ProviderTurns','providerNativeIds','providerContexts'])c[key]=new Map(c[key]??[]);
  for(const key of['ignoredT3Runs','ignoredTurns'])c[key]=new Set(c[key]??[]);
  c.t3Finish=null;c.t3PendingAcceptance=null;
  hook(c,'submit',async()=>{submitAttempts++;throw new Error('Reply replay blocks all submissions');});
  for(const client of[c.t3,c.rpc])if(client?.call){const call=client.call;hook(client,'call',function(tag,payload,...rest){if(/dispatch|launch|mutate/i.test(tag)||['turn/start','thread/start','thread/resume','thread/inject_items'].includes(tag)){dispatchAttempts++;return Promise.reject(new Error('Reply replay blocks provider dispatch'));}return Reflect.apply(call,this,[tag,payload,...rest]);});}
  if(c.bridge?.call){
   const call=c.bridge.call,windowId=window=>{const handle=window.getNativeWindowHandle();return(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();};
   hook(c.bridge,'call',function(method,...args){
    const params=args[0],ownFocus=method==='focus-own'&&args.length===1&&params&&Object.keys(params).length===1&&typeof params.windowId==='string'&&[dashboard,bubble].some(window=>!window.isDestroyed()&&windowId(window)===params.windowId);
    if(ownFocus)ownedWindowFocusCalls++;else if(method==='monitors')nativeMetadataCalls++;else{nativeAttempts++;return Promise.reject(new Error('Reply replay blocks native capture, external focus and actions'));}
    return Reflect.apply(call,this,[method,...args]);
   });
  }
  for(const[name,listener]of listeners)c.on(name,listener);
  await bounded(()=>showDashboard('companion'));
  const addUser=(suffix,text)=>{const message={id:id+'-'+suffix,role:'user',text,at:Date.now(),source:'verification-fixture',delivery:'sent',t3MessageId:id+'-remote-'+suffix};c.messages.push(message);c.emit('messagesRestored',c.messages);return message;};

  phase='stopped partial replay';
  const stoppedUser=addUser('partial-user','[Synthetic reply-recovery fixture] A confirmed stopped partial reply.'),run={id:id+'-partial-run',userMessageId:stoppedUser.t3MessageId,status:'running',request:stoppedUser.text};
  c.beginExternalRun(run);const partial={id:id+'-partial-item',runId:run.id,type:'assistant_message',streaming:true,text:'[Synthetic reply-recovery fixture] This partial text must remain after the replayed Stop confirmation.',startedAt:new Date().toISOString()};event('turn-item.updated',partial);
  c.t3StopIntent={threadId:c.t3ThreadId,messageId:stoppedUser.t3MessageId,runId:run.id,accepted:true,sent:true,requestedAt:Date.now()};c.ignoredT3Runs.add(run.id);c.desktopActionsRevoked=true;c.publish({busy:true,stopping:true});
  const stopped={thread:{id:c.t3ThreadId,activeRunId:null},runs:[{...run,status:'interrupted'}],messages:[],turnItems:[partial],attempts:[],providerThreads:[],providerTurns:[]};c.t3Stream({kind:'snapshot',projection:stopped});c.t3Stream({kind:'snapshot',projection:stopped});await flush();await frames();
  const retained=c.messages.filter(message=>message.providerItemId===partial.id);assert.equal(retained.length,1);assert.equal(retained[0].text,partial.text);assert.equal(retained[0].interrupted,true);assert.ok(!c.state.busy&&!c.state.stopping&&!c.t3StopIntent);
  assert.equal(JSON.parse(await readFile(join(dataReal,'settings.json'),'utf8')).messages.find(message=>message.id===retained[0].id)?.interrupted,true,'The replayed partial was not saved in the isolated profile');
  c.emit('responseStart',{generation:++c.generation});await reload(dashboard,'window.hephaestusDashboardInspect?.().initialized');await bounded(()=>showDashboard('companion'));await frames();
  const retainedView=await ui(`(()=>{const rows=[...document.querySelectorAll('[data-message-id]')].filter(row=>row.dataset.messageId===${JSON.stringify(retained[0].id)});return {count:rows.length,badge:rows[0]?.querySelector('.interrupted-state')?.textContent,text:rows[0]?.textContent,draftHidden:document.querySelector('#reply-draft').hidden};})()`);
  assert.ok(retainedView.count===1&&retainedView.badge==='Interrupted'&&retainedView.text.includes(partial.text)&&retainedView.draftHidden,'The stopped partial did not survive as one ordinary interrupted row');
  checks.push('A replayed stopped partial survives responseStart and renderer reload as one Interrupted row');await snapshot('reply-recovery-interrupted.png');

  phase='completed empty replay';
  const exact='  [Synthetic reply-recovery fixture] Review this exact message.\nΔοκιμή — 漢字.  ',emptyUser=addUser('empty-user',exact),emptyRun={id:id+'-empty-run',userMessageId:emptyUser.t3MessageId,status:'running',request:exact};
  c.beginExternalRun(emptyRun);const firstTextBefore=c.state.lastReplyMs,eventStart=events.length;
  for(const streaming of[true,false])event('turn-item.updated',{id:id+'-empty-item',runId:emptyRun.id,type:'assistant_message',streaming,text:' \u00a0\u2003\n\t'});
  event('run.updated',{...emptyRun,status:'completed'});event('run.updated',{...emptyRun,status:'completed'});await flush();await frames();
  assert.ok(!c.t3FirstText&&c.state.lastReplyMs===firstTextBefore&&c.messages.every(message=>message.turnId!==emptyRun.id)&&events.slice(eventStart).every(e=>!['delta','speechFlush','speak'].includes(e.name)&&!(e.name==='message'&&e.data?.role==='assistant')),'An empty replay produced an assistant row, first text, or audio event');
  const emptyView=await ui(`(()=>{const row=document.querySelector('[data-message-id="${emptyUser.id}"]');return {badge:row?.querySelector('.empty-reply-state')?.textContent,review:row?.querySelector('button')?.textContent,blankAssistants:[...document.querySelectorAll('.answer.assistant[data-message-id]')].filter(row=>!row.querySelector('div')?.textContent.trim()).length};})()`);
  assert.ok(emptyUser.delivery==='sent'&&emptyUser.replyStatus==='empty'&&emptyView.badge==='No text reply'&&emptyView.review==='Review message'&&emptyView.blankAssistants===0&&c.state.replyIssue?.kind==='empty','The original sent request did not receive no-text recovery');checks.push('A replayed empty completion marks its sent request without a blank assistant or first-text event');
  assert.equal(JSON.parse(await readFile(join(dataReal,'settings.json'),'utf8')).messages.find(message=>message.id===emptyUser.id)?.replyStatus,'empty','The replayed no-text status was not saved in the isolated profile');
  const protectedDraft='[Synthetic reply-recovery fixture] Existing unsent draft';
  await ui(`(()=>{const input=document.querySelector('#dashboard-input');input.value=${JSON.stringify(protectedDraft)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-message-id="${emptyUser.id}"] button').click();})()`);await frames();assert.equal(await ui(`document.querySelector('#dashboard-input').value`),protectedDraft,'Review message overwrote an existing draft');
  await ui(`(()=>{const input=document.querySelector('#dashboard-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-message-id="${emptyUser.id}"] button').click();})()`);await frames();assert.equal(await ui(`document.querySelector('#dashboard-input').value`),exact,'Review message did not restore the exact original input');assert.equal(submitAttempts,0);assert.equal(dispatchAttempts,0);checks.push('The real Review message button protects an existing draft and restores exact input without dispatch');await snapshot('reply-recovery-empty-reviewed.png');
  bubble.showInactive();const bubbleView=await until(()=>popup(`(()=>{const view=window.hephaestusBubbleInspect();return document.querySelector('#bubble-mode').textContent==='No text reply'&&/review your message/i.test(view.renderedText)&&/completed actions/i.test(view.renderedText)?view:false;})()`),'The actual bubble did not display factual no-text guidance');assert.ok(!bubbleView.thinking&&!bubbleView.talking);checks.push('The production bubble gives factual no-text guidance for a replayed empty completion');await snapshot('reply-recovery-empty-bubble.png',bubble);
 }catch(error){failure=new Error('Reply recovery verification failed during '+phase+': '+error.message,{cause:error});}
 finally{
  phase='restoration';phaseDeadline=deadline;const cleanup=[];
  if(original){
   try{await flush();for(const[name,listener]of listeners)c.off(name,listener);const blockedSubmit=c.submit;for(const key of Reflect.ownKeys(c))if(!Object.hasOwn(original.descriptors,key))delete c[key];Object.defineProperties(c,original.descriptors);c.submit=blockedSubmit;for(const file of original.files)await bounded(()=>restoreFile(file));c.publish();
    await reload(dashboard,'window.hephaestusDashboardInspect?.().initialized');await reload(bubble,'!!window.hephaestusBubbleInspect');await bounded(()=>showDashboard(original.view.page));await frames();
    await ui(`(()=>{const input=document.querySelector('#dashboard-input');input.value=${JSON.stringify(original.view.draft)};input.dispatchEvent(new Event('input',{bubbles:true}));for(const[id,value]of${JSON.stringify([['prompt',original.view.prompt],['excluded-apps',original.view.privacy]])}){const el=document.getElementById(id);if(el.value!==value){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}}const toggle=document.querySelector('#toggle-screen');if(toggle.getAttribute('aria-expanded')!==${JSON.stringify(original.view.expanded)})toggle.click();const answers=document.querySelector('#answers');if(!${original.view.following})answers.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));answers.scrollTop=${original.view.top};answers.dispatchEvent(new Event('scroll'));document.getElementById(${JSON.stringify(original.view.focus)})?.focus({preventScroll:true});})()`);
    if(original.bubbleVisible)bubble.showInactive();else bubble.hide();
    await until(()=>popup(`document.querySelector('#bubble-mode').textContent===${JSON.stringify(original.popup.mode)}&&window.hephaestusBubbleInspect().renderedText===${JSON.stringify(original.popup.text)}`),'The original bubble content did not finish restoring');
    assert.ok(original.files.every(file=>file.bytes.length>0));for(const file of original.files)assert.equal(hash(await readFile(file.path)),hash(file.bytes),'Reply replay did not restore exact saved bytes');for(const key of['state','messages','activities','t3Runs','t3Seen','generation','t3FirstText'])assert.equal(c[key],original.descriptors[key]?.value,'Reply replay did not restore controller '+key);assert.equal(submitAttempts,0);assert.equal(dispatchAttempts,0);assert.equal(nativeAttempts,0);checks.push('Reply replay restores the original controller, saved bytes and production renderers');
   }catch(error){cleanup.push(error);}finally{for(const restore of hooks.reverse())try{restore();}catch(error){cleanup.push(error);}}
  }
  if(cleanup.length){const errors=[...(failure?[failure]:[]),...cleanup];failure=new AggregateError(errors,'Reply replay could not safely restore its isolated profile: '+errors.map(error=>error.message).join('; '));}
 }
 if(failure)throw failure;
 return{checks,screenshots,kind:'synthetic controller and transport-event replay in production windows',liveModelRequests:0,liveCancellation:false,humanInput:false,blockedSubmissionAttempts:submitAttempts,blockedProviderDispatchAttempts:dispatchAttempts,nativeActionAttempts:nativeAttempts,ownedWindowFocusCalls,nativeMetadataCalls,restoration:{controllerReferences:true,exactRawFiles:2,rendererReload:true},limitations:['Fixtures are explicitly synthetic and are removed after verification.','Reload means renderer reload; no process restart, live model completion, live Stop, or human speech is claimed.','Native calls are limited to focusing the supplied app-owned windows and reading monitor metadata for renderer initialization.']};
}
