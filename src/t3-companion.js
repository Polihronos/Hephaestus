import {Companion,dynamicTools} from './companion.js';
import {T3Client} from './t3-client.js';
import {startDesktopServer} from './desktop-server.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {T3Workspace,t3Tools} from './t3-workspace.js';

const cleanText=text=>(text??'').replace(/^<previous_conversation>[\s\S]*?<\/previous_conversation>\s*/,'').split(/<screen_observation>|<recent_companion_observations>|<companion_runtime>/)[0].trim();
const terminal=new Set(['completed','failed','cancelled','interrupted','rolled_back']);
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
  this.t3ProjectId=saved.projectId;
  const projects=await fetch(t3.origin+'/api/projects',{headers:{Authorization:'Bearer '+t3.token}}).then(r=>r.json());
  const list=projects.projects??projects;const existing=Array.isArray(list)?list.find(p=>p.workspaceRoot.toLowerCase()===join(this.dataDir,'context').toLowerCase()):null;
  if(existing)this.t3ProjectId=existing.id;
  if(!this.t3ProjectId){const p=await t3.call('projects.mutate',{type:'project.create',commandId:randomUUID(),projectId:randomUUID(),title:'Hephaestus',workspaceRoot:join(this.dataDir,'context'),defaultModelSelection:this.modelSelection(),scripts:[]});this.t3ProjectId=p.id;}
  const luna={instanceId:'codex',model:'gpt-6-luna',options:[{id:'reasoningEffort',value:'low'},{id:'serviceTier',value:'default'}]},existingOverrides=this.t3Config.settings.projectSettingsOverrides?.[this.t3ProjectId]??{};
  const budgetDefaults={defaultModelSelection:luna,textGenerationModelSelection:luna,sourceControlWriterModelSelection:luna,reviewGuideModelSelection:luna,responseStreamingMode:'paragraph'};
  if(Object.entries(budgetDefaults).some(([k,v])=>JSON.stringify(existingOverrides[k])!==JSON.stringify(v)))await t3.call('server.updateSettings',{patch:{projectSettingsOverrides:{[this.t3ProjectId]:{...existingOverrides,...budgetDefaults}}}});
  this.t3ThreadId=saved.threadId;this.t3Seen=new Map();this.providerNativeIds=new Map();this.providerContexts=new Map();this.t3Runs=new Map();this.t3Attempts=new Map();
  if(this.t3ThreadId){try{const p=await t3.call('orchestration.getThreadProjection',{threadId:this.t3ThreadId});this.restoreProjection(p);this.hasT3History=p.runs.length>0;if(saved.adapterVersion!==4)for(const session of p.providerSessions??[])if(session.status!=='stopped')await t3.call('orchestration.dispatchCommand',{type:'provider-session.detach',commandId:randomUUID(),threadId:this.t3ThreadId,providerSessionId:session.id,reason:'Reload Hephaestus desktop tools'});}catch{this.t3ThreadId=null;}}
  if(!this.t3ThreadId){const r=await t3.call('orchestration.launchThread',{commandId:randomUUID(),projectId:this.t3ProjectId,title:'Hephaestus',modelSelection:this.modelSelection(),runtimeMode:'full-access',interactionMode:'default',workspaceStrategy:{type:'root'}});this.t3ThreadId=r.threadId;}
  await this.saveT3();
  this.workspace=await new T3Workspace({client:t3,dataDir:this.dataDir,context:()=>this.runtimeContext(),onActivity:e=>this.activityEvent(e)}).start();
  this.stopT3Subscription?.();this.stopT3Subscription=t3.subscribe('orchestration.subscribeThread',{threadId:this.t3ThreadId},item=>this.t3Stream(item));
  t3.on('disconnected',()=>{if(!this.closed&&this.t3===t3){this.publish({connection:'reconnecting',activity:'Reconnecting to T3'});this.t3Finish?.();this.scheduleReconnect();}});
  this.publish({connection:'connected',runtime:'t3',t3ThreadId:this.t3ThreadId,t3Origin:t3.origin,models:this.models,activity:'Ready',error:null});
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
 async saveT3(){await writeFile(join(this.dataDir,'t3-runtime.json'),JSON.stringify({version:1,adapterVersion:4,projectId:this.t3ProjectId,threadId:this.t3ThreadId},null,2));}
 beginExternalRun(run){
  const nativeTurn=this.turnId,nativeThread=this.activeThreadId;this.generation++;if(this.background&&nativeTurn){this.ignoredTurns??=new Set();this.ignoredTurns.add(nativeTurn);this.rpc.call('turn/interrupt',{threadId:nativeThread,turnId:nativeTurn}).catch(()=>{});this.finishTurn?.();this.finishTurn=null;}
  this.t3InFlight=true;this.externalT3Run=true;this.background=false;this.turnId=null;this.t3RunId=run.id;this.t3TurnStart=Date.now();this.t3FirstText=false;this.t3MessageId=run.userMessageId;this.emit('responseStart',{generation:this.generation});this.publish({busy:true,background:false,activity:'Thinking'});
 }
 restoreProjection(p){for(const run of p.runs??[])this.t3Runs.set(run.id,{...run,request:cleanText(p.messages?.find(m=>m.id===run.userMessageId)?.text)});for(const attempt of p.attempts??[])this.t3Attempts.set(attempt.id,attempt.runId);for(const item of p.turnItems??[])this.t3Seen.set(item.id,item);for(const provider of p.providerThreads??[])this.providerUpdate(provider);for(const turn of p.providerTurns??[])this.providerTurnUpdate(turn);}
 t3Stream(item){
  if(item.kind==='snapshot'){this.restoreProjection(item.projection);return;}if(item.kind!=='event')return;
  const {type,payload:p}=item.event;if(p.runId&&this.ignoredT3Runs?.has(p.runId))return;
  if(type==='provider-thread.updated')this.providerUpdate(p);
  if(type==='provider-turn.updated')this.providerTurnUpdate(p);
  if(type==='run-attempt.created'||type==='run-attempt.updated')this.t3Attempts.set(p.id,p.runId);
  if(type==='run.created'||type==='run.updated')this.t3Runs.set(p.id,{...p,request:this.currentUserText??this.t3Runs.get(p.id)?.request??''});
  if(type==='run.created'){if(!this.t3InFlight)this.beginExternalRun(p);if(p.userMessageId===this.t3MessageId||this.externalT3Run)this.t3RunId=p.id;}
  if(type==='run.updated'&&p.id===this.t3RunId){if(terminal.has(p.status)){if(p.status==='failed')this.publish({error:'T3 could not complete this request. See Activity for details.'});this.t3Finish?.();if(this.externalT3Run){this.externalT3Run=false;this.t3InFlight=false;this.turnId=null;this.publish({busy:false,activity:'Ready'});}}else this.publish({activity:p.status==='waiting'?'Waiting for your answer':'Thinking'});}
  if(type==='thread.model-selection-updated'){this.publish({model:p.modelSelection.model,effort:p.modelSelection.options?.find(o=>o.id==='reasoningEffort')?.value??'low'});this.save().catch(()=>{});}
  if(type!=='turn-item.updated')return;
  const old=this.t3Seen.get(p.id);this.t3Seen.set(p.id,p);
  if(p.type==='assistant_message'){
   if(p.streaming){if(!this.t3FirstText){this.t3FirstText=true;this.publish({lastReplyMs:Date.now()-this.t3TurnStart});}this.emit('delta',{itemId:p.id,turnId:p.runId,generation:this.generation,full:p.text,text:p.text.slice(old?.text?.length??0)});}
   else if(!this.messages.some(m=>m.providerItemId===p.id)){if(!this.t3FirstText){this.t3FirstText=true;this.publish({lastReplyMs:Date.now()-this.t3TurnStart});}this.message('assistant',p.text,{providerItemId:p.id,turnId:p.runId,toolWarning:this.lastActionError??null});this.emit('speechFlush');}
  }else if(p.type==='user_message'&&(p.messageId!==this.t3MessageId||this.externalT3Run)&&!this.messages.some(m=>m.t3MessageId===p.messageId)){this.currentUserText=p.text;this.message('user',cleanText(p.text),{source:'workspace',t3MessageId:p.messageId});}
  else if(p.type==='reasoning')this.activityEvent({id:p.id,kind:'reasoning',title:'Reasoning summary',text:p.text,status:p.streaming?'running':'completed'});
  else if(!['user_message','checkpoint'].includes(p.type)&&!p.toolName?.startsWith('hephaestus.'))this.activityEvent({id:p.id,kind:'tool',title:p.toolName??p.title??p.type.replaceAll('_',' '),text:typeof p.input==='string'?p.input:JSON.stringify(p.input??p.error??p.reason??'').slice(0,3000),status:p.status==='running'||p.status==='pending'?'running':p.status==='failed'?'failed':'completed',durationMs:p.completedAt&&p.startedAt?Date.parse(p.completedAt)-Date.parse(p.startedAt):undefined});
 }
 providerUpdate(p){if(p.contextUsage?.usedTokens)this.providerContexts.set(p.id,p.contextUsage.usedTokens);const native=p.nativeThreadRef?.nativeId;if(native)this.providerNativeIds.set(p.id,native);const u=p.contextUsage;if(native&&u?.inputTokens!==undefined){this.ledger?.record(native,{...u,totalTokens:u.totalProcessedTokens??u.inputTokens+(u.outputTokens??0)},{model:this.state.model,purpose:'conversation',prompt:this.currentUserText??'',tools:this.activities.filter(a=>a.at>=this.t3TurnStart&&a.kind==='tool').map(a=>a.title)});this.publish({tokens:this.ledger.summary()});}}
 providerTurnUpdate(p){const native=this.providerNativeIds.get(p.providerThreadId),u=p.turnTokenUsage;if(!native||!u?.inputTokens)return;const run=this.t3Runs.get(this.t3Attempts.get(p.runAttemptId));this.ledger.recordTurn(native,p.id,{inputTokens:u.inputTokens,cachedInputTokens:u.cachedInputTokens,cacheCreationTokens:u.cacheCreationTokens,outputTokens:u.outputTokens,reasoningOutputTokens:u.reasoningTokens,totalTokens:u.inputTokens+u.outputTokens},{at:p.completedAt??p.startedAt,ordinal:p.ordinal,contextTokens:this.providerContexts.get(p.providerThreadId)??0,model:u.models?.[0]??run?.modelSelection?.model??this.state.model,purpose:this.dataDir.includes('verification')?'verification':'conversation',request:run?.request??this.currentUserText??'',tools:[...new Set([...this.t3Seen.values()].filter(i=>i.providerTurnId===p.id&&!['user_message','assistant_message','reasoning','checkpoint'].includes(i.type)).map(i=>i.toolName??i.title??i.type))],source:'live',serviceTier:'default'});this.publish({tokens:this.ledger.summary()});}
 async turn(text,{background=false}={}){
  if(background)return super.turn(text,{background:true});
  if([this.state.usage?.primary,this.state.usage?.secondary].some(w=>w?.usedPercent>=100)){this.publish({backgroundVision:false});throw new Error('Your included Codex allowance is used up. Wait for its reset.');}
  if(!this.t3||this.state.connection!=='connected')throw new Error('T3 is reconnecting. Please try again shortly.');
  const generation=++this.generation;this.background=false;this.actionCount=0;this.lastActionError=null;this.t3TurnStart=Date.now();this.t3FirstText=false;this.observations.clear();this.currentUserText=text;this.t3MessageId=randomUUID();this.t3RunId=null;this.t3InFlight=true;this.externalT3Run=false;const requestId=this.t3MessageId;const localMessage=this.messages.filter(m=>m.role==='user').at(-1);if(localMessage)localMessage.t3MessageId=this.t3MessageId;
  this.publish({busy:true,background:false,activity:'Thinking'});this.emit('responseStart',{generation});
  let timer;const done=new Promise(resolve=>{this.t3Finish=resolve;timer=setTimeout(()=>{this.publish({error:'T3 is taking longer than expected. You can stop the request.'});},90000);});
  try{
   let attachments=[],screenText='';if(this.state.watching){const f=await this.observe();const result=await this.t3.call('assets.persistChatAttachments',{threadId:this.t3ThreadId,messageId:this.t3MessageId,attachments:[{type:'image',name:'screen-observation.jpg',mimeType:'image/jpeg',sizeBytes:Buffer.from(f.image,'base64').length,dataUrl:'data:image/jpeg;base64,'+f.image}]});attachments=result.attachments;screenText='\n\n<screen_observation>\n'+JSON.stringify(this.metadata(f))+'\n</screen_observation>';}
   if(generation!==this.generation)return;
   const notices=this.messages.filter(m=>m.source==='noticed').slice(-3).map(m=>({at:m.at,text:m.text})),noticeContext=notices.length?'\n\n<recent_companion_observations>\n'+JSON.stringify(notices)+'\n</recent_companion_observations>':'';
   let history='';if(!this.hasT3History){history='<previous_conversation>\n'+this.messages.filter(m=>['user','assistant'].includes(m.role)).slice(-21,-1).map(m=>m.role+': '+m.text).join('\n')+'\n</previous_conversation>\n\n';}
   const runtimeText='\n\n<companion_runtime>\n'+JSON.stringify(this.runtimeContext())+'\n</companion_runtime>';
   await this.t3.call('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId:this.t3ThreadId,messageId:this.t3MessageId,text:history+text+runtimeText+noticeContext+screenText,attachments,modelSelection:this.modelSelection(),dispatchMode:{type:'start_immediately'}});this.hasT3History=true;await done;
  }catch(e){this.message('system',e.message);this.publish({error:e.message});}
  finally{clearTimeout(timer);if(this.t3MessageId===requestId){this.t3InFlight=false;this.t3Finish=null;this.turnId=null;this.activeThreadId=this.threadId;if(generation===this.generation)this.publish({busy:false,activity:'Ready',lastTotalMs:Date.now()-this.t3TurnStart});}await this.ledger?.flush();}
 }
 async invokeDesktopTool(tool,args){
  if(![...dynamicTools,...t3Tools].some(t=>t.name===tool))throw new Error('Unknown Hephaestus tool');
  if(!this.t3InFlight||!this.state.running||!this.state.busy)throw new Error('No active Hephaestus request');
  if(tool==='t3_workspace'){
   const id=randomUUID(),started=Date.now(),generation=this.generation;this.activityEvent({id,kind:'tool',title:tool,status:'running',text:JSON.stringify(args)});
   try{const result=await this.workspace.execute(args,()=>{if(generation!==this.generation||!this.t3InFlight||!this.state.running)throw new Error('This turn is no longer active');});this.activityEvent({id,kind:'tool',title:tool,status:'completed',text:JSON.stringify(result).slice(0,2500),durationMs:Date.now()-started});return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};}
   catch(e){this.activityEvent({id,kind:'tool',title:tool,status:'failed',text:e.message});return{success:false,contentItems:[{type:'inputText',text:e.message}]};}
  }
  const turnId=this.turnId='t3-'+this.t3RunId,threadId=this.activeThreadId=this.t3ThreadId;
  return new Promise(resolve=>super.onTool({method:'item/tool/call',id:randomUUID(),params:{threadId,turnId,tool,arguments:args}},{reply:(_id,result)=>resolve(result)}));
 }
 async interrupt(){
  if(this.t3InFlight&&this.t3){const runId=this.t3RunId,finish=this.t3Finish,requestId=this.t3MessageId;this.ignoredT3Runs??=new Set();if(runId)this.ignoredT3Runs.add(runId);this.observations.clear();this.generation++;this.emit('silence');try{await this.t3.call('orchestration.dispatchCommand',{type:'thread.stop',commandId:randomUUID(),threadId:this.t3ThreadId,reason:'Interrupted from Hephaestus'});}catch{}finish?.();if(this.t3MessageId===requestId){this.t3InFlight=false;this.externalT3Run=false;this.turnId=null;this.publish({busy:false,background:false,activity:'Ready'});}return;}
  return super.interrupt();
 }
 async replacePrompt(prompt){await this.interrupt();await writeFile(join(this.dataDir,'context','AGENTS.md'),prompt+'\n');if(this.t3){const old=this.t3ThreadId;const r=await this.t3.call('orchestration.launchThread',{commandId:randomUUID(),projectId:this.t3ProjectId,title:'Hephaestus',modelSelection:this.modelSelection(),runtimeMode:'full-access',interactionMode:'default',workspaceStrategy:{type:'root'}});this.stopT3Subscription?.();this.t3ThreadId=r.threadId;this.hasT3History=false;this.stopT3Subscription=this.t3.subscribe('orchestration.subscribeThread',{threadId:this.t3ThreadId},item=>this.t3Stream(item));await this.saveT3();this.publish({t3ThreadId:this.t3ThreadId});await this.t3.call('orchestration.dispatchCommand',{type:'thread.archive',commandId:randomUUID(),threadId:old});}}
 async close(){this.workspace?.close();await this.interrupt();this.stopT3Subscription?.();await this.t3?.close();await super.close();this.desktopServer?.close();}
}
