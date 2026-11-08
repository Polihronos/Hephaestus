import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {ORIGIN_HOOK_MATCHER,ensureOriginHook,originHookCommand} from '../src/origin-hooks.js';
import {TOOL_ORIGIN_FIELD,verifyToolOrigin} from '../src/tool-origin.js';

async function fixture(callback){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-hooks-'));
 const contextDir=join(directory,'context & 100%'),hookDirectory=join(directory,'tools & 100% Кирилица'),hookPath=join(hookDirectory,'tool-origin-hook.js'),bridgeConfigPath=join(directory,'bridge & 100% Кирилица.json'),sourcePath=join(contextDir,'.codex','hooks.json');
 await mkdir(join(contextDir,'.codex'),{recursive:true});
 await mkdir(hookDirectory,{recursive:true});await writeFile(join(hookDirectory,'package.json'),JSON.stringify({type:'module'}));
 for(const file of ['tool-origin-hook.js','tool-origin.js'])await copyFile(join(process.cwd(),'src',file),join(hookDirectory,file));
 const calls=[],state={trusted:false,enabled:true,hash:'sha256:'+'a'.repeat(64)};
 const rpc={async call(method,params){
  calls.push({method,params});
  if(method==='config/batchWrite'){state.trusted=true;state.enabled=true;return {status:'ok'};}
  if(method!=='hooks/list')throw Error('Unexpected API');
  const config=JSON.parse(await readFile(sourcePath,'utf8')),group=config.hooks.PreToolUse.find(group=>group.matcher===ORIGIN_HOOK_MATCHER),handler=group.hooks[0];
  return {data:[{cwd:contextDir,errors:[],warnings:[],hooks:[{...handler,handlerType:'command',timeoutSec:handler.timeout,eventName:'preToolUse',matcher:group.matcher,source:'project',sourcePath,key:'project:key.with."quotes"',currentHash:state.hash,trustStatus:state.trusted?'trusted':'untrusted',enabled:state.enabled,isManaged:false}]}]};
 }};
 try{await callback({directory,contextDir,hookPath,bridgeConfigPath,sourcePath,rpc,calls,state});}finally{await rm(directory,{recursive:true,force:true});}
}

test('the exact owned hook is installed and trusted through only the supported RPC edits',()=>fixture(async f=>{
 const result=await ensureOriginHook(f),config=JSON.parse(await readFile(f.sourcePath,'utf8'));
 assert.equal(config.hooks.PreToolUse.length,1);assert.equal(config.hooks.PreToolUse[0].matcher,ORIGIN_HOOK_MATCHER);assert.equal(result.trustStatus,'trusted');
 assert.deepEqual(f.calls.map(call=>call.method),['hooks/list','config/batchWrite','hooks/list']);
 const write=f.calls[1].params,keyPath='hooks.state.'+JSON.stringify(result.key);
 assert.deepEqual(write,{edits:[{keyPath:keyPath+'.trusted_hash',value:result.currentHash,mergeStrategy:'upsert'},{keyPath:keyPath+'.enabled',value:true,mergeStrategy:'upsert'}],reloadUserConfig:true});
 assert.equal(write.filePath,undefined);
}));

test('unrelated hook definitions and configuration survive installation unchanged',()=>fixture(async f=>{
 const other={matcher:'mcp__other__.*',hooks:[{type:'command',command:'other-hook',timeout:30}]},sameMatcher={matcher:ORIGIN_HOOK_MATCHER,hooks:[{type:'command',command:'my-existing-policy'}]};
 await writeFile(f.sourcePath,JSON.stringify({description:'Existing hooks',hooks:{PreToolUse:[other,sameMatcher],Stop:[{hooks:[{type:'command',command:'stop-hook'}]}]}}));
 const original=f.rpc.call;f.rpc.call=async(method,params)=>{if(method==='hooks/list'){
  const result=await original(method,params),config=JSON.parse(await readFile(f.sourcePath,'utf8')),group=config.hooks.PreToolUse.at(-1),handler=group.hooks[0];
  result.data[0].hooks[0]={...result.data[0].hooks[0],...handler,command:handler.command,timeoutSec:handler.timeout,matcher:group.matcher};return result;
 }return original(method,params);};
 await ensureOriginHook(f);const result=JSON.parse(await readFile(f.sourcePath,'utf8'));
 assert.equal(result.description,'Existing hooks');assert.deepEqual(result.hooks.PreToolUse.slice(0,2),[other,sameMatcher]);assert.deepEqual(result.hooks.Stop,[{hooks:[{type:'command',command:'stop-hook'}]}]);
}));

test('a trusted exact hook is idempotent and does not rewrite trust',()=>fixture(async f=>{
 await ensureOriginHook(f);const before=await readFile(f.sourcePath,'utf8');f.calls.length=0;
 await ensureOriginHook(f);assert.equal(await readFile(f.sourcePath,'utf8'),before);assert.deepEqual(f.calls.map(call=>call.method),['hooks/list']);
}));

test('inventory substitution cannot authorize another source, command, matcher or hash',()=>fixture(async f=>{
 const original=f.rpc.call;
 for(const change of [{source:'user'},{sourcePath:join(f.directory,'other.json')},{command:'other-command'},{matcher:'.*'},{eventName:'postToolUse'},{currentHash:''},{key:''}]){
  f.calls.length=0;f.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='hooks/list')Object.assign(result.data[0].hooks[0],change);return result;};
  await assert.rejects(ensureOriginHook(f),/originating-turn authorization/);assert.equal(f.calls.some(call=>call.method==='config/batchWrite'),false);
 }
}));

test('unsupported APIs, ineffective trust writes and changing definitions stop startup explicitly',()=>fixture(async f=>{
 const original=f.rpc.call;
 f.rpc.call=async()=>{throw Error('Unknown method');};await assert.rejects(ensureOriginHook(f),/hooks\/list failed.*Update Codex/);
 f.rpc.call=async(method,params)=>method==='config/batchWrite'?{status:'ok'}:original(method,params);
 await assert.rejects(ensureOriginHook(f),/did not confirm/);
 f.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='config/batchWrite')f.state.hash='sha256:'+'b'.repeat(64);return result;};
 await assert.rejects(ensureOriginHook(f),/did not confirm/);
}));

test('invalid existing JSON is preserved instead of replacing other hook configuration',()=>fixture(async f=>{
 await writeFile(f.sourcePath,'{invalid');await assert.rejects(ensureOriginHook(f),/correct its JSON/);assert.equal(await readFile(f.sourcePath,'utf8'),'{invalid');assert.equal(f.calls.length,0);
}));

test('encoded launch commands work with spaces, ampersands, percent signs and Unicode paths',()=>fixture(async f=>{
 const secret=randomBytes(32).toString('hex');await writeFile(f.bridgeConfigPath,JSON.stringify({originSecret:secret}));
 const command=originHookCommand(f);assert.equal(command.includes(f.bridgeConfigPath),false);assert.equal(command.includes(f.hookPath),false);
 const expression=command.match(/^node --input-type=module -e "(.+)"$/)[1];
 const event={hook_event_name:'PreToolUse',tool_name:'mcp__hephaestus__screen_action',session_id:'native-thread',turn_id:'origin-turn',tool_use_id:'call-1',tool_input:{kind:'type',text:'Здравей, свят!'}};
 const result=await new Promise((resolve,reject)=>{
  const child=process.platform==='win32'?spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c',command],{windowsHide:true,windowsVerbatimArguments:true,stdio:['pipe','pipe','pipe']}):spawn(process.execPath,['--input-type=module','-e',expression],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill();reject(Error('Hook command timed out'));},5000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(JSON.stringify(event));
 });
 assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');const output=JSON.parse(result.stdout).hookSpecificOutput;
 assert.equal(output.permissionDecision,'allow');assert.equal(output.updatedInput.text,event.tool_input.text);assert.equal(output.updatedInput[TOOL_ORIGIN_FIELD].nativeTurnId,event.turn_id);
 assert.equal(verifyToolOrigin({secret,tool:'screen_action',args:output.updatedInput}).nativeTurnId,event.turn_id);
}));
