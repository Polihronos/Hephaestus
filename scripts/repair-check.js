import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function repairCheck({dashboard,companion:c,root,showDashboard}){
 const report={at:new Date().toISOString(),checks:[]},previous={backgroundVision:c.state.backgroundVision};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);console.log('CHECK '+name);};
 const page=async name=>{await showDashboard(name);for(let i=0;i<40;i++){if(await dashboard.webContents.executeJavaScript(`!document.querySelector('[data-view="${name}"]').hidden`)){await new Promise(r=>setTimeout(r,150));return;}await new Promise(r=>setTimeout(r,50));}throw Error('Dashboard did not display '+name);};
 await mkdir(join(root,'artifacts'),{recursive:true});
 try{
  check('Installed T3 runtime is connected with Luna',c.state.runtime==='t3'&&c.state.connection==='connected'&&c.state.model==='gpt-6-luna');
  await c.configure({backgroundVision:false});
  if(c.state.prompt!==c.defaultPrompt)await writeFile(join(c.dataDir,'prompt-before-connection-repair.txt'),c.state.prompt,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await c.configure({prompt:c.defaultPrompt});
  check('The sole visible prompt explains Hephaestus and its working T3 and desktop tools',c.state.prompt.includes('Your name is Hephaestus.')&&c.state.prompt.includes('t3_workspace')&&c.state.prompt.includes('do not depend on the separate cua_repl'));
  if(process.argv.includes('--repair-review')){
   const prior=JSON.parse(await readFile(join(root,'artifacts/repair-check.json'),'utf8'));report.actualRunAt=prior.actualRunAt??prior.at;report.latency=prior.latency;report.activities=prior.activities;report.messages=prior.messages;
  }else{
   const started=Date.now();
   const pending=c.submit('Hephaestus, find the Boot.dev development conversation, register its current folder in T3 as Hephaestus App, and move that conversation there when its current run finishes. Use your connected T3 tools. Also confirm whether your desktop connection can list the open applications. Do not click or change other applications.');
   const timeout=setTimeout(()=>c.interrupt().catch(()=>{}),90000);try{await pending;}finally{clearTimeout(timeout);}
   report.latency={firstReplyMs:c.state.lastReplyMs,totalMs:c.state.lastTotalMs};report.activities=c.activities.filter(a=>a.at>=started);report.messages=c.messages.filter(m=>m.at>=started);
  }
  check('Luna reads actual T3 state through its connected workspace tool',report.activities.some(a=>a.title==='t3_workspace'&&a.status==='completed'&&a.text.includes('connection')&&(a.text.includes('threadCount')||a.text.includes('operations'))));
  check('Luna uses its desktop bridge independently of cua_repl',report.activities.some(a=>a.title==='screen_windows'&&a.status==='completed'));
  check('The actual development conversation move is persistently queued',c.workspace.operations.some(o=>o.threadId==='ac0fc5ea-e9cd-418b-b5ad-5b57312e167b'&&['queued','completed'].includes(o.status)&&o.projectTitle==='Hephaestus App'));
  check('No placeholder thread ID or unavailable CUA connection is used',!report.activities.some(a=>/t3_thread_wait|cua_repl/.test(a.title)));
  await page('instructions');
  check('The dashboard shows the full configured prompt',await dashboard.webContents.executeJavaScript(`!![...document.querySelectorAll('textarea')].find(e=>e.value.includes('t3_workspace'))`));
  await writeFile(join(root,'artifacts/hephaestus-repaired-instructions.png'),(await dashboard.webContents.capturePage()).toPNG());
  await page('activity');
  check('The tool inventory includes direct T3 control',await dashboard.webContents.executeJavaScript(`document.querySelector('.tool-inventory').textContent.includes('t3_workspace')`));
  await writeFile(join(root,'artifacts/hephaestus-repaired-activity.png'),(await dashboard.webContents.capturePage()).toPNG());
  report.operations=c.workspace.operations;report.threadId=c.t3ThreadId;report.success=true;
 }catch(e){report.success=false;report.error=e.stack;console.error(e);}
 finally{await c.configure(previous);await showDashboard('companion');await c.ledger?.flush();await writeFile(join(root,'artifacts/repair-check.json'),JSON.stringify(report,null,2));console.log('REPAIR_CHECK '+JSON.stringify({success:report.success,error:report.error,checks:report.checks,latency:report.latency}));}
}
