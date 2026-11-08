import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import {verifyInstructionSettings} from './settings-check.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000, message = 'Condition was not met') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle=Math.floor(sorted.length/2),median=sorted.length?sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2:null;
  return { samples: sorted.length, medianMs: median,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null };
}

// Exercises the production windows and real local runtime in a separate data directory.
// No transcript, token count, response or screenshot is fabricated.
export async function qualityCheck({ dashboard, mascot, bubble, companion: c, root, showDashboard, showBubble, app, fast = false }) {
  const outputName=process.argv.find(a=>a.startsWith('--quality-output='))?.split('=')[1]??'';
  if(outputName&&!/^[a-z0-9-]+$/.test(outputName))throw new Error('Invalid quality output name');
  const out = join(root, 'artifacts', 'quality',outputName);
  await mkdir(out, { recursive: true });
  const report = { at: new Date().toISOString(), fast, checks: [], screenshots: [], localCommands: [], requests: [] };
  let fixture, lines;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('CHECK ' + name); };
  const snapshot = async name => {
    await delay(200);
    await writeFile(join(out, name), (await dashboard.webContents.capturePage()).toPNG());
    report.screenshots.push(name);
  };
  try {
    report.startup = { connection: c.state.connection, activity: c.state.activity, error: c.state.error ?? null };
    check('Real T3 conversation and subscription are connected', c.state.connection === 'connected' && c.state.runtime === 't3');
    check('Desktop tools use the enabled trusted origin hook',c.originHook?.enabled===true&&c.originHook?.trustStatus==='trusted');
    await c.configure({ watching: false, backgroundVision: false, inputMode: 'wispr', spokenReplies: false });
    const version = app.getVersion();
    report.runtime = { version, model: c.state.model, platform: process.platform, electron: process.versions.electron };
    report.scaleFactor=await dashboard.webContents.executeJavaScript('window.devicePixelRatio');
    const sprite = await mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect()');
    check('Real sprite renders and the microphone remains closed', sprite.character === 'Hephaestus' && !sprite.voice.microphoneActive);

    for (const [width, height] of [[1280, 840], [960, 620]]) {
      dashboard.setSize(width, height);
      await showDashboard('companion');
      await delay(150);
      await dashboard.webContents.executeJavaScript(`(()=>{const b=document.querySelector('#toggle-screen');if(b?.getAttribute('aria-expanded')==='false')b.click();})()`);
      const layout = await dashboard.webContents.executeJavaScript(`(()=>{
        const input=document.querySelector('#dashboard-input').getBoundingClientRect(),send=document.querySelector('#send').getBoundingClientRect();
        return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
          composerVisible:input.width>150&&input.top>=0&&input.bottom<=innerHeight,
          sendVisible:send.top>=0&&send.bottom<=innerHeight,
          unnamedButtons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.getAttribute('aria-label')&&!b.textContent.trim()).length};
      })()`);
      report['layout' + width] = layout;
      check(`Composer remains accessible at ${width}×${height}`, !layout.horizontalOverflow && layout.composerVisible && layout.sendVisible && layout.unnamedButtons === 0);
      await snapshot(`dashboard-${width}.png`);
      const collapse=await dashboard.webContents.executeJavaScript(`(()=>{
        const card=document.querySelector('.conversation-card'),button=document.querySelector('#toggle-screen'),before=card.getBoundingClientRect().width;
        button.click();const bounds=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1};};
        return {before,expanded:button.getAttribute('aria-expanded'),after:card.getBoundingClientRect().width,send:bounds(document.querySelector('#send')),toggle:bounds(button),composer:bounds(document.querySelector('#dashboard-input')),overflow:document.documentElement.scrollWidth>innerWidth+1};
      })()`);
      check(`Conversation can take full width at ${width}×${height}`,collapse.expanded==='false'&&collapse.after>collapse.before*1.2);
      check(`Expanded conversation controls stay inside ${width}×${height}`,!collapse.overflow&&collapse.send.visible&&collapse.toggle.visible&&collapse.composer.visible);
      report['expandedLayout'+width]=collapse;
      await snapshot(`conversation-full-${width}.png`);
      await dashboard.webContents.executeJavaScript(`document.querySelector('#toggle-screen').click()`);
    }
    dashboard.setSize(1280, 840);
    for (const page of ['screen', 'voice', 'instructions', 'activity', 'usage']) {
      await showDashboard(page);
      await delay(page === 'usage' ? 600 : 120);
      check(`${page} view opens`, await dashboard.webContents.executeJavaScript(`document.querySelector('[data-view="${page}"]').hidden===false`));
      await snapshot(page + '.png');
    }
    await showDashboard('companion', true);
    check('Sharing paused clears both screen previews', await dashboard.webContents.executeJavaScript(`document.querySelector('#screen-preview').hidden&&!document.querySelector('#large-preview')?.getAttribute('src')`));
    await showDashboard('screen');
    await dashboard.webContents.executeJavaScript(`(()=>{const e=document.querySelector('#excluded-apps');e.value='invalid/path.exe';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#save-privacy').click();})()`);
    await until(()=>dashboard.webContents.executeJavaScript(`document.querySelector('#excluded-apps').getAttribute('aria-invalid')==='true'`),3000,'Invalid privacy input did not surface an inline error');
    check('Settings failures preserve input and show plain guidance beside the field',await dashboard.webContents.executeJavaScript(`(()=>{const field=document.querySelector('#excluded-apps'),error=document.querySelector('#privacy-status'),r=error.getBoundingClientRect();return field.value==='invalid/path.exe'&&field.getAttribute('aria-describedby').includes('privacy-status')&&error.textContent.includes('process names')&&!error.textContent.includes('remote method')&&r.top>=0&&r.bottom<=innerHeight;})()`));
    await snapshot('privacy-error.png');
    await dashboard.webContents.executeJavaScript(`(()=>{const field=document.querySelector('#excluded-apps');field.value='';field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#save-privacy').click();})()`);
    await until(()=>dashboard.webContents.executeJavaScript(`document.querySelector('#privacy-status').textContent==='Private apps saved.'`),3000,'Corrected privacy settings were not saved');
    check('Correcting the field clears its error',await dashboard.webContents.executeJavaScript(`!document.querySelector('#excluded-apps').hasAttribute('aria-invalid')`));
    report.instructions=await verifyInstructionSettings({root,companion:c,dashboard,showDashboard,out});
    for(const name of report.instructions.checks)check(name,true);
    report.screenshots.push(...report.instructions.screenshots);
    await showDashboard('companion');
    const messagesBeforeLong=c.messages.length,runsBeforeLong=c.t3Runs.size;
    await dashboard.webContents.executeJavaScript(String.raw`(()=>{const input=document.querySelector('#dashboard-input');input.value='  '+'Я'.repeat(16001)+'\n';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#message-form').requestSubmit();})()`);
    await until(()=>dashboard.webContents.executeJavaScript(`!document.querySelector('#notice').hidden&&/16,?000/.test(document.querySelector('#notice-message').textContent)`),3000,'Oversized input did not receive a readable error');
    check('Oversized input remains intact and does not reach a model or transcript',c.messages.length===messagesBeforeLong&&c.t3Runs.size===runsBeforeLong&&await dashboard.webContents.executeJavaScript(String.raw`document.querySelector('#dashboard-input').value==='  '+'Я'.repeat(16001)+'\n'&&!document.querySelector('#notice-message').textContent.includes('remote method')`));
    await dashboard.webContents.executeJavaScript(`(()=>{const input=document.querySelector('#dashboard-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#notice-dismiss').click();})()`);
    const composingBefore={messages:new Set(c.messages.map(message=>message.id)),runs:new Set(c.t3Runs.keys())};
    const composingSaved=await dashboard.webContents.executeJavaScript(`({draft:document.querySelector('#dashboard-input').value,noticeHidden:document.querySelector('#notice').hidden})`);
    assert.ok(composingSaved.noticeHidden&&!c.state.sendPending,'The composing-key check requires the previous oversized-input notice to be dismissed');
    try{
      const keyboard=await dashboard.webContents.executeJavaScript(String.raw`(()=>{
        const input=document.querySelector('#dashboard-input'),draft='  '+'\u6f22'.repeat(16001)+'\n';
        input.value=draft;input.dispatchEvent(new Event('input',{bubbles:true}));
        const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true});
        const defaultAllowed=input.dispatchEvent(event),inspect=window.hephaestusDashboardInspect();
        return {isComposing:event.isComposing,defaultPrevented:event.defaultPrevented,defaultAllowed,draftPreserved:input.value===draft,
          pending:inspect.sendPending||inspect.input.submitting,draftCharacters:draft.length};
      })()`);
      await until(()=>dashboard.webContents.executeJavaScript(`(()=>{const view=window.hephaestusDashboardInspect();return !view.sendPending&&!view.input.submitting;})()`),3000,'The composing-key check did not settle');
      const preserved=await dashboard.webContents.executeJavaScript(String.raw`document.querySelector('#dashboard-input').value==='  '+'\u6f22'.repeat(16001)+'\n'&&document.querySelector('#notice').hidden`);
      report.composingEnter={kind:'synthetic composing keyboard event',humanImeTrial:false,oversizedSafety:true,...keyboard};
      check('Synthetic composing Enter preserves the unfinished draft without dispatch',keyboard.isComposing&&!keyboard.defaultPrevented&&keyboard.defaultAllowed&&keyboard.draftPreserved&&!keyboard.pending&&preserved&&!c.state.sendPending&&c.messages.length===composingBefore.messages.size&&c.messages.every(message=>composingBefore.messages.has(message.id))&&c.t3Runs.size===composingBefore.runs.size&&[...c.t3Runs.keys()].every(id=>composingBefore.runs.has(id)));
    }finally{
      await dashboard.webContents.executeJavaScript(`(()=>{document.querySelector('#notice-dismiss').click();const input=document.querySelector('#dashboard-input');input.value=${JSON.stringify(composingSaved.draft)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }

    if (!fast) {
      const records = [];
      fixture = spawn(join(root, 'native/bin/release/ScreenBridge.exe'), ['--test-window'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      lines = createInterface({ input: fixture.stdout });
      lines.on('line', line => { try { records.push(JSON.parse(line)); } catch {} });
      await until(() => records.some(r => r.eventName === 'ready'), 10000, 'Native verification window did not open');
      const target = records.find(r => r.eventName === 'ready').windowId;
      await c.bridge.call('action', { kind: 'focus', query: target });
      await c.configure({ watching: true });

      const runsBefore=c.t3Runs.size;
      for (let i = 0; i < 30; i++) {
        const started = Date.now();
        await c.submit(i % 2 ? 'Scroll up' : 'Scroll down');
        report.localCommands.push(Date.now() - started);
      }
      check('Thirty local commands complete without model requests', c.t3Runs.size===runsBefore&&c.messages.filter(m => m.source === 'local').length >= 30 && report.localCommands.length === 30);
      report.localLatency = distribution(report.localCommands);

      const prompts = [
        'Describe the visible verification window in one short sentence. Do not call tools.',
        'Which input field is visible in this window? One short sentence; no tools.',
        'What action does the main button in this window offer? Answer briefly without tools.',
      ];
      for (const prompt of prompts) {
        await c.bridge.call('action', { kind: 'focus', query: target });
        const started = Date.now();
        await c.submit(prompt);
        const answer = c.messages.filter(m => m.role === 'assistant' && m.source !== 'local' && m.at >= started).at(-1);
        check('Contextual request produced a real reply', !!answer?.text?.trim());
        report.requests.push({ kind: 'contextual', timings: c.state.lastTimings, firstReplyMs: c.state.lastReplyMs });
      }

      await c.bridge.call('action', { kind: 'focus', query: target });
      await c.submit('In the verification window only, click the Keyboard verification area and type "Hephaestus verified" using screen_action. Do not change other applications.');
      check('Real model-controlled input reaches the intended field', records.some(r => r.eventName === 'text' && r.text === 'Hephaestus verified'));
      check('Desktop action passed originating-turn authorization',(c.desktopServer?.metrics?.tools.screen_action??0)>0);
      await until(()=>(c.desktopServer?.metrics?.imagesConfirmed??0)>0,3000,'No shared tool image received a confirmed MCP delivery receipt');
      check('Tool images are confirmed after MCP delivery',(c.desktopServer?.metrics?.imagesConfirmed??0)>0);
      report.desktopBridge={originsAuthorized:c.desktopServer.metrics.originsAuthorized,tools:{...c.desktopServer.metrics.tools},imagesConfirmed:c.desktopServer.metrics.imagesConfirmed,hookTrusted:c.originHook?.trustStatus==='trusted'};
      report.requests.push({ kind: 'desktop action', timings: c.state.lastTimings, firstReplyMs: c.state.lastReplyMs });
      await c.bridge.call('action',{kind:'focus',query:target});
      const externalId=randomUUID(),externalStarted=Date.now(),bridgeMetrics=c.desktopServer.metrics;
      const baseline={originsAuthorized:bridgeMetrics.originsAuthorized,imagesConfirmed:bridgeMetrics.imagesConfirmed,tools:{...bridgeMetrics.tools}};
      const external=report.externalWorkspace={success:false,dispatch:'direct T3 orchestration API; not companion.submit',creationSource:'web',messageId:externalId,externalBranchObserved:false};
      let externalBranch=false,externalRun,externalUser,externalReply;
      const externalState=state=>{if(state.busy&&c.externalT3Run&&c.t3MessageId===externalId){externalBranch=true;external.externalBranchObserved=true;}};
      const externalDelta=data=>{if(external.firstTextMs===undefined&&c.externalT3Run&&c.t3MessageId===externalId&&data.full?.trim())external.firstTextMs=Date.now()-externalStarted;};
      c.on('state',externalState);c.on('delta',externalDelta);
      try{
        await c.t3.call('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),
          threadId:c.t3ThreadId,messageId:externalId,attachments:[],modelSelection:c.modelSelection(),dispatchMode:{type:'start_immediately'},
          text:`Use only Hephaestus MCP screen_windows exactly once, then Hephaestus MCP screen_observe exactly once for a fresh view of the foreground input verification window (window ID ${target}). Then describe that verification window in one short sentence. Do not click, type, focus, scroll, annotate, change applications, or call any other tools.`});
        await until(()=>{
          externalRun=[...c.t3Runs.values()].find(run=>run.userMessageId===externalId);
          if(externalRun&&['failed','cancelled','interrupted','rolled_back'].includes(externalRun.status))throw new Error('Direct workspace request ended with '+externalRun.status);
          externalUser=c.messages.find(message=>message.role==='user'&&message.t3MessageId===externalId);
          externalReply=c.messages.find(message=>message.role==='assistant'&&message.turnId===externalRun?.id&&message.providerItemId&&message.text?.trim());
          return externalRun?.status==='completed'&&externalUser&&externalReply&&!c.state.busy&&!c.t3InFlight;
        },90000,'The direct workspace request did not complete with a real transcript');
        external.completionMs=Date.now()-externalStarted;
        const canonical=await c.t3.call('orchestration.getThreadProjection',{threadId:c.t3ThreadId});
        check('Direct T3 workspace requests retain the external conversation branch',externalBranch&&externalUser.source==='workspace'&&canonical.runs.some(run=>run.id===externalRun.id&&run.status==='completed')&&Number.isFinite(external.firstTextMs));
        await until(()=>bridgeMetrics.imagesConfirmed>baseline.imagesConfirmed,5000,'The workspace MCP observation did not receive a delivery confirmation');
        external.originTools=Object.fromEntries(['screen_windows','screen_observe'].map(tool=>[tool,(bridgeMetrics.tools[tool]??0)-(baseline.tools[tool]??0)]));
        external.originsAuthorized=bridgeMetrics.originsAuthorized-baseline.originsAuthorized;
        external.deliveryConfirmed=bridgeMetrics.imagesConfirmed-baseline.imagesConfirmed;
        check('Workspace-origin calls retain signed desktop tools and confirmed image delivery',external.originsAuthorized>0&&external.originTools.screen_windows>0&&external.originTools.screen_observe>0&&external.deliveryConfirmed>0);
        Object.assign(external,{success:true,runId:externalRun.id,externalBranchObserved:externalBranch});
      }finally{c.off('state',externalState);c.off('delta',externalDelta);}
      await c.configure({ watching: false });
      fixture.kill(); fixture = null;

      const before = c.messages.filter(m => m.role === 'assistant').length;
      const projection = await c.t3.call('orchestration.getThreadProjection', { threadId: c.t3ThreadId });
      c.restoreProjection(projection);
      c.restoreProjection(projection);
      check('Real T3 snapshot reconciliation does not duplicate replies', c.messages.filter(m => m.role === 'assistant').length === before);

      await showDashboard('companion');
      await snapshot('conversation.png');
      showBubble();
      await delay(150);
      await writeFile(join(out, 'bubble.png'), (await bubble.webContents.capturePage()).toPNG());
      const popup = await bubble.webContents.executeJavaScript('window.hephaestusBubbleInspect()');
      check('The answer bubble contains a real response and a single card', popup.cardCount === 1 && !!popup.renderedText.trim());
      report.replyLatency = distribution(report.requests.map(r => r.firstReplyMs).filter(Number.isFinite));
    }
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    console.error(error);
  } finally {
    lines?.close(); fixture?.kill();
    await c.configure({ watching: false, backgroundVision: false }).catch(() => {});
    await c.ledger?.flush();
    await writeFile(join(out, fast ? 'fast-check.json' : 'quality-check.json'), JSON.stringify(report, null, 2));
    console.log('QUALITY_CHECK ' + JSON.stringify({ success: report.success, error: report.error, checks: report.checks, localLatency: report.localLatency, replyLatency: report.replyLatency }));
  }
  return report.success;
}
