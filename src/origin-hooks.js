import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const ORIGIN_HOOK_MATCHER='^mcp__hephaestus__.*$';
const STATUS='Verifying Hephaestus tool origin';
const TIMEOUT_SECONDS=10;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const samePath=(left,right)=>typeof left==='string'&&typeof right==='string'&&(process.platform==='win32'?resolve(left).toLowerCase()===resolve(right).toLowerCase():resolve(left)===resolve(right));
const validIdentity=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);
const startupError=detail=>new Error(`Hephaestus could not enable originating-turn authorization: ${detail} Update Codex if its hook APIs are unavailable, then reconnect.`);

/** Encode both paths so Windows shell metacharacters are never part of command syntax. */
export function originHookCommand({hookPath,bridgeConfigPath}){
 if(!isAbsolute(hookPath??'')||!isAbsolute(bridgeConfigPath??''))throw startupError('The hook and bridge paths must be absolute.');
 const moduleUrl=Buffer.from(pathToFileURL(resolve(hookPath)).href).toString('base64');
 const bridgePath=Buffer.from(resolve(bridgeConfigPath)).toString('base64');
 return `node --input-type=module -e "const h=await import(Buffer.from('${moduleUrl}','base64').toString());await h.runToolOriginHook({bridgeFile:Buffer.from('${bridgePath}','base64').toString()})"`;
}

function ownedGroup(group){return group?.matcher===ORIGIN_HOOK_MATCHER&&Array.isArray(group.hooks)&&group.hooks.length===1&&group.hooks[0]?.type==='command'&&group.hooks[0]?.statusMessage===STATUS;}

async function installDefinition(path,command){
 let config;
 try{config=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')config={};else throw startupError('The project hooks.json could not be read; correct its JSON before reconnecting.');}
 if(!record(config)||config.hooks!==undefined&&!record(config.hooks)||config.hooks?.PreToolUse!==undefined&&!Array.isArray(config.hooks.PreToolUse))throw startupError('The project hooks.json has an invalid PreToolUse configuration.');
 const groups=config.hooks?.PreToolUse??[],owned=groups.map((group,index)=>ownedGroup(group)?index:-1).filter(index=>index!==-1);
 if(owned.length>1)throw startupError('The project contains duplicate Hephaestus origin hooks.');
 const group={matcher:ORIGIN_HOOK_MATCHER,hooks:[{type:'command',command,timeout:TIMEOUT_SECONDS,statusMessage:STATUS}]};
 const nextGroups=[...groups];if(owned.length)nextGroups[owned[0]]=group;else nextGroups.push(group);
 const next={...config,hooks:{...config.hooks,PreToolUse:nextGroups}};
 if(JSON.stringify(config)!==JSON.stringify(next)){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
}

function exactInventoryHook(result,{contextDir,sourcePath,command}){
 if(!Array.isArray(result?.data))throw startupError('Codex hooks/list returned an unsupported response.');
 const entries=result.data.filter(entry=>samePath(entry.cwd,contextDir));
 if(entries.length!==1||!Array.isArray(entries[0].hooks))throw startupError('Codex did not return the project hook inventory.');
 if(entries[0].errors?.length)throw startupError('Codex reported errors while loading the project hooks.');
 const matching=entries[0].hooks.filter(hook=>hook.source==='project'&&samePath(hook.sourcePath,sourcePath)&&hook.eventName==='preToolUse'&&hook.handlerType==='command'&&hook.matcher===ORIGIN_HOOK_MATCHER&&hook.command===command&&hook.statusMessage===STATUS&&hook.timeoutSec===TIMEOUT_SECONDS&&hook.async!==true&&hook.isManaged===false);
 if(matching.length!==1)throw startupError('The exact generated project hook was not discovered; ensure the project .codex directory is trusted.');
 const hook=matching[0];
 if(!validIdentity(hook.key)||!validIdentity(hook.currentHash)||!['trusted','untrusted','modified'].includes(hook.trustStatus)||typeof hook.enabled!=='boolean')throw startupError('Codex returned unsupported hook identity or trust metadata.');
 return hook;
}

async function hookInventory(rpc,contextDir){
 try{return await rpc.call('hooks/list',{cwds:[contextDir]});}catch{throw startupError('Codex hooks/list failed.');}
}

/** Trust only this generated definition through Codex's public config RPC, then verify it. */
export async function ensureOriginHook({rpc,contextDir,hookPath,bridgeConfigPath}){
 if(typeof rpc?.call!=='function'||!isAbsolute(contextDir??''))throw startupError('An initialized Codex connection and absolute context path are required.');
 const context=resolve(contextDir),sourcePath=join(context,'.codex','hooks.json'),command=originHookCommand({hookPath,bridgeConfigPath});
 await installDefinition(sourcePath,command);
 const expected={contextDir:context,sourcePath,command};
 let hook=exactInventoryHook(await hookInventory(rpc,context),expected);
 if(hook.trustStatus!=='trusted'||!hook.enabled){
  const keyPath='hooks.state.'+JSON.stringify(hook.key);
  try{await rpc.call('config/batchWrite',{edits:[{keyPath:keyPath+'.trusted_hash',value:hook.currentHash,mergeStrategy:'upsert'},{keyPath:keyPath+'.enabled',value:true,mergeStrategy:'upsert'}],reloadUserConfig:true});}catch{throw startupError('Codex could not save trust for the generated hook.');}
  const verified=exactInventoryHook(await hookInventory(rpc,context),expected);
  if(verified.key!==hook.key||verified.currentHash!==hook.currentHash||verified.trustStatus!=='trusted'||!verified.enabled)throw startupError('Codex did not confirm the generated hook is enabled and trusted.');
  hook=verified;
 }
 return {sourcePath,key:hook.key,currentHash:hook.currentHash,trustStatus:hook.trustStatus,enabled:hook.enabled};
}
