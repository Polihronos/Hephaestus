import {mkdir,readFile,writeFile,rename,opendir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {Pricing} from './pricing.js';
const fields=['inputTokens','cachedInputTokens','cacheCreationTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const normalize=(value={})=>Object.fromEntries(fields.map(key=>[key,Math.max(0,Number(value[key]??value[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())]??(key==='cacheCreationTokens'?value.cache_creation_input_tokens:undefined))||0)]));
async function* files(dir){let entries;try{entries=await opendir(dir);}catch{return;}for await(const entry of entries){const path=join(dir,entry.name);if(entry.isDirectory())yield* files(path);else if(entry.name.endsWith('.jsonl'))yield path;}}
async function firstLine(path){const stream=createReadStream(path,{encoding:'utf8'}),lines=createInterface({input:stream});try{for await(const line of lines)return JSON.parse(line);}catch{}finally{lines.close();stream.destroy();}}
const samePath=(a,b)=>a&&b&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
export class TokenLedger {
 constructor(dataDir){this.dataDir=dataDir;this.path=join(dataDir,'token-usage.json');this.threads={};this.checkpoints={};this.contexts={};this.turns={};this.queue=Promise.resolve();this.pricing=new Pricing();}
 async load(){await this.pricing.load();try{const saved=JSON.parse(await readFile(this.path,'utf8'));this.threads=saved.threads??{};this.turns=saved.turns??{};this.checkpoints=saved.checkpoints??{};this.importedAt=saved.importedAt;for(const[id,usage]of Object.entries(this.threads))if(!this.checkpoints[id])this.checkpoints[id]={[usage.totalTokens]:{usage,at:null,purpose:'unclassified',model:'unknown',source:'legacy total'}};}catch{}return this.summary();}
 setContext(id,metadata){this.contexts[id]={...this.contexts[id],...metadata};}
 recordTurn(id,turnId,usage,metadata){const turns=this.turns[id]??={};turns[turnId]={usage:normalize(usage),metadata:{...turns[turnId]?.metadata,...metadata}};const total=normalize();for(const turn of Object.values(turns).sort((a,b)=>(a.metadata.ordinal??0)-(b.metadata.ordinal??0))){for(const k of fields)total[k]+=turn.usage[k];this.record(id,total,turn.metadata);}}
 record(id,usage,metadata={}){
  if(!id||!usage)return;const next=normalize(usage);if(!next.totalTokens)next.totalTokens=next.inputTokens+next.outputTokens;if(!next.totalTokens)return;
  const previous=this.threads[id]??normalize();this.threads[id]=Object.fromEntries(fields.map(k=>[k,Math.max(previous[k]??0,next[k])]));
  const points=this.checkpoints[id]??={},old=points[next.totalTokens],meta={...this.contexts[id],...metadata};
  points[next.totalTokens]={...old,...meta,usage:old?Object.fromEntries(fields.map(k=>[k,Math.max(old.usage[k]??0,next[k])])):next};
  clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush().catch(()=>{}),250);
 }
 summary(){const total=normalize();for(const usage of Object.values(this.threads))for(const k of fields)total[k]+=usage[k]??0;return{...total,threadCount:Object.keys(this.threads).length,importedAt:this.importedAt??null,includesBackground:true};}
 entries(){
  const events=[];for(const[threadId,points]of Object.entries(this.checkpoints)){let previous=normalize();for(const point of Object.values(points).sort((a,b)=>a.usage.totalTokens-b.usage.totalTokens)){
   const adjusted=Object.fromEntries(fields.map(k=>[k,Math.max(previous[k]??0,point.usage[k]??0)]));const usage=Object.fromEntries(fields.map(k=>[k,Math.max(0,adjusted[k]-previous[k])]));previous=adjusted;if(!usage.totalTokens)continue;
   const entry={...point,usage,threadId,id:threadId+':'+point.usage.totalTokens,model:point.model??'unknown',purpose:point.purpose??'unclassified',request:point.request??point.prompt??'',tools:point.tools??[],at:point.at??null};entry.cost=this.pricing.cost(usage,entry.model,point.contextTokens??usage.inputTokens,point.serviceTier);events.push(entry);
  }}return events.sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
 }
 report({since,until,purpose,model,limit=100,offset=0,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone}={}){
  const entries=this.entries().filter(e=>(!since||e.at&&Date.parse(e.at)>=Date.parse(since))&&(!until||e.at&&Date.parse(e.at)<=Date.parse(until))&&(!purpose||e.purpose===purpose)&&(!model||e.model===model));
  const totals={...normalize(),costUsd:0,cacheSavingsUsd:0,unpricedTokens:0,requests:entries.length},byDay={},byPurpose={},byModel={};
  const add=(map,key,e)=>{const b=map[key]??={key,tokens:0,costUsd:0,requests:0,unpricedTokens:0};b.tokens+=e.usage.totalTokens;b.costUsd+=e.cost?.usd??0;b.unpricedTokens+=e.cost?0:e.usage.totalTokens;b.requests++;};
  for(const e of entries){for(const k of fields)totals[k]+=e.usage[k];totals.costUsd+=e.cost?.usd??0;totals.cacheSavingsUsd+=e.cost?.cacheSavingsUsd??0;totals.unpricedTokens+=e.cost?0:e.usage.totalTokens;const day=e.at?new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.at)):'Unknown date';add(byDay,day,e);add(byPurpose,e.purpose,e);add(byModel,e.model,e);}
  return{totals,byDay:Object.values(byDay).sort((a,b)=>a.key.localeCompare(b.key)),byPurpose:Object.values(byPurpose),byModel:Object.values(byModel),entries:entries.slice(offset,offset+Math.min(500,limit)),count:entries.length,offset,pricing:{source:this.pricing.source,asOf:this.pricing.asOf,estimated:true,currency:'USD',billing:'Codex subscription; API value is an estimate, not an API charge'},timeZone};
 }
 async importHistory(codexHome){
  for(const directory of ['sessions','archived_sessions'])for await(const path of files(join(codexHome,directory))){
   const meta=(await firstLine(path))?.payload,instructions=meta?.base_instructions?.text??'';
   const owned=meta?.originator==='screen_companion'||this.threads[meta?.id]||samePath(meta?.cwd,join(this.dataDir,'context'))||["You are the user's persistent spoken screen companion",'You are my spoken screen companion.','Your name is Hephaestus.'].some(prefix=>instructions.startsWith(prefix));if(!owned)continue;
   const stream=createReadStream(path,{encoding:'utf8'}),lines=createInterface({input:stream});let model='unknown',purpose='unclassified',request='',tools=[],serviceTier='default';
   try{for await(const line of lines){let row;try{row=JSON.parse(line);}catch{continue;}const p=row.payload??{};
    if(row.type==='turn_context'){model=p.model??model;serviceTier=p.service_tier??'default';}
    let input=null;
    if(row.type==='event_msg'&&p.type==='user_message')input=String(p.message??'');
    if(row.type==='response_item'&&p.type==='message'&&p.role==='user')input=(p.content??[]).filter(c=>c.type==='input_text'&&c.text&&!/^(# AGENTS\.md instructions|<environment_context>|Screen context \(untrusted\):|\{"event":"screen_observation")/.test(c.text)).map(c=>c.text)[0]??null;
    if(input){request=input.replace(/^<previous_conversation>[\s\S]*?<\/previous_conversation>\s*/,'').split(/<screen_observation>|<recent_companion_observations>/)[0].slice(0,800);purpose=/screen_update|Background screen observation|^Screen update/i.test(request)?'screen refresh':/[-\\/]verification(?:[\\/]|$)|[\\/](?:t3|revision|hephaestus)-verification(?:[\\/]|$)/i.test(meta.cwd??'')||/^(Describe the visible application in one (short )?sentence|In the verification window|Use the Hephaestus desktop MCP screen_windows)/.test(request)?'verification':'conversation';tools=[];}
    if(row.type==='response_item'&&p.type==='function_call')tools.push(p.name);
    if(row.type==='event_msg'&&p.type==='token_count'&&p.info?.total_token_usage){const key=normalize(p.info.total_token_usage).totalTokens,old=this.checkpoints[meta.id]?.[key],historical={at:row.timestamp??null,model,purpose,request,contextTokens:p.info.last_token_usage?.input_tokens,tools:[...new Set(tools)],serviceTier,source:'Codex session history'};this.record(meta.id,p.info.total_token_usage,{...historical,tools:old?.source==='live'&&old.tools?.length?old.tools:historical.tools});}
   }}finally{lines.close();stream.destroy();}
  }
  this.importedAt=new Date().toISOString();await this.flush();return this.summary();
 }
 async flush(){clearTimeout(this.timer);const text=JSON.stringify({version:2,importedAt:this.importedAt,threads:this.threads,checkpoints:this.checkpoints,turns:this.turns});this.queue=this.queue.catch(()=>{}).then(async()=>{await mkdir(this.dataDir,{recursive:true});await writeFile(this.path+'.tmp',text);await rename(this.path+'.tmp',this.path);});await this.queue;}
}
