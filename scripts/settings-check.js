import assert from 'node:assert/strict';
import {realpath,readFile,writeFile,mkdir,lstat,readdir,rmdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
const normalized=prompt=>prompt.replace(/\r\n?/g,'\n');
const activeStatus=new Set(['preparing','queued','starting','running','waiting']);

// Uses the actual settings UI and filesystem in the quality profile. It never
// starts a conversation, supplies a response, or changes a model preference.
export async function verifyInstructionSettings({root,companion:c,dashboard,showDashboard,out}){
 const started=Date.now(),deadline=started+30000;let phaseDeadline=started+22000,phase='profile isolation';
 const checks=[],screenshots=[],client=c.t3,snapshots=[];let original,ownedBlock=false,blockIdentity,blockCreation,restored=false,failure,sampleHook,callHook,threadListener,postCommitScreenFailure;
 const injectedScreenMessage='Injected screen-helper dependency failure after instructions committed';
 const bounded=async(task,timeout=5000,message='Instruction settings verification timed out')=>{
  const remaining=Math.min(timeout,phaseDeadline-Date.now());if(remaining<=0)throw new Error(message+' during '+phase);
  let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message+' during '+phase)),remaining);})]);}finally{clearTimeout(timer);}
 };
 const until=async(predicate,timeout,message)=>{
  const end=Math.min(phaseDeadline,Date.now()+timeout);
  while(Date.now()<end){const result=await bounded(predicate,Math.min(1500,end-Date.now()),message);if(result)return result;await delay(Math.min(75,Math.max(1,end-Date.now())));}
  throw new Error(message);
 };
 const ui=source=>bounded(()=>dashboard.webContents.executeJavaScript(source),3000,'The Instructions view did not answer');
 const subscriptions=()=>new Set([...client.pending??[]].filter(([,value])=>value.subscription&&value.tag==='orchestration.subscribeThread').map(([id])=>String(id)));
 const frameListener=frame=>{
  if(frame?._tag!=='Chunk')return;
  for(const value of frame.values??[])if(value.kind==='snapshot'&&typeof value.projection?.thread?.id==='string')snapshots.push({requestId:String(frame.requestId),threadId:value.projection.thread.id});
 };
 const rootReal=await bounded(()=>realpath(root)),expected=join(rootReal,'runtime','quality-verification');
 const [expectedReal,dataReal,outReal]=await bounded(()=>Promise.all([realpath(expected),realpath(c.dataDir),realpath(out)]));
 assert.ok(samePath(expectedReal,expected)&&samePath(dataReal,expectedReal),'Instruction settings verification requires the real isolated runtime/quality-verification profile');
 assert.ok(outReal.startsWith(join(rootReal,'artifacts')+sep),'Settings screenshots must remain inside this checkout’s artifacts directory');
 const settings=join(dataReal,'settings.json'),agents=join(dataReal,'context','AGENTS.md'),block=join(dataReal,'settings.tmp');
 const exists=async path=>{try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const readUI=()=>ui(`(()=>{const prompt=document.querySelector('#prompt'),button=document.querySelector('#save-prompt'),notice=document.querySelector('#notice'),r=notice.getBoundingClientRect();return {draft:prompt.value,status:document.querySelector('#prompt-status').textContent,disabled:button.disabled,buttonText:button.textContent,errorVisible:!notice.hidden&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+1,error:document.querySelector('#notice-message').textContent};})()`);
 const pasteAndSave=async text=>{
  const result=await ui(`(()=>{const prompt=document.querySelector('#prompt'),button=document.querySelector('#save-prompt');if(button.disabled)throw new Error('An instruction save is already pending');prompt.focus();prompt.value=${JSON.stringify(text)};prompt.dispatchEvent(new Event('input',{bubbles:true}));const exact=prompt.value===${JSON.stringify(text)};if(!exact)throw new Error('The Instructions field changed the proposed text');button.click();return exact;})()`);
  assert.ok(result,'The actual Instructions field did not retain the proposal');
 };
 const removeBlock=async()=>{
  if(!ownedBlock)return;
  const current=await bounded(()=>exists(block),1000,'Could not inspect the settings fault directory');
  if(!current){ownedBlock=false;return;}
  assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===blockIdentity.dev&&current.ino===blockIdentity.ino,'The owned settings fault directory changed identity');
  assert.ok((await bounded(()=>readdir(block),1000)).length===0,'The owned settings fault directory is no longer empty');
  await bounded(()=>rmdir(block),1000,'Could not remove the owned empty settings fault directory');ownedBlock=false;
 };
 const snapshot=async name=>{
  const destination=join(outReal,name),previous=await bounded(()=>exists(destination),1000);
  assert.ok(!previous||previous.isFile()&&!previous.isSymbolicLink(),'The screenshot target is not a normal generated artifact');
  await ui('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const image=await bounded(()=>dashboard.webContents.capturePage(),3000,'Could not capture the actual Instructions view');
  await bounded(()=>writeFile(destination,image.toPNG()),2000,'Could not save the Instructions screenshot');screenshots.push(name);
 };
 const representations=async prompt=>{
  const [saved,active]=await bounded(()=>Promise.all([readFile(settings,'utf8'),readFile(agents,'utf8')]),2000);
  return c.state.prompt===prompt&&JSON.parse(saved).prompt===prompt&&active===prompt+'\n';
 };
 const idle=()=>c.state.connection==='connected'&&c.t3===client&&client?.socket?.readyState===1&&!c.state.busy&&!c.t3InFlight&&!c.state.instructionsSaving&&!c.updatingPrompt;
 const committed=async prompt=>{
  if(!idle()||c.state.prompt!==prompt)return false;
  const view=await readUI();return !view.disabled&&view.status==='Instructions saved'&&view.draft===normalized(prompt)&&await representations(prompt);
 };
 const confirmConversation=async(threadId,retiredSubscriptions)=>{
  const canonical=await bounded(()=>client.call('orchestration.getThreadProjection',{threadId}),4000,'The saved instruction conversation could not be verified');
  const liveReceipt=snapshots.find(item=>item.threadId===threadId&&client.pending.get(item.requestId)?.subscription===true);
  assert.ok(canonical.thread?.id===threadId&&!canonical.thread.activeRunId&&!(canonical.runs??[]).some(run=>activeStatus.has(run.status))&&liveReceipt&&[...retiredSubscriptions].every(id=>!client.pending.has(id)),'The saved instructions do not have a confirmed live replacement subscription');
 };
 const restoreScreenFault=()=>{
  if(sampleHook){if(c.sample===sampleHook.wrapper){if(sampleHook.own)c.sample=sampleHook.original;else delete c.sample;}sampleHook=null;}
  if(callHook){if(client.call===callHook.wrapper){if(callHook.own)client.call=callHook.original;else delete client.call;}callHook=null;}
  if(threadListener){c.removeListener('state',threadListener);threadListener=null;}
  if(original&&c.state.screenError===injectedScreenMessage)c.publish({screenError:original.screenError??null});
 };
 const restoreOriginal=async({checkView=true}={})=>{
  await until(()=>!c.state.instructionsSaving&&!c.updatingPrompt,4000,'An instruction transaction is still pending; its isolated journal must recover after restart');
  assert.ok(c.state.connection==='connected'&&!c.promptRecoveryBlocked,'The isolated connection cannot restore instructions safely');
  await ui(`document.querySelector('#prompt').blur()`);
  // A browser textarea normalizes CRLF. This production API transaction is
  // explicit restoration of the original bytes, not a claimed UI save.
  if(!await representations(original.prompt))await bounded(()=>c.configure({prompt:original.prompt}),7000,'The original instruction bytes could not be restored');
  await until(async()=>!c.state.instructionsSaving&&!c.updatingPrompt&&await representations(original.prompt),3000,'The original instructions did not finish restoring');
  if(checkView)await until(async()=>(await readUI()).draft===normalized(original.prompt),1500,'The actual Instructions renderer did not show the browser-normalized original after API restoration');
  restored=true;
 };
 try{
  phase='baseline';await until(idle,3000,'The isolated settings check needs an idle connected conversation');
  assert.ok(c.state.watching===false&&c.state.backgroundVision===false&&c.state.inputMode==='wispr','The settings check requires the already-paused quality verification profile');
  await bounded(()=>c.saveQueue??Promise.resolve(),2000,'Existing settings writes did not settle');
  const [settingsInfo,agentsInfo,existingBlock]=await bounded(()=>Promise.all([lstat(settings),lstat(agents),exists(block)]),2000);
  assert.ok(settingsInfo.isFile()&&!settingsInfo.isSymbolicLink()&&agentsInfo.isFile()&&!agentsInfo.isSymbolicLink(),'Instruction verification files must be regular isolated files');
  assert.ok(!existingBlock,'An existing settings.tmp file or directory cannot be used as this check’s fault');
  const [savedBytes,agentBytes]=await bounded(()=>Promise.all([readFile(settings),readFile(agents)]),2000);
  original={prompt:c.state.prompt,thread:c.t3ThreadId,subscription:c.stopT3Subscription,subscriptionIds:subscriptions(),settings:savedBytes,agents:agentBytes,saveQueue:c.saveQueue,screenError:c.state.screenError,messages:new Set(c.messages.map(message=>message.id)),runs:new Set(c.t3Runs.keys())};
  assert.ok(typeof original.prompt==='string'&&original.prompt.trim()&&normalized(original.prompt).length<=31998,'The current instruction text cannot be verified by adding the verification newlines');
  assert.ok(JSON.parse(savedBytes.toString('utf8')).prompt===original.prompt&&agentBytes.equals(Buffer.from(original.prompt+'\n')),'The baseline instruction representations already disagree');
  assert.ok(typeof original.subscription==='function'&&original.subscriptionIds.size>0,'There is no actual current conversation subscription');
  client.on('frame',frameListener);await bounded(()=>showDashboard('instructions'),3000,'The actual Instructions view did not open');
  assert.ok(await ui(`document.querySelector('[data-view=instructions]').hidden===false&&document.querySelector('#prompt').value===${JSON.stringify(normalized(original.prompt))}`),'The Instructions view does not reflect the actual original prompt');
  await ui(`(()=>{const notice=document.querySelector('#notice');if(!notice.hidden)document.querySelector('#notice-dismiss').click();})()`);
  const proposal=normalized(original.prompt)+'\n';
  phase='real settings write failure';blockCreation=mkdir(block).then(async()=>{ownedBlock=true;blockIdentity=await lstat(block);});await bounded(()=>blockCreation,1000,'Could not create the isolated settings write fault');
  await pasteAndSave(proposal);
  const failedView=await until(async()=>{const view=await readUI();return !c.state.instructionsSaving&&!c.updatingPrompt&&!view.disabled&&view.errorVisible&&view.error.trim()?view:false;},8000,'The actual settings write failure did not become a visible finished UI error');
  assert.ok(c.saveQueue!==original.saveQueue,'The injected failure did not reach actual settings persistence');
  const writeError=await bounded(()=>c.saveQueue.then(()=>null,error=>error),1000);let filesystemFault=false;
  for(let error=writeError,depth=0;error&&depth<8;error=error.cause,depth++)if(['EISDIR','EACCES','EPERM'].includes(error.code)&&(!error.path||samePath(resolve(error.path),block)))filesystemFault=true;
  assert.ok(filesystemFault,'The rejected save was not the injected real settings.tmp filesystem failure');
  assert.ok(failedView.draft===proposal&&failedView.status==='Unsaved changes'&&!/remote method/i.test(failedView.error),'The failed save lost its exact draft or reported a false Saved status');
  assert.ok(c.state.prompt===original.prompt&&c.t3ThreadId===original.thread&&c.stopT3Subscription===original.subscription&&[...original.subscriptionIds].every(id=>client.pending.has(id)),'The failed save changed the original active instruction session');
  const [failedSettings,failedAgents]=await bounded(()=>Promise.all([readFile(settings),readFile(agents)]),2000);
  assert.ok(failedSettings.equals(original.settings)&&failedAgents.equals(original.agents),'The rejected save changed durable settings or AGENTS.md');
  checks.push('A real instruction write failure preserves the exact draft and original session');await snapshot('settings-error.png');await removeBlock();

  phase='UI retry';await pasteAndSave(proposal);await until(()=>committed(proposal),9000,'Retry did not durably save the proposed instructions through the UI');
  const savedThread=c.t3ThreadId;assert.ok(savedThread!==original.thread&&c.stopT3Subscription!==original.subscription,'Retry did not activate the replacement conversation');
  phase='subscription confirmation';await confirmConversation(savedThread,original.subscriptionIds);
  checks.push('Retry saves instructions and files with a confirmed live replacement conversation');await snapshot('settings-saved.png');

  phase='post-commit screen dependency failure';
  assert.ok(c.state.running===true&&c.state.watching===false&&c.state.backgroundVision===false&&c.state.inputMode==='wispr'&&!c.state.listening&&!c.state.dictating,'The post-commit fault check requires a running text-only companion with no microphone');
  const postCommitPrompt=proposal+'\n',priorSubscriptions=subscriptions(),priorSubscription=c.stopT3Subscription,priorError=c.state.error,traffic={launches:0,launchesAcknowledged:0,archives:[],archivesAcknowledged:[]},transitions=[];
  let lastThread=savedThread,faultArmed=true,faultCalls=0;
  threadListener=()=>{if(c.t3ThreadId!==lastThread){lastThread=c.t3ThreadId;transitions.push(lastThread);}};c.on('state',threadListener);
  const previousCall=client.call;
  const observedCall=function(...args){
   const[tag,payload]=args,launch=tag==='orchestration.launchThread',archive=tag==='orchestration.dispatchCommand'&&payload?.type==='thread.archive';
   if(launch)traffic.launches++;if(archive)traffic.archives.push(payload.threadId);
   // Observe actual acknowledgements without changing arguments, timeouts or
   // the product's returned promise. No response or history is substituted.
   const request=Reflect.apply(previousCall,this,args);
   if(launch||archive)Promise.resolve(request).then(()=>{if(launch)traffic.launchesAcknowledged++;if(archive)traffic.archivesAcknowledged.push(payload.threadId);},()=>{});
   return request;
  };
  callHook={original:previousCall,wrapper:observedCall,own:Object.hasOwn(client,'call')};client.call=observedCall;
  const previousSample=c.sample;
  const failedSample=function(...args){
   if(this.state.watching!==false||this.state.backgroundVision!==false||this.state.inputMode!=='wispr')return Promise.reject(new Error('Settings verification must keep screen sharing and microphone capture paused'));
   if(faultArmed&&this.state.prompt===postCommitPrompt&&this.t3ThreadId!==savedThread&&!this.state.instructionsSaving&&!this.updatingPrompt){faultArmed=false;faultCalls++;return Promise.reject(Object.assign(new Error(injectedScreenMessage),{code:'VERIFICATION_SCREEN_HELPER_FAILURE'}));}
   return Reflect.apply(previousSample,this,args);
  };
  sampleHook={original:previousSample,wrapper:failedSample,own:Object.hasOwn(c,'sample')};c.sample=failedSample;
  await pasteAndSave(postCommitPrompt);await until(()=>committed(postCommitPrompt),9000,'A post-commit screen-helper failure was misreported as a failed instruction save');
  const postCommitThread=c.t3ThreadId,postCommitView=await readUI(),runtimeCache=JSON.parse(await bounded(()=>readFile(join(dataReal,'t3-runtime.json'),'utf8'),2000));
  assert.ok(faultCalls===1&&c.state.screenError===injectedScreenMessage&&c.state.error===priorError&&!postCommitView.errorVisible,'The injected screen failure was not reported separately from the successful settings save');
  assert.ok(postCommitView.status==='Instructions saved'&&postCommitView.draft===postCommitPrompt&&!postCommitView.disabled&&postCommitThread!==savedThread&&c.stopT3Subscription!==priorSubscription&&runtimeCache.threadId===postCommitThread,'The committed instruction draft or replacement session was lost after the screen failure');
  assert.ok(traffic.launches===1&&traffic.launchesAcknowledged===1&&traffic.archives.length===1&&traffic.archives[0]===savedThread&&traffic.archivesAcknowledged.length===1&&traffic.archivesAcknowledged[0]===savedThread&&transitions.length===1&&transitions[0]===postCommitThread,'A successful post-commit save duplicated its launch, archive or active conversation transition');
  await confirmConversation(postCommitThread,priorSubscriptions);
  assert.ok(c.t3ThreadId===postCommitThread&&await representations(postCommitPrompt),'The successful instruction transaction changed again after its screen error');
  postCommitScreenFailure={kind:'fault injection',dependency:'companion.sample',afterCommit:true,screenErrorChannel:true,failureCalls:faultCalls,launches:traffic.launchesAcknowledged,archives:traffic.archivesAcknowledged.length,nativeCapture:false};
  checks.push('A post-commit screen-helper failure preserves one successful instruction save');await snapshot('settings-saved-screen-failure.png');restoreScreenFault();

  phase='original-byte restoration';await restoreOriginal();
  assert.ok(c.messages.length===original.messages.size&&c.messages.every(message=>original.messages.has(message.id))&&c.t3Runs.size===original.runs.size&&[...c.t3Runs.keys()].every(id=>original.runs.has(id)),'Instruction verification unexpectedly created conversation messages or model runs');
  checks.push('The original instruction bytes are restored through the production settings API');
 }catch(error){failure=new Error('Instruction settings verification failed during '+phase+': '+error.message,{cause:error});}
 finally{
  phaseDeadline=deadline;phase='cleanup';const cleanup=[];
  try{restoreScreenFault();}catch(error){cleanup.push(error);}
  try{if(blockCreation)await bounded(()=>blockCreation,1000,'The owned settings fault directory creation did not settle');await removeBlock();}catch(error){cleanup.push(error);}
  if(original&&!restored)try{await restoreOriginal({checkView:false});}catch(error){cleanup.push(error);}
  client?.removeListener('frame',frameListener);
  if(cleanup.length)failure=new AggregateError([...(failure?[failure]:[]),...cleanup],'Instruction settings verification could not finish cleanup; the isolated profile must recover its instruction journal on restart');
 }
 if(failure)throw failure;
 return{checks,screenshots,faultInjection:{kind:'real filesystem write failure',target:'settings.tmp',scope:'runtime/quality-verification'},postCommitScreenFailure,restoration:{method:'backend-configure',reason:'HTML textareas normalize line endings; original instruction bytes were restored through the real API'}};
}
