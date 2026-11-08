import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {TOOL_ORIGIN_FIELD,TOOL_ORIGIN_MAX_AGE_MS,canonicalToolArguments,signToolOrigin,stripToolOrigin,verifyToolOrigin} from '../src/tool-origin.js';
import {createToolOriginHookOutput} from '../src/tool-origin-hook.js';

const secret=randomBytes(32).toString('hex'),now=1800000000000;
const args={kind:'click',observationId:'observation',point:{x:12,y:25}};
const input={secret,tool:'screen_action',args,nativeSessionId:'native-thread',nativeTurnId:'original-turn',toolUseId:'call-1',issuedAt:now};
const event={hook_event_name:'PreToolUse',tool_name:'mcp__hephaestus__screen_action',session_id:'native-thread',turn_id:'original-turn',tool_use_id:'call-1',tool_input:args};

test('a signed call retains its native origin without reading the active run',()=>{
 const proof=signToolOrigin(input),origin=verifyToolOrigin({secret,tool:input.tool,args,proof,now});
 assert.equal(origin.nativeTurnId,'original-turn');assert.equal(origin.nativeSessionId,'native-thread');assert.equal(origin.toolUseId,'call-1');
 assert.ok(Object.isFrozen(proof));assert.ok(Object.isFrozen(origin));assert.equal(JSON.stringify(proof).includes(secret),false);
});

test('tool authorization binds the full arguments, tool and native IDs',()=>{
 const proof=signToolOrigin(input);
 for(const change of [{nativeTurnId:'new-turn'},{nativeSessionId:'other-thread'},{toolUseId:'other-call'},{nonce:randomBytes(24).toString('base64url')},{issuedAt:now-1}])assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args,proof:{...proof,...change},now}),/no valid originating turn/);
 assert.throws(()=>verifyToolOrigin({secret,tool:'t3_workspace',args,proof,now}),/no valid originating turn/);
 assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args:{...args,point:{x:13,y:25}},proof,now}),/no valid originating turn/);
 assert.throws(()=>verifyToolOrigin({secret:randomBytes(32).toString('hex'),tool:input.tool,args,proof,now}),/no valid originating turn/);
});

test('canonical arguments preserve nested values and array order across JSON transports',()=>{
 const first={b:[{d:3,c:2},1],a:'text'},second={a:'text',b:[{c:2,d:3},1]};
 assert.equal(canonicalToolArguments(first),canonicalToolArguments(second));
 const proof=signToolOrigin({...input,args:first});assert.doesNotThrow(()=>verifyToolOrigin({secret,tool:input.tool,args:JSON.parse(JSON.stringify(second)),proof,now}));
 assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args:{...second,b:[1,{c:2,d:3}]},proof,now}));
 for(const value of [{value:undefined},{value:NaN},{value:BigInt(1)},{value:new Date()}, {value:[,1]}])assert.throws(()=>canonicalToolArguments(value));
});

test('proof transport data cannot change the underlying tool arguments',()=>{
 const spoofed={...args,[TOOL_ORIGIN_FIELD]:{nativeTurnId:'new-turn'}};
 const proof=signToolOrigin({...input,args:spoofed});
 assert.equal(canonicalToolArguments(spoofed),canonicalToolArguments(args));
 assert.deepEqual(stripToolOrigin({...args,[TOOL_ORIGIN_FIELD]:proof}),args);
 assert.doesNotThrow(()=>verifyToolOrigin({secret,tool:input.tool,args:{...args,[TOOL_ORIGIN_FIELD]:proof},now}));
 assert.equal(spoofed[TOOL_ORIGIN_FIELD].nativeTurnId,'new-turn');
});

test('expired and future authorizations fail independently of a valid signature',()=>{
 const proof=signToolOrigin(input);
 assert.doesNotThrow(()=>verifyToolOrigin({secret,tool:input.tool,args,proof,now:now+TOOL_ORIGIN_MAX_AGE_MS}));
 assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args,proof,now:now+TOOL_ORIGIN_MAX_AGE_MS+1}),/expired/);
 assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args,proof,now:now-10001}),/expired/);
});

test('missing, malformed and extended proofs cannot be mistaken for authorization',()=>{
 const proof=signToolOrigin(input);
 for(const value of [undefined,null,{},[],{...proof,signature:'invalid'},{...proof,extra:true},{...proof,version:2}])assert.throws(()=>verifyToolOrigin({secret,tool:input.tool,args,proof:value,now}),/no valid originating turn/);
 assert.throws(()=>signToolOrigin({...input,nativeTurnId:undefined}));assert.throws(()=>signToolOrigin({...input,secret:'short'}));
 assert.notEqual(signToolOrigin(input).nonce,signToolOrigin(input).nonce);
});

test('PreToolUse rewrites the call with a signed origin and replaces a spoofed envelope',()=>{
 const result=createToolOriginHookOutput({...event,tool_input:{...args,[TOOL_ORIGIN_FIELD]:{nativeTurnId:'forged-turn'}}},{secret,issuedAt:now});
 const output=result.hookSpecificOutput;
 assert.equal(output.permissionDecision,'allow');assert.equal(output.hookEventName,'PreToolUse');
 const origin=verifyToolOrigin({secret,tool:input.tool,args:output.updatedInput,now});
 assert.equal(origin.nativeTurnId,event.turn_id);assert.equal(origin.toolUseId,event.tool_use_id);assert.deepEqual(stripToolOrigin(output.updatedInput),args);
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.deepEqual(createToolOriginHookOutput({...event,tool_name:'mcp__other__read'},{secret}),{});
 assert.throws(()=>createToolOriginHookOutput({...event,turn_id:undefined},{secret}));
});

test('an MCP tool with no arguments receives a valid empty argument envelope',()=>{
 const output=createToolOriginHookOutput({...event,tool_name:'mcp__hephaestus__screen_windows',tool_input:null},{secret,issuedAt:now}).hookSpecificOutput;
 assert.equal(output.permissionDecision,'allow');assert.deepEqual(stripToolOrigin(output.updatedInput),{});
 assert.equal(verifyToolOrigin({secret,tool:'screen_windows',args:output.updatedInput,now}).nativeTurnId,event.turn_id);
});

async function runHook(payload,bridgeFile){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['src/tool-origin-hook.js',bridgeFile],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Hook process timed out.'));},5000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(payload);
 });
}

test('the real hook CLI signs stdin and emits only its protocol response',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-origin-'));
 try{
  const file=join(directory,'bridge.json');await writeFile(file,JSON.stringify({originSecret:secret}));
  const result=await runHook(JSON.stringify(event),file);assert.equal(result.code,0);assert.equal(result.stderr,'');
  const output=JSON.parse(result.stdout).hookSpecificOutput;assert.equal(output.permissionDecision,'allow');
  assert.equal(verifyToolOrigin({secret,tool:input.tool,args:output.updatedInput}).nativeTurnId,event.turn_id);
  assert.equal(result.stdout.includes(secret),false);assert.equal(result.stdout.trim().split('\n').length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('the hook CLI denies malformed input or missing signing configuration without disclosing it',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-origin-'));
 try{
  const file=join(directory,'bridge.json');await writeFile(file,JSON.stringify({originSecret:secret}));
  for(const [payload,path] of [['not JSON',file],[JSON.stringify({...event,turn_id:null}),file],[JSON.stringify(event),join(directory,'missing.json')]]){
   const result=await runHook(payload,path),output=JSON.parse(result.stdout).hookSpecificOutput;
   assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(output.permissionDecision,'deny');assert.equal(result.stdout.includes(secret),false);assert.equal(result.stdout.includes(path),false);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
