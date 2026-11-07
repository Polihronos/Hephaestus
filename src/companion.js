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

export const dynamicTools=[
 {type:'function',name:'screen_observe',description:'Get a fresh screenshot and observationId. Choose monitor to see the desktop, Start menu, or multiple apps; window gives the active app clearly.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['window','monitor']},monitor:{type:'integer'}},additionalProperties:false}},
 {type:'function',name:'screen_annotate',description:'Draw a temporary screen mark. Coordinates use screenshot pixels. Does not click or type.',inputSchema:{type:'object',properties:{observationId:{type:'string'},kind:{type:'string',enum:['circle','rectangle','arrow','label','path','clear']},x:{type:'number'},y:{type:'number'},x2:{type:'number'},y2:{type:'number'},radius:{type:'number'},color:{type:'string',enum:['mint','amber','rose','blue']},label:{type:'string'},ttl:{type:'number'},points:{type:'array',items:{type:'object',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y'],additionalProperties:false}}},required:['observationId','kind'],additionalProperties:false}},
 {type:'function',name:'move_attention',description:'Move the small mascot near a point and highlight what you are discussing. Coordinates use screenshot pixels.',inputSchema:{type:'object',properties:{observationId:{type:'string'},x:{type:'number'},y:{type:'number'},label:{type:'string'}},required:['observationId','x','y'],additionalProperties:false}}
];
dynamicTools.push(
 {type:'function',name:'screen_zoom',description:'Read a small area clearly at native resolution. Region coordinates are pixels in a previous observation.',inputSchema:{type:'object',properties:{observationId:{type:'string'},x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}},required:['observationId','x','y','width','height'],additionalProperties:false}},
 {type:'function',name:'screen_windows',description:'List visible applications and their window IDs.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {type:'function',name:'screen_action',description:'Control an app on a user request. Every action returns a fresh observation; reuse it instead of observing again. For a stable input, sequence can click, type and press Enter in one call (at most six steps on the same window). Set focusTarget=true to bring that observed window forward immediately before input; changed content returns a fresh observation instead.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['click','doubleclick','rightclick','scroll','key','type','focus','browser','sequence']},observationId:{type:'string'},x:{type:'number'},y:{type:'number'},key:{type:'string'},text:{type:'string'},query:{type:'string'},delta:{type:'integer'},focusTarget:{type:'boolean'},needsConfirmation:{type:'boolean'},reason:{type:'string'},steps:{type:'array',maxItems:6,items:{type:'object',properties:{kind:{type:'string',enum:['click','doubleclick','rightclick','scroll','key','type']},x:{type:'number'},y:{type:'number'},key:{type:'string'},text:{type:'string'},delta:{type:'integer'}},required:['kind'],additionalProperties:false}}},required:['kind','observationId'],additionalProperties:false}},
 {type:'function',name:'companion_notice',description:'Show a useful, specific spontaneous insight as a small popup. Speech follows the user setting. Paused, duplicate or cooling-down notices return a normal suppressed result; do not retry.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}
);
const settingsKeys=['model','effort','watching','backgroundVision','spokenReplies','monitor','prompt','opacity','autoSend','voice','mascotPosition','inputMode','inputDevice','control','proactive','captureMode','backgroundInterval'];
export class Companion extends EventEmitter{
 constructor({root,dataDir,excludePids=[],openBrowser}){super();Object.assign(this,{root,dataDir,excludePids,openBrowser});this.state={name:'Hephaestus',connection:'connecting',plan:null,model:'gpt-6-luna',effort:'low',running:true,watching:true,backgroundVision:true,spokenReplies:false,monitor:-1,busy:false,activity:'Connecting',inputMode:'wispr',inputDevice:'default',control:true,proactive:true,captureMode:'window',backgroundInterval:20000,opacity:1,autoSend:true,voice:'',prompt:'',speech:'off',listening:false,usage:null,error:null};this.frames=[];this.observations=new Map();this.messages=[];this.activities=[];this.generation=0;this.closed=false;this.lastWatchAt=Date.now();this.spokenHistory=[];}
 publish(extra={}){Object.assign(this.state,extra);this.emit('state',{...this.state});}
 message(role,text,extra={}){const m={id:randomUUID(),role,text,at:Date.now(),...extra};this.messages.push(m);this.messages=this.messages.slice(-120);this.emit('message',m);if(this.threadId)this.save().catch(()=>{});return m;}
 async start(){await mkdir(this.dataDir,{recursive:true});this.defaultPrompt=await readFile(join(this.root,'assets','system-prompt.txt'),'utf8');let s={};try{s=JSON.parse(await readFile(join(this.dataDir,'settings.json'),'utf8'));}catch{}for(const k of settingsKeys)if(s[k]!==undefined)this.state[k]=s[k];if(!s.defaultsRevision){this.state.inputMode='wispr';this.state.spokenReplies=false;}if(!s.lunaRevision){this.state.model='gpt-6-luna';this.state.effort='low';}if(!this.state.prompt||(s.promptVersion<4&&this.state.prompt.startsWith('You are my spoken screen companion.')))this.state.prompt=this.defaultPrompt;this.messages=(s.messages??[]).filter(m=>m&&typeof m.text==='string').slice(-120);for(const m of this.messages)this.emit('message',m);this.savedThread=s.promptVersion===4&&s.performanceRevision===2?s.threadId:null;
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
 async transcribe(audio){
  if(this.state.inputMode!=='always'||!this.state.running||this.state.dictating||this.state.speech!=='ready')return;
  if(this.transcribing){this.voiceAudioQueue??=[];if(this.voiceAudioQueue.length<3)this.voiceAudioQueue.push(audio);return;}
  this.transcribing=true;const epoch=this.voiceEpoch??0;
  try{const result=await this.speech.call('transcribe',{audio},60000);if(epoch!==(this.voiceEpoch??0)||!this.state.running||this.state.dictating)return;
   const text=result.text?.trim();if(!text)return;const normalize=s=>s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();const heard=normalize(text);
   const echo=this.spokenHistory.some(s=>Date.now()-s.at<10000&&heard.length>8&&(normalize(s.text).includes(heard)||heard.includes(normalize(s.text))));
   if(echo){this.publish({voiceActivity:'Playback echo rejected'});return;}
   this.publish({lastRecognitionMs:result.elapsedMs});this.submit(text,{source:'voice'}).catch(e=>this.publish({error:e.message}));
  }finally{this.transcribing=false;this.publish({hearing:false});const next=this.voiceAudioQueue?.shift();if(next)setImmediate(()=>this.transcribe(next).catch(e=>this.publish({error:e.message})));}
 }
 scheduleReconnect(){if(this.closed||this.reconnectTimer)return;this.publish({connection:'reconnecting',busy:false,activity:'Reconnecting to Codex'});const delay=Math.min(30000,1500*2**(this.reconnectAttempts??0));this.reconnectAttempts=(this.reconnectAttempts??0)+1;this.reconnectTimer=setTimeout(async()=>{this.reconnectTimer=null;this.rpc?.removeAllListeners('disconnected');this.rpc?.close();try{await this.connect();this.reconnectAttempts=0;}catch(e){this.publish({error:e.message});this.scheduleReconnect();}},delay);}
 threadParams(){return {cwd:join(this.dataDir,'context'),model:this.state.model,modelProvider:'openai',sandbox:'read-only',approvalPolicy:'never',baseInstructions:this.state.prompt,developerInstructions:'',config:{model_reasoning_effort:this.state.effort,model_reasoning_summary:'auto',project_doc_max_bytes:0},dynamicTools};}
 async openThread(){const p=this.threadParams();let r;if(this.savedThread){try{const {dynamicTools,...resume}=p;r=await this.rpc.call('thread/resume',{...resume,threadId:this.savedThread,excludeTurns:true},60000);}catch{}}if(!r){r=await this.rpc.call('thread/start',p,60000);const items=this.messages.filter(m=>['user','assistant'].includes(m.role)).slice(-40).map(m=>({type:'message',role:m.role,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}));if(items.length)await this.rpc.call('thread/inject_items',{threadId:r.thread.id,items});}this.threadId=r.thread.id;this.savedThread=this.threadId;await this.save();}
 async connect(){
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
  this.publish({connection:'connected',plan:account.account.planType,models:this.models,activity:'Ready',error:null});
  await this.updateUsage();
 }
 async save(){const s={promptVersion:4,defaultsRevision:1,performanceRevision:2,lunaRevision:1,threadId:this.threadId,messages:this.messages};for(const k of settingsKeys)s[k]=this.state[k];this.saveQueue=(this.saveQueue??Promise.resolve()).catch(()=>{}).then(async()=>{const tmp=join(this.dataDir,'settings.tmp');await writeFile(tmp,JSON.stringify(s,null,2));await rename(tmp,join(this.dataDir,'settings.json'));});return this.saveQueue;}
 async updateUsage(){if(this.state.connection!=='connected')return;const r=await this.rpc.call('account/rateLimits/read',{});this.publish({usage:r.rateLimits});}
 async sample(){if(this.sampling||!this.state.running||!this.state.watching)return;this.sampling=true;try{const f=await this.bridge.call('capture',{monitor:this.state.monitor,mode:this.state.captureMode,maxWidth:2560});if(!this.state.running||!this.state.watching)return;f.id=randomUUID();this.latest=f;this.frames=[f];this.publish({screenWindow:f.window.title,screenError:null,captureSource:f.captureSource});this.emit('frame',f);}finally{this.sampling=false;}}
 async observe(region,options={}){if(!this.state.running||!this.state.watching)throw new Error('Screen sharing is paused');const f=await this.bridge.call('capture',{monitor:options.monitor??this.state.monitor,mode:options.mode??this.state.captureMode,maxWidth:options.maxWidth??2560,...(region?{region}:{})});if(!this.state.running||!this.state.watching)throw new Error('Screen sharing was paused');f.id=randomUUID();this.latest=f;this.observations.set(f.id,f);if(this.observations.size>20)this.observations.delete(this.observations.keys().next().value);this.publish({lastVisionAt:Date.now()});this.emit('visionFrame',f);return f;}
 metadata(f){const p=this.attentionPhysical;const attention=p?{x:Math.round((p.x-f.bounds.x)*f.width/f.bounds.width),y:Math.round((p.y-f.bounds.y)*f.height/f.bounds.height),label:p.label}:this.attention??null;return {observationId:f.id,capturedAt:f.capturedAt,image:{width:f.width,height:f.height},pointer:f.cursor,window:f.window,attention};}
 frameContent(f){return [{type:'inputText',text:JSON.stringify(this.metadata(f))},{type:'inputImage',imageUrl:'data:image/jpeg;base64,'+f.image}];}
 observationContext(){const user=this.messages.filter(m=>m.role==='user').at(-1),reply=this.messages.filter(m=>m.role==='assistant'&&m.source!=='noticed').at(-1);return{lastUserMessage:user?{at:user.at,text:user.text.slice(0,1600)}:null,lastAssistantReply:reply?{at:reply.at,text:reply.text.slice(0,1600)}:null};}
 async watch(){if(!this.state.running||!this.state.watching||!this.state.backgroundVision||!this.state.proactive||this.state.busy||this.userRequests||this.transcribing||this.state.dictating||this.state.connection!=='connected'||Date.now()-this.lastWatchAt<this.state.backgroundInterval||Date.now()-(this.lastNoticeAt??0)<60000||!this.latest)return;const fp=Buffer.from(this.latest.fingerprint,'base64');if(screenDifference(fp,this.lastWatchFingerprint)<5)return;this.lastWatchAt=Date.now();this.lastWatchFingerprint=fp;await this.turn(JSON.stringify({event:'screen_update',proactive:true,context:this.observationContext(),recentNotices:this.messages.filter(m=>m.source==='noticed').slice(-4).map(m=>({at:m.at,text:m.text}))}),{background:true});}
 async submit(text,{source='text'}={}){
  text=String(text).trim().slice(0,16000);if(!text)return;if(!this.state.running)await this.configure({running:true});this.userRequests=(this.userRequests??0)+1;
  try{this.message('user',text,{source});await this.interrupt();const detected=fastCommand(text),fast=this.state.runtime==='t3'&&!['stop','mute'].includes(detected?.kind)?null:detected;if(fast?.kind==='stop')return;if(fast?.kind==='mute'){await this.configure({inputMode:'wispr'});return;}
   if(fast&&this.state.control){const id='local-'+randomUUID(),started=Date.now();this.activityEvent({id,kind:'tool',title:'screen_action',text:fast.label,status:'running'});
    try{if(fast.browser||fast.kind==='browser')await this.focusBrowser();if(fast.kind!=='browser'){const f=await this.observe();const a={...fast,windowId:f.window.id};if(fast.atCursor)Object.assign(a,coordinates(f,f.cursor.x,f.cursor.y));await this.bridge.call('action',a);}await this.observe();this.activityEvent({id,kind:'tool',title:'screen_action',status:'completed',durationMs:Date.now()-started});this.message('assistant',fast.label+'.');this.emit('speak',fast.label+'.');this.publish({lastReplyMs:Date.now()-started});return;}
    catch(e){this.activityEvent({id,kind:'tool',title:'screen_action',status:'failed',text:e.message});throw e;}
   }
   await this.turn(text);
  }finally{this.userRequests--;}
 }
 async focusBrowser(){const ws=await this.bridge.call('windows');const w=ws.find(w=>/^(chrome|msedge|firefox|brave|vivaldi|opera)$/i.test(w.process));if(w)return this.bridge.call('action',{kind:'focus',query:w.id});if(this.openBrowser)return this.openBrowser();throw new Error('Open your browser first');}
 async turn(text,{background=false}={}){
  if(this.state.connection!=='connected')throw new Error('Codex is reconnecting. Your input remains available to retry.');if([this.state.usage?.primary,this.state.usage?.secondary].some(w=>w?.usedPercent>=100)){this.publish({backgroundVision:false});throw new Error('Your included Codex allowance is used up. Wait for its reset.');}
  const turnModel=background?'gpt-6-luna':this.state.model,turnEffort=background?'low':this.state.effort;const token=++this.generation;this.background=background;this.actionCount=0;this.lastActionError=null;this.agentItems=new Map();this.turnId=null;this.turnStart=Date.now();this.firstReply=false;this.activeThreadId=this.threadId;
  this.publish({busy:true,background,activity:background?'Refreshing screen context':'Thinking'});if(!background)this.emit('responseStart',{generation:token});
  const input=[{type:'text',text}];let finish,threadId=this.threadId;const completed=new Promise(resolve=>{finish=resolve;this.finishTurn=resolve;});
  try{
   if(background){const r=await this.rpc.call('thread/start',{...this.threadParams(),model:turnModel,ephemeral:true},30000);threadId=r.thread.id;if(token!==this.generation)return;this.activeThreadId=threadId;}
   const captureStart=Date.now();
   if(this.state.watching){let f=background?null:this.latest;const target=f&&Date.now()-f.capturedAt<=1000?await this.bridge.call('target-info'):null;if(!f||!target||target.id!==f.window.id)f=await this.observe(null,{maxWidth:background?1600:2560});else{this.observations.set(f.id,f);this.publish({lastVisionAt:Date.now()});this.emit('visionFrame',f);}input.push({type:'text',text:JSON.stringify({event:'screen_observation',...this.metadata(f)})},{type:'image',url:'data:image/jpeg;base64,'+f.image});}
   if(token!==this.generation)return;this.publish({captureMs:Date.now()-captureStart});
   this.ledger?.setContext(threadId,{model:turnModel,purpose:this.dataDir.includes('verification')?'verification':background?'screen refresh':'conversation',request:background?text:this.messages.filter(m=>m.role==='user').at(-1)?.text??text,source:'live',startedAt:this.turnStart});
   const pending=this.rpc.call('turn/start',{threadId,input,model:turnModel,effort:turnEffort,summary:'auto',serviceTierForTurn:'default'},60000);this.starting=pending;const r=await pending;if(this.starting===pending)this.starting=null;
   if(token!==this.generation){this.ignoredTurns??=new Set();this.ignoredTurns.add(r.turn.id);await this.rpc.call('turn/interrupt',{threadId,turnId:r.turn.id}).catch(()=>{});return;}this.turnId=r.turn.id;
   const timeout=setTimeout(()=>{if(token===this.generation){this.interrupt().catch(()=>{});this.publish({error:'The response timed out. Please try again.'});}finish();},90000);await completed;clearTimeout(timeout);
  }catch(e){if(token===this.generation){this.message('system',e.message);this.publish({error:e.message});}}
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
  if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&!this.background&&p.item.text){this.message('assistant',p.item.text,{providerItemId:p.item.id,turnId:p.turnId,toolWarning:this.lastActionError??null});this.emit('speechFlush');}
  if(m.method==='error')this.publish({error:p.error?.message??'Codex reported an error'});
  if(m.method==='turn/completed'){for(const e of [...this.activities])if(e.status==='running'&&e.kind==='reasoning')this.activityEvent({...e,status:'completed'});this.finishTurn?.();}
 }
 async onTool(m,rpc=this.rpc){
  const token=this.generation;
  const activityId='tool-'+(m.params?.callId??m.id),started=Date.now();
  const reply=content=>{if(m.params.tool==='screen_action')this.lastActionError=null;this.activityEvent({id:activityId,kind:'tool',title:m.params.tool,status:'completed',durationMs:Date.now()-started});rpc.reply(m.id,{success:true,contentItems:typeof content==='string'?[{type:'inputText',text:content}]:content});};
  try{
   if(m.method!=='item/tool/call'){rpc.reply(m.id,{decision:'decline'});return;}
   if(m.params.threadId!==(this.activeThreadId??this.threadId)||!this.state.running||!this.state.busy||this.ignoredTurns?.has(m.params.turnId)||m.params.turnId!==this.turnId)throw new Error('This turn is no longer active');
   const tool=m.params.tool,a=typeof m.params.arguments==='string'?JSON.parse(m.params.arguments):m.params.arguments??{};
   this.activityEvent({id:activityId,kind:'tool',title:tool,status:'running',text:a.reason??'',background:this.background});
   if(tool==='screen_observe'){const f=await this.observe(null,a);if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(f));return;}
   if(tool==='screen_windows'){reply(JSON.stringify(await this.bridge.call('windows')));return;}
   if(tool==='companion_notice'){
    const text=String(a.text??'').trim().slice(0,1500);if(!text)throw new Error('Enter a notice');
    const recent=this.messages.filter(m=>m.source==='noticed'&&Date.now()-m.at<600000),normalize=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    const reason=!this.state.proactive&&this.background?'paused':this.background&&Date.now()-(this.lastNoticeAt??0)<60000?'cooldown':recent.some(m=>normalize(m.text)===normalize(text))?'duplicate':null;
    if(reason){reply(JSON.stringify({status:'suppressed',reason,retry:false}));return;}
    this.lastNoticeAt=Date.now();this.message('assistant',text,{source:'noticed'});if(this.state.spokenReplies)this.emit('speak',text);reply(JSON.stringify({status:'shown'}));return;
   }
   if(++this.actionCount>20)throw new Error('Tool limit reached for this reply');
   const f=this.observations.get(a.observationId);if(!f||Date.now()-f.capturedAt>15000)throw new Error('Observation expired. Observe again.');
   if(tool==='screen_zoom'){
    const p=framePoint(f,a.x,a.y),q=framePoint(f,a.x+a.width,a.y+a.height);if(a.width<16||a.height<16)throw new Error('Zoom region is too small');
    const fresh=await this.observe({x:p.x,y:p.y,width:q.x-p.x,height:q.y-p.y});if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(fresh));return;
   }
   if(tool==='screen_action'){
    if(this.background)throw new Error('Application control requires a user request');if(!this.state.control)throw new Error('App control is turned off');
    let actionFrame=f;const steps=a.kind==='sequence'?a.steps:[a];if(!Array.isArray(steps)||!steps.length||steps.length>6)throw new Error('Use between one and six actions');for(const step of steps){validateAction(step);if(a.kind==='sequence'&&['focus','browser'].includes(step.kind))throw new Error('A sequence must stay in the observed window');}if(a.needsConfirmation)await this.askConfirmation(a);if(token!==this.generation||!this.state.control)throw new Error('Interrupted');
    if(a.focusTarget&&!['focus','browser'].includes(a.kind)){const current=await this.bridge.call('target-info');if(current.id!==f.window.id){await this.bridge.call('action',{kind:'focus',query:f.window.id});const fresh=await this.observe();if(fresh.window.id!==f.window.id||fresh.width!==f.width||fresh.height!==f.height||screenDifference(Buffer.from(fresh.fingerprint,'base64'),Buffer.from(f.fingerprint,'base64'))>8){this.lastActionError='The intended window changed; no input was sent. Use this fresh observation to retry.';this.activityEvent({id:activityId,kind:'tool',title:tool,status:'failed',text:this.lastActionError,durationMs:Date.now()-started});rpc.reply(m.id,{success:false,contentItems:[{type:'inputText',text:this.lastActionError},...this.frameContent(fresh)]});return;}actionFrame=fresh;}}
    this.publish({activity:a.reason||`Using ${a.kind}`});this.emit('action',{kind:a.kind,reason:a.reason,at:Date.now()});
    for(const step of steps){if(token!==this.generation)throw new Error('Interrupted');if(step.kind==='browser')await this.focusBrowser();else{const request={...step,windowId:actionFrame.window.id};if(['click','doubleclick','rightclick','scroll'].includes(step.kind)&&Number.isFinite(step.x))Object.assign(request,coordinates(actionFrame,step.x,step.y));await this.bridge.call('action',request);}}
    const fresh=await this.observe();if(token!==this.generation)throw new Error('Interrupted');reply(this.frameContent(fresh));return;
   }
   if(this.background&&!this.state.proactive)throw new Error('Spontaneous highlights are off');
   if(tool==='screen_annotate')this.emit('annotation',{mark:validateAnnotation(a,f),frame:f});
   else if(tool==='move_attention'){const point=framePoint(f,a.x,a.y);this.attention={x:a.x,y:a.y,observationId:f.id,label:String(a.label??'').slice(0,120)};this.emit('attention',{point,label:this.attention.label});}
   else throw new Error('Unknown tool');reply('Shown');
  }catch(e){if(m.params?.tool==='screen_action')this.lastActionError=e.message;this.activityEvent({id:activityId,kind:'tool',title:m.params?.tool??'Request',status:'failed',text:e.message,durationMs:Date.now()-started});this.emit('toolError',{tool:m.params?.tool,message:e.message});try{rpc.reply(m.id,{success:false,contentItems:[{type:'inputText',text:e.message}]});}catch{}}
 }
 async askConfirmation(action){const promise=new Promise((resolve,reject)=>{this.confirmation={resolve,reject};this.confirmationTimer=setTimeout(()=>this.confirm(false),60000);});this.emit('confirmation',{reason:action.reason||'Approve this action?',kind:action.kind});return promise;}
 confirm(approved){clearTimeout(this.confirmationTimer);const c=this.confirmation;this.confirmation=null;if(c)approved?c.resolve():c.reject(new Error('The action was declined'));this.emit('confirmation',null);}
 async interrupt(){this.generation++;this.emit('silence');this.confirm(false);if(this.starting){const p=this.starting;const r=await p.catch(()=>null);if(this.starting===p)this.starting=null;if(r?.turn?.id)this.turnId=r.turn.id;}if(this.turnId&&this.rpc){const id=this.turnId;this.ignoredTurns??=new Set();this.ignoredTurns.add(id);this.turnId=null;await this.rpc.call('turn/interrupt',{threadId:this.activeThreadId??this.threadId,turnId:id},5000).catch(()=>{});}this.finishTurn?.();this.finishTurn=null;this.publish({busy:false,background:false,activity:'Ready'});}
 async replacePrompt(prompt){
  await this.interrupt();const old=this.threadId;
  const result=await this.rpc.call('thread/start',{...this.threadParams(),baseInstructions:prompt},60000);
  const items=this.messages.filter(m=>['user','assistant'].includes(m.role)).slice(-40).map(m=>({type:'message',role:m.role,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}));
  if(items.length)await this.rpc.call('thread/inject_items',{threadId:result.thread.id,items},60000);
  this.threadId=result.thread.id;this.savedThread=this.threadId;
  if(old)this.rpc.call('thread/unsubscribe',{threadId:old}).catch(()=>{});
 }
 async configure(p){if(p.model!==undefined&&this.models&&!this.models.some(m=>m.id===p.model))throw new Error('Choose an available Codex model');if(p.inputMode!==undefined&&!['always','wispr'].includes(p.inputMode))throw new Error('Choose always-on or Wispr input');if(p.prompt!==undefined&&(typeof p.prompt!=='string'||!p.prompt.trim()||p.prompt.length>32000))throw new Error('Enter a prompt between 1 and 32,000 characters');const replace=p.prompt!==undefined&&p.prompt!==this.state.prompt;if(replace&&this.state.connection==='connected')await this.replacePrompt(p.prompt);for(const k of [...settingsKeys,'running'])if(p[k]!==undefined)this.state[k]=p[k];this.state.opacity=Math.max(.45,Math.min(1,Number(this.state.opacity)||1));if(p.running===false||p.inputMode==='wispr')this.voiceEpoch=(this.voiceEpoch??0)+1;if(p.running===false||p.watching===false){await this.interrupt();this.frames=[];this.observations.clear();this.latest=null;}if(p.inputMode==='always')await this.startSpeech();this.publish();await this.save();if(this.state.running)await this.sample();return this.state;}
 async close(){this.closed=true;clearInterval(this.screenTimer);clearInterval(this.visionTimer);clearInterval(this.usageTimer);clearTimeout(this.reconnectTimer);clearTimeout(this.bridgeTimer);clearTimeout(this.speechTimer);await this.interrupt();await this.historyImport;await this.ledger?.flush();this.rpc?.close();this.speech?.close();this.bridge?.close();}
}
