import {Companion,dynamicTools} from './companion.js';
import {T3Client} from './t3-client.js';
import {startDesktopServer} from './desktop-server.js';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {T3Workspace,t3Tools} from './t3-workspace.js';

const cleanText=text=>(text??'').replace(/^<previous_conversation>[\s\S]*?<\/previous_conversation>\s*/,'').split(/<screen_observation>|<recent_companion_observations>|<companion_runtime>/)[0].trim();
const terminal=new Set(['completed','failed','cancelled','interrupted','rolled_back']);
const timestamp=(...values)=>{for(const value of values){if(value==null)continue;const at=Date.parse(value);if(Number.isFinite(at))return at;}return null;};
export class T3Companion extends Companion {
 async connect(){
  const previous=this.t3;this.t3=null;this.workspace?.close();this.stopT3Subscription?.();await previous?.close();
  await super.connect();this.publish({connection:'connecting',activity:'Connecting Hephaestus to T3'});
  this.desktopServer??=await startDesktopServer(this);
  const t3=this.t3=new T3Client();t3.on('fault',e=>this.publish({error:e.message}));
  await t3.start();this.t3Config=await t3.call('server.getConfig');
  const provider=this.t3Config.providers.find(p=>p.instanceId==='codex'&&p.status==='ready');if(!provider)throw new Error('Enable your Codex provider in T3 Code.');if(provider.auth?.type!=='chatgpt')throw new Error('Hephaestus requires the T3 Codex provider to use your ChatGPT subscription.');
  if(!provider.models.some(m=>m.slug==='gpt-6-luna'))throw new Error('GPT-6 Luna is not available in the T3 Codex provider.');
  if(!provider.models.some(m=>m.slug===this.state.model))this.state.model='gpt-6-luna';
  this.models=provider.models.filter(m=>!m.isLegacy).map(m=>({id:m.slug,name:m.name,efforts:m.capabilities?.optionDescriptors?.find(o=>o.id==='reasoningEffort')?.options.map(o=>o.id)??['low']}));
  await this.prepareWorkspace();
  let saved={};try{saved=JSON.parse(await readFile(join(this.dataDir,'t3-runtime.json'),'utf8'));}catch{}
  this.desktopToolVersion=saved.adapterVersion??0;
  this.t3ProjectId=saved.projectId;
  const projects=await fetch(t3.origin+'/api/projects',{headers:{Authorization:'Bearer '+t3.token}}).then(r=>r.json());
  const list=projects.projects??projects;const existing=Array.isArray(list)?list.find(p=>p.workspaceRoot.toLowerCase()===join(this.dataDir,'context').toLowerCase()):null;
  if(existing)this.t3ProjectId=existing.id;
  if(!this.t3ProjectId){const p=await t3.call('projects.mutate',{type:'project.create',commandId:randomUUID(),projectId:randomUUID(),title:'Hephaestus',workspaceRoot:join(this.dataDir,'context'),defaultModelSelection:this.modelSelection(),scripts:[]});this.t3ProjectId=p.id;}
  const luna={instanceId:'codex',model:'gpt-6-luna',options:[{id:'reasoningEffort',value:'low'},{id:'serviceTier',value:'default'}]},existingOverrides=this.t3Config.settings.projectSettingsOverrides?.[this.t3ProjectId]??{};
  const budgetDefaults={defaultModelSelection:luna,textGenerationModelSelection:luna,sourceControlWriterModelSelection:luna,reviewGuideModelSelection:luna,responseStreamingMode:'paragraph'};
  if(Object.entries(budgetDefaults).some(([k,v])=>JSON.stringify(existingOverrides[k])!==JSON.stringify(v)))await t3.call('server.updateSettings',{patch:{projectSettingsOverrides:{[this.t3ProjectId]:{...existingOverrides,...budgetDefaults}}}});
  this.t3ThreadId=saved.threadId;this.t3Seen=new Map();this.providerNativeIds=new Map();this.providerContexts=new Map();this.t3Runs=new Map();this.t3Attempts=new Map();
  if(this.t3ThreadId){
   let projection;try{projection=await t3.call('orchestration.getThreadProjection',{threadId:this.t3ThreadId});}catch{this.t3ThreadId=null;}
   if(projection){this.restoreProjection(projection);this.hasT3History=projection.runs.length>0;if(this.desktopToolVersion!==5&&!this.t3InFlight)await this.reloadDesktopTools(projection);}
  }
  if(!this.t3ThreadId){const r=await t3.call('orchestration.launchThread',{commandId:randomUUID(),projectId:this.t3ProjectId,title:'Hephaestus',modelSelection:this.modelSelection(),runtimeMode:'full-access',interactionMode:'default',workspaceStrategy:{type:'root'}});this.t3ThreadId=r.threadId;this.desktopToolVersion=5;}
  await this.saveT3();
  this.workspace=await new T3Workspace({client:t3,dataDir:this.dataDir,context:()=>this.runtimeContext(),onActivity:e=>this.activityEvent(e)}).start();
  this.stopT3Subscription?.();this.stopT3Subscription=t3.subscribe('orchestration.subscribeThread',{threadId:this.t3ThreadId},item=>this.t3Stream(item));
  t3.on('disconnected',()=>{if(!this.closed&&this.t3===t3){this.publish({connection:'reconnecting',activity:'Reconnecting to T3'});this.t3Finish?.();this.scheduleReconnect();}});
  this.publish({connection:'connected',runtime:'t3',t3ThreadId:this.t3ThreadId,t3Origin:t3.origin,models:this.models,activity:this.t3InFlight?'Continuing your request':'Ready',busy:!!this.t3InFlight,error:null});
  await this.save();
 }
 modelSelection(){return{instanceId:'codex',model:this.state.model,options:[{id:'reasoningEffort',value:this.state.effort??'low'},{id:'serviceTier',value:'default'}]};}
 runtimeContext(){return{name:'Hephaestus',runtime:'T3 Code through Codex',model:this.state.model,projectId:this.t3ProjectId,threadId:this.t3ThreadId,t3Connected:!!this.t3?.token,desktopConnected:!!this.bridge,appControl:this.state.control,watching:this.state.watching,proactive:this.state.proactive,desktopTools:dynamicTools.map(t=>t.name),workspaceTool:'t3_workspace',promptFile:join(this.dataDir,'context','AGENTS.md')};}
 observationContext(){return{...super.observationContext(),workspaceOperations:(this.workspace?.operations??[]).slice(-4).map(o=>({threadTitle:o.threadTitle,projectTitle:o.projectTitle,status:o.status,error:o.error})),conversationBusy:!!this.t3InFlight};}
 async prepareWorkspace(){
  const cwd=join(this.dataDir,'context');await mkdir(join(cwd,'.codex'),{recursive:true});await writeFile(join(cwd,'AGENTS.md'),this.state.prompt+'\n');
  const bridge=join(this.root,'src','desktop-mcp.js');await writeFile(join(cwd,'.codex','config.toml'),`[mcp_servers.hephaestus]\ncommand = "node"\nargs = [${JSON.stringify(bridge.replaceAll('\\','/'))}, ${JSON.stringify(join(this.dataDir,'desktop-bridge.json').replaceAll('\\','/'))}]\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n`);
  const config=join(homedir(),'.codex','config.toml');let text=await readFile(config,'utf8');const key=JSON.stringify(cwd.replaceAll('\\','/'));if(!text.includes(`[projects.${key}]`)){text+=`\n[projects.${key}]\ntrust_level = "trusted"\n`;await writeFile(config,text);}
 }
 async saveT3(){
  const data=JSON.stringify({version:1,adapterVersion:this.desktopToolVersion??5,projectId:this.t3ProjectId,threadId:this.t3ThreadId},null,2);
  this.t3SaveQueue=(this.t3SaveQueue??Promise.resolve()).catch(()=>{}).then(async()=>{const file=join(this.dataDir,'t3-runtime.json');await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);});
  return this.t3SaveQueue;
 }
 async reloadDesktopTools(projection){
  const p=projection??await this.t3.call('orchestration.getThreadProjection',{threadId:this.t3ThreadId});
  if(p.thread?.activeRunId||(p.runs??[]).some(r=>!terminal.has(r.status)))throw new Error('The conversation is still working. Tool updates will apply after it finishes.');
  for(const session of p.providerSessions??[])if(session.status!=='stopped')await this.t3.call('orchestration.dispatchCommand',{type:'provider-session.detach',commandId:randomUUID(),threadId:this.t3ThreadId,providerSessionId:session.id,reason:'Reload Hephaestus desktop tools'});
  this.desktopToolVersion=5;await this.saveT3();
 }
 beginExternalRun(run){
  const nativeTurn=this.turnId,nativeThread=this.activeThreadId;this.generation++;if(this.background&&nativeTurn){this.ignoredTurns??=new Set();this.ignoredTurns.add(nativeTurn);this.rpc.call('turn/interrupt',{threadId:nativeThread,turnId:nativeTurn}).catch(()=>{});this.finishTurn?.();this.finishTurn=null;}
  this.t3InFlight=true;this.externalT3Run=true;this.desktopActionsRevoked=false;this.background=false;this.turnId=null;this.t3RunId=run.id;this.t3TurnStart=Date.now();this.t3FirstText=false;this.t3MessageId=run.userMessageId;this.currentUserText=run.request??'';this.actionCount=0;this.lastActionError=null;this.emit('responseStart',{generation:this.generation});this.publish({busy:true,stopping:false,background:false,activity:run.status==='waiting'?'Waiting for your answer':'Thinking'});
 }
 restoreProjection(p){
  for(const run of p.runs??[])this.t3Runs.set(run.id,{...run,request:cleanText(p.messages?.find(m=>m.id===run.userMessageId)?.text)});
  for(const attempt of p.attempts??[])this.t3Attempts.set(attempt.id,attempt.runId);
  for(const item of p.turnItems??[])this.t3Seen.set(item.id,item);
  const active=(p.runs??[]).find(r=>r.id===p.thread?.activeRunId)??[...(p.runs??[])].reverse().find(r=>!terminal.has(r.status));
  if(active&&!this.ignoredT3Runs?.has(active.id)){
   if(!this.t3InFlight)this.beginExternalRun(this.t3Runs.get(active.id));
   this.t3RunId=active.id;
   this.publish({busy:true,background:false,activity:active.status==='waiting'?'Waiting for your answer':'Continuing your request'});
  }else if(this.t3RunId&&p.runs?.some(r=>r.id===this.t3RunId&&terminal.has(r.status))){
   this.t3Finish?.();
   if(this.externalT3Run||this.desktopActionsRevoked){this.externalT3Run=false;this.t3InFlight=false;this.turnId=null;this.publish({busy:false,stopping:false,background:false,activity:'Ready'});}
  }
  // Restore missing transcript items without replaying speech or opening old popups.
  for(const item of p.turnItems??[]){
   if(item.streaming||!['assistant_message','user_message'].includes(item.type))continue;
   const user=item.type==='user_message',remote=item.messageId?p.messages?.find(m=>m.id===item.messageId):null,run=this.t3Runs.get(item.runId);
   const at=user?timestamp(remote?.createdAt,item.startedAt,item.createdAt,item.completedAt,run?.requestedAt,item.updatedAt):timestamp(item.completedAt,item.startedAt,item.createdAt,item.updatedAt);
   const existing=this.messages.find(m=>m.providerItemId===item.id||(user&&item.messageId&&m.t3MessageId===item.messageId));
   if(existing){
    let changed=false;
    if(user&&existing.delivery!=='sent'){existing.delivery='sent';delete existing.deliveryError;changed=true;}
    if(at!==null&&existing.at!==at){existing.at=at;changed=true;}
    if(changed)this.emit('messageUpdated',{...existing});
   }else this.messages.push({id:randomUUID(),role:user?'user':'assistant',text:user?cleanText(item.text):item.text??'',at,providerItemId:item.id,...(user?{source:'workspace',t3MessageId:item.messageId}:{turnId:item.runId})});
  }
  this.messages.sort((a,b)=>(a.at??0)-(b.at??0));this.messages=this.messages.slice(-120);
  this.emit('messagesRestored',this.messages);
  for(const provider of p.providerThreads??[])this.providerUpdate(provider);
  for(const turn of p.providerTurns??[])this.providerTurnUpdate(turn);
 }
 t3Stream(item){
  if(item.kind==='snapshot'){this.restoreProjection(item.projection);return;}if(item.kind!=='event')return;
  const {type,payload:p}=item.event;if(p.runId&&this.ignoredT3Runs?.has(p.runId))return;
  if(type==='provider-thread.updated')this.providerUpdate(p);
  if(type==='provider-turn.updated')this.providerTurnUpdate(p);
  if(type==='run-attempt.created'||type==='run-attempt.updated')this.t3Attempts.set(p.id,p.runId);
  if(type==='run.created'||type==='run.updated')this.t3Runs.set(p.id,{...p,request:this.currentUserText??this.t3Runs.get(p.id)?.request??''});
  if(type==='run.created'){if(!this.t3InFlight)this.beginExternalRun(p);if(p.userMessageId===this.t3MessageId||this.externalT3Run)this.t3RunId=p.id;const pending=this.t3PendingAcceptance;if(pending?.messageId===p.userMessageId&&pending.generation===this.generation)pending.acknowledge();}
  if(type==='run.updated'&&p.id===this.t3RunId){if(terminal.has(p.status)){if(p.status==='failed')this.publish({error:'T3 could not complete this request. See Activity for details.'});this.t3Finish?.();if(this.externalT3Run||this.desktopActionsRevoked){this.externalT3Run=false;this.t3InFlight=false;this.turnId=null;this.publish({busy:false,stopping:false,activity:'Ready'});}}else this.publish({activity:this.state.stopping?'Stopping':p.status==='waiting'?'Waiting for your answer':'Thinking'});}
  if(type==='thread.model-selection-updated'){this.publish({model:p.modelSelection.model,effort:p.modelSelection.options?.find(o=>o.id==='reasoningEffort')?.value??'low'});this.save().catch(()=>{});}
  if(type!=='turn-item.updated')return;
  const old=this.t3Seen.get(p.id);this.t3Seen.set(p.id,p);
  if(p.type==='assistant_message'){
   if(p.streaming){if(!this.t3FirstText){this.t3FirstText=true;this.publish({lastReplyMs:Date.now()-this.t3TurnStart});}this.emit('delta',{itemId:p.id,turnId:p.runId,generation:this.generation,full:p.text,text:p.text.slice(old?.text?.length??0)});}
   else if(!this.messages.some(m=>m.providerItemId===p.id)){
    if(!this.t3FirstText){this.t3FirstText=true;this.publish({lastReplyMs:Date.now()-this.t3TurnStart});}
    const previous=old?.text??'',remaining=p.text?.startsWith(previous)?p.text.slice(previous.length):old?.streaming?'':p.text;
    if(remaining)this.emit('delta',{itemId:p.id,turnId:p.runId,generation:this.generation,full:p.text,text:remaining});
    this.message('assistant',p.text,{providerItemId:p.id,turnId:p.runId,toolWarning:this.lastActionError??null});this.emit('speechFlush');
   }
  }else if(p.type==='user_message'&&(p.messageId!==this.t3MessageId||this.externalT3Run)&&!this.messages.some(m=>m.t3MessageId===p.messageId)){this.currentUserText=p.text;this.message('user',cleanText(p.text),{source:'workspace',t3MessageId:p.messageId});}
  else if(p.type==='reasoning')this.activityEvent({id:p.id,kind:'reasoning',title:'Reasoning summary',text:p.text,status:p.streaming?'running':'completed'});
  else if(!['user_message','checkpoint'].includes(p.type)&&!p.toolName?.startsWith('hephaestus.'))this.activityEvent({id:p.id,kind:'tool',title:p.toolName??p.title??p.type.replaceAll('_',' '),text:typeof p.input==='string'?p.input:JSON.stringify(p.input??p.error??p.reason??'').slice(0,3000),status:p.status==='running'||p.status==='pending'?'running':p.status==='failed'?'failed':'completed',durationMs:p.completedAt&&p.startedAt?Date.parse(p.completedAt)-Date.parse(p.startedAt):undefined});
 }
 providerUpdate(p){if(p.contextUsage?.usedTokens)this.providerContexts.set(p.id,p.contextUsage.usedTokens);const native=p.nativeThreadRef?.nativeId;if(native)this.providerNativeIds.set(p.id,native);const u=p.contextUsage;if(native&&u?.inputTokens!==undefined){this.ledger?.record(native,{...u,totalTokens:u.totalProcessedTokens??u.inputTokens+(u.outputTokens??0)},{model:this.state.model,purpose:'conversation',prompt:this.currentUserText??'',tools:this.activities.filter(a=>a.at>=this.t3TurnStart&&a.kind==='tool').map(a=>a.title)});this.publish({tokens:this.ledger.summary()});}}
 providerTurnUpdate(p){const native=this.providerNativeIds.get(p.providerThreadId),u=p.turnTokenUsage;if(!native||!u?.inputTokens)return;const run=this.t3Runs.get(this.t3Attempts.get(p.runAttemptId));this.ledger.recordTurn(native,p.id,{inputTokens:u.inputTokens,cachedInputTokens:u.cachedInputTokens,cacheCreationTokens:u.cacheCreationTokens,outputTokens:u.outputTokens,reasoningOutputTokens:u.reasoningTokens,totalTokens:u.inputTokens+u.outputTokens},{at:p.completedAt??p.startedAt,ordinal:p.ordinal,contextTokens:this.providerContexts.get(p.providerThreadId)??0,model:u.models?.[0]??run?.modelSelection?.model??this.state.model,purpose:this.dataDir.includes('verification')?'verification':'conversation',request:run?.request??this.currentUserText??'',tools:[...new Set([...this.t3Seen.values()].filter(i=>i.providerTurnId===p.id&&!['user_message','assistant_message','reasoning','checkpoint'].includes(i.type)).map(i=>i.toolName??i.title??i.type))],source:'live',serviceTier:'default'});this.publish({tokens:this.ledger.summary()});}
 async turn(text,{background=false,onAccepted}={}){
  if(background)return super.turn(text,{background:true});
  if([this.state.usage?.primary,this.state.usage?.secondary].some(w=>w?.usedPercent>=100)){this.publish({backgroundVision:false});throw new Error('Your included Codex allowance is used up. Wait for its reset.');}
  if(!this.t3||this.state.connection!=='connected')throw new Error('T3 is reconnecting. Please try again shortly.');
  if(this.state.stopping||this.desktopActionsRevoked&&this.t3InFlight)throw new Error('The previous request has not stopped yet. Your message has not been sent.');
  if(this.desktopToolVersion!==undefined&&this.desktopToolVersion!==5)await this.reloadDesktopTools();
  const generation=++this.generation;this.background=false;this.desktopActionsRevoked=false;this.actionCount=0;this.lastActionError=null;this.t3TurnStart=Date.now();this.t3FirstText=false;this.observations.clear();this.currentUserText=text;this.t3MessageId=randomUUID();this.t3RunId=null;this.t3InFlight=true;this.externalT3Run=false;const requestId=this.t3MessageId;const localMessage=this.messages.filter(m=>m.role==='user').at(-1);if(localMessage)localMessage.t3MessageId=this.t3MessageId;
  const timings={startedAt:this.t3TurnStart,captureMs:0,attachmentMs:0,dispatchMs:0};
  let accepted=false;const acknowledge=()=>{if(accepted||generation!==this.generation)return;accepted=true;onAccepted?.({requestId});};
  this.t3PendingAcceptance={messageId:requestId,generation,acknowledge};
  this.publish({busy:true,background:false,activity:'Thinking'});this.emit('responseStart',{generation});
  let timer;const done=new Promise(resolve=>{this.t3Finish=resolve;timer=setTimeout(()=>{this.publish({error:'T3 is taking longer than expected. You can stop the request.'});},90000);});
  try{
   let attachments=[],screenText='',sentObservation;if(this.state.watching){
    let f;const captureStarted=Date.now();try{f=await this.observe();}catch(e){if(e.code!=='SCREEN_PRIVACY_BLOCKED')throw e;screenText='\n\nScreen sharing is blocked for the active application by the user’s privacy settings. Continue with text and the existing conversation; do not capture that application through other tools.';}timings.captureMs=Date.now()-captureStarted;
    if(f){const attachmentStarted=Date.now();const result=await this.t3.call('assets.persistChatAttachments',{threadId:this.t3ThreadId,messageId:this.t3MessageId,attachments:[{type:'image',name:'screen-observation.jpg',mimeType:'image/jpeg',sizeBytes:Buffer.from(f.image,'base64').length,dataUrl:'data:image/jpeg;base64,'+f.image}]});timings.attachmentMs=Date.now()-attachmentStarted;attachments=result.attachments;sentObservation=f;screenText='\n\n<screen_observation>\n'+JSON.stringify(this.metadata(f))+'\n</screen_observation>';}
   }
   if(generation!==this.generation)throw new Error('Request cancelled before it was sent.');
   if(sentObservation)this.markModelObservation(sentObservation,{generation});
   const notices=this.messages.filter(m=>m.source==='noticed').slice(-3).map(m=>({at:m.at,text:m.text})),noticeContext=notices.length?'\n\n<recent_companion_observations>\n'+JSON.stringify(notices)+'\n</recent_companion_observations>':'';
   let history='';if(!this.hasT3History){history='<previous_conversation>\n'+this.messages.filter(m=>['user','assistant'].includes(m.role)&&m.delivery!=='failed').slice(-21,-1).map(m=>m.role+': '+m.text).join('\n')+'\n</previous_conversation>\n\n';}
   const runtimeText='\n\n<companion_runtime>\n'+JSON.stringify(this.runtimeContext())+'\n</companion_runtime>';
   const localActions=this.messages.filter(m=>m.localCommand||m.source==='local').slice(-10).map(m=>({role:m.role,text:m.text,at:m.at,delivery:m.delivery??'sent',...(m.deliveryError?{error:m.deliveryError}:{})}));
   const localContext=localActions.length?'\n\n<recent_local_actions>\n'+JSON.stringify(localActions)+'\n</recent_local_actions>':'';
   const dispatchStarted=Date.now();
   await this.t3.call('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId:this.t3ThreadId,messageId:this.t3MessageId,text:history+text+runtimeText+localContext+noticeContext+screenText,attachments,modelSelection:this.modelSelection(),dispatchMode:{type:'start_immediately'}});
   timings.dispatchMs=Date.now()-dispatchStarted;this.publish({lastTimings:{...timings}});
   if(generation!==this.generation){await this.t3.call('orchestration.dispatchCommand',{type:'thread.stop',commandId:randomUUID(),threadId:this.t3ThreadId,reason:'Cancelled while sending'});throw new Error('Request cancelled while it was being sent.');}
   this.hasT3History=true;acknowledge();await done;
  }catch(e){if(accepted){await done;}else{this.publish({error:e.message});throw e;}}
  finally{clearTimeout(timer);if(this.t3PendingAcceptance?.messageId===requestId)this.t3PendingAcceptance=null;if(this.t3MessageId===requestId){this.t3InFlight=false;this.t3Finish=null;this.turnId=null;this.activeThreadId=this.threadId;if(generation===this.generation)this.publish({busy:this.state.connection==='connected'?false:this.state.busy,activity:this.state.connection==='connected'?'Ready':this.state.activity,lastTotalMs:Date.now()-this.t3TurnStart,lastTimings:{...timings,firstTextMs:this.t3FirstText?this.state.lastReplyMs:null,totalMs:Date.now()-this.t3TurnStart}});}await this.ledger?.flush();}
 }
 async invokeDesktopTool(tool,args){
  if(![...dynamicTools,...t3Tools].some(t=>t.name===tool))throw new Error('Unknown Hephaestus tool');
  if(!this.t3InFlight||!this.state.running||!this.state.busy||this.desktopActionsRevoked)throw new Error('No active Hephaestus request');
  if(tool==='t3_workspace'){
   const id=randomUUID(),started=Date.now(),generation=this.generation;this.activityEvent({id,kind:'tool',title:tool,status:'running',text:JSON.stringify(args)});
   try{const result=await this.workspace.execute(args,()=>{if(generation!==this.generation||!this.t3InFlight||!this.state.running)throw new Error('This turn is no longer active');});this.activityEvent({id,kind:'tool',title:tool,status:'completed',text:JSON.stringify(result).slice(0,2500),durationMs:Date.now()-started});return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};}
   catch(e){this.activityEvent({id,kind:'tool',title:tool,status:'failed',text:e.message});return{success:false,contentItems:[{type:'inputText',text:e.message}]};}
  }
  const turnId=this.turnId='t3-'+this.t3RunId,threadId=this.activeThreadId=this.t3ThreadId;
  return new Promise(resolve=>super.onTool({method:'item/tool/call',id:randomUUID(),params:{threadId,turnId,tool,arguments:args}},{reply:(_id,result)=>resolve(result)}));
 }
 async interrupt(){
  if(this.t3InFlight&&this.t3){
   const runId=this.t3RunId,finish=this.t3Finish,requestId=this.t3MessageId;
   this.ignoredT3Runs??=new Set();if(runId)this.ignoredT3Runs.add(runId);
   this.desktopActionsRevoked=true;this.observations.clear();this.generation++;this.emit('silence');this.confirm(false);
   this.publish({busy:true,stopping:true,activity:'Stopping',error:null});
   let transportError;
   try{await this.t3.call('orchestration.dispatchCommand',{type:'thread.stop',commandId:randomUUID(),threadId:this.t3ThreadId,reason:'Interrupted from Hephaestus'});}catch(e){transportError=e;}
   try{
    const projection=await this.t3.call('orchestration.getThreadProjection',{threadId:this.t3ThreadId},10000);
    const active=projection.thread?.activeRunId||(projection.runs??[]).some(r=>!terminal.has(r.status));
    if(!active){
     finish?.();if(this.t3MessageId===requestId){this.t3InFlight=false;this.externalT3Run=false;this.turnId=null;this.publish({busy:false,stopping:false,background:false,activity:'Ready',error:null});}
     return{confirmed:true};
    }
    if(!transportError)return{confirmed:false};
   }catch(e){transportError??=e;}
   const error=new Error('Stop could not be confirmed. Hephaestus desktop actions are blocked; check the Workspace before starting another request.');
   this.publish({busy:true,stopping:false,activity:'Stop not confirmed',error:error.message});throw error;
  }
  return super.interrupt();
 }
 async replacePrompt(prompt){
  if(this.updatingPrompt)throw new Error('Instructions are already being saved.');
  this.updatingPrompt=true;
  try{
   const stopped=await this.interrupt();
   if(stopped?.confirmed===false||this.state.stopping||this.t3InFlight)throw new Error('Your current request is still stopping. Wait for it to finish, then save your instructions again.');
   if(!this.t3)throw new Error('The connection is recovering. Your instructions have not been changed.');
   const path=join(this.dataDir,'context','AGENTS.md'),oldThread=this.t3ThreadId,oldHistory=this.hasT3History;
   let previous;try{previous=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
   const created=await this.t3.call('orchestration.launchThread',{commandId:randomUUID(),projectId:this.t3ProjectId,title:'Hephaestus',modelSelection:this.modelSelection(),runtimeMode:'full-access',interactionMode:'default',workspaceStrategy:{type:'root'}});
   let switched=false,promptWritten=false;
   try{
    await writeFile(path+'.tmp',prompt+'\n');await rename(path+'.tmp',path);promptWritten=true;
    this.stopT3Subscription?.();this.t3ThreadId=created.threadId;this.hasT3History=false;switched=true;
    this.stopT3Subscription=this.t3.subscribe('orchestration.subscribeThread',{threadId:this.t3ThreadId},item=>this.t3Stream(item));
    await this.saveT3();
   }catch(error){
    if(switched){this.stopT3Subscription?.();this.t3ThreadId=oldThread;this.hasT3History=oldHistory;this.stopT3Subscription=this.t3.subscribe('orchestration.subscribeThread',{threadId:oldThread},item=>this.t3Stream(item));}
    if(promptWritten){if(previous!==undefined){await writeFile(path+'.tmp',previous);await rename(path+'.tmp',path);}else await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    await unlink(path+'.tmp').catch(()=>{});
    await this.t3.call('orchestration.dispatchCommand',{type:'thread.archive',commandId:randomUUID(),threadId:created.threadId}).catch(()=>{});
    throw error;
   }
   this.publish({t3ThreadId:this.t3ThreadId,busy:false,stopping:false,activity:'Ready'});
   await this.t3.call('orchestration.dispatchCommand',{type:'thread.archive',commandId:randomUUID(),threadId:oldThread}).catch(error=>{
    this.activityEvent({id:randomUUID(),kind:'tool',title:'Conversation history',status:'failed',text:'Instructions were saved. The previous conversation could not be archived: '+error.message});
   });
  }finally{this.updatingPrompt=false;}
 }
 async close(){
  this.workspace?.close();
  try{await this.interrupt();}catch{/* Local actions were revoked even when remote cancellation is unavailable. */}
  this.stopT3Subscription?.();
  try{await this.t3?.close();}finally{this.t3=null;this.t3InFlight=false;await super.close();this.desktopServer?.close();}
 }
}
