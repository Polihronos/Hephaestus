import {Companion}from'../src/companion.js';import{ProcessRpc}from'../src/process-rpc.js';import{readFile,mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
const root=process.cwd(),dataDir=join(root,'runtime/latency-check');await mkdir(dataDir,{recursive:true});const c=new Companion({root,dataDir});const results=[];
try{c.state.prompt=await readFile('assets/system-prompt.txt','utf8');c.state.inputMode='wispr';c.bridge=new ProcessRpc(join(root,'native/bin/release/ScreenBridge.exe')).start();await c.connect();const frame=await c.observe();
 for(const model of ['gpt-6-luna','gpt-6.1-sol']){if(!c.models.some(m=>m.id===model))continue;c.state.model=model;const params=c.threadParams();const r=await c.rpc.call('thread/start',params);c.threadId=r.thread.id;const t=Date.now();await c.turn('Describe the visible application in one short sentence.');const row={model,firstReplyMs:c.state.lastReplyMs,totalMs:Date.now()-t,text:c.messages.at(-1)?.text};results.push(row);console.log(row);}
 await writeFile('artifacts/latency-check.json',JSON.stringify(results,null,2));
}finally{await c.close();}
