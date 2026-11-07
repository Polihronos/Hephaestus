import assert from'node:assert/strict';import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';import{spawn}from'node:child_process';import{createInterface}from'node:readline';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function hephaestusCheck({dashboard,mascot,bubble,ink,companion:c,root,showDashboard,showBubble,placeBubble}){
 const out=join(root,'artifacts');await mkdir(out,{recursive:true});const report={at:new Date().toISOString(),checks:[]},check=(name,value)=>{assert.ok(value,name);report.checks.push(name);console.log('CHECK '+name);};
 const previous={inputMode:c.state.inputMode,spokenReplies:c.state.spokenReplies,backgroundVision:c.state.backgroundVision,proactive:c.state.proactive};let fixture,lines,speechHandler;
 try{
  check('ChatGPT Pro subscription connected',c.state.connection==='connected'&&c.state.plan==='pro');
  await showDashboard('companion');await wait(150);await writeFile(join(out,'hephaestus-dashboard-initial.png'),(await dashboard.webContents.capturePage()).toPNG());
  report.windows={dashboardVisible:dashboard.isVisible(),spriteVisible:mascot.isVisible(),spriteOnTop:mascot.isAlwaysOnTop(),dashboardOnTop:dashboard.isAlwaysOnTop()};check('Dashboard and overlay both exist',dashboard.isVisible()&&mascot.isVisible()&&mascot.isAlwaysOnTop()&&!dashboard.isAlwaysOnTop());
  for(let i=0;i<120&&(!c.state.listening||c.state.speech!=='ready');i++)await wait(100);
  report.sprite=await mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect()');check('Supplied Hephaestus sprite is active',report.sprite.character==='Hephaestus');
  check('Always-on microphone uses system-wide echo cancellation',report.sprite.voice.microphoneActive&&report.sprite.voice.echoCancellation==='all');
  report.audio=await c.bridge.call('audio-state');check('Desktop output remains unmuted',!report.audio.muted);
  const f=await c.observe();report.capture={source:f.captureSource,width:f.width,height:f.height,window:f.window.title,bounds:f.bounds};
  await showDashboard('companion');await wait(180);const dash=await dashboard.webContents.executeJavaScript('window.hephaestusDashboardInspect()');check('Live screen preview is restored',dash.screenVisible&&dash.imageWidth>0);
  check('Screenshot protection is disabled',!dashboard.isContentProtected()&&!mascot.isContentProtected());
  check('Popup contains answers only',!(await bubble.webContents.executeJavaScript('window.hephaestusBubbleInspect()')).hasInput);
  c.publish({calibrating:true});await wait(100);await mascot.webContents.executeJavaScript('window.hephaestusAudioProbe.start()');await wait(400);
  await new Promise((resolve,reject)=>{const p=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/aec-playback.ps1')],{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Playback check failed')));});await wait(500);
  const audio=await mascot.webContents.executeJavaScript('window.hephaestusAudioProbe.finish()');
  const rawText=await c.speech.call('transcribe',{audio:audio.raw.audio}),cleanText=await c.speech.call('transcribe',{audio:audio.clean.audio});
  const reference='hephaestus is checking speaker playback cancellation this sentence is coming from the computer and should not be treated as a request'.split(' '),match=text=>{const words=new Set(text.toLowerCase().replace(/[^a-z ]/g,'').split(/\s+/));return reference.filter(w=>words.has(w)).length/reference.length;};
  report.echo={rawRms:audio.raw.rms,cleanRms:audio.clean.rms,reductionDb:20*Math.log10(Math.max(audio.raw.rms,1e-8)/Math.max(audio.clean.rms,1e-8)),rawPlaybackMatch:match(rawText.text),cleanPlaybackMatch:match(cleanText.text)};
  check('Computer speech is rejected without muting output',report.echo.cleanPlaybackMatch<.25);c.publish({calibrating:false});
  await c.configure({backgroundVision:false,proactive:false,spokenReplies:true});
  for(let i=0;i<150&&c.state.dictating;i++)await wait(100);
  let spoken=false;speechHandler=s=>{if(s.speaking)spoken=true;};c.on('state',speechHandler);
  await c.submit('Describe the application you can see in one short sentence.');for(let i=0;i<30&&!spoken;i++)await wait(100);
  report.speaker=await mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect().speaker');check('Actual speech works with the dashboard and popup independent',spoken);
  for(let i=0;i<80&&c.state.speaking;i++)await wait(100);
  check('Own speech does not submit itself',!c.messages.filter(m=>m.role==='user').some(m=>m.text===c.messages.filter(m=>m.role==='assistant').at(-1)?.text));
  showBubble();await wait(150);const a=mascot.getBounds(),b=bubble.getBounds();mascot.setPosition(a.x-24,a.y-16);await wait(150);placeBubble();await wait(80);const b2=bubble.getBounds();check('Answer bubble follows the sprite',Math.abs((b2.x-b.x)+24)<8&&Math.abs((b2.y-b.y)+16)<8);mascot.setPosition(a.x,a.y);
  c.emit('mouseDown',{x:-99999,y:-99999});await wait(80);check('Clicking outside dismisses the answer popup',!bubble.isVisible());
  await c.configure({inputMode:'wispr',spokenReplies:false});
  fixture=spawn(join(root,'native/bin/release/ScreenBridge.exe'),['--test-window'],{windowsHide:true,stdio:['ignore','pipe','pipe']});lines=createInterface({input:fixture.stdout});let ready;const records=[];const available=new Promise(r=>ready=r);lines.on('line',line=>{try{const e=JSON.parse(line);records.push(e);if(e.eventName==='ready')ready(e);}catch{}});
  const target=await Promise.race([available,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Verification window did not start')),10000))]);
  await c.bridge.call('action',{kind:'focus',query:target.windowId});await c.submit('In the input verification window, click the Increment button exactly once and tell me the new click count.');
  report.controls=records;check('Real model request clicks the intended app control',records.some(e=>e.eventName==='click'&&e.count===1));fixture.kill();fixture=null;await wait(250);
  await showDashboard('companion');await c.sample();await wait(200);await writeFile(join(out,'hephaestus-dashboard.png'),(await dashboard.webContents.capturePage()).toPNG());
  await showDashboard('instructions');await wait(120);check('Exact prompt is visible and editable',await dashboard.webContents.executeJavaScript('document.getElementById("prompt").value')===c.state.prompt);await writeFile(join(out,'hephaestus-instructions.png'),(await dashboard.webContents.capturePage()).toPNG());
  await showDashboard('voice');await wait(120);await writeFile(join(out,'hephaestus-voice.png'),(await dashboard.webContents.capturePage()).toPNG());
  await writeFile(join(out,'hephaestus-sprite.png'),(await mascot.webContents.capturePage()).toPNG());showBubble();await wait(100);await writeFile(join(out,'hephaestus-popup.png'),(await bubble.webContents.capturePage()).toPNG());
  report.success=true;
 }catch(e){report.success=false;report.error=e.stack;report.nativeDetail=e.detail;console.error(e);}finally{c.publish({calibrating:false});await mascot.webContents.executeJavaScript('window.hephaestusAudioProbe.finish()').catch(()=>{});if(speechHandler)c.off('state',speechHandler);lines?.close();fixture?.kill();await c.configure(previous).catch(e=>{report.restoreError={message:e.message,detail:e.detail};});await showDashboard('companion');report.state={connection:c.state.connection,plan:c.state.plan,inputMode:c.state.inputMode,echoCancellation:c.state.echoCancellation,listening:c.state.listening};await writeFile(join(out,'hephaestus-check.json'),JSON.stringify(report,null,2));console.log('HEPHAESTUS_CHECK '+JSON.stringify(report));}
}
