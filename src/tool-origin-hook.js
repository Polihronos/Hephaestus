import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOOL_ORIGIN_FIELD,signToolOrigin,stripToolOrigin} from './tool-origin.js';

const TOOL_PREFIX='mcp__hephaestus__';
const denial=()=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Hephaestus could not verify the tool\'s originating turn.'}});

export function createToolOriginHookOutput(event,{secret,issuedAt=Date.now()}={}){
 if(event?.hook_event_name!=='PreToolUse')throw new Error('Expected a PreToolUse event.');
 if(typeof event.tool_name!=='string')throw new Error('Expected a tool name.');
 if(!event.tool_name.startsWith(TOOL_PREFIX))return {};
 const tool=event.tool_name.slice(TOOL_PREFIX.length),args=stripToolOrigin(event.tool_input??{});
 const proof=signToolOrigin({secret,tool,args,nativeSessionId:event.session_id,nativeTurnId:event.turn_id,toolUseId:event.tool_use_id,issuedAt});
 return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...args,[TOOL_ORIGIN_FIELD]:proof}}};
}

export async function runToolOriginHook({bridgeFile,input=process.stdin,output=process.stdout}={}){
 let result;
 try{
  const chunks=[];let bytes=0;
  for await(const chunk of input){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>1000000)throw new Error('Hook input too large.');chunks.push(buffer);}
  const event=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof bridgeFile!=='string'||!bridgeFile)throw new Error('Missing bridge configuration.');
  const config=JSON.parse(await readFile(bridgeFile,'utf8'));
  result=createToolOriginHookOutput(event,{secret:config.originSecret});
 }catch{result=denial();}
 output.write(JSON.stringify(result)+'\n');
 return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runToolOriginHook({bridgeFile:process.argv[2]});
