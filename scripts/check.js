import { Companion } from '../src/companion.js';
import { ProcessRpc } from '../src/process-rpc.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.cwd();
await mkdir('artifacts',{recursive:true});await mkdir('runtime/check',{recursive:true});
const companion=new Companion({root,dataDir:join(root,'runtime/check'),openBrowser:async()=>{throw new Error('Browser launch is disabled during this check');}});
const messages=[];
companion.on('message',m=>{messages.push(m);console.log(m.role+': '+m.text);});
companion.on('state',s=>{if(s.error)console.log('State:',s.error);});
const started=Date.now();
try{
  await companion.start();
  await companion.configure({backgroundVision:false,spokenReplies:false});
  console.log('Connected:',companion.state.plan,Date.now()-started+'ms');
  companion.state.running=true;
  const f=await companion.observe();
  console.log('Screen:',f.width,f.height,f.window.process);
  await companion.turn('Describe the visible application in one short sentence. Do not take actions or call any tools.');
  const report={date:new Date().toISOString(),auth:'chatgpt',plan:companion.state.plan,model:companion.state.model,screen:{width:f.width,height:f.height,process:f.window.process},firstReplyMs:companion.state.lastReplyMs,totalMs:Date.now()-started,messages};
  await writeFile('artifacts/subscription-check.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({firstReplyMs:report.firstReplyMs,totalMs:report.totalMs}));
  if(!messages.some(m=>m.role==='assistant'))process.exitCode=1;
}catch(error){console.error(error);process.exitCode=1;}finally{await companion.close();}
