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
 const checks=[],screenshots=[],client=c.t3,snapshots=[];let original,ownedBlock=false,blockIdentity,blockCreation,restored=false,failure;
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
  original={prompt:c.state.prompt,thread:c.t3ThreadId,subscription:c.stopT3Subscription,subscriptionIds:subscriptions(),settings:savedBytes,agents:agentBytes,saveQueue:c.saveQueue,messages:new Set(c.messages.map(message=>message.id)),runs:new Set(c.t3Runs.keys())};
  assert.ok(typeof original.prompt==='string'&&original.prompt.trim()&&normalized(original.prompt).length<32000,'The current instruction text cannot be verified by adding one newline');
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
  checks.push('Retry saves the actual Instructions text, settings file and AGENTS.md');
  phase='subscription confirmation';const canonical=await bounded(()=>client.call('orchestration.getThreadProjection',{threadId:savedThread}),4000,'The new instruction conversation could not be verified');
  const liveReceipt=snapshots.find(item=>item.threadId===savedThread&&client.pending.get(item.requestId)?.subscription===true);
  assert.ok(canonical.thread?.id===savedThread&&!canonical.thread.activeRunId&&!(canonical.runs??[]).some(run=>activeStatus.has(run.status))&&liveReceipt&&[...original.subscriptionIds].every(id=>!client.pending.has(id)),'The saved instructions do not have a confirmed live replacement subscription');
  checks.push('The replacement conversation has a real processed subscription and canonical projection');await snapshot('settings-saved.png');

  phase='original-byte restoration';await restoreOriginal();
  assert.ok(c.messages.length===original.messages.size&&c.messages.every(message=>original.messages.has(message.id))&&c.t3Runs.size===original.runs.size&&[...c.t3Runs.keys()].every(id=>original.runs.has(id)),'Instruction verification unexpectedly created conversation messages or model runs');
  checks.push('The original instruction bytes are restored through the production settings API');
 }catch(error){failure=new Error('Instruction settings verification failed during '+phase+': '+error.message,{cause:error});}
 finally{
  phaseDeadline=deadline;phase='cleanup';const cleanup=[];
  try{if(blockCreation)await bounded(()=>blockCreation,1000,'The owned settings fault directory creation did not settle');await removeBlock();}catch(error){cleanup.push(error);}
  if(original&&!restored)try{await restoreOriginal({checkView:false});}catch(error){cleanup.push(error);}
  client?.removeListener('frame',frameListener);
  if(cleanup.length)failure=new AggregateError([...(failure?[failure]:[]),...cleanup],'Instruction settings verification could not finish cleanup; the isolated profile must recover its instruction journal on restart');
 }
 if(failure)throw failure;
 return{checks,screenshots,faultInjection:{kind:'real filesystem write failure',target:'settings.tmp',scope:'runtime/quality-verification'},restoration:{method:'backend-configure',reason:'HTML textareas normalize line endings; original instruction bytes were restored through the real API'}};
}
