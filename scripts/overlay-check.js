import assert from 'node:assert/strict';
import {mkdir,writeFile}from'node:fs/promises';
import {join}from'node:path';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function overlayCheck({mascot,chat,settings,ink,companion:c,root,showChat,showSettings,wisprKey,drawMark,moveAttention,startInk,finishInk}){
 const out=join(root,'artifacts');await mkdir(out,{recursive:true});const report={at:new Date().toISOString(),checks:[]};const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};const original=c.defaultPrompt;const wasSpoken=c.state.spokenReplies;await c.configure({spokenReplies:false,backgroundVision:false,prompt:original});
 try{
  check('ChatGPT subscription authentication',c.state.connection==='connected'&&c.state.plan==='pro');
  report.mascot={alwaysOnTop:mascot.isAlwaysOnTop(),bounds:mascot.getBounds()};check('Tiny always-on-top mascot',mascot.isAlwaysOnTop()&&mascot.getBounds().width>=95&&mascot.getBounds().width<=105);
  check('Click-through full-screen drawing overlay',ink.isAlwaysOnTop()&&ink.getBounds().width>=1000);
  check('Wispr actual Caps Lock shortcut',c.state.wispr?.bindings.some(b=>b.keys.includes(20)));
  const servers=await c.rpc.call('mcpServerStatus/list',{threadId:c.threadId,detail:'toolsAndAuthOnly'});report.mcpServers=servers.data?.map(s=>({name:s.name,tools:Object.keys(s.tools??{}).length}));check('Inherited computer-control plugins are disabled',!servers.data?.some(s=>Object.keys(s.tools??{}).length>0));
  const before=await c.bridge.call('audio-state');await c.bridge.call('audio-duck');const during=await c.bridge.call('audio-state');await c.bridge.call('audio-restore');const after=await c.bridge.call('audio-state');check('Playback is muted and prior state restored',during.muted&&before.muted===after.muted&&Math.abs(before.level-after.level)<.001);
  await showChat();await wait(80);const inspect=await chat.webContents.executeJavaScript('window.companionInspect()');check('No microphone is open',inspect.microphoneActive===false);
  const focus=await c.bridge.call('focus-probe');const handle=chat.getNativeWindowHandle();const chatId=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();report.inputFocus={...focus,expected:chatId};check('Companion input receives native Windows focus',focus.windowId===chatId&&focus.editable===true);
  check('Windows media permission is denied',await chat.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'opened';},e=>e.name)`) === 'NotAllowedError');
  await wisprKey({phase:'start',at:Date.now()});await wait(200);check('Wispr arms the focused companion input',(await chat.webContents.executeJavaScript('window.companionInspect()')).armed);
  await wisprKey({phase:'cancel'});check('Escape disarms dictation',!(await chat.webContents.executeJavaScript('window.companionInspect()')).armed);
  let submitted=[];const actualSubmit=c.submit;c.submit=async(text,options)=>submitted.push({text,...options});
  try{
   await chat.webContents.executeJavaScript(`document.getElementById('text-input').value='';`);await showChat();await wait(100);await wisprKey({phase:'start',at:Date.now()});await wait(150);
   await chat.webContents.executeJavaScript(`(()=>{const input=document.getElementById('text-input');input.dispatchEvent(new Event('paste'));input.value='Dictation routing verification';input.dispatchEvent(new InputEvent('input',{inputType:'insertFromPaste',data:input.value,bubbles:true}));})()`);for(let i=0;i<30&&!submitted.length;i++)await wait(100);
   report.dictation={submitted,renderer:await chat.webContents.executeJavaScript('window.companionInspect()'),autoSend:c.state.autoSend};check('Wispr insertion submits once through the real input and IPC',submitted.length===1&&submitted[0].source==='wispr');
   await chat.webContents.executeJavaScript(`(()=>{const input=document.getElementById('text-input');input.value='Unarmed insertion';input.dispatchEvent(new InputEvent('input',{inputType:'insertFromPaste',data:input.value,bubbles:true}));})()`);await wait(600);check('Unarmed insertion cannot submit itself',submitted.length===1);
  }finally{c.submit=actualSubmit;await wisprKey({phase:'cancel'});await chat.webContents.executeJavaScript(`document.getElementById('text-input').value='';`);}
  const replacement='Reply exactly "Prompt replacement verified." to a user message. Do not draw.';
  await c.configure({prompt:replacement});await c.submit('Verify my prompt.');report.promptReply=c.messages.at(-1);check('One editable prompt replaces previous instructions',c.messages.at(-1)?.text==='Prompt replacement verified.');await c.configure({prompt:original});
  const f=await c.observe();drawMark({mark:{kind:'circle',x:600,y:250,radius:45,label:'Screen attention',color:'mint',ttl:60000},frame:f});moveAttention({point:{x:f.bounds.x+Math.round(f.bounds.width*.6),y:f.bounds.y+Math.round(f.bounds.height*.45)},label:'Your focus'});await wait(600);
  check('Annotation reaches the overlay',(await ink.webContents.executeJavaScript('window.companionInkInspect()')).marks>0);
  let modelDrew=false,modelMoved=false;const drew=()=>modelDrew=true,moved=()=>modelMoved=true;c.on('annotation',drew);c.on('attention',moved);
  await c.submit('Draw a mint circle at screenshot coordinate (500, 300), radius 45. Then move your attention mascot near that circle. Use your drawing and attention tools.');c.off('annotation',drew);c.off('attention',moved);check('Actual subscription response draws and moves the mascot',modelDrew&&modelMoved);
  startInk('draw');await wait(100);check('Drawing mode captures deliberate input',(await ink.webContents.executeJavaScript('window.companionInkInspect()')).mode==='draw');finishInk();
  // Trusted test input exercises the actual own-app renderer and IPC, without another app's UI.
  await chat.webContents.executeJavaScript(`document.getElementById('text-input').value='What are we looking at?';`);
  showChat();await wait(200);await writeFile(join(out,'overlay-chat.png'),(await chat.webContents.capturePage()).toPNG());await writeFile(join(out,'overlay-mascot.png'),(await mascot.webContents.capturePage()).toPNG());
  showSettings();await wait(200);check('Prompt editor displays the exact active prompt',await settings.webContents.executeJavaScript('document.getElementById("prompt").value')===original);
  await writeFile(join(out,'overlay-settings.png'),(await settings.webContents.capturePage()).toPNG());settings.hide();
  report.state={connection:c.state.connection,plan:c.state.plan,model:c.state.model,hotkeys:c.state.wispr.labels,usage:c.state.usage};report.success=true;
 }catch(error){report.success=false;report.error=error.stack;console.error(error);}finally{await c.configure({prompt:original,spokenReplies:wasSpoken,backgroundVision:true});await c.bridge.call('audio-restore').catch(()=>{});await writeFile(join(out,'overlay-check.json'),JSON.stringify(report,null,2));console.log('OVERLAY_CHECK '+JSON.stringify(report));}
}
