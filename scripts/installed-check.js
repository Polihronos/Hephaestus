import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function installedCheck({dashboard,bubble,mascot,companion:c,root,showDashboard,wisprKey,runtimeView}){
 const report={at:new Date().toISOString(),checks:[]},previous={backgroundVision:c.state.backgroundVision};
 let usagePreferences;
 const check=(name,ok)=>{assert.ok(ok,name);report.checks.push(name);console.log('CHECK '+name);};
 const capture=async(name,window=dashboard)=>{await wait(250);await writeFile(join(root,'artifacts/'+name),(await window.webContents.capturePage()).toPNG());};
 try{
  check('Installed production runtime uses T3 and Luna',c.state.runtime==='t3'&&c.state.model==='gpt-6-luna');check('Wispr is selected and speaking is off',c.state.inputMode==='wispr'&&!c.state.spokenReplies);await c.configure({backgroundVision:false});await c.historyImport;
  check('Lifetime totals persist and details reconcile',c.ledger.report().totals.totalTokens===c.ledger.summary().totalTokens);report.usage=c.ledger.report({limit:3});
  await showDashboard('usage');await wait(900);check('Installed usage records render',await dashboard.webContents.executeJavaScript(`document.querySelectorAll('#usage-rows tr').length>0`));await capture('hephaestus-final-usage.png');
  await dashboard.webContents.executeJavaScript(`document.querySelector('.content').scrollTop=document.querySelector('.content').scrollHeight;document.querySelector('#usage-rows details')?.setAttribute('open','');`);await capture('hephaestus-final-usage-history.png');
  await dashboard.webContents.executeJavaScript(`document.querySelector('.content').scrollTop=0;document.getElementById('open-t3-usage').click();`);
  for(let i=0;i<150;i++){const view=runtimeView();if(view&&!view.webContents.isLoading()&&/\$[0-9]/.test(await view.webContents.executeJavaScript('document.body.innerText')))break;await wait(200);}
  const view=runtimeView();const usageText=view?await view.webContents.executeJavaScript('document.body.innerText'):'';report.t3Usage={url:view?.webContents.getURL(),text:usageText.slice(0,5000)};check('Original T3 usage UI loads inside Hephaestus',report.t3Usage.url?.endsWith('/usage')&&/\$[0-9]/.test(usageText));await capture('hephaestus-final-t3-usage.png',view);
  usagePreferences=await view.webContents.executeJavaScript(`localStorage.getItem('t3code:usage-page-preferences:v1')`);
  await view.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Tokens')?.click()`);await wait(1700);check('Embedded T3 keeps the user-selected usage tab',await view.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('t3code:usage-page-preferences:v1')).metric==='tokens'`));
  await dashboard.webContents.executeJavaScript(`document.getElementById('workspace-conversation').click()`);for(let i=0;i<100&&view.webContents.isLoading();i++)await wait(100);await wait(1200);view.webContents.focus();await view.webContents.executeJavaScript(`document.querySelector('textarea,[contenteditable="true"]')?.focus()`);await wisprKey({phase:'start',at:Date.now()});await wait(150);check('Wispr preserves the embedded T3 editor',view.webContents.isFocused()&&!mascot.isFocused());await wisprKey({phase:'cancel'});
  await showDashboard('companion');await wait(250);check('Both conversation roles are visible',await dashboard.webContents.executeJavaScript(`document.querySelectorAll('.answer.user').length>0&&document.querySelectorAll('.answer.assistant').length>0`));check('Existing assistant Markdown renders',await dashboard.webContents.executeJavaScript(`!!document.querySelector('.answer.assistant strong')`));await capture('hephaestus-final-dashboard.png');
  check('The microphone stays closed',!(await mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect()')).voice.microphoneActive);report.runtime=JSON.parse(await readFile(join(c.dataDir,'t3-runtime.json'),'utf8'));report.sessionId=c.t3.sessionId;report.model=c.state.model;report.success=true;
 }catch(e){report.success=false;report.error=e.stack;console.error(e);}
 finally{if(usagePreferences!==undefined){const view=runtimeView();if(view&&!view.webContents.isDestroyed())await view.webContents.executeJavaScript(usagePreferences===null?`localStorage.removeItem('t3code:usage-page-preferences:v1')`:`localStorage.setItem('t3code:usage-page-preferences:v1',${JSON.stringify(usagePreferences)})`);}await c.configure(previous);await showDashboard('companion');await writeFile(join(root,'artifacts/installed-check.json'),JSON.stringify(report,null,2));console.log('INSTALLED_CHECK '+JSON.stringify({success:report.success,error:report.error,checks:report.checks}));}
}
