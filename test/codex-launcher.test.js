import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveCodexLauncher} from '../src/codex-launcher.js';
import {CodexRpc} from '../src/rpc.js';

const filtered=['OPENAI_API_KEY','CODEX_API_KEY','AZURE_OPENAI_API_KEY','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','T3CODE_THREAD_ID'];
const fakeServer=`const {createInterface}=require('node:readline');
const {basename}=require('node:path');
const filtered=${JSON.stringify(filtered)};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id==null)return;
 const result=message.method==='inspect'?{argv:process.argv.slice(2),script:basename(process.argv[1]),nodeChild:process.env.ELECTRON_RUN_AS_NODE==='1',filtered:Object.fromEntries(filtered.map(key=>[key,Object.hasOwn(process.env,key)]))}:{ok:true};
 process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});`;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'codex-launcher-'));
 t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('codex-launcher-'));await rm(root,{recursive:true,force:true});});
 return root;
}
async function npmFixture(root,{local=false,suffix='.cmd',metadata={name:'@openai/codex',bin:{codex:'cli/entry.cjs'}},server=fakeServer}={}){
 const prefix=join(root,local?'local project':'npm & prefix with spaces');
 const shimDirectory=local?join(prefix,'node_modules','.bin'):prefix;
 const packageRoot=join(prefix,'node_modules','@openai','codex');
 await mkdir(shimDirectory,{recursive:true});await mkdir(join(packageRoot,'cli'),{recursive:true});
 const shim=join(shimDirectory,'codex'+suffix),entry=join(packageRoot,'cli','entry.cjs');
 await writeFile(shim,suffix==='.ps1'?'throw "This shell wrapper must never run"':'@echo off\r\nexit /b 92\r\n');
 await writeFile(join(packageRoot,'package.json'),JSON.stringify(metadata));await writeFile(entry,server);
 return{shim,entry,prefix,packageRoot};
}
async function withEnvironment(callback){
 const values=new Map([...filtered,'ELECTRON_RUN_AS_NODE'].map(key=>[key,process.env[key]]));
 for(const key of filtered)process.env[key]='fixture-only-do-not-use';
 process.env.ELECTRON_RUN_AS_NODE='parent-sentinel';
 try{return await callback();}finally{for(const[key,value]of values)if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
async function stopRpc(rpc){
 if(!rpc.process)return;
 if(rpc.process.exitCode!==null||rpc.process.signalCode!==null){rpc.close();return;}
 const exited=new Promise(resolve=>rpc.process.once('exit',resolve));rpc.close();await exited;
}

test('explicit Windows native executable resolves without a JavaScript runner',async t=>{
 const root=await fixture(t),path=join(root,'native install','codex.exe');await mkdir(dirname(path),{recursive:true});await writeFile(path,'Native executable fixture; not executed');
 const result=await resolveCodexLauncher(path,{platform:'win32',env:{},execPath:'unused-runner'});
 assert.deepEqual(result,{command:path,args:[],runAsNode:false,kind:'native'});
 const relative=await resolveCodexLauncher(join('native install','codex.exe'),{cwd:root,platform:'win32',env:{}});assert.equal(relative.command,path);
});

test('bare codex prefers a native executable across PATH before an earlier npm shim',async t=>{
 const root=await fixture(t),npm=await npmFixture(root),nativeDirectory=join(root,'native second');await mkdir(nativeDirectory);const path=join(nativeDirectory,'codex.exe');await writeFile(path,'Native fixture; not executed');
 const result=await resolveCodexLauncher('codex',{platform:'win32',env:{Path:`"${npm.prefix}";${nativeDirectory}`}});
 assert.equal(result.kind,'native');assert.equal(result.command,path);
});

test('global cmd and PowerShell npm launchers use the package metadata entry exactly',async t=>{
 const root=await fixture(t);
 for(const suffix of['.cmd','.ps1']){
  const npm=await npmFixture(join(root,suffix),{suffix});
  const result=await resolveCodexLauncher(npm.shim,{platform:'win32',execPath:'node-runner.exe'});
  assert.deepEqual(result,{command:'node-runner.exe',args:[npm.entry],runAsNode:true,kind:'npm'});
 }
});

test('local node_modules .bin launcher resolves its adjacent scoped package',async t=>{
 const root=await fixture(t),npm=await npmFixture(root,{local:true,suffix:'.ps1'});
 const result=await resolveCodexLauncher(npm.shim,{platform:'win32'});assert.equal(result.kind,'npm');assert.deepEqual(result.args,[npm.entry]);
});

test('bare PATH discovery supports npm cmd and PowerShell launchers without a native install',async t=>{
 const root=await fixture(t);
 for(const suffix of['.cmd','.ps1']){
  const npm=await npmFixture(join(root,suffix),{suffix});
  const result=await resolveCodexLauncher('codex',{platform:'win32',env:{PATH:npm.prefix}});assert.equal(result.kind,'npm');assert.deepEqual(result.args,[npm.entry]);
 }
});

test('a standard npm string bin entry is supported without reading the shim body',async t=>{
 const root=await fixture(t),npm=await npmFixture(root,{metadata:{name:'@openai/codex',bin:'cli/entry.cjs'}});
 const result=await resolveCodexLauncher(npm.shim,{platform:'win32'});assert.deepEqual(result.args,[npm.entry]);
});

test('unsupported shell wrappers and command strings reject before any process starts',async t=>{
 const root=await fixture(t),batch=join(root,'codex.bat');await writeFile(batch,'do not execute');
 for(const command of[batch,'codex --some-option','powershell','cmd.exe /c codex'])await assert.rejects(resolveCodexLauncher(command,{platform:'win32',env:{}}),/Unsupported Codex launcher/);
 const rpc=new CodexRpc({command:batch,cwd:root});await assert.rejects(rpc.start(),/Unsupported Codex launcher/);assert.equal(rpc.process,undefined);assert.equal(rpc.pending.size,0);
});

test('unrelated or broken npm wrapper metadata fails with a useful launcher error',async t=>{
 const root=await fixture(t);
 const invalid=[{name:'another-package',bin:{codex:'cli/entry.cjs'}},{name:'@openai/codex',bin:{}},{name:'@openai/codex',bin:{codex:'../outside.cjs'}},{name:'@openai/codex',bin:{codex:'cli/missing.js'}},{name:'@openai/codex',bin:{codex:'native.exe'}}];
 for(const[index,metadata]of invalid.entries()){
  const npm=await npmFixture(join(root,String(index)),{metadata});await assert.rejects(resolveCodexLauncher(npm.shim,{platform:'win32'}),/official @openai\/codex npm.*valid JavaScript bin.codex/);
 }
 const shim=join(root,'codex.ps1');await writeFile(shim,'do not execute');await assert.rejects(resolveCodexLauncher(shim,{platform:'win32'}),/Unsupported Codex launcher/);
});

test('missing PATH installation and missing explicit files fail clearly',async t=>{
 const root=await fixture(t);await assert.rejects(resolveCodexLauncher('codex',{platform:'win32',env:{PATH:root}}),/not found on PATH/);
 await assert.rejects(resolveCodexLauncher(join(root,'missing.exe'),{platform:'win32'}),/launcher was not found/);
});

test('a broken earlier npm shim does not hide a valid later npm install',async t=>{
 const root=await fixture(t),broken=join(root,'broken');await mkdir(broken);await writeFile(join(broken,'codex.cmd'),'do not run');const npm=await npmFixture(root);
 const result=await resolveCodexLauncher('codex',{platform:'win32',env:{PATH:broken+';'+npm.prefix}});assert.deepEqual(result.args,[npm.entry]);
});

test('actual RPC startup through npm cmd and ps1 fixtures preserves argv and child-only environment',async t=>{
 const root=await fixture(t),args=['-c','developer_instructions=""','value with spaces="a & b"','%PATH%','quote "inside"','x&y',''];
 for(const suffix of['.cmd','.ps1']){
  const npm=await npmFixture(join(root,suffix),{suffix});
  await withEnvironment(async()=>{
   const rpc=new CodexRpc({command:npm.shim,args,cwd:root});
   try{
    await rpc.start();const result=await rpc.call('inspect');
    assert.deepEqual(result.argv,['app-server',...args]);assert.equal(result.script,'entry.cjs');assert.equal(result.nodeChild,true);
    assert.ok(filtered.every(key=>result.filtered[key]===false));assert.equal(process.env.ELECTRON_RUN_AS_NODE,'parent-sentinel');assert.ok(filtered.every(key=>process.env[key]==='fixture-only-do-not-use'));
   }finally{await stopRpc(rpc);}
  });
 }
});

test('actual native-process RPC startup keeps the native command and literal arguments',async t=>{
 const root=await fixture(t);await writeFile(join(root,'app-server'),fakeServer);
 const args=['-c','developer_instructions=""','spaces and "quotes"','%PATH%','a&b',''];
 await withEnvironment(async()=>{
  const rpc=new CodexRpc({command:process.execPath,args,cwd:root});
  try{
   await rpc.start();const result=await rpc.call('inspect');assert.equal(rpc.process.spawnfile,process.execPath);
   assert.equal(result.script,'app-server');assert.deepEqual(result.argv,args);assert.equal(result.nodeChild,false);assert.ok(filtered.every(key=>result.filtered[key]===false));
   assert.equal(process.env.ELECTRON_RUN_AS_NODE,'parent-sentinel');
  }finally{await stopRpc(rpc);}
 });
});
