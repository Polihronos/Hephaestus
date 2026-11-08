import assert from 'node:assert/strict';
import {realpath,readFile,writeFile,mkdir,lstat,readdir,rmdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';

const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Actual production controls and a real filesystem fault, confined to the
// quality profile. DOM input is synthetic; no speech or model is requested.
export async function verifyOrdinarySettings({root,companion:c,dashboard,mascot,showDashboard,out}){
 const started=Date.now(),deadline=started+18000;let phaseDeadline=started+12000,phase='profile isolation',original,ownedBlock=false,blockIdentity,blockCreation,restored=false,failure,frames=0;
 const checks=[],screenshots=[];
 const bounded=async(task,timeout=2500)=>{
  const remaining=Math.min(timeout,phaseDeadline-Date.now());assert.ok(remaining>0,'Ordinary settings verification timed out during '+phase);
  let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Ordinary settings verification timed out during '+phase)),remaining);})]);}finally{clearTimeout(timer);}
 };
 const until=async(predicate,timeout,message)=>{
  const end=Math.min(phaseDeadline,Date.now()+timeout);
  while(Date.now()<end){const result=await bounded(predicate,Math.min(1000,end-Date.now()));if(result)return result;await delay(Math.min(75,Math.max(1,end-Date.now())));}
  throw new Error(message);
 };
 const ui=source=>bounded(()=>dashboard.webContents.executeJavaScript(source));
 const exists=async path=>{try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const rootReal=await bounded(()=>realpath(root)),expected=join(rootReal,'runtime','quality-verification');
 const [expectedReal,dataReal,outReal,artifactsReal]=await bounded(()=>Promise.all([realpath(expected),realpath(c.dataDir),realpath(out),realpath(join(rootReal,'artifacts'))]));
 assert.ok(samePath(expectedReal,expected)&&samePath(dataReal,expectedReal),'Ordinary settings verification requires the real isolated runtime/quality-verification profile');
 const artifactPath=relative(artifactsReal,outReal);assert.ok(!isAbsolute(artifactPath)&&artifactPath!=='..'&&!artifactPath.startsWith('..\\')&&!artifactPath.startsWith('../'),'Ordinary settings screenshots must remain inside this checkout artifacts directory');
 const settings=join(dataReal,'settings.json'),block=join(dataReal,'settings.tmp');
 const saved=async()=>JSON.parse(await bounded(()=>readFile(settings,'utf8')));
 const readUI=()=>ui(`(()=>{const speech=document.querySelector('#spokenReplies'),opacity=document.querySelector('#opacity'),notice=document.querySelector('#notice'),r=notice.getBoundingClientRect();return {checked:speech.checked,opacity:Number(opacity.value)/100,voiceVisible:!document.querySelector('[data-view=voice]').hidden,errorVisible:!notice.hidden&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+1,error:document.querySelector('#notice-message').textContent};})()`);
 const inspectVoice=()=>bounded(()=>mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect()'));
 const frameListener=frame=>{if(frame)frames++;};
 const removeBlock=async()=>{
  if(!ownedBlock)return;const current=await bounded(()=>exists(block),1000);if(!current){ownedBlock=false;return;}
  assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===blockIdentity.dev&&current.ino===blockIdentity.ino,'The owned settings fault directory changed identity');
  assert.equal((await bounded(()=>readdir(block),1000)).length,0,'The owned settings fault directory is no longer empty');await bounded(()=>rmdir(block),1000);ownedBlock=false;
 };
 const snapshot=async name=>{
  const path=join(outReal,name),previous=await bounded(()=>exists(path),1000);assert.ok(!previous||previous.isFile()&&!previous.isSymbolicLink(),'The screenshot target is not a regular generated artifact');
  await ui('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const image=await bounded(()=>dashboard.webContents.capturePage());await bounded(()=>writeFile(path,image.toPNG()));screenshots.push(name);
 };
 const restoreOriginal=async()=>{
  await bounded(()=>c.configureQueue?.catch(()=>{}));await bounded(()=>c.saveQueue?.catch(()=>{}));
  if(c.state.spokenReplies!==original.spokenReplies||c.state.opacity!==original.opacity||!(await bounded(()=>readFile(settings))).equals(original.bytes))await bounded(()=>c.configure({spokenReplies:original.spokenReplies,opacity:original.opacity}),3000);
  await until(async()=>{const view=await readUI();return view.checked===original.spokenReplies&&(original.uiOpacity===undefined||view.opacity===original.uiOpacity)&&c.state.spokenReplies===original.spokenReplies&&c.state.opacity===original.opacity&&(await bounded(()=>readFile(settings))).equals(original.bytes);},2000,'Ordinary settings did not restore the exact original values and bytes');
  await ui(`document.querySelector('#notice-dismiss').click()`);restored=true;
 };
 try{
  phase='baseline';await bounded(()=>c.configureQueue?.catch(()=>{}));await bounded(()=>c.saveQueue?.catch(()=>{}));
  assert.ok(c.state.connection==='connected'&&!c.state.busy&&!c.t3InFlight&&!c.state.instructionsSaving&&!c.updatingPrompt,'Ordinary settings verification requires an idle completed instruction check');
  assert.ok(c.state.watching===false&&c.state.backgroundVision===false&&c.state.proactive===false&&c.state.inputMode==='wispr'&&c.state.spokenReplies===false&&!c.state.listening&&!c.state.dictating,'Ordinary settings verification requires screen sharing, proactivity, microphone and speech paused');
  const [info,existingBlock,bytes,voice]=await bounded(()=>Promise.all([lstat(settings),exists(block),readFile(settings),inspectVoice()]));
  assert.ok(info.isFile()&&!info.isSymbolicLink(),'Ordinary settings must be a regular isolated file');assert.ok(!existingBlock,'An existing settings.tmp cannot be used as this check fault');
  assert.ok(!voice.voice.microphoneActive&&!voice.speaker.pending&&!voice.speaker.speaking&&!voice.speaker.enabled,'The isolated audio renderer must be inactive');
  const baseline=JSON.parse(bytes.toString('utf8'));assert.ok(baseline.spokenReplies===false&&baseline.opacity===c.state.opacity,'Active and durable ordinary settings already disagree');
  original={bytes,spokenReplies:c.state.spokenReplies,opacity:c.state.opacity,saveQueue:c.saveQueue,spokenCount:voice.speaker.spokenCount,messages:new Set(c.messages.map(message=>message.id)),runs:new Set(c.t3Runs.keys())};
  c.on('frame',frameListener);c.on('visionFrame',frameListener);await bounded(()=>showDashboard('voice'));
  const baselineView=await readUI();assert.ok(baselineView.voiceVisible&&!baselineView.checked,'The actual Voice view must display speech off');original.uiOpacity=baselineView.opacity;
  await ui(`(()=>{if(!document.querySelector('#notice').hidden)document.querySelector('#notice-dismiss').click();document.querySelector('#spokenReplies').scrollIntoView({block:'center'});})()`);

  phase='real ordinary settings write failure';blockCreation=mkdir(block).then(async()=>{ownedBlock=true;blockIdentity=await lstat(block);});await bounded(()=>blockCreation,1000);
  assert.ok(blockIdentity.isDirectory()&&!blockIdentity.isSymbolicLink()&&samePath(await bounded(()=>realpath(block)),block)&&(await bounded(()=>readdir(block))).length===0,'The owned settings fault must be a new empty real directory');
  await ui(`document.querySelector('#spokenReplies').click()`);
  const rejected=await until(async()=>{const view=await readUI();return c.saveQueue!==original.saveQueue&&!c.configureQueue&&view.errorVisible&&view.error.trim()?view:false;},4000,'The actual Speak replies save did not finish with a readable visible error');
  const error=await bounded(()=>c.saveQueue.then(()=>null,error=>error));let filesystemFault=false;for(let e=error,depth=0;e&&depth<8;e=e.cause,depth++)if(['EISDIR','EACCES','EPERM'].includes(e.code)&&(!e.path||samePath(resolve(e.path),block)))filesystemFault=true;
  assert.ok(filesystemFault&&/settings|saved|writ|disk/i.test(rejected.error)&&!/remote method/i.test(rejected.error),'The notice must explain the actual settings.tmp write failure in plain language');
  assert.ok(!rejected.checked&&c.state.spokenReplies===false&&(await saved()).spokenReplies===false&&(await bounded(()=>readFile(settings))).equals(original.bytes),'The rejected speech enable changed the checkbox, runtime or durable settings');
  checks.push('A real ordinary settings write failure keeps speech off in the UI, runtime and disk');await snapshot('ordinary-settings-error.png');await removeBlock();

  phase='unrelated opacity save';const opacity=original.opacity===1?.95:1,previousQueue=c.saveQueue;
  await ui(`(()=>{const control=document.querySelector('#opacity');control.scrollIntoView({block:'center'});control.value=${JSON.stringify(opacity*100)};control.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(async()=>c.saveQueue!==previousQueue&&!c.configureQueue&&c.state.opacity===opacity&&(await saved()).opacity===opacity,4000,'The unrelated opacity control did not durably save');
  const recovered=await readUI();assert.ok(!recovered.checked&&c.state.spokenReplies===false&&(await saved()).spokenReplies===false,'The unrelated opacity save silently persisted the rejected speech enable');
  await ui(`document.querySelector('#notice-dismiss').click()`);checks.push('An unrelated opacity control save cannot persist a rejected speech enable');await snapshot('ordinary-settings-recovered.png');

  phase='original settings restoration';await restoreOriginal();
  const afterVoice=await inspectVoice();assert.ok(!afterVoice.voice.microphoneActive&&!afterVoice.speaker.pending&&!afterVoice.speaker.speaking&&afterVoice.speaker.spokenCount===original.spokenCount&&frames===0&&c.state.watching===false&&c.state.backgroundVision===false&&c.state.inputMode==='wispr','Ordinary settings verification activated audio or produced a screen frame');
  assert.ok(c.messages.length===original.messages.size&&c.messages.every(message=>original.messages.has(message.id))&&c.t3Runs.size===original.runs.size&&[...c.t3Runs.keys()].every(id=>original.runs.has(id)),'Ordinary settings verification created a message or model run');
  checks.push('Ordinary settings verification restores the original settings bytes without audio, frames or model runs');
 }catch(error){failure=new Error('Ordinary settings verification failed during '+phase+': '+error.message,{cause:error});}
 finally{
  phase='cleanup';phaseDeadline=deadline;const cleanup=[];
  try{if(blockCreation)await bounded(()=>blockCreation,1000);await removeBlock();}catch(error){cleanup.push(error);}
  if(original&&!restored)try{await restoreOriginal();}catch(error){cleanup.push(error);}
  c.removeListener('frame',frameListener);c.removeListener('visionFrame',frameListener);
  if(cleanup.length)failure=new AggregateError([...(failure?[failure]:[]),...cleanup],'Ordinary settings verification could not safely restore its isolated profile');
 }
 if(failure)throw failure;
 return{checks,screenshots,faultInjection:{kind:'real filesystem write failure',target:'settings.tmp',scope:'runtime/quality-verification'},interaction:{kind:'synthetic DOM control events',checkbox:'HTMLElement.click',opacity:'input event',humanVoiceTrial:false},restoration:{method:'production configure API',exactOriginalSettingsBytes:true},modelRequests:0,audioPlayback:false,screenFrames:frames};
}
