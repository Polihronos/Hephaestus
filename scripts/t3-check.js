import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const bounded=(promise,ms=15000)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Verification step timed out')),ms))]);
export async function t3Check({dashboard,mascot,bubble,companion:c,root,showDashboard,showBubble,runtimeView,runtimeDiagnostics}){
 const report={at:new Date().toISOString(),checks:[]},file=join(root,'artifacts/t3-check.json');let fixture,lines;
 const save=()=>writeFile(file,JSON.stringify(report,null,2)),check=async(name,ok)=>{assert.ok(ok,name);report.checks.push(name);console.log('CHECK '+name);await save();};
 const capture=async(window,name)=>{await wait(200);await writeFile(join(root,'artifacts/'+name),(await bounded(window.webContents.capturePage())).toPNG());};
 try{
  await check('T3 runtime connected with Luna and subscription authentication',c.state.connection==='connected'&&c.state.runtime==='t3'&&c.state.model==='gpt-6-luna');
  await check('Wispr and silent replies remain the defaults',c.state.inputMode==='wispr'&&!c.state.spokenReplies&&!(await mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect()')).voice.microphoneActive);
  await c.configure({backgroundVision:false});const started=Date.now();
  await bounded(c.submit('Use the Hephaestus desktop MCP screen_windows tool to list open apps, then use the T3 environment read tool to identify the server version. Reply in one sentence with the app count and version; make the version bold. Do not click or change any applications.'),60000);
  report.latency={firstTextMs:c.state.lastReplyMs,totalMs:c.state.lastTotalMs};report.messages=c.messages.slice(-2);report.activities=c.activities.filter(a=>a.at>=started);
  await check('Luna uses desktop tools and inherited T3 tools',report.activities.some(a=>a.title==='screen_windows'&&a.status==='completed')&&report.activities.some(a=>/t3_environment_read/.test(a.title)&&a.status==='completed'));
  await check('Assistant Markdown renders as bold text',await dashboard.webContents.executeJavaScript(`!![...document.querySelectorAll('.answer.assistant strong')].find(e=>e.textContent==='0.1.7')`));
  showBubble();if(!bubble.isVisible())bubble.showInactive();await wait(250);await check('Popup renders Markdown and keeps one card',await bubble.webContents.executeJavaScript(`document.querySelectorAll('#answer-bubble').length===1&&!!document.querySelector('#bubble-text strong')`));await capture(bubble,'t3-popup.png');
  fixture=spawn(join(root,'native/bin/release/ScreenBridge.exe'),['--test-window'],{windowsHide:true,stdio:['ignore','pipe','pipe']});lines=createInterface({input:fixture.stdout});let ready;const rows=[],available=new Promise(r=>ready=r);lines.on('line',line=>{try{const row=JSON.parse(line);rows.push(row);if(row.eventName==='ready')ready(row);}catch{}});const target=await bounded(available);await c.bridge.call('action',{kind:'focus',query:target.windowId});
  await bounded(c.submit('In the verification window (window ID '+target.windowId+'), use the Hephaestus screen_action tool with focusTarget=true and one sequence to click the Keyboard verification input, type "Luna through T3 verified.", and press End. Verify the result before replying. Do not change any other application.'),60000);
  report.controls=rows;await check('Luna controls the verification app through T3',rows.some(r=>r.eventName==='text'&&r.text==='Luna through T3 verified.'));fixture.kill();fixture=null;
  const main=c.t3ThreadId;await bounded(c.turn('Background screen observation for integration verification: use companion_notice to say "Proactive verification passed." Do not change applications.',{background:true}),30000);
  await check('Proactive Luna watcher notifies without replacing the T3 conversation',c.t3ThreadId===main&&c.messages.some(m=>m.source==='noticed'&&m.text.includes('Proactive verification passed')));
  await check('Live usage includes model, timestamp, purpose and API value',c.ledger.report().entries.some(e=>e.source==='live'&&e.model==='gpt-6-luna'&&e.at&&e.cost));report.usage=c.ledger.report({limit:5});
  await showDashboard('usage');await wait(1000);await check('Usage view displays real detailed records and chart',await dashboard.webContents.executeJavaScript(`document.querySelectorAll('#usage-rows tr').length>0&&document.querySelectorAll('#usage-chart .usage-column').length>0`));await capture(dashboard,'t3-usage.png');
  await showDashboard('workspace');for(let i=0;i<100&&(!runtimeView()?.webContents||runtimeView().webContents.isLoading());i++)await wait(100);const runtime=runtimeView();for(let i=0;i<100;i++){if((await runtime.webContents.executeJavaScript('document.body.innerText')).includes('Luna through T3 verified'))break;await wait(200);}assert.ok(runtime,'Native T3 workspace exists');report.workspace={diagnostics:runtimeDiagnostics(),url:runtime.webContents.getURL(),text:(await runtime.webContents.executeJavaScript('document.body.innerText')).slice(0,3500)};
  await check('Real T3 workspace is embedded and authenticated',(await runtime.webContents.executeJavaScript('document.body.innerText')).includes('Luna through T3 verified')&&!/Pair this device|Sign in to T3 Code/.test(report.workspace.text));await capture(runtime,'t3-workspace.png');
  await showDashboard('companion');await wait(200);await capture(dashboard,'t3-dashboard.png');report.state={runtime:c.state.runtime,model:c.state.model,threadId:c.t3ThreadId};report.success=true;
 }catch(e){report.success=false;report.error=e.stack;console.error(e);}
 finally{await c.interrupt();lines?.close();fixture?.kill();await c.ledger?.flush();await save();console.log('T3_CHECK '+JSON.stringify({success:report.success,error:report.error,checks:report.checks}));}
}
