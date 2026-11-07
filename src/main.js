import {app,BrowserWindow,WebContentsView,ipcMain,globalShortcut,Tray,Menu,nativeImage,session,screen,powerMonitor,shell}from'electron';
import{fileURLToPath}from'node:url';import{dirname,join}from'node:path';import{mkdir,readFile,writeFile}from'node:fs/promises';import{mkdirSync}from'node:fs';
import{Companion,dynamicTools}from'./companion.js';import{readWisprShortcuts,dictationDestination,DictationSession}from'./wispr.js';import{framePoint}from'./annotations.js';
import{T3Companion}from'./t3-companion.js';
import{preserveFailedVoiceInput}from'./input-recovery.js';
import{t3Tools}from'./t3-workspace.js';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const qualityMode=process.argv.includes('--quality-check')||process.argv.includes('--quality-check-fast');
const sessionMode=process.argv.includes('--session-check');
const routeMode=process.argv.includes('--route-check');
if(qualityMode||sessionMode||routeMode){const verificationData=join(root,'runtime',routeMode?'route-verification':sessionMode?'session-verification':'quality-verification');mkdirSync(verificationData,{recursive:true});app.setPath('userData',verificationData);}
// Retain the existing data directory and desktop installation.
app.setName('Screen Companion');app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const locked=app.requestSingleInstanceLock();if(!locked)app.quit();
let dashboard,mascot,bubble,ink,companion,tray,quitting=false,closing=false,animation,shortcutTimer,routeTimer,recordingTimer,popupSuppressed=false,dictationTarget='mascot',bubbleResizeTimer,runtimeView,runtimeRoute,runtimeSession,runtimeDiagnostics=[];
let trayMenuKey='';
let verificationExitCode=0;
const dictation=new DictationSession(),icon=nativeImage.createFromPath(join(root,'assets/hephaestus-sprites/frames/idle-00.png'));
const windows=()=>[dashboard,mascot,bubble,ink].filter(w=>w&&!w.isDestroyed());
const safe=p=>Promise.resolve(p).catch(e=>companion?.publish({error:e.message}));
const send=(w,event,data)=>{if(w&&!w.isDestroyed())w.webContents.send('companion:event',{event,data});};
const deliver=(event,data)=>{for(const w of windows())send(w,event,data);};
function createWindow(page,options){
 const w=new BrowserWindow({frame:false,transparent:true,hasShadow:false,show:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,icon,webPreferences:{preload:join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'},...options});
 if(options.alwaysOnTop!==false)w.setAlwaysOnTop(true,'screen-saver');
 w.setContentProtection(false);w.setMenuBarVisibility(false);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());
 w.on('close',e=>{if(!quitting){e.preventDefault();w.hide();}});w.loadFile(join(root,'ui',page));return w;
}
function clampPosition(p,width=100,height=124){const a=screen.getDisplayNearestPoint(p).workArea;return{x:Math.round(Math.max(a.x,Math.min(a.x+a.width-width,p.x))),y:Math.round(Math.max(a.y,Math.min(a.y+a.height-height,p.y)))};}
function windowId(w){const h=w.getNativeWindowHandle();return(h.length===8?h.readBigUInt64LE():BigInt(h.readUInt32LE())).toString();}
async function focusOwn(w){if(companion?.bridge){const r=await companion.bridge.call('focus-own',{windowId:windowId(w)});if(!r.focused)throw new Error('Click Hephaestus to give the input keyboard focus.');}}
async function showDashboard(page='companion',focusInput=false){dashboard.show();dashboard.focus();await focusOwn(dashboard);send(dashboard,'navigate',{page,focusInput});}
async function showRuntimeView({visible,route='thread',bounds,selectCost=false,navigateToRoute=false}){
 if(!visible){runtimeView?.setVisible(false);return;}
 if(!companion?.t3||companion.state.connection!=='connected')return;
 if(!runtimeView){
  runtimeSession=session.fromPartition('persist:hephaestus-t3');
  runtimeSession.webRequest.onBeforeSendHeaders((details,callback)=>{const headers={...details.requestHeaders};delete headers.Authorization;delete headers.authorization;const url=details.url.replace(/^ws:/,'http:');if(companion.t3?.token&&url.startsWith(companion.t3.origin+'/'))headers.Authorization='Bearer '+companion.t3.token;callback({requestHeaders:headers});});
  runtimeView=new WebContentsView({webPreferences:{session:runtimeSession,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});dashboard.contentView.addChildView(runtimeView);runtimeView.webContents.on('console-message',event=>{if(event.level>=2)runtimeDiagnostics.push(event.message.slice(0,700));});
  runtimeView.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//.test(url))safe(shell.openExternal(url));return{action:'deny'};});
  runtimeView.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(companion.t3.origin+'/')){event.preventDefault();if(/^https?:\/\//.test(url))safe(shell.openExternal(url));}});
 }
 if(!bounds||!Object.values(bounds).every(Number.isFinite))throw new Error('Invalid workspace bounds');
 const size=dashboard.getContentBounds(),x=Math.max(0,bounds.x),y=Math.max(0,bounds.y);runtimeView.setBounds({x,y,width:Math.max(1,Math.min(bounds.width,size.width-x)),height:Math.max(1,Math.min(bounds.height,size.height-y))});runtimeView.setVisible(true);
 const path=route==='usage'?'/usage':'/'+companion.t3Config.environment.environmentId+'/'+encodeURIComponent(companion.t3ThreadId);
 const url=companion.t3.origin+path,changed=!runtimeRoute||!runtimeRoute.startsWith(companion.t3.origin+'/')||navigateToRoute&&runtimeView.webContents.getURL()!==url;if(changed){runtimeRoute=url;await runtimeView.webContents.loadURL(url);}
 if(route==='usage'&&(changed||selectCost))await runtimeView.webContents.executeJavaScript(`new Promise(resolve=>{let attempts=0;const timer=setInterval(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cost');if(button){button.click();clearInterval(timer);resolve(true);}else if(++attempts>100){clearInterval(timer);resolve(false);}},100);})`);
}
function placeBubble(){
 if(!bubble||!mascot)return;const m=mascot.getBounds(),a=screen.getDisplayMatching(m).workArea,b=bubble.getBounds();
 const below=m.y-b.height+12<a.y+8;const x=Math.max(a.x+10,Math.min(a.x+a.width-b.width-10,m.x+m.width/2-b.width+44));const y=below?m.y+m.height-30:m.y-b.height+20;
 bubble.setPosition(Math.round(x),Math.round(Math.max(a.y+8,Math.min(a.y+a.height-b.height-8,y))));send(bubble,'placement',{below,tail:Math.max(26,Math.min(b.width-26,m.x+m.width/2-x))});
}
function showBubble(){if(popupSuppressed||bubble.isVisible())return;placeBubble();bubble.showInactive();mascot.moveTop();}
function dismissBubble(){popupSuppressed=true;bubble.hide();}
function overlayBounds(){const ds=screen.getAllDisplays().map(d=>d.bounds),x=Math.min(...ds.map(d=>d.x)),y=Math.min(...ds.map(d=>d.y));return{x,y,width:Math.max(...ds.map(d=>d.x+d.width))-x,height:Math.max(...ds.map(d=>d.y+d.height))-y};}
function localPoint(point){const p=screen.screenToDipPoint(point),b=ink.getBounds();return{x:p.x-b.x,y:p.y-b.y};}
function drawMark({mark,frame}){
 if(mark.kind==='clear'){send(ink,'clearInk',{});return;}
 const p=localPoint(framePoint(frame,mark.x,mark.y)),m={...mark,...p};
 if(mark.x2!==undefined){const q=localPoint(framePoint(frame,mark.x2,mark.y2));m.x2=q.x;m.y2=q.y;}
 if(mark.radius){const edge=localPoint(framePoint(frame,Math.min(frame.width,mark.x+mark.radius),mark.y));m.radius=Math.max(8,edge.x-p.x);}
 if(mark.points)m.points=mark.points.map(v=>localPoint(framePoint(frame,v.x,v.y)));send(ink,'mark',m);
}
function moveAttention({point,label=''}){
 const p=screen.screenToDipPoint(point);companion.attentionPhysical={...point,label};send(ink,'attention',{...localPoint(point),label});
 const start=mascot.getPosition(),target=clampPosition({x:p.x+42,y:p.y-62}),dx=target.x-start[0],dy=target.y-start[1];
 const directions=['east','southeast','south','southwest','west','northwest','north','northeast'],direction=directions[(Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8];
 const duration=Math.min(2600,Math.max(500,Math.hypot(dx,dy)*3)),started=Date.now();clearInterval(animation);deliver('movement',{active:true,direction});
 animation=setInterval(()=>{const f=Math.min(1,(Date.now()-started)/duration);mascot.setPosition(Math.round(start[0]+dx*f),Math.round(start[1]+dy*f));if(f===1){clearInterval(animation);deliver('movement',{active:false});safe(companion.configure({mascotPosition:target}));}},24);
}
async function installWispr(){if(!companion.bridge)return;const w=await readWisprShortcuts();companion.publish({wispr:w});await companion.bridge.call('input-watch',{bindings:w.bindings});}
function disarm(){clearTimeout(routeTimer);clearInterval(recordingTimer);dictation.reset();deliver('dictation',{armed:false});companion.voiceEpoch=(companion.voiceEpoch??0)+1;companion.publish({dictating:false,hearing:false});}
function released(){dictation.active=false;dictation.sticky=false;companion.publish({dictating:false});deliver('dictationReleased',{});clearTimeout(routeTimer);routeTimer=setTimeout(disarm,12000);}
async function wisprKey(event){
 const action=dictation.key(event);if(action==='cancel'){disarm();return;}
 if(action==='start'){
  clearTimeout(routeTimer);clearInterval(recordingTimer);companion.voiceEpoch=(companion.voiceEpoch??0)+1;deliver('silence');companion.publish({dictating:true});
  const version=dictation.version,focus=await companion.bridge.call('focus-probe');if(version!==dictation.version||!dictation.active)return;
  const runtimeFocused=runtimeView?.webContents.isFocused()===true;
  const runtimeEditable=runtimeFocused?await runtimeView.webContents.executeJavaScript(`(()=>{const e=document.activeElement;return !!e&&(e.isContentEditable||['TEXTAREA','INPUT'].includes(e.tagName)&&!e.readOnly&&!e.disabled);})()`):false;
  const active=dashboard.isFocused()&&!runtimeFocused?await dashboard.webContents.executeJavaScript('document.activeElement?.id'):'';
  const ownInput=mascot.isFocused()||active==='dashboard-input';
  const route=dictationDestination({ownChat:ownInput,ownSettings:dashboard.isFocused()&&!runtimeFocused&&focus.editable===true&&active!=='dashboard-input',editable:runtimeFocused?runtimeEditable:focus.editable});
  dictation.armed=route==='companion';dictationTarget=active==='dashboard-input'||!companion.state.autoSend?'dashboard':'mascot';
  if(dictation.armed){safe(companion.interrupt());if(dictationTarget==='mascot'){mascot.focus();await focusOwn(mascot);}else await showDashboard('companion',true);send(dictationTarget==='mascot'?mascot:dashboard,'focusDictation',{});send(dictationTarget==='mascot'?mascot:dashboard,'dictation',{armed:true});}
  let seen=false,misses=0,polling=false;const started=Date.now();
  recordingTimer=setInterval(async()=>{if(polling)return;polling=true;try{const s=await companion.bridge.call('wispr-recording');if(s.active){seen=true;misses=0;}else if(s.available&&((seen&&++misses>=2)||(!seen&&Date.now()-started>10000))){clearInterval(recordingTimer);released();}}catch{}finally{polling=false;}},350);
  routeTimer=setTimeout(disarm,20*60*1000);
 }
 if(['finish','tap'].includes(action))released();
}
function inside(w,p){const b=w.getBounds();return w.isVisible()&&p.x>=b.x&&p.x<=b.x+b.width&&p.y>=b.y&&p.y<=b.y+b.height;}

async function boot(){
 await mkdir(join(root,'runtime'),{recursive:true});await writeFile(join(root,'runtime/app.pid'),String(process.pid));
 const work=screen.getPrimaryDisplay().workArea;
 dashboard=createWindow('dashboard.html',{width:Math.min(1280,work.width-40),height:Math.min(840,work.height-40),minWidth:Math.min(960,work.width-40),minHeight:Math.min(620,work.height-40),resizable:true,skipTaskbar:false,alwaysOnTop:false,transparent:false,backgroundColor:'#121419',hasShadow:true,title:'Hephaestus'});
 mascot=createWindow('mascot.html',{width:100,height:124,x:work.x+work.width-140,y:work.y+work.height-172,title:'Hephaestus'});
 bubble=createWindow('bubble.html',{width:366,height:200,focusable:false,title:'Hephaestus · Reply'});
 ink=createWindow('ink.html',{...overlayBounds(),focusable:false,title:'Hephaestus · Highlights'});ink.setIgnoreMouseEvents(true);
 companion=new T3Companion({root,dataDir:process.argv.includes('--t3-check')?join(root,'runtime/t3-verification'):process.argv.includes('--revision-check')?join(root,'runtime/revision-verification'):process.argv.includes('--hephaestus-check')?join(root,'runtime/hephaestus-verification'):app.getPath('userData'),excludePids:[process.pid],openBrowser:()=>shell.openExternal('microsoft-edge:about:blank')});
 if(qualityMode||sessionMode||routeMode){
  const overrides={watching:false,backgroundVision:false,proactive:false,inputMode:'wispr',spokenReplies:false};Object.assign(companion.state,overrides);
  await mkdir(companion.dataDir,{recursive:true});let verificationSettings={};try{verificationSettings=JSON.parse(await readFile(join(companion.dataDir,'settings.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  await writeFile(join(companion.dataDir,'settings.json'),JSON.stringify({...verificationSettings,...overrides},null,2));
 }
 session.defaultSession.setPermissionRequestHandler((contents,p,cb)=>cb(p==='media'&&contents===mascot.webContents&&companion.state.inputMode==='always'&&companion.state.running));
 session.defaultSession.setPermissionCheckHandler((contents,p)=>p==='media'&&contents===mascot.webContents&&companion.state.inputMode==='always'&&companion.state.running);
 let positioned=false,wasBusy=false;
 companion.on('state',s=>{if(quitting)return;deliver('state',s);mascot.setOpacity(s.opacity);tray?.setToolTip(`Hephaestus · ${s.activity}`);const menuKey=String(s.running)+'/'+String((s.noticeSnoozeUntil??0)>Date.now());if(tray&&menuKey!==trayMenuKey){trayMenuKey=menuKey;tray.setContextMenu(menu());}if(!positioned&&s.connection==='connected'){positioned=true;if(s.mascotPosition){const p=clampPosition(s.mascotPosition);mascot.setPosition(p.x,p.y);}}if(s.busy&&!wasBusy&&!String(s.activity).startsWith('Refreshing'))showBubble();wasBusy=s.busy;});
 companion.on('message',m=>{deliver('message',m);if(m.role==='user'){popupSuppressed=false;send(bubble,'thinking',{});}else if(m.role==='assistant'){if(m.source==='noticed')popupSuppressed=false;showBubble();}});
 companion.on('messageUpdated',m=>deliver('messageUpdated',m));
 companion.on('messagesRestored',messages=>deliver('messagesRestored',messages));
 companion.on('voiceInputFailed',()=>{if(!quitting)safe(showDashboard('companion',true));});
 companion.on('delta',d=>{deliver('delta',d);showBubble();});
 for(const e of ['speechFlush','silence','speak','confirmation','action','responseStart','activity'])companion.on(e,d=>{deliver(e,d);if(e==='confirmation'&&d)safe(showDashboard('companion'));});
 companion.on('frame',f=>send(dashboard,'frame',f));companion.on('visionFrame',f=>send(dashboard,'visionFrame',f));
 companion.on('annotation',drawMark);companion.on('attention',moveAttention);companion.on('wisprKey',e=>safe(wisprKey(e)));companion.on('bridgeReady',()=>safe(installWispr()));companion.on('bridgeLost',disarm);
 companion.on('mouseDown',e=>{if(!bubble.isVisible())return;const p=screen.screenToDipPoint({x:e.x,y:e.y});if(!inside(mascot,p)&&!inside(bubble,p))dismissBubble();});
 mascot.on('move',()=>{if(bubble.isVisible())placeBubble();});
 ipcMain.handle('companion:request',async(event,{command,params={}})=>{
  const sender=windows().find(w=>w.webContents===event.sender);if(!sender)throw new Error('Unknown caller');
  if(command==='init')return{state:companion.state,messages:companion.messages,activities:companion.activities,tools:[...dynamicTools,...t3Tools].map(t=>({name:t.name,description:t.description})),defaultPrompt:companion.defaultPrompt??'',frame:companion.latest,monitors:await companion.bridge?.call('monitors').catch(()=>[])??[],startAtLogin:app.getLoginItemSettings().openAtLogin,inkBounds:ink.getBounds()};
  if(command==='configure'){const result=await companion.configure(params);if(params.inputMode||params.inputDevice)send(mascot,'listenerRestart',{});return result;}
  if(command==='dismiss-error'){companion.publish({error:null});return;}
  if(command==='notice-feedback')return companion.noticeFeedback(params.id,params.value);
  if(command==='usage-report'){await companion.historyImport;return companion.ledger.report(params);}
  if(command==='runtime-view'&&sender===dashboard)return showRuntimeView(params);
  if(command==='open-link'){if(!/^https?:\/\//i.test(params.url??''))throw new Error('Only web links can open here');return shell.openExternal(params.url);}
  if(command==='send'){
   if(sender!==dashboard&&sender!==mascot)throw new Error('Use the dashboard or Wispr input');
   if(params.source==='wispr'&&!dictation.armed)throw new Error('Dictation session ended');
   const text=String(params.text??''),intentionalWispr=params.source==='wispr'&&dictation.armed,startedAt=Date.now();
   try{
   disarm();if(!text.trim())return{accepted:false};
   if(companion.state.sendPending)throw new Error('Your message is being sent. Please wait a moment.');
   if(companion.state.stopping||companion.desktopActionsRevoked&&companion.t3InFlight)throw new Error('The previous request has not stopped yet. Your message has not been sent.');
   companion.publish({sendPending:true,error:null});
   return await new Promise((resolve,reject)=>{
    let accepted=false;
    const acknowledge=(result={})=>{if(accepted)return;accepted=true;companion.publish({sendPending:false});resolve({accepted:true,...result});};
    companion.submit(text,{source:params.source==='wispr'?'wispr':'text',onAccepted:acknowledge}).then(()=>{
     if(!accepted){companion.publish({sendPending:false});reject(new Error('Your message was not sent. Please try again.'));}
    },error=>{
     companion.publish({sendPending:false,error:error.message});
     if(!accepted)reject(error);
    });
   });
   }catch(error){
    if(intentionalWispr&&text.trim()){
     try{await preserveFailedVoiceInput(companion,{text,source:'wispr',error,startedAt});if(sender===mascot)send(mascot,'dictationRecovered',{text});}catch(saveError){companion.publish({error:'Dictation could not be saved: '+saveError.message});}
     if(!quitting)safe(showDashboard('companion',true));
    }
    throw error;
   }
  }
  if(command==='audio'&&sender===mascot){const bytes=Buffer.from(params.audio);if(bytes.length>16000*32*4)throw new Error('Audio segment too long');safe(companion.transcribe(bytes.toString('base64')));return;}
  if(command==='voice-status'&&sender===mascot){companion.publish({listening:params.active===true,echoCancellation:params.echoCancellation??null,voiceError:params.error??null,...(!params.active?{hearing:false}:{})});return;}
  if(command==='voice-level'&&sender===mascot){send(dashboard,'voiceLevel',params);return;}
  if(command==='voice-start'&&sender===mascot){companion.publish({hearing:true});deliver('silence');return;}
  if(command==='voice-idle'&&sender===mascot){if(!companion.transcribing)companion.publish({hearing:false});return;}
  if(command==='dictation-complete'&&dictation.armed){released();return;}
  if(command==='talking'&&sender===mascot){if(companion.state.speaking!==(params.active===true))companion.publish({speaking:params.active===true});if(params.text){companion.spokenHistory.push({text:String(params.text),at:Date.now()});companion.spokenHistory=companion.spokenHistory.slice(-8);}if(params.error)companion.publish({error:'Speech: '+params.error});return;}
  if(command==='interrupt'){disarm();return companion.interrupt();}
  if(command==='confirm')return companion.confirm(params.approved===true);
  if(command==='show-dashboard')return showDashboard(params.page??'companion',params.focusInput===true);
  if(command==='toggle-bubble'){if(bubble.isVisible())dismissBubble();else{popupSuppressed=false;showBubble();}return;}
  if(command==='bubble-size'&&sender===bubble){const height=Math.max(96,Math.min(340,Math.ceil(params.height)+26));clearTimeout(bubbleResizeTimer);bubbleResizeTimer=setTimeout(()=>{if(Math.abs(bubble.getBounds().height-height)>3){bubble.setResizable(true);bubble.setSize(366,height);bubble.setResizable(false);placeBubble();}},32);return;}
  if(command==='hide'){sender.hide();return;}
  if(command==='window-minimize'&&sender===dashboard){dashboard.minimize();return;}
  if(command==='window-maximize'&&sender===dashboard){dashboard.isMaximized()?dashboard.unmaximize():dashboard.maximize();return;}
  if(command==='clear-ink'){send(ink,'clearInk',{});return;}
  if(command==='refresh-screen'){await companion.sample();return;}
  if(command==='drag-mascot'&&sender===mascot){clearInterval(animation);const p=clampPosition({x:params.x,y:params.y});mascot.setPosition(p.x,p.y);deliver('movement',{active:true,direction:params.direction??'east'});return;}
  if(command==='drag-finished'&&sender===mascot){deliver('movement',{active:false});const[x,y]=mascot.getPosition();return companion.configure({mascotPosition:{x,y}});}
  if(command==='menu'){menu().popup({window:mascot});return;}
  if(command==='login-startup'){app.setLoginItemSettings({openAtLogin:params.enabled===true,path:process.execPath,args:app.isPackaged?['--background']:[root,'--background']});return{enabled:app.getLoginItemSettings().openAtLogin};}
  if(command==='quit'){app.quit();return;}
  throw new Error('Unknown command');
 });
 await Promise.all(windows().map(w=>w.webContents.isLoading()?new Promise(r=>w.webContents.once('did-finish-load',r)):Promise.resolve()));
 ink.showInactive();mascot.showInactive();mascot.moveTop();tray=new Tray(icon);tray.setToolTip('Hephaestus');tray.on('double-click',()=>safe(showDashboard()));tray.setContextMenu(menu());
 globalShortcut.register('Control+Alt+Space',()=>safe(showDashboard('companion',true)));globalShortcut.register('Control+Alt+H',()=>safe(showDashboard()));globalShortcut.register('Control+Alt+Escape',()=>{disarm();dismissBubble();safe(companion.interrupt());});
 app.on('second-instance',()=>safe(showDashboard()));const resize=()=>{ink.setBounds(overlayBounds());placeBubble();};screen.on('display-metrics-changed',resize);screen.on('display-added',resize);screen.on('display-removed',resize);
 const pause=()=>{disarm();safe(companion.configure({running:false}));};powerMonitor.on('suspend',pause);powerMonitor.on('lock-screen',pause);
 await companion.start();shortcutTimer=setInterval(()=>safe(installWispr()),15000);
 if(!process.argv.includes('--background'))await showDashboard();
 if(process.argv.includes('--hephaestus-check')){const{hephaestusCheck}=await import('../scripts/hephaestus-check.js');await hephaestusCheck({dashboard,mascot,bubble,ink,companion,root,showDashboard,showBubble,placeBubble,moveAttention,wisprKey});}
 if(routeMode){const{wisprRouteCheck}=await import('../scripts/wispr-route-check.js');const passed=await wisprRouteCheck({dashboard,mascot,bubble,companion,root,wisprKey,showDashboard,showBubble,app});verificationExitCode=passed?0:1;app.quit();return;}
 if(process.argv.includes('--revision-check')){const{revisionCheck}=await import('../scripts/revision-check.js');await revisionCheck({dashboard,mascot,bubble,companion,root,showDashboard,showBubble});}
 if(process.argv.includes('--t3-check')){const{t3Check}=await import('../scripts/t3-check.js');await t3Check({dashboard,mascot,bubble,companion,root,showDashboard,showBubble,runtimeView:()=>runtimeView,runtimeDiagnostics:()=>runtimeDiagnostics});}
 if(process.argv.includes('--installed-check')){const{installedCheck}=await import('../scripts/installed-check.js');await installedCheck({dashboard,mascot,bubble,companion,root,showDashboard,wisprKey,runtimeView:()=>runtimeView});}
 if(process.argv.includes('--repair-check')){const{repairCheck}=await import('../scripts/repair-check.js');await repairCheck({dashboard,companion,root,showDashboard});}
 if(qualityMode){const{qualityCheck}=await import('../scripts/quality-check.js');const passed=await qualityCheck({dashboard,mascot,bubble,companion,root,showDashboard,showBubble,app,fast:process.argv.includes('--quality-check-fast')});verificationExitCode=passed?0:1;app.quit();}
 if(sessionMode){const{sessionCheck}=await import('../scripts/session-check.js');const passed=await sessionCheck({dashboard,mascot,bubble,companion,root,showDashboard,app});verificationExitCode=passed?0:1;app.quit();}
}
function menu(){return Menu.buildFromTemplate([{label:'Open Hephaestus',click:()=>safe(showDashboard())},{label:'Voice & listening',click:()=>safe(showDashboard('voice'))},{label:'Instructions',click:()=>safe(showDashboard('instructions'))},{type:'separator'},{label:companion?.state.running?'Pause companion':'Resume companion',click:()=>safe(companion.configure({running:!companion.state.running}))},{label:(companion?.state.noticeSnoozeUntil??0)>Date.now()?'Resume spontaneous observations':'Quiet for 15 minutes',click:()=>safe(companion.configure({noticeSnoozeUntil:(companion.state.noticeSnoozeUntil??0)>Date.now()?0:Date.now()+15*60000}))},{type:'separator'},{label:'Show / hide answer bubble',click:()=>{if(bubble.isVisible())dismissBubble();else{popupSuppressed=false;showBubble();}}},{label:'Clear highlights',click:()=>send(ink,'clearInk',{})},{label:'Stop reply · Ctrl+Alt+Esc',click:()=>safe(companion.interrupt())},{type:'separator'},{label:'Quit Hephaestus',click:()=>app.quit()}]);}
app.on('before-quit',e=>{if(closing)return;e.preventDefault();closing=true;quitting=true;runtimeView?.webContents.close();globalShortcut.unregisterAll();clearInterval(shortcutTimer);clearInterval(animation);clearTimeout(routeTimer);clearInterval(recordingTimer);if(qualityMode||sessionMode||routeMode)console.log('VERIFICATION_EXIT cleanup started');Promise.resolve(companion?.close()).then(()=>{if(qualityMode||sessionMode||routeMode)console.log('VERIFICATION_EXIT cleanup finished');app.exit(verificationExitCode);},error=>{console.error(error);app.exit(1);});});app.on('window-all-closed',()=>{});
if(locked)app.whenReady().then(boot).catch(e=>{console.error(e);verificationExitCode=1;app.quit();});
