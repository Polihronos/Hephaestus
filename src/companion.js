import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexRpc } from './rpc.js';
import { ProcessRpc } from './process-rpc.js';
import { screenDifference, coordinates, validateAction, fastCommand } from './commands.js';
import { validateAnnotation, framePoint } from './annotations.js';
import {TokenLedger} from './token-ledger.js';
import {PrivacyBlockedError,excludedApps,excludedProcess} from './privacy.js';
import {evaluateNotice,NOTICE_COOLDOWN} from './notice-policy.js';
import {preserveFailedVoiceInput} from './input-recovery.js';
import {readPromptSettings,defaultPromptHash} from './settings-migrations.js';
export {PrivacyBlockedError} from './privacy.js';
export const MAX_MESSAGE_LENGTH=16000;

export const dynamicTools=[
 {type:'function',name:'screen_observe',description:'Get a fresh screenshot and observationId. Choose monitor to see the desktop, Start menu, or multiple apps; window gives the active app clearly.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['window','monitor']},monitor:{type:'integer'}},additionalProperties:false}},
 {type:'function',name:'screen_annotate',description:'Draw a temporary screen mark. Coordinates use screenshot pixels. Does not click or type.',inputSchema:{type:'object',properties:{observationId:{type:'string'},kind:{type:'string',enum:['circle','rectangle','arrow','label','path','clear']},x:{type:'number'},y:{type:'number'},x2:{type:'number'},y2:{type:'number'},radius:{type:'number'},color:{type:'string',enum:['mint','amber','rose','blue']},label:{type:'string'},ttl:{type:'number'},points:{type:'array',items:{type:'object',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y'],additionalProperties:false}}},required:['observationId','kind'],additionalProperties:false}},
 {type:'function',name:'move_attention',description:'Move the small mascot near a point and highlight what you are discussing. Coordinates use screenshot pixels.',inputSchema:{type:'object',properties:{observationId:{type:'string'},x:{type:'number'},y:{type:'number'},label:{type:'string'}},required:['observationId','x','y'],additionalProperties:false}}
];
dynamicTools.push(
 {type:'function',name:'screen_zoom',description:'Read a small area clearly at native resolution. Region coordinates are pixels in a previous observation.',inputSchema:{type:'object',properties:{observationId:{type:'string'},x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}},required:['observationId','x','y','width','height'],additionalProperties:false}},
 {type:'function',name:'screen_windows',description:'List visible applications and their window IDs.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {type:'function',name:'screen_action',description:'Control an app on a user request. Every action returns a fresh observation; reuse it instead of observing again. For a stable input, sequence can click, type and press Enter in one call (at most six steps on the same window). Set focusTarget=true to bring that observed window forward immediately before input; changed content returns a fresh observation instead.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['click','doubleclick','rightclick','scroll','key','type','focus','browser','sequence']},observationId:{type:'string'},x:{type:'number'},y:{type:'number'},key:{type:'string'},text:{type:'string'},query:{type:'string'},delta:{type:'integer'},focusTarget:{type:'boolean'},needsConfirmation:{type:'boolean'},reason:{type:'string'},steps:{type:'array',maxItems:6,items:{type:'object',properties:{kind:{type:'string',enum:['click','doubleclick','rightclick','scroll','key','type']},x:{type:'number'},y:{type:'number'},key:{type:'string'},text:{type:'string'},delta:{type:'integer'}},required:['kind'],additionalProperties:false}}},required:['kind','observationId'],additionalProperties:false}},
 {type:'function',name:'companion_notice',description:'Show a concrete problem or opportunity that advances the current user task. Include fresh visible evidence, a specific next action, why it matters and the benefit. Status narration is suppressed. A suppressed result is normal: do not retry or rephrase.',inputSchema:{type:'object',properties:{text:{type:'string'},kind:{type:'string',enum:['problem','opportunity']},subject:{type:'string',description:'Stable specific subject, such as migration P2022 User.timezone; retain it across paraphrases.'},task:{type:'string',description:'The current task this directly advances, from the conversation or fresh visible work.'},taskSource:{type:'string',enum:['conversation','screen'],description:'Use screen for an independently observed task; evidence must identify that task.'},evidence:{type:'string',description:'Concrete visible evidence, including relevant identifiers or exact values.'},action:{type:'string',description:'A specific useful next action the user can take.'},rationale:{type:'string',description:'Why this matters to the current user task now.'},benefit:{type:'string',description:'The concrete outcome or avoided cost.'},observationId:{type:'string'}},required:['text','kind','subject','task','taskSource','evidence','action','rationale','benefit'],additionalProperties:false}}
);
const settingsKeys=['model','effort','watching','backgroundVision','spokenReplies','monitor','prompt','opacity','autoSend','voice','mascotPosition','inputMode','inputDevice','control','proactive','captureMode','backgroundInterval','excludedApps','noticeSnoozeUntil','noticeFeedback'];
export class Companion extends EventEmitter{
 constructor({root,dataDir,excludePids=[],openBrowser}){super();Object.assign(this,{root,dataDir,excludePids,openBrowser});this.state={name:'Hephaestus',connection:'connecting',plan:null,model:'gpt-6-luna',effort:'low',running:true,watching:true,backgroundVision:true,spokenReplies:false,monitor:-1,busy:false,activity:'Connecting',inputMode:'wispr',inputDevice:'default',control:true,proactive:true,captureMode:'window',backgroundInterval:20000,opacity:1,autoSend:true,voice:'',prompt:'',speech:'off',listening:false,usage:null,error:null,excludedApps:[],noticeSnoozeUntil:0,noticeFeedback:[],screenPrivacyBlocked:false,screenPrivacyReason:null};this.frames=[];this.observations=new Map();this.messages=[];this.activities=[];this.generation=0;this.closed=false;this.lastWatchAt=Date.now();this.spokenHistory=[];}
 publish(extra={}){Object.assign(this.state,extra,{voiceEpoch:this.voiceEpoch??0});this.emit('state',{...this.state});}
 message(role,text,extra={}){const m={id:randomUUID(),role,text,at:Date.now(),...extra};this.messages.push(m);this.messages=this.messages.slice(-120);this.emit('message',m);if(this.threadId)this.save().catch(()=>{});return m;}
 async start(){await mkdir(this.dataDir,{recursive:true});this.defaultPrompt=await readFile(join(this.root,'assets','system-prompt.txt'),'utf8');const {settings:s,migration}=await readPromptSettings(join(this.dataDir,'settings.json'),this.defaultPrompt);for(const k of settingsKeys)if(s[k]!==undefined)this.state[k]=s[k];if(!s.defaultsRevision){this.state.inputMode='wispr';this.state.spokenReplies=false;}if(!s.lunaRevision){this.state.model='gpt-6-luna';this.state.effort='low';}this.state.prompt=migration.prompt;this.messages=(s.messages??[]).filter(m=>m&&typeof m.text==='string').slice(-120);for(const m of this.messages)this.emit('message',m);this.savedThread=s.promptVersion===4&&s.performanceRevision===2?s.threadId:null;
  try{this.state.excludedApps=excludedApps(this.state.excludedApps);}catch{this.privacyConfigurationError='Saved app exclusions are invalid; save valid private apps in Settings before sharing your screen';this.state.excludedApps=[];}
  this.state.noticeFeedback=Array.isArray(this.state.noticeFeedback)?this.state.noticeFeedback.filter(f=>f&&['useful','dismiss'].includes(f.value)&&typeof f.text==='string'&&Number.isFinite(f.at)).slice(-150):[];
  this.state.noticeSnoozeUntil=Number.isFinite(this.state.noticeSnoozeUntil)?Math.max(0,this.state.noticeSnoozeUntil):0;
  this.state.backgroundInterval=Math.max(10000,Math.min(600000,Number(this.state.backgroundInterval)||20000));
  this.lastNoticeAt=this.messages.filter(m=>m.source==='noticed').at(-1)?.at??0;
  if(migration.migrated)await this.save();
  this.ledger=new TokenLedger(this.dataDir);this.publish({tokens:await this.ledger.load()});this.historyImport=this.ledger.importHistory(join(homedir(),'.codex')).then(tokens=>this.publish({tokens})).catch(e=>this.publish({tokenImportError:e.message}));
  await this.startBridge();if(this.state.inputMode==='always')this.startSpeech().catch(e=>this.publish({speech:'error',error:e.message}));try{await this.connect();}catch(e){this.publish({error:e.message});this.scheduleReconnect();}this.screenTimer=setInterval(()=>this.sample().catch(e=>this.publish({screenError:e.message})),750);this.visionTimer=setInterval(()=>this.watch().catch(()=>{}),1000);this.usageTimer=setInterval(()=>this.updateUsage().catch(()=>{}),60000);await this.sample();return this.state;}
 activityEvent(event){const index=this.activities.findIndex(e=>e.id===event.id);const item={at:Date.now(),...event};if(index>=0)this.activities[index]={...this.activities[index],...item};else this.activities.push(item);this.activities=this.activities.slice(-150);this.emit('activity',item);}
 async startBridge(){if(this.closed)return;this.bridge=new ProcessRpc(join(this.root,'native','bin','release','ScreenBridge.exe')).start();this.bridge.on('fault',e=>this.publish({error:e.message}));this.bridge.on('wisprKey',e=>this.emit('wisprKey',e));this.bridge.on('mouseDown',e=>this.emit('mouseDown',e));this.bridge.on('inputError',e=>this.publish({error:e.message}));this.bridge.on('disconnected',()=>{if(!this.closed){this.emit('bridgeLost');this.publish({error:'Recovering the screen and shortcut helper'});this.bridgeTimer=setTimeout(()=>this.startBridge().catch(e=>this.publish({error:e.message})),1500);}});await this.bridge.call('configure',{excludePids:this.excludePids});this.emit('bridgeReady');}
 async startSpeech(){
  if(this.speech||this.closed)return;this.publish({speech:'loading'});
  this.speech=new ProcessRpc(join(this.root,'.venv','Scripts','python.exe'),['-u',join(this.root,'speech','worker.py')],{cwd:this.root,env:{...process.env,PYTHONIOENCODING:'utf-8'}}).start();
  this.speech.on('ready',m=>this.publish({speech:'ready',speechModel:m.model}));this.speech.on('failed',m=>this.publish({speech:'error',error:m.error}));this.speech.on('fault',e=>this.publish({speech:'error',error:e.message}));
  this.speech.on('disconnected',()=>{this.speech=null;if(!this.closed){this.publish({speech:'loading'});this.speechTimer=setTimeout(()=>this.startSpeech().catch(e=>this.publish({error:e.message})),2000);}});
 }
 invalidateVoiceInput(){this.voiceEpoch=(this.voiceEpoch??0)+1;this.state.voiceEpoch=this.voiceEpoch;this.state.hearing=false;this.voiceAudioQueue=[];this.voiceDrainPending=null;}
 drainVoiceAudioQueue(){
  if(this.closed||this.transcribing||this.voiceDrainPending)return;
  let next;do{next=this.voiceAudioQueue?.shift();}while(next&&next.epoch!==(this.voiceEpoch??0));
  if(!next)return;
  this.voiceDrainPending=next;
  setImmediate(()=>{if(this.voiceDrainPending!==next)return;this.voiceDrainPending=null;this.transcribe(next.audio,{epoch:next.epoch}).catch(error=>{if(!this.closed&&next.epoch===(this.voiceEpoch??0))this.publish({error:error.message});});});
 }
 async transcribe(audio,{epoch=this.voiceEpoch??0}={}){
  if(this.closed||epoch!==(this.voiceEpoch??0)||this.state.inputMode!=='always'||!this.state.running||this.state.dictating||this.state.speech!=='ready')return;
  if(this.transcribing||this.voiceDrainPending){this.voiceAudioQueue??=[];if(this.voiceAudioQueue.length<3)this.voiceAudioQueue.push({audio,epoch});return;}
  this.transcribing=true;
  try{const result=await this.speech.call('transcribe',{audio},60000);if(this.closed||epoch!==(this.voiceEpoch??0)||this.state.inputMode!=='always'||!this.state.running||this.state.dictating)return;
   const text=result.text?.trim();if(!text)return;const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();const heard=normalize(text);
   const echo=this.spokenHistory.some(s=>Date.now()-s.at<10000&&heard.length>8&&(normalize(s.text).includes(heard)||heard.includes(normalize(s.text))));
   if(echo){this.publish({voiceActivity:'Playback echo rejected'});return;}
   this.publish({lastRecognitionMs:result.elapsedMs});const startedAt=Date.now();this.submit(text,{source:'voice'}).catch(async error=>{
    let message=error.message;try{await preserveFailedVoiceInput(this,{text,source:'voice',error,startedAt});}catch(saveError){message+=' The recognized text could not be saved: '+saveError.message;}
    this.publish({error:message});this.emit('voiceInputFailed');
   });
  }finally{this.transcribing=false;if(!this.closed)this.publish({hearing:false});this.drainVoiceAudioQueue();}
 }
 scheduleReconnect(){if(this.closed||this.reconnectTimer)return;this.publish({connection:'reconnecting',busy:!!this.t3InFlight&&this.state.busy,activity:'Reconnecting to Codex'});const delay=Math.min(30000,1500*2**(this.reconnectAttempts??0));this.reconnectAttempts=(this.reconnectAttempts??0)+1;this.reconnectTimer=setTimeout(async()=>{this.reconnectTimer=null;if(this.closed)return;this.rpc?.removeAllListeners('disconnected');this.rpc?.close();try{await this.connect();if(!this.closed)this.reconnectAttempts=0;}catch(e){if(this.closed)return;this.publish({error:e.message});this.scheduleReconnect();}},delay);}
 threadParams(){return {cwd:join(this.dataDir,'context'),model:this.state.model,modelProvider:'openai',sandbox:'read-only',approvalPolicy:'never',baseInstructions:this.state.prompt,developerInstructions:'',config:{model_reasoning_effort:this.state.effort,model_reasoning_summary:'auto',project_doc_max_bytes:0},dynamicTools};}
 async openThread(){const p=this.threadParams();let r;if(this.savedThread){try{const {dynamicTools,...resume}=p;r=await this.rpc.call('thread/resume',{...resume,threadId:this.savedThread,excludeTurns:true},60000);}catch{}}if(!r){r=await this.rpc.call('thread/start',p,60000);const items=this.messages.filter(m=>['user','assistant'].includes(m.role)).slice(-40).map(m=>({type:'message',role:m.role,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}));if(items.length)await this.rpc.call('thread/inject_items',{threadId:r.thread.id,items});}this.threadId=r.thread.id;this.savedThread=this.threadId;await this.save();}
 async connect({publishReady=true}={}){
  if(this.closed)return;
  while(this.promptSaveBarrier)await this.promptSaveBarrier;
  if(this.closed)return;
  this.publish({connection:'connecting',activity:'Connecting to your Codex subscription',error:null});
  await mkdir(join(this.dataDir,'context'),{recursive:true});
  const args=[];
  try{
   const c=await readFile(join(homedir(),'.codex','config.toml'),'utf8');
   for(const m of c.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm))args.push('-c',`mcp_servers.${m[1]}.enabled=false`);
   for(const m of c.matchAll(/^\[plugins\.("[^"\n]+"|[\w-]+)\]/gm))args.push('-c',`plugins.${m[1]}.enabled=false`);
  }catch{}
  const overrides=['features.shell_tool=false','features.apps=false','features.computer_use=false','features.plugins=false','features.remote_plugin=false','features.in_app_browser=false','features.skill_search=false','plugins._default.enabled=false','skills.include_instructions=false','skills.bundled.enabled=false','project_doc_max_bytes=0','developer_instructions=""'];
  for(const override of overrides)args.push('-c',override);
  let command=process.env.COMPANION_CODEX_PATH??'codex';
  try{const c=JSON.parse(await readFile(join(this.root,'runtime-config.json'),'utf8'));if(c.codexPath)command=c.codexPath;}catch{}
  const rpc=this.rpc=new CodexRpc({command,args,cwd:this.root});
  rpc.on('fault',e=>this.publish({error:e.message}));
  rpc.on('notification',m=>{if(this.rpc===rpc)this.onNotification(m);});
  rpc.on('request',m=>this.onTool(m,rpc));
  rpc.on('disconnected',()=>{if(!this.closed){this.generation++;this.turnId=null;this.finishTurn?.();this.scheduleReconnect();}});
  await rpc.start();
  const account=await rpc.call('account/read',{refreshToken:false});
  if(account.account?.type!=='chatgpt')throw new Error('Sign in to Codex with ChatGPT. API-key billing is disabled in this application.');
  const catalog=await rpc.call('model/list',{});
  this.models=catalog.data.filter(m=>!m.hidden).map(m=>({id:m.id,name:m.displayName,efforts:m.supportedReasoningEfforts?.map(e=>e.reasoningEffort)??['low']}));
  if(!this.models.some(m=>m.id==='gpt-6-luna'))throw new Error('Luna 6 is unavailable in your signed-in account. No more expensive model will be selected automatically.');if(!this.models.some(m=>m.id===this.state.model)){this.state.model='gpt-6-luna';this.state.effort='low';}
  await this.openThread();
  this.publish({plan:account.account.planType,models:this.models,...(publishReady?{connection:'connected',activity:'Ready',error:null}:{})});
  if(publishReady)await this.updateUsage();
 }
 async save(options={}){
  if(this.promptSaveBarrier&&!Object.hasOwn(options,'settings')){await this.promptSaveBarrier;return this.save(options);}
  this.saveQueue=(this.saveQueue??Promise.resolve()).catch(()=>{}).then(async()=>{
   // Read ordinary state when this write starts, after earlier commits have applied.
   const settings=typeof options.settings==='function'?options.settings():options.settings??this.state,threadId=options.threadId!==undefined?options.threadId:this.threadId??this.savedThread;
   const s={promptVersion:4,promptDefaultHash:defaultPromptHash(settings.prompt,this.defaultPrompt),defaultsRevision:1,performanceRevision:2,lunaRevision:1,threadId,messages:this.messages};for(const k of settingsKeys)s[k]=settings[k];
   const tmp=join(this.dataDir,'settings.tmp');await writeFile(tmp,JSON.stringify(s,null,2));await rename(tmp,join(this.dataDir,'settings.json'));options.onSaved?.(settings);
   if(this.settingsSaveError&&this.settingsSaveError===this.state.error&&settingsKeys.every(k=>JSON.stringify(settings[k])===JSON.stringify(this.state[k]))){this.settingsSaveError=null;this.publish({error:null});}
  }).catch(error=>{throw Object.assign(new Error('Your settings could not be saved. Check free disk space and that the settings folder is writable.',{cause:error}),{code:error.code});});return this.saveQueue;
 }
 async updateUsage(){if(this.state.connection!=='connected')return;const r=await this.rpc.call('account/rateLimits/read',{});this.publish({usage:r.rateLimits});}
 clearScreen(){this.frames=[];this.observations.clear();this.modelObservations?.clear();this.lastModelObservationId=null;this.latest=null;this.attention=null;this.attentionPhysical=null;this.lastWatchFingerprint=null;this.emit('frame',null);this.emit('visionFrame',null);this.emit('annotation',{mark:{kind:'clear'}});}
 blockScreen(reason){this.clearScreen();this.publish({screenPrivacyBlocked:true,screenPrivacyReason:reason,screenWindow:null,captureSource:null,lastVisionAt:null});throw new PrivacyBlockedError(reason);}
 async assertScreenAllowed({mode='window',frame}={}){
  if(this.privacyConfigurationError)this.blockScreen(this.privacyConfigurationError);
  let target;try{target=await this.bridge.call('target-info');}catch(e){if(this.state.excludedApps?.length)this.blockScreen('Cannot verify the active app; screen capture is blocked');else throw e;}
  const apps=this.state.excludedApps??[];
  const excluded=excludedProcess(target,apps)||excludedProcess(frame?.window,apps);
  if(excluded)this.blockScreen(`Screen capture is blocked for ${excluded}.exe`);
  if(apps.length&&(mode==='monitor'||frame?.captureSource?.startsWith('monitor'))){
   let windows;try{windows=await this.bridge.call('windows');}catch{this.blockScreen('Cannot verify visible apps; monitor capture is blocked');}
   const visible=windows.find(w=>excludedProcess(w,this.state.excludedApps));if(visible)this.blockScreen(`Monitor capture is blocked while ${excludedProcess(visible,this.state.excludedApps)}.exe has an open window`);
  }
  if(apps.length&&(!target?.process||!target?.id))this.blockScreen('Cannot identify the active app; screen capture is blocked');
  if(this.state.screenPrivacyBlocked)this.publish({screenPrivacyBlocked:false,screenPrivacyReason:null});
  return target;
 }
 async captureSafely(region,options={}){
  if(!this.state.running||!this.state.watching)throw new Error('Screen sharing is paused');
  const generation=this.generation,mode=options.mode??this.state.captureMode;
  await this.assertScreenAllowed({mode});
  if(generation!==this.generation||!this.state.running||!this.state.watching)throw new Error('Screen capture was interrupted');
  const f=await this.bridge.call('capture',{monitor:options.monitor??this.state.monitor,mode,maxWidth:options.maxWidth??2560,...(region?{region}:{})});
  await this.assertScreenAllowed({mode,frame:f});
  if(generation!==this.generation||!this.state.running||!this.state.watching)throw new Error('Screen capture was interrupted');
  f.id=randomUUID();return f;
 }
 async sample(){if(this.closed||this.sampling||!this.state.running||!this.state.watching)return;this.sampling=true;try{const f=await this.captureSafely();this.latest=f;this.frames=[f];this.publish({screenWindow:f.window.title,screenError:null,captureSource:f.captureSource});this.emit('frame',f);}catch(e){if(e.code!=='SCREEN_PRIVACY_BLOCKED'&&e.message!=='Screen capture was interrupted')throw e;}finally{this.sampling=false;}}
 async observe(region,options={}){const f=await this.captureSafely(region,options);this.latest=f;this.observations.set(f.id,f);if(this.observations.size>20)this.observations.delete(this.observations.keys().next().value);return f;}
 async safeObservation(region,options={}){return this.observe(region,options);}
 metadata(f){const p=this.attentionPhysical;const attention=p?{x:Math.round((p.x-f.bounds.x)*f.width/f.bounds.width),y:Math.round((p.y-f.bounds.y)*f.height/f.bounds.height),label:p.label}:this.attention??null;return {observationId:f.id,capturedAt:f.capturedAt,image:{width:f.width,height:f.height},pointer:f.cursor,window:f.window,attention};}
 markModelObservation(f,{generation=this.generation}={}){
  if(generation!==this.generation)throw new Error('The observation belongs to an interrupted request');
  if(!f?.id||this.observations.get(f.id)!==f||!Number.isFinite(f.capturedAt))throw new Error('The model observation is no longer available');
  this.modelObservations??=new Map();
  for(const[id,entry]of this.modelObservations)if(entry.generation!==generation||this.observations.get(id)!==entry.frame)this.modelObservations.delete(id);
  this.modelObservations.set(f.id,{generation,frame:f,observation:{id:f.id,capturedAt:f.capturedAt,window:{...f.window},captureSource:f.captureSource}});
  this.lastModelObservationId=f.id;return f;
 }
 modelObservation(observationId){
  const id=observationId===undefined?this.lastModelObservationId:observationId,entry=this.modelObservations?.get(id);
  return entry&&entry.generation===this.generation&&this.observations.get(id)===entry.frame?entry.observation:null;
 }
 shareModelObservation(f,{generation=this.generation}={}){
  if(!f||generation!==this.generation||!this.state.running||!this.state.watching||this.state.screenPrivacyBlocked||this.privacyConfigurationError||this.observations.get(f.id)!==f||excludedProcess(f.window,this.state.excludedApps))return false;
  this.markModelObservation(f,{generation});this.publish({lastVisionAt:Date.now()});this.emit('visionFrame',f);return true;
 }
 frameContent(f){return [{type:'inputText',text:JSON.stringify(this.metadata(f))},{type:'inputImage',imageUrl:'data:image/jpeg;base64,'+f.image}];}
 observationContext(){const user=this.messages.filter(m=>m.role==='user').at(-1),reply=this.messages.filter(m=>m.role==='assistant'&&m.source!=='noticed').at(-1);return{lastUserMessage:user?{at:user.at,text:user.text.slice(0,1600)}:null,lastAssistantReply:reply?{at:reply.at,text:reply.text.slice(0,1600)}:null};}
 async watch(){
  if(this.state.instructionsSaving||this.updatingPrompt||this.promptRecoveryBlocked)return;
  const now=Date.now(),context=this.observationContext();
  if(this.watchPending||!this.state.running||!this.state.watching||!this.state.backgroundVision||!this.state.proactive||this.state.noticeSnoozeUntil>now||this.state.busy||this.userRequests||this.transcribing||this.state.dictating||this.state.connection!=='connected'||now-this.lastWatchAt<this.state.backgroundInterval||now-(this.lastNoticeAt??0)<NOTICE_COOLDOWN||!this.latest)return;
  const fp=Buffer.from(this.latest.fingerprint,'base64');if(screenDifference(fp,this.lastWatchFingerprint)<5)return;
  const generation=this.generation;this.watchPending=true;
  try{
   await this.assertScreenAllowed({mode:this.state.captureMode,frame:this.latest});
   if(generation!==this.generation||!this.state.running||!this.state.watching||!this.state.backgroundVision||this.state.connection!=='connected'||this.state.busy||this.userRequests||!this.state.proactive||this.state.noticeSnoozeUntil>Date.now())return;
   this.lastWatchAt=Date.now();this.lastWatchFingerprint=fp;
   await this.turn(JSON.stringify({event:'screen_update',proactive:true,context,recentNotices:this.messages.filter(m=>m.source==='noticed').slice(-8).map(m=>({at:m.at,text:m.text,subject:m.notice?.subject})),noticeFeedback:this.state.noticeFeedback.slice(-12).map(f=>({subject:f.subject,value:f.value}))}),{background:true});
  }catch(e){if(e.code!=='SCREEN_PRIVACY_BLOCKED')throw e;}finally{this.watchPending=false;}
 }
 assertModelAvailable(){if(this.state.connection!=='connected')throw new Error('Codex is reconnecting. Your input remains available to retry.');if(this.state.stopping||this.desktopActionsRevoked&&this.t3InFlight)throw new Error('The previous request has not stopped yet. Your message has not been sent.');if([this.state.usage?.primary,this.state.usage?.secondary].some(w=>w?.usedPercent>=100))throw new Error('Your included Codex allowance is used up. Wait for its reset.');}
 async submit(text,{source='text',onAccepted}={}){
  text=String(text);if(text.length>MAX_MESSAGE_LENGTH){const error=new RangeError(`Message exceeds the ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')}-character limit (received ${text.length.toLocaleString('en-US')}). Shorten it and try again; nothing was sent.`);error.code='MESSAGE_TOO_LONG';error.limit=MAX_MESSAGE_LENGTH;error.length=text.length;throw error;}if(!text.trim())return;
  const fast=fastCommand(text),request=this.submitSequence=(this.submitSequence??0)+1;
  if((this.state.instructionsSaving||this.promptRecoveryBlocked)&&!['stop','mute'].includes(fast?.kind))throw new Error('Instructions are still being saved or recovered. Your message has not been sent.');
  if(!fast)this.assertModelAvailable();
  if(fast&&!['stop','mute'].includes(fast.kind)){if(this.state.stopping||this.desktopActionsRevoked&&this.t3InFlight)throw new Error('The previous request has not stopped yet. Focus the Workspace to check its status');if(!this.state.control)throw new Error('App control is turned off');if(!this.state.running||!this.state.watching)throw new Error('Screen sharing is paused; resume it before controlling an app');}
  if(!this.state.running&&!['stop','mute'].includes(fast?.kind))await this.configure({running:true});
  this.userRequests=(this.userRequests??0)+1;let accepted=false,message;
  const accept=()=>{if(accepted)return;accepted=true;if(message){message.delivery='sent';this.emit('messageUpdated',{...message});}onAccepted?.();};
  try{
   message=this.message('user',text,{source,delivery:'pending',...(fast?{localCommand:true}:{})});const interrupted=await this.interrupt(),token=this.generation;
   const current=()=>{if(request!==this.submitSequence||token!==this.generation||this.closed)throw new Error('Request interrupted');};current();
   if(fast?.kind==='stop'){this.message('assistant',interrupted?.confirmed===false?'Stopping the request.':'Stopped.',{source:'local'});accept();return;}
   if(fast?.kind==='mute'){await this.configure({inputMode:'wispr'});current();this.message('assistant','Microphone paused.',{source:'local'});accept();return;}
   if(fast){
    const id='local-'+randomUUID(),started=Date.now(),guard=()=>{current();if(interrupted?.confirmed===false||this.state.stopping||this.desktopActionsRevoked&&this.t3InFlight)throw new Error('The previous request has not stopped yet; no app input was sent');if(!this.state.running||!this.state.watching)throw new Error('Screen sharing is paused');if(!this.state.control)throw new Error('App control is turned off');};
    this.activityEvent({id,kind:'tool',title:'screen_action',text:fast.label,status:'running'});
    try{
     guard();let target=await this.assertScreenAllowed();guard();
     if(fast.browser||fast.kind==='browser'){target=await this.focusBrowser({guard,allowOpen:fast.kind==='browser'});guard();}
     if(fast.kind!=='browser'){
      let action={kind:fast.kind,key:fast.key,delta:fast.delta,windowId:target?.id};
      if(fast.atCursor){const f=await this.observe();guard();if(f.window.id!==target?.id)throw new Error('The target changed; no input was sent');Object.assign(action,coordinates(f,f.cursor.x,f.cursor.y));}
      const verified=await this.assertScreenAllowed();guard();if(!target?.id||verified.id!==target.id)throw new Error('The target changed; no input was sent');
      await this.bridge.call('action',action);guard();
     }
     this.activityEvent({id,kind:'tool',title:'screen_action',status:'completed',durationMs:Date.now()-started});this.message('assistant',fast.label+'.',{source:'local'});if(this.state.spokenReplies)this.emit('speak',fast.label+'.');this.publish({lastReplyMs:Date.now()-started});accept();return;
    }catch(e){this.activityEvent({id,kind:'tool',title:'screen_action',status:'failed',text:e.message});throw e;}
   }
   current();await this.turn(text,{onAccepted:accept});if(!accepted)throw new Error('Request interrupted before dispatch');
  }catch(e){if(message&&!accepted){message.delivery='failed';message.deliveryError=e.message;this.emit('messageUpdated',{...message});this.save().catch(()=>{});}throw e;}
  finally{this.userRequests--;}
 }
 async focusBrowser({guard=()=>{},allowOpen=true}={}){
  const browser=w=>/^(chrome|msedge|firefox|brave|vivaldi|opera)(\.exe)?$/i.test(w?.process??'');
  const active=await this.assertScreenAllowed();guard();if(browser(active))return active;
  const ws=await this.bridge.call('windows');guard();const choices=ws.filter(w=>browser(w)&&!excludedProcess(w,this.state.excludedApps));
  if(choices.length>1)throw new Error('Several browser windows are open. Focus the browser you want, then try again');
  if(choices.length===1){const w=choices[0];await this.assertScreenAllowed();guard();await this.bridge.call('action',{kind:'focus',query:w.id});guard();const focused=await this.assertScreenAllowed();guard();if(focused.id!==w.id)throw new Error('The requested browser could not be focused');return focused;}
  if(allowOpen&&this.openBrowser&&!this.state.excludedApps.length){guard();await this.openBrowser();guard();return null;}
  throw new Error('Open and focus your browser first');
 }
 async turn(text,{background=false,onAccepted}={}){
  if(this.state.instructionsSaving||this.promptRecoveryBlocked)throw new Error('Instructions are still being saved or recovered. Your message has not been sent.');
  if(this.state.connection!=='connected')throw new Error('Codex is reconnecting. Your input remains available to retry.');if([this.state.usage?.primary,this.state.usage?.secondary].some(w=>w?.usedPercent>=100)){this.publish({backgroundVision:false});throw new Error('Your included Codex allowance is used up. Wait for its reset.');}
  const turnModel=background?'gpt-6-luna':this.state.model,turnEffort=background?'low':this.state.effort;const token=++this.generation;this.background=background;this.actionCount=0;this.lastActionError=null;this.agentItems=new Map();this.turnId=null;this.turnStart=Date.now();this.firstReply=false;this.activeThreadId=this.threadId;
  this.publish({busy:true,background,activity:background?'Refreshing screen context':'Thinking'});if(!background)this.emit('responseStart',{generation:token});
  const input=[{type:'text',text}];let finish,threadId=this.threadId,modelFrame;const completed=new Promise(resolve=>{finish=resolve;this.finishTurn=resolve;});
  try{
   if(background){const r=await this.rpc.call('thread/start',{...this.threadParams(),model:turnModel,ephemeral:true},30000);threadId=r.thread.id;if(token!==this.generation)return;this.activeThreadId=threadId;}
   const captureStart=Date.now();
   if(this.state.watching){try{const f=await this.observe(null,{maxWidth:background?1600:2560});modelFrame=f;input.push({type:'text',text:JSON.stringify({event:'screen_observation',...this.metadata(f)})},{type:'image',url:'data:image/jpeg;base64,'+f.image});}catch(e){if(e.code!=='SCREEN_PRIVACY_BLOCKED')throw e;if(background)return;input.push({type:'text',text:JSON.stringify({event:'screen_privacy',blocked:true,reason:e.message,scope:'Hephaestus screen sharing only; continue with this text request'})});}}
   if(token!==this.generation)return;this.publish({captureMs:Date.now()-captureStart});
   this.ledger?.setContext(threadId,{model:turnModel,purpose:this.dataDir.includes('verification')?'verification':background?'screen refresh':'conversation',request:background?text:this.messages.filter(m=>m.role==='user').at(-1)?.text??text,source:'live',startedAt:this.turnStart});
   const pending=this.rpc.call('turn/start',{threadId,input,model:turnModel,effort:turnEffort,summary:'auto',serviceTierForTurn:'default'},60000);this.starting=pending;const r=await pending;if(this.starting===pending)this.starting=null;
   if(token!==this.generation){this.ignoredTurns??=new Set();this.ignoredTurns.add(r.turn.id);await this.rpc.call('turn/interrupt',{threadId,turnId:r.turn.id}).catch(()=>{});throw new Error('Request interrupted');}this.turnId=r.turn.id;if(modelFrame)this.shareModelObservation(modelFrame,{generation:token});onAccepted?.();
   const timeout=setTimeout(()=>{if(token===this.generation){this.interrupt().catch(()=>{});this.publish({error:'The response timed out. Please try again.'});}finish();},90000);await completed;clearTimeout(timeout);
  }catch(e){if(token===this.generation){this.message('system',e.message);this.publish({error:e.message});}throw e;}
  finally{if(background&&threadId!==this.threadId)this.rpc.call('thread/unsubscribe',{threadId}).catch(()=>{});if(token===this.generation){this.turnId=null;this.finishTurn=null;this.publish({busy:false,background:false,lastTotalMs:Date.now()-this.turnStart,activity:'Ready'});}}
 }
 onNotification(m){
  const p=m.params??{};
  if(m.method==='account/rateLimits/updated')this.publish({usage:p.rateLimits});
  if(m.method==='thread/tokenUsage/updated'){const context=this.ledger?.contexts[p.threadId];this.ledger?.record(p.threadId,p.tokenUsage.total,context?{...context,at:new Date().toISOString(),tools:this.activities.filter(a=>a.at>=context.startedAt&&a.kind==='tool').map(a=>a.title),contextTokens:p.tokenUsage.last?.inputTokens}:{});if(this.ledger)this.publish({tokens:this.ledger.summary(),lastTokens:p.tokenUsage.last});return;}
  if(p.threadId!==(this.activeThreadId??this.threadId))return;
  const id=p.turnId??p.turn?.id;if(id&&this.ignoredTurns?.has(id))return;if(!this.state.busy&&m.method!=='error')return;
  if(m.method==='turn/started')this.turnId=p.turn.id;
  if(m.method==='item/reasoning/summaryTextDelta'&&!this.background){const key='reasoning-'+p.itemId+'-'+p.summaryIndex;const old=this.activities.find(e=>e.id===key);this.activityEvent({id:key,kind:'reasoning',title:'Reasoning summary',text:(old?.text??'')+p.delta,status:'running'});}
  if(m.method==='item/agentMessage/delta'&&!this.background){
   if(!this.firstReply){this.firstReply=true;this.publish({lastReplyMs:Date.now()-this.turnStart});}
   this.agentItems??=new Map();const full=(this.agentItems.get(p.itemId)??'')+p.delta;this.agentItems.set(p.itemId,full);this.emit('delta',{itemId:p.itemId,turnId:p.turnId,generation:this.generation,text:p.delta,full});
  }
  if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&!this.background&&p.item.text){const previous=this.agentItems?.get(p.item.id)??'';if(previous!==p.item.text){this.emit('delta',{itemId:p.item.id,turnId:p.turnId,generation:this.generation,full:p.item.text,text:p.item.text.startsWith(previous)?p.item.text.slice(previous.length):p.item.text});this.agentItems??=new Map();this.agentItems.set(p.item.id,p.item.text);}this.message('assistant',p.item.text,{providerItemId:p.item.id,turnId:p.turnId,toolWarning:this.lastActionError??null});this.emit('speechFlush');}
  if(m.method==='error')this.publish({error:p.error?.message??'Codex reported an error'});
  if(m.method==='turn/completed'){for(const e of [...this.activities])if(e.status==='running'&&e.kind==='reasoning')this.activityEvent({...e,status:'completed'});this.finishTurn?.();}
 }
 async onTool(m,rpc=this.rpc){
  const token=this.generation;
  const activityId='tool-'+(m.params?.callId??m.id),started=Date.now();
  const shared=frame=>{const commit=()=>this.shareModelObservation(frame,{generation:token});if(rpc.deferSharedFrame)rpc.deferSharedFrame(commit);else commit();};
  const reply=(content,frame)=>{if(m.params.tool==='screen_action')this.lastActionError=null;this.activityEvent({id:activityId,kind:'tool',title:m.params.tool,status:'completed',durationMs:Date.now()-started});rpc.reply(m.id,{success:true,contentItems:typeof content==='string'?[{type:'inputText',text:content}]:content});if(frame)shared(frame);};
  try{
   rpc.assertActive?.();
   if(m.method!=='item/tool/call'){rpc.reply(m.id,{decision:'decline'});return;}
   if(m.params.threadId!==(this.activeThreadId??this.threadId)||!this.state.running||!this.state.busy||this.ignoredTurns?.has(m.params.turnId)||m.params.turnId!==this.turnId)throw new Error('This turn is no longer active');
   const tool=m.params.tool,a=typeof m.params.arguments==='string'?JSON.parse(m.params.arguments):m.params.arguments??{};
   this.activityEvent({id:activityId,kind:'tool',title:tool,status:'running',text:a.reason??'',background:this.background});
   if(tool==='screen_observe'){const f=await this.observe(null,a);rpc.assertActive?.();if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(f),f);return;}
   if(tool==='screen_windows'){const windows=await this.bridge.call('windows');rpc.assertActive?.();if(token!==this.generation)throw new Error('Interrupted');reply(JSON.stringify(windows.filter(w=>!excludedProcess(w,this.state.excludedApps))));return;}
   if(tool==='companion_notice'){
    const text=String(a.text??'').trim().slice(0,1500);if(!text)throw new Error('Enter a notice');
    const notice={...a,text},evaluate=()=>evaluateNotice({notice,context:this.observationContext(),recentNotices:this.messages.filter(m=>m.source==='noticed'),feedback:this.state.noticeFeedback,enabled:!this.background||this.state.proactive,snoozeUntil:this.background?this.state.noticeSnoozeUntil:0,lastNoticeAt:this.background?this.lastNoticeAt:0,observation:this.modelObservation(a.observationId),background:this.background});let result=evaluate();
    if(result.status==='suppressed'){reply(JSON.stringify(result));return;}
    if(this.background){if(!this.state.watching){reply(JSON.stringify({status:'suppressed',reason:'screen-paused',retry:false}));return;}try{await this.assertScreenAllowed({mode:this.state.captureMode,frame:this.modelObservation(a.observationId)});}catch(e){if(e.code!=='SCREEN_PRIVACY_BLOCKED')throw e;reply(JSON.stringify({status:'suppressed',reason:'screen-private',retry:false}));return;}rpc.assertActive?.();if(token!==this.generation)throw new Error('Interrupted');result=evaluate();}
    if(result.status==='suppressed'){reply(JSON.stringify(result));return;}
    this.lastNoticeAt=Date.now();const message=this.message('assistant',text,{source:'noticed',notice});if(this.state.spokenReplies)this.emit('speak',text);reply(JSON.stringify({...result,id:message.id}));return;
   }
   if(++this.actionCount>20)throw new Error('Tool limit reached for this reply');
   const f=this.observations.get(a.observationId);if(!f||Date.now()-f.capturedAt>15000)throw new Error('Observation expired. Observe again.');
   await this.assertScreenAllowed({mode:this.state.captureMode,frame:f});rpc.assertActive?.();if(token!==this.generation||!this.state.watching)throw new Error('Interrupted');
   if(tool==='screen_zoom'){
    const p=framePoint(f,a.x,a.y),q=framePoint(f,a.x+a.width,a.y+a.height);if(a.width<16||a.height<16)throw new Error('Zoom region is too small');
    const fresh=await this.observe({x:p.x,y:p.y,width:q.x-p.x,height:q.y-p.y});rpc.assertActive?.();if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(fresh),fresh);return;
   }
   if(tool==='screen_action'){
    if(this.background)throw new Error('Application control requires a user request');if(!this.state.control)throw new Error('App control is turned off');
    let actionFrame=f;const steps=a.kind==='sequence'?a.steps:[a];if(!Array.isArray(steps)||!steps.length||steps.length>6)throw new Error('Use between one and six actions');for(const step of steps){validateAction(step);if(a.kind==='sequence'&&['focus','browser'].includes(step.kind))throw new Error('A sequence must stay in the observed window');}if(a.needsConfirmation)await this.askConfirmation(a);rpc.assertActive?.();if(token!==this.generation||!this.state.control)throw new Error('Interrupted');
    if(a.focusTarget&&!['focus','browser'].includes(a.kind)){const current=await this.assertScreenAllowed({frame:f});rpc.assertActive?.();if(token!==this.generation||!this.state.control)throw new Error('Interrupted');if(current.id!==f.window.id){await this.bridge.call('action',{kind:'focus',query:f.window.id});const fresh=await this.observe();if(fresh.window.id!==f.window.id||fresh.width!==f.width||fresh.height!==f.height||screenDifference(Buffer.from(fresh.fingerprint,'base64'),Buffer.from(f.fingerprint,'base64'))>8){this.lastActionError='The intended window changed; no input was sent. Use this fresh observation to retry.';this.activityEvent({id:activityId,kind:'tool',title:tool,status:'failed',text:this.lastActionError,durationMs:Date.now()-started});rpc.reply(m.id,{success:false,contentItems:[{type:'inputText',text:this.lastActionError},...this.frameContent(fresh)]});shared(fresh);return;}actionFrame=fresh;}}
    this.publish({activity:a.reason||`Using ${a.kind}`});this.emit('action',{kind:a.kind,reason:a.reason,at:Date.now()});
    for(const step of steps){await this.assertScreenAllowed({frame:actionFrame});rpc.assertActive?.();if(token!==this.generation||!this.state.running||!this.state.watching||!this.state.control)throw new Error('Interrupted');if(step.kind==='browser')await this.focusBrowser({guard:()=>{rpc.assertActive?.();if(token!==this.generation||!this.state.control)throw new Error('Interrupted');}});else{const request={...step,windowId:actionFrame.window.id};if(['click','doubleclick','rightclick','scroll'].includes(step.kind)&&Number.isFinite(step.x))Object.assign(request,coordinates(actionFrame,step.x,step.y));await this.bridge.call('action',request);}}
    const fresh=await this.observe();rpc.assertActive?.();if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(fresh),fresh);return;
   }
   if(this.background&&!this.state.proactive)throw new Error('Spontaneous highlights are off');
   if(tool==='screen_annotate')this.emit('annotation',{mark:validateAnnotation(a,f),frame:f});
   else if(tool==='move_attention'){const point=framePoint(f,a.x,a.y);this.attention={x:a.x,y:a.y,observationId:f.id,label:String(a.label??'').slice(0,120)};this.emit('attention',{point,label:this.attention.label});}
   else throw new Error('Unknown tool');reply('Shown');
  }catch(e){if(m.params?.tool==='screen_action')this.lastActionError=e.message;this.activityEvent({id:activityId,kind:'tool',title:m.params?.tool??'Request',status:'failed',text:e.message,durationMs:Date.now()-started});this.emit('toolError',{tool:m.params?.tool,message:e.message});try{rpc.reply(m.id,{success:false,contentItems:[{type:'inputText',text:e.message}]});}catch{}}
 }
 async askConfirmation(action){const promise=new Promise((resolve,reject)=>{this.confirmation={resolve,reject};this.confirmationTimer=setTimeout(()=>this.confirm(false),60000);});this.emit('confirmation',{reason:action.reason||'Approve this action?',kind:action.kind});return promise;}
 confirm(approved){clearTimeout(this.confirmationTimer);const c=this.confirmation;this.confirmation=null;if(c)approved?c.resolve():c.reject(new Error('The action was declined'));this.emit('confirmation',null);}
 async interrupt(){
  const token=++this.generation;this.emit('silence');this.confirm(false);
  const threadId=this.activeThreadId??this.threadId,rpc=this.rpc,id=this.turnId,finish=this.finishTurn;this.turnId=null;this.finishTurn=null;
  const cancel=async id=>{if(!id||!rpc)return;this.ignoredTurns??=new Set();this.ignoredTurns.add(id);await rpc.call('turn/interrupt',{threadId,turnId:id},5000).catch(()=>{});};
  if(this.starting){const pending=this.starting;this.starting=null;const cancelled=pending.then(r=>cancel(r?.turn?.id)).catch(()=>{});await Promise.race([cancelled,new Promise(resolve=>setImmediate(resolve))]);}
  await cancel(id);finish?.();if(token===this.generation)this.publish({busy:false,background:false,activity:'Ready'});
 }
 async replacePrompt(prompt,{persist}={}){
  await this.interrupt();const old=this.threadId;
  const result=await this.rpc.call('thread/start',{...this.threadParams(),baseInstructions:prompt},60000);
  const items=this.messages.filter(m=>['user','assistant'].includes(m.role)).slice(-40).map(m=>({type:'message',role:m.role,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}));
  if(items.length)await this.rpc.call('thread/inject_items',{threadId:result.thread.id,items},60000);
  try{await (persist??(options=>this.save({...options,settings:{...this.state,prompt}})))({threadId:result.thread.id});}catch(error){await this.rpc.call('thread/unsubscribe',{threadId:result.thread.id}).catch(()=>{});throw error;}
  this.threadId=result.thread.id;this.savedThread=this.threadId;this.state.prompt=prompt;
  if(old)this.rpc.call('thread/unsubscribe',{threadId:old}).catch(()=>{});
 }
 async noticeFeedback(id,value){
  if(!['useful','dismiss'].includes(value))throw new Error('Choose useful or dismiss');
  const message=this.messages.find(m=>m.id===id&&m.source==='noticed');if(!message)throw new Error('Notice not found');
  const feedback={id,value,at:Date.now(),text:message.text,subject:message.notice?.subject??message.text};
  this.state.noticeFeedback=[...this.state.noticeFeedback.filter(f=>f.id!==id),feedback].slice(-150);message.noticeFeedback=value;this.emit('messageUpdated',{...message});this.publish();await this.save();return this.state;
 }
 async configure(p){
  if(p.model!==undefined&&this.models&&!this.models.some(m=>m.id===p.model))throw new Error('Choose an available Codex model');
  if(p.inputMode!==undefined&&!['always','wispr'].includes(p.inputMode))throw new Error('Choose always-on or Wispr input');
  if(p.prompt!==undefined&&(typeof p.prompt!=='string'||!p.prompt.trim()||p.prompt.length>32000))throw new Error('Enter a prompt between 1 and 32,000 characters');
  if(p.noticeSnoozeUntil!==undefined&&(!Number.isFinite(p.noticeSnoozeUntil)||p.noticeSnoozeUntil<0))throw new Error('Choose a valid notice snooze time');
  if(p.noticeFeedback!==undefined)throw new Error('Use feedback on a notice to update its relevance');
  if(p.captureMode!==undefined&&!['window','monitor'].includes(p.captureMode))throw new Error('Choose window or monitor capture');
  if(p.excludedApps!==undefined)p={...p,excludedApps:excludedApps(p.excludedApps)};
  const instructionEdit=p.prompt!==undefined&&p.prompt!==this.state.prompt,protective={};
  for(const key of ['running','watching','control','backgroundVision','proactive','autoSend',...(!instructionEdit?['spokenReplies']:[])])if(p[key]===false)protective[key]=false;
  if(p.inputMode==='wispr')protective.inputMode='wispr';
  if(p.noticeSnoozeUntil>Date.now()&&p.noticeSnoozeUntil>this.state.noticeSnoozeUntil)protective.noticeSnoozeUntil=p.noticeSnoozeUntil;
  if(p.excludedApps!==undefined)protective.excludedApps=[...new Set([...this.state.excludedApps,...p.excludedApps])];
  const onlyProtective=Object.keys(p).every(key=>Object.hasOwn(protective,key));
  if(this.state.instructionsSaving&&!onlyProtective)throw new Error('Instructions are already being saved. Wait before changing settings.');
  if(instructionEdit&&this.state.connection!=='connected')throw new Error('Wait for the connection to recover before saving instructions. Your edits have not been saved.');
  this.settingsSafetyRevisions??={};const revisions={...this.settingsSafetyRevisions};
  // Revocation must precede both the settings queue and any disk or runtime wait.
  for(const [key,value]of Object.entries(protective)){this.state[key]=value;revisions[key]=this.settingsSafetyRevisions[key]=(this.settingsSafetyRevisions[key]??0)+1;}
  if(p.running===false||p.inputMode!==undefined||p.inputDevice!==undefined)this.invalidateVoiceInput();
  const stopping=p.running===false||p.watching===false||p.control===false||this.background&&(p.backgroundVision===false||p.proactive===false||p.noticeSnoozeUntil>Date.now());
  const interrupted=stopping?this.interrupt():Promise.resolve();
  interrupted.catch(()=>{}); // The transaction still awaits this result after any earlier settings write.
  if(p.running===false||p.watching===false||p.excludedApps!==undefined){this.clearScreen();if(!this.state.watching||!this.state.running)this.publish({screenPrivacyBlocked:false,screenPrivacyReason:null,screenWindow:null,captureSource:null});}
  if(Object.keys(protective).length)this.publish();
  if(Object.keys(p).length===1&&p.running===false){await interrupted;return this.state;}
  const patch=()=>Object.fromEntries([...settingsKeys,'running'].filter(key=>p[key]!==undefined&&(this.settingsSafetyRevisions[key]??0)===(revisions[key]??0)).map(key=>[key,p[key]]));
  const apply=next=>{for(const key of Object.keys(patch()))this.state[key]=next[key];if(p.excludedApps!==undefined)this.privacyConfigurationError=null;};
  const transaction=async()=>{
   const replace=p.prompt!==undefined&&p.prompt!==this.state.prompt;
   const candidate=()=>{const next={...this.state,...patch()};next.opacity=Math.max(.45,Math.min(1,Number(next.opacity)||1));next.backgroundInterval=Math.max(10000,Math.min(600000,Number(next.backgroundInterval)||20000));return next;};
   try{
    await interrupted;
    if(replace){
     if(this.state.connection!=='connected')throw new Error('Wait for the connection to recover before saving instructions. Your edits have not been saved.');
     const next=candidate();let release;this.promptSaveBarrier=new Promise(resolve=>release=resolve);this.publish({instructionsSaving:true});
     try{await this.replacePrompt(p.prompt,{persist:options=>this.save({settings:next,...options})});apply(next);}finally{this.promptSaveBarrier=null;this.publish({instructionsSaving:false});release();}
    }else{
     let committed=candidate();await this.save({settings:()=>committed=candidate(),onSaved:apply});apply(committed);
    }
   }catch(error){
    if(Object.keys(protective).some(key=>settingsKeys.includes(key))){const message=error.message+' Your safety changes remain active for this session, but were not saved. Retry before restarting.';this.settingsSaveError=message;this.publish({error:message});throw Object.assign(new Error(message,{cause:error}),{code:error.code});}
    throw error;
   }
   if(p.inputMode==='always'&&this.state.inputMode==='always')await this.startSpeech();this.publish();if(this.state.running)try{await this.sample();}catch(error){this.publish({screenError:error.message});}return this.state;
  };
  const update=(this.configureQueue??Promise.resolve()).catch(()=>{}).then(transaction);this.configureQueue=update;
  try{return await update;}finally{if(this.configureQueue===update)this.configureQueue=null;}
 }
 async close(){this.closed=true;this.invalidateVoiceInput();clearInterval(this.screenTimer);clearInterval(this.visionTimer);clearInterval(this.usageTimer);clearTimeout(this.reconnectTimer);clearTimeout(this.bridgeTimer);clearTimeout(this.speechTimer);try{await this.interrupt();await this.configureQueue?.catch(()=>{});await this.historyImport;await this.saveQueue;await this.ledger?.flush();}finally{this.rpc?.close();this.speech?.close();this.bridge?.close();}}
}
