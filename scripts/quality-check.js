import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
    check('Real T3 conversation and subscription are connected', c.state.connection === 'connected' && c.state.runtime === 't3');
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
    await snapshot('settings-error.png');
    await dashboard.webContents.executeJavaScript(`(()=>{const field=document.querySelector('#excluded-apps');field.value='';field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#save-privacy').click();})()`);
    await until(()=>dashboard.webContents.executeJavaScript(`document.querySelector('#privacy-status').textContent==='Private apps saved.'`),3000,'Corrected privacy settings were not saved');
    check('Correcting the field clears its error',await dashboard.webContents.executeJavaScript(`!document.querySelector('#excluded-apps').hasAttribute('aria-invalid')`));
    await showDashboard('companion');
    const messagesBeforeLong=c.messages.length,runsBeforeLong=c.t3Runs.size;
    await dashboard.webContents.executeJavaScript(String.raw`(()=>{const input=document.querySelector('#dashboard-input');input.value='  '+'Я'.repeat(16001)+'\n';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#message-form').requestSubmit();})()`);
    await until(()=>dashboard.webContents.executeJavaScript(`!document.querySelector('#notice').hidden&&/16,?000/.test(document.querySelector('#notice-message').textContent)`),3000,'Oversized input did not receive a readable error');
    check('Oversized input remains intact and does not reach a model or transcript',c.messages.length===messagesBeforeLong&&c.t3Runs.size===runsBeforeLong&&await dashboard.webContents.executeJavaScript(String.raw`document.querySelector('#dashboard-input').value==='  '+'Я'.repeat(16001)+'\n'&&!document.querySelector('#notice-message').textContent.includes('remote method')`));
    await dashboard.webContents.executeJavaScript(`(()=>{const input=document.querySelector('#dashboard-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#notice-dismiss').click();})()`);

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
      report.requests.push({ kind: 'desktop action', timings: c.state.lastTimings, firstReplyMs: c.state.lastReplyMs });
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
