import { Companion } from '../src/companion.js';
import { ProcessRpc } from '../src/process-rpc.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.cwd();await mkdir('runtime/latency',{recursive:true});await mkdir('artifacts',{recursive:true});
const c=new Companion({root,dataDir:join(root,'runtime/latency'),openBrowser:async()=>{}});
const results=[];
c.on('message',m=>{if(m.role==='assistant')console.log(m.text);});
try{
  c.bridge=new ProcessRpc(join(root,'native/bin/release/ScreenBridge.exe')).start();await c.connect();c.state.running=true;
  for(const model of ['gpt-6-luna','gpt-6.1-sol','gpt-6-luna']){
    c.state.model=model;const t=Date.now();
    await c.turn('Name the application visible on my screen. Answer in five words or fewer. Do not use tools.');
    const r={model,firstReplyMs:c.state.lastReplyMs,totalMs:Date.now()-t};results.push(r);console.log(JSON.stringify(r));
  }
  await writeFile('artifacts/latency.json',JSON.stringify(results,null,2));
}finally{await c.close();}
