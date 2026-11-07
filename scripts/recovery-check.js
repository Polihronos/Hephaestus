import {Companion} from '../src/companion.js';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const root=process.cwd();await mkdir('runtime/recovery',{recursive:true});
const c=new Companion({root,dataDir:join(root,'runtime/recovery'),openBrowser:async()=>{}});
const report={date:new Date().toISOString()};
async function until(predicate,timeout=30000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Recovery timed out');await delay(100);}}
try{
  await c.start();await until(()=>c.state.speech==='ready');
  const oldSpeech=c.speech.process.pid;let start=Date.now();c.speech.process.kill();
  await until(()=>c.speech.process.pid!==oldSpeech&&c.state.speech==='ready');report.speechRestartMs=Date.now()-start;
  const oldCodex=c.rpc.process.pid;start=Date.now();c.rpc.process.kill();
  await until(()=>c.rpc.process.pid!==oldCodex&&c.state.connection==='connected');report.codexReconnectMs=Date.now()-start;
  c.state.running=true;c.state.watching=false;
  const replies=[];c.on('message',m=>{if(m.role==='assistant')replies.push(m.text);});
  await c.turn('What is 2 plus 3? Answer only the number.');
  report.replyAfterRecovery=replies.at(-1);report.plan=c.state.plan;report.passed=/5|five/i.test(report.replyAfterRecovery??'');
  console.log(JSON.stringify(report));
  await writeFile('artifacts/recovery-check.json',JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}catch(error){console.error(error);process.exitCode=1;}finally{await c.close();}
