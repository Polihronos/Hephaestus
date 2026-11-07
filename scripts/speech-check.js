import { ProcessRpc } from '../src/process-rpc.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
await mkdir('artifacts',{recursive:true});
const useWindows=process.argv.includes('--windows');
const p=useWindows?new ProcessRpc('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File','speech/windows-worker.ps1']).start():new ProcessRpc(join(process.cwd(),'.venv/Scripts/python.exe'),['-u','speech/worker.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_DISABLE_TELEMETRY:'1'}}).start();
p.on('diagnostic',d=>process.stderr.write(d));
try{
  await new Promise((resolve,reject)=>{p.once('ready',resolve);p.once('failed',m=>reject(new Error(m.error)));p.once('fault',reject);p.once('disconnected',()=>reject(new Error('Speech worker stopped before becoming ready')));});
  console.log('Local model loaded');const results=[];
  for(const filename of ['navigation','question']){const result=await p.call('file',{path:join(process.cwd(),'artifacts',filename+'.wav')},60000);results.push({filename,...result});console.log(JSON.stringify(results.at(-1)));}
  await writeFile(`artifacts/${useWindows?'windows-':''}speech-check.json`,JSON.stringify({source:'Windows offline speech synthesis, not a live human voice',results},null,2));
}finally{p.close();}
