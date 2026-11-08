import {createWorkspace} from './workspace.js';
import {renderMarkdown} from './markdown.js';
import {createDictation} from './dictation.js';
import {createTelemetry} from './telemetry.js';
import {fastCommand} from '../src/commands.js';
import {userErrorMessage} from './errors.js';

const $ = id => document.getElementById(id);
const rawRequest = window.companion.request;
let state = {}, frame = null, sentFrame = null, showSent = false, dirty = false, privacyDirty = false;
let defaultPrompt = '', modelKey = '', lastScreenTitle = '', lastStateError = '', localPending = false, lastAttempt = null;
let retryNotice = null, noticeSource = '', following = true, scrollFrame = 0, streamGeneration = -1, initialized = false, scrollIntentUntil = 0;
let screenCollapsed = false, stopPending = false, noticeRevision = 0, latestStopId = null;
try { screenCollapsed = localStorage.getItem('hephaestus.screenPanel') === 'hidden'; } catch { /* The panel still works if local storage is unavailable. */ }
const messages = new Map();
const time = value => value == null || !Number.isFinite(new Date(value).getTime()) ? 'Earlier' : new Date(value).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

function announce(text) { $('conversation-announcer').textContent = text; }
function notice(error, {retry = null, title = 'Something needs attention', source = 'local'} = {}) {
  noticeRevision++;
  $('notice-title').textContent = title;
  $('notice-message').textContent = userErrorMessage(error);
  $('notice').hidden = false;
  retryNotice = retry; noticeSource = source;
  $('notice-retry').hidden = !retry;
  if(source!=='state')$('notice').scrollIntoView({block:'nearest'});
}
function hideNotice() { noticeRevision++; $('notice').hidden = true; retryNotice = null; noticeSource = ''; }
async function perform(command, params, {retry = true} = {}) {
  try { const result = await request(command, params); if (noticeSource === 'action:' + command) hideNotice(); return result; }
  catch (error) { notice(error, {retry:retry ? () => perform(command, params) : null,source:'action:' + command}); renderControls(); return null; }
}
function reviewMessage(text) {
  navigate('companion');
  const input = $('dashboard-input');
  if (input.value.trim() && input.value.trim() !== text.trim()) {
    notice(new Error('Your current draft is still in the composer. Send it or clear it before reviewing the earlier message.'), {title:'Your draft is safe'});
    input.focus(); return;
  }
  input.value = text; updateComposer(); input.focus(); hideNotice();
}
async function request(command, params) {
  if (command !== 'send') return rawRequest(command, params);
  if (localPending || state.sendPending === true) return {accepted:false};
  if (state.connection !== 'connected' && !fastCommand(params.text)) throw new Error('The connection is recovering. Your message is saved here; try again when connected.');
  lastAttempt = params.text; localPending = true; following = true; updateComposer();
  try {
    const result = await rawRequest(command, params);
    if (result?.accepted) { hideNotice(); followConversation(true); }
    return result;
  } finally { localPending = false; requestAnimationFrame(updateComposer); }
}
const dictation = createDictation($('dashboard-input'), request, {manual:true, onError:error => notice(error, {title:'Your message was not sent', retry:lastAttempt ? () => reviewMessage(lastAttempt) : null})});
const telemetry = createTelemetry(request, error => notice(error));
const runtimeUI = createWorkspace(request, navigate, error => notice(error));

function navigate(page) {
  if (!document.querySelector(`[data-view="${page}"]`)) page = 'companion';
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== page;
  for (const el of document.querySelectorAll('[data-page]')) {
    const selected = el.dataset.page === page; el.classList.toggle('selected', selected);
    if (selected) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  }
  $('page-label').textContent = {companion:'Companion',screen:'What I see',voice:'Voice & listening',instructions:'Instructions',activity:'Activity',usage:'Usage',workspace:'Workspace'}[page];
  runtimeUI.navigate(page);
  document.querySelector('.content').scrollTop = 0;
  if (page === 'usage') telemetry.usage.refresh();
  if (page === 'companion') followConversation();
}
function activity(text, at = Date.now()) {
  $('activity-empty').hidden = true;
  const row = document.createElement('div'); row.className = 'activity-item';
  const stamp = document.createElement('time'); stamp.textContent = time(at); stamp.dateTime = new Date(at).toISOString();
  const content = document.createElement('span'); content.textContent = text;
  row.append(stamp, content); $('activity-list').prepend(row);
  while ($('activity-list').childElementCount > 100) $('activity-list').lastElementChild.remove();
}
function updateComposer() {
  const pending = localPending || state.sendPending === true;
  const localCommand = !!fastCommand($('dashboard-input').value);
  $('send').disabled = pending || state.instructionsSaving === true || (state.connection !== 'connected' && !localCommand) || !$('dashboard-input').value.trim();
  $('send').textContent = pending ? '…' : '↑';
  $('send').setAttribute('aria-label',pending ? 'Sending message' : 'Send message');
  $('message-form').setAttribute('aria-busy',String(pending));
  $('compose-hint').textContent = state.instructionsSaving ? 'Saving instructions · your draft stays here' : pending ? 'Sending your message…' : state.connection !== 'connected' ? localCommand ? 'Local command · Enter to send' : 'Reconnecting · your draft stays here' : 'Enter to send · Shift + Enter for a new line';
  updateStopControls(pending);
}
function updateStopControls(pending = localPending || state.sendPending === true) {
  const stop = $('stop'), retry = state.stopRetryAvailable === true;
  const waiting = stopPending || state.stopRequestPending === true;
  const active = state.busy === true || state.speaking === true || pending;
  stop.disabled = waiting || (state.stopping === true && !retry) || !(retry || active);
  stop.textContent = waiting ? 'Stopping…' : retry && state.stopping ? 'Retry Stop' : state.stopping ? 'Stopping…' : active ? '■ Stop reply' : retry ? 'Save Stop recovery' : '■ Stop reply';
  let status = $('stop-persistence-status');
  if (!status) { status = document.createElement('span'); status.id = 'stop-persistence-status'; status.setAttribute('role','status'); stop.before(status); }
  status.hidden = !state.stopPersistenceError;
  status.textContent = state.stopPersistenceError ? 'Stop recovery not saved' : '';
  status.title = state.stopPersistenceError ?? '';
  status.setAttribute('aria-label',state.stopPersistenceError ?? '');
  stop.title = state.stopPersistenceError ?? (retry ? 'Retry cancellation until T3 confirms the request has stopped.' : '');
  if (state.stopPersistenceError) stop.setAttribute('aria-describedby',status.id); else stop.removeAttribute('aria-describedby');
}
function currentStopRetry() { return state.stopping && state.stopRetryId ? {kind:'cancel',stopId:state.stopRetryId} : {kind:'recovery'}; }
function stopNoticeRetry(action, owner = latestStopId, kind = 'persistence') {
  const retry = () => requestStop(action); retry.keepNotice = true; retry.stopOwnerId = owner; retry.stopAction = action; retry.stopNoticeKind = kind; return retry;
}
function refreshStopNotice() {
  const previous = retryNotice;
  if (noticeSource !== 'action:interrupt' || !previous?.stopOwnerId || previous.stopOwnerId !== latestStopId) return;
  if (!state.stopPersistenceError) { if (!state.stopping && !state.stopRequestPending) hideNotice(); return; }
  if (previous.stopNoticeKind !== 'persistence' && state.stopping) return;
  const action = currentStopRetry();
  if ($('notice-message').textContent !== state.stopPersistenceError || previous.stopAction.kind !== action.kind || previous.stopAction.stopId !== action.stopId) {
    notice(new Error(state.stopPersistenceError), {title:'Stop recovery was not saved',retry:stopNoticeRetry(action,previous.stopOwnerId),source:'action:interrupt'});
  }
}
async function requestStop(retryAction = null) {
  if (stopPending) return;
  const originalNotice = noticeRevision;
  stopPending = true; updateComposer();
  try {
    const result = await request(retryAction ? 'retry-stop' : 'interrupt',retryAction ?? undefined);
    if (result?.stale || retryAction && noticeRevision !== originalNotice) return result;
    const retry = currentStopRetry();
    if (state.stopPersistenceError) notice(new Error(state.stopPersistenceError), {title:'Stop recovery was not saved',retry:stopNoticeRetry(retry),source:'action:interrupt'});
    else if (noticeSource === 'action:interrupt') hideNotice();
    return result;
  } catch (error) { if (retryAction && noticeRevision !== originalNotice) return; const retry = currentStopRetry(); notice(error, {title:'Stop needs attention',retry:stopNoticeRetry(retry,latestStopId,'cancellation'),source:'action:interrupt'}); }
  finally { stopPending = false; updateComposer(); }
}
function renderControls() {
  $('proactive-shortcut').checked = state.proactive === true;
  for (const key of ['watching','backgroundVision','proactive','control','spokenReplies','autoSend']) $(key).checked = state[key] === true;
  for (const el of document.querySelectorAll('[data-mode]')) {
    const selected = el.dataset.mode === state.inputMode; el.classList.toggle('selected',selected); el.setAttribute('aria-pressed',String(selected));
  }
  for (const [id,value] of Object.entries({captureMode:state.captureMode ?? 'window',monitor:state.monitor ?? -1,backgroundInterval:state.backgroundInterval ?? 20000,voice:state.voice ?? '',inputDevice:state.inputDevice ?? 'default'})) $(id).value = value;
  $('opacity').value = Math.round((state.opacity ?? 1) * 100); $('opacity-value').textContent = $('opacity').value + '%';
  updateComposer();
}
function render(next) {
  if (next.stopRetryId) latestStopId = next.stopRetryId;
  state = next; telemetry.updateState(next); runtimeUI.updateState(next); dictation.event('state',next); renderControls();
  $('plan').textContent = next.plan ? `ChatGPT ${next.plan.toUpperCase()}` : next.connection === 'connected' ? 'Codex connected' : 'Connecting';
  const used = next.usage?.primary?.usedPercent;
  $('quota-label').textContent = used !== undefined ? `${used}% allowance used` : 'Using your Codex subscription';
  $('quota-bar').style.width = `${Math.max(0,Math.min(100,used ?? 0))}%`;
  const meter = document.querySelector('.quota-track');
  if (used !== undefined) meter.setAttribute('aria-valuenow',String(used)); else meter.removeAttribute('aria-valuenow');
  $('connection').textContent = next.connection === 'connected' ? `Connected · ${next.model ?? 'Codex'}` : next.connection === 'reconnecting' ? 'Reconnecting to Codex' : 'Connecting to Codex';
  $('connection-dot').style.background = next.connection === 'connected' ? 'var(--green)' : '#c4a27e';
  document.querySelector('.subscription .connected-dot').style.background = next.connection === 'connected' ? 'var(--green)' : '#c4a27e';
  $('pause').textContent = next.running === true ? 'Pause companion' : 'Resume companion';
  $('pause').setAttribute('aria-pressed',String(next.running !== true));
  const foreground = next.busy === true && next.background !== true;
  const replyState = next.stopping ? next.activity === 'Stop not confirmed' ? 'Stop not confirmed' : 'Stopping…' : next.sendPending ? 'Sending…' : foreground ? next.activity === 'Waiting for your answer' ? 'Needs your answer' : 'Thinking…' : next.speaking ? 'Speaking' : next.connection === 'connected' ? 'Ready' : 'Connecting';
  $('reply-state').textContent = replyState; $('reply-state').dataset.active = String(foreground || next.sendPending === true);
  const always = next.inputMode === 'always';
  $('listening-label').textContent = next.running !== true ? 'Companion paused' : next.dictating ? 'Listening to your Wispr dictation' : always ? next.listening ? 'Listening when you need me' : next.speech === 'loading' ? 'Preparing local speech' : 'Microphone needs attention' : 'Wispr Flow is ready';
  $('listening-detail').textContent = next.running !== true ? 'Resume when you are ready. You can still type a message.' : always ? next.listening ? 'Echo cancellation is on · your desktop sound stays on.' : next.voiceError ?? 'Opening the microphone with playback cancellation.' : 'Use your usual shortcut to talk to Hephaestus.';
  $('voice-status').textContent = next.listening ? 'Microphone is open' : next.inputMode === 'wispr' ? 'Wispr dictation mode' : next.speech === 'loading' ? 'Loading local recognition' : 'Microphone is paused';
  $('echo-status').textContent = next.echoCancellation === 'all' ? 'System-wide echo cancellation is active.' : next.voiceError ?? 'Desktop playback stays on.';
  for (const id of ['voice-orb','settings-meter']) $(id).classList.toggle('live',next.listening === true);
  if (!dirty && document.activeElement !== $('prompt')) $('prompt').value = next.prompt ?? '';
  $('prompt-count').textContent = `${$('prompt').value.length.toLocaleString()} / 32,000`;
  const key = JSON.stringify(next.models);
  if (key !== modelKey && next.models) { modelKey = key; $('model').replaceChildren(...next.models.map(model => new Option(model.name,model.id))); }
  $('model').value = next.model;
  $('wispr-shortcut').textContent = next.wispr?.labels?.map(binding => `${binding.label}${binding.mode === 'toggle' ? ' · hands-free' : ''}`).join(' / ') || 'Open Wispr Flow to use its shortcut';
  $('last-vision').textContent = next.lastVisionAt ? `Last shared at ${time(next.lastVisionAt)}` : 'Screen context accompanies your requests.';
  $('latency').textContent = [next.lastRecognitionMs ? `Transcribed in ${(next.lastRecognitionMs / 1000).toFixed(1)}s` : '',next.lastReplyMs ? `First reply ${(next.lastReplyMs / 1000).toFixed(1)}s` : ''].filter(Boolean).join(' · ');
  if (!privacyDirty && document.activeElement !== $('excluded-apps')) $('excluded-apps').value = (next.excludedApps ?? []).join('\n');
  const quietUntil = Number(next.noticeSnoozeUntil) || 0;
  $('snooze-status').textContent = quietUntil > Date.now() ? `Quiet until ${time(quietUntil)}. Direct replies still arrive.` : 'Choose when Hephaestus may interrupt.';
  const snooze = $('notice-snooze');
  snooze.querySelector('option[value="active"]')?.remove();
  if (quietUntil > Date.now()) { snooze.add(new Option(`Quiet until ${time(quietUntil)}`,'active')); snooze.value = 'active'; } else snooze.value = '0';
  if (!canShowScreen()) { frame = null; sentFrame = null; }
  renderScreen();
  if (next.error && next.error !== lastStateError) { lastStateError = next.error; notice(new Error(next.error), {source:'state'}); }
  if (!next.error) { lastStateError = ''; if (noticeSource === 'state') hideNotice(); }
  refreshStopNotice();
  if (!$('reply-draft').hidden && (next.stopping || !next.busy && !next.sendPending)) {
    $('reply-draft').querySelector('.streaming-label').textContent = next.stopping
      ? next.activity === 'Stop not confirmed' ? '· stop not confirmed' : '· stopping'
      : '· interrupted';
  }
}
function canShowScreen() { return state.running === true && state.watching === true && state.screenPrivacyBlocked !== true; }
function renderScreen() {
  const allowed = canShowScreen(), visible = allowed && frame && !state.screenError;
  $('screen-preview').hidden = !visible; $('screen-empty').hidden = !!visible; $('live-tag').hidden = !visible;
  $('screen-dot').style.background = visible ? 'var(--green)' : '#8c8e94';
  $('refresh-screen').disabled = $('share-now').disabled = !allowed;
  $('last-vision').textContent = state.screenPrivacyBlocked ? 'Private app. Screenshots are not displayed or shared.' : !allowed ? 'Text-only conversation. Screen sharing is paused.' : state.lastVisionAt ? `Last shared at ${time(state.lastVisionAt)}` : 'Screen context accompanies your requests.';
  if (visible) {
    const source = 'data:image/jpeg;base64,' + frame.image;
    if ($('screen-preview').src !== source) $('screen-preview').src = source;
    $('screen-preview').alt = 'Live preview of ' + (frame.window?.title || 'your selected screen');
    $('screen-title').textContent = frame.window?.title || 'Selected screen';
    $('screen-title').title = $('screen-title').textContent;
    $('screen-resolution').textContent = `${frame.width} × ${frame.height}`;
  } else {
    $('screen-preview').removeAttribute('src'); $('screen-title').textContent = 'Screen is not being shared'; $('screen-resolution').textContent = '';
    const privacy = state.screenPrivacyBlocked === true;
    $('screen-empty').querySelector('b').textContent = privacy ? 'This app is private' : !allowed ? 'Screen sharing is paused' : state.screenError ? 'Screen preview unavailable' : 'Waiting for your screen';
    $('screen-empty').querySelector('p').textContent = privacy ? state.screenPrivacyReason || 'This application is excluded in your privacy settings.' : !allowed ? 'You can keep the conversation going without a screen.' : state.screenError || 'Your selected application will appear here.';
  }
  const selected = allowed ? showSent ? sentFrame : state.screenError ? null : frame : null;
  document.querySelector('.full-screen-stage').dataset.empty = String(!selected);
  $('large-preview').hidden = !selected; $('large-empty').hidden = !!selected;
  if (selected) { $('large-preview').src = 'data:image/jpeg;base64,' + selected.image; $('large-caption').textContent = `${selected.window?.title || 'Selected screen'} · ${selected.width} × ${selected.height} · ${time(selected.capturedAt)}`; }
  else { $('large-preview').removeAttribute('src'); $('large-caption').textContent = ''; $('large-empty').textContent = !allowed ? $('screen-empty').querySelector('b').textContent + '. ' + $('screen-empty').querySelector('p').textContent : showSent ? 'No image has been shared in this session yet.' : state.screenError || 'Waiting for a screen image.'; }
}
function setFrame(value, sent = false) {
  if (!value) { if (sent) sentFrame = null; else frame = null; renderScreen(); return; }
  if (!canShowScreen()) return;
  if (sent) sentFrame = value; else {
    frame = value;
    if (value.window?.title && value.window.title !== lastScreenTitle) { lastScreenTitle = value.window.title; activity(`Viewing ${value.window.title}`); }
  }
  renderScreen();
}
function followConversation(force = false) {
  if (force) following = true;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; if (following) $('answers').scrollTop = $('answers').scrollHeight; $('jump-latest').hidden = following; });
}
for (const type of ['wheel','touchstart','touchmove','pointerdown']) $('answers').addEventListener(type,() => { scrollIntentUntil = Date.now() + 1200; },{passive:true});
document.addEventListener('keydown',event => { if (['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key) && $('answers').contains(document.activeElement)) scrollIntentUntil = Date.now() + 1200; });
$('answers').addEventListener('scroll',() => {
  if (Date.now() < scrollIntentUntil) { following = $('answers').scrollHeight - $('answers').clientHeight - $('answers').scrollTop < 65; scrollIntentUntil = Date.now() + 400; }
  else if (following) followConversation();
  $('jump-latest').hidden = following;
});
new ResizeObserver(() => { if (following) followConversation(); }).observe($('answers'));
$('jump-latest').onclick = () => followConversation(true);
function message(value, {restored = false} = {}) {
  if (!value?.id) return;
  const existing = messages.get(value.id), old = existing?.message;
  let row = existing?.row;
  if (!row) {
    row = document.createElement('div'); row.dataset.messageId = value.id;
  }
  if (!old || old.at !== value.at) {
    const next = [...$('answers').querySelectorAll('[data-message-id]')].find(candidate => candidate !== row && (messages.get(candidate.dataset.messageId)?.message.at ?? 0) > (value.at ?? 0));
    $('answers').insertBefore(row,next ?? $('reply-draft'));
  }
  row.className = 'answer ' + (value.role === 'user' ? 'user' : value.role === 'system' ? 'system' : 'assistant');
  if (value.delivery === 'failed') row.classList.add('delivery-failed');
  if (value.noticeFeedback === 'dismiss') row.classList.add('dismissed');
  row.replaceChildren();
  const label = document.createElement('small');
  label.textContent = (value.role === 'user' ? `YOU${value.source === 'wispr' ? ' · WISPR' : ''}` : value.role === 'system' ? 'SYSTEM' : value.source === 'noticed' ? 'HEPHAESTUS NOTICED' : 'HEPHAESTUS') + ' · ' + time(value.at);
  if (value.role === 'user' && ['failed','pending'].includes(value.delivery)) { const delivery = document.createElement('span'); delivery.className = 'delivery-state'; delivery.textContent = value.delivery === 'failed' ? 'Not sent' : 'Sending…'; label.append(delivery); }
  const body = document.createElement('div'); renderMarkdown(body,(value.toolWarning ? 'Action failed: ' + value.toolWarning + '\n\n' : '') + value.text); row.append(label,body);
  if (value.delivery === 'failed') { const actions = document.createElement('div'); actions.className = 'message-actions'; const retry = document.createElement('button'); retry.textContent = 'Review & retry'; retry.onclick = () => reviewMessage(value.text); actions.append(retry); row.append(actions); }
  if (value.source === 'noticed') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    for (const [feedback,text] of [['useful','Helpful'],['dismiss','Dismiss']]) { const button = document.createElement('button'); button.textContent = text; button.setAttribute('aria-pressed',String(value.noticeFeedback === feedback)); button.onclick = () => perform('notice-feedback',{id:value.id,value:feedback}); actions.append(button); }
    row.append(actions);
  }
  messages.set(value.id,{row,message:value}); $('conversation-empty').hidden = true;
  if (value.role === 'assistant') $('reply-draft').hidden = true;
  if (!old && !restored) {
    if (value.role === 'assistant') { activity(value.source === 'noticed' ? `Noticed: ${value.text}` : `Replied: ${value.text.slice(0,180)}`,value.at); announce(`Hephaestus: ${value.text}`); }
    if (value.role === 'user') following = true;
  }
  followConversation();
}
window.companion.onEvent((event,data) => {
  dictation.event(event,data);
  if (event === 'state') render(data);
  if (event === 'frame') setFrame(data);
  if (event === 'visionFrame') setFrame(data,true);
  if (event === 'message' || event === 'messageUpdated') message(data);
  if (event === 'messagesRestored') { for (const item of data ?? []) message(item,{restored:true}); followConversation(); }
  if (event === 'delta') {
    if ((data.generation ?? 0) < streamGeneration) return;
    streamGeneration = data.generation ?? streamGeneration; $('conversation-empty').hidden = true; $('reply-draft').hidden = false;
    renderMarkdown($('reply-draft').querySelector('div'),data.full); followConversation();
  }
  if (event === 'responseStart') { streamGeneration = data.generation ?? streamGeneration; $('reply-draft').querySelector('div').replaceChildren(); $('reply-draft').hidden = true; $('reply-draft').querySelector('.streaming-label').textContent = '· replying'; announce('Hephaestus is thinking.'); }
  if (event === 'activity') telemetry.activity(data);
  if (event === 'navigate') { navigate(data.page); if (data.focusInput) $('dashboard-input').focus(); }
  if (event === 'confirmation') { $('confirmation').hidden = !data; if (data) { $('confirm-reason').textContent = data.reason; announce('Hephaestus needs your approval. ' + data.reason); } }
  if (event === 'action') activity(`${data.kind}: ${data.reason ?? 'Requested control'}`);
  if (event === 'voiceLevel') for (const meter of [$('voice-orb'),$('settings-meter')]) for (const [i,bar] of [...meter.children].entries()) bar.style.height = `${Math.max(4,Math.min(29,(data.rms ?? 0) * 1200 * (i === 2 ? 1 : .5 + (i % 2) * .25)))}px`;
});
for (const el of document.querySelectorAll('[data-page]')) el.onclick = () => navigate(el.dataset.page);
for (const el of document.querySelectorAll('[data-mode]')) el.onclick = () => perform('configure',{inputMode:el.dataset.mode,running:true});
for (const key of ['watching','backgroundVision','proactive','control','spokenReplies','autoSend']) $(key).onchange = () => perform('configure',{[key]:$(key).checked});
for (const key of ['captureMode','monitor','backgroundInterval','inputDevice','voice','model']) $(key).onchange = () => perform('configure',{[key]:['monitor','backgroundInterval'].includes(key) ? Number($(key).value) : $(key).value});
$('proactive-shortcut').onchange = () => perform('configure',{proactive:$('proactive-shortcut').checked,...($('proactive-shortcut').checked ? {backgroundVision:true} : {})});
let opacityTimer;
$('opacity').oninput = () => { $('opacity-value').textContent = $('opacity').value + '%'; clearTimeout(opacityTimer); opacityTimer = setTimeout(() => perform('configure',{opacity:Number($('opacity').value) / 100}),100); };
$('startup').onchange = () => perform('login-startup',{enabled:$('startup').checked});
$('message-form').onsubmit = event => { event.preventDefault(); dictation.submit(); };
$('dashboard-input').addEventListener('input',updateComposer);
$('pause').onclick = () => perform('configure',{running:state.running !== true});
$('stop').onclick = () => requestStop(state.stopping || state.stopRetryAvailable && !(state.busy || state.speaking || state.sendPending || localPending) ? currentStopRetry() : null);
for (const [id,command] of Object.entries({'open-popup':'toggle-bubble',quit:'quit',close:'hide',minimize:'window-minimize',maximize:'window-maximize'})) $(id).onclick = () => perform(command,undefined,{retry:false});
$('open-voice').onclick = () => navigate('voice'); $('expand-screen').onclick = () => navigate('screen');
function toggleScreenPanel() {
  $('screen-context').hidden = screenCollapsed;
  document.querySelector('.workspace').classList.toggle('screen-hidden',screenCollapsed);
  $('toggle-screen').textContent = screenCollapsed ? 'Show screen' : 'Hide screen';
  $('toggle-screen').setAttribute('aria-expanded',String(!screenCollapsed));
  followConversation();
}
$('toggle-screen').onclick = () => { screenCollapsed = !screenCollapsed; try { localStorage.setItem('hephaestus.screenPanel',screenCollapsed ? 'hidden' : 'visible'); } catch { /* Remember for this session when storage is unavailable. */ } toggleScreenPanel(); };
toggleScreenPanel();
for (const id of ['refresh-screen','share-now']) $(id).onclick = async () => { $(id).disabled = true; try { await perform('refresh-screen'); } finally { renderScreen(); } };
for (const [id,sent] of [['view-live',false],['view-sent',true]]) $(id).onclick = () => { showSent = sent; for (const [key,selected] of [['view-live',!sent],['view-sent',sent]]) { $(key).classList.toggle('selected',selected); $(key).setAttribute('aria-pressed',String(selected)); } renderScreen(); };
$('notice-dismiss').onclick = () => { hideNotice(); rawRequest('dismiss-error').catch(() => {}); };
$('notice-retry').onclick = async () => { const retry = retryNotice; if (!retry) return; if (!retry.keepNotice) hideNotice(); await retry(); };
$('prompt').oninput = () => { dirty = true; $('prompt-status').textContent = 'Unsaved changes'; $('prompt-count').textContent = `${$('prompt').value.length.toLocaleString()} / 32,000`; };
$('save-prompt').onclick = async () => {
  const submitted=$('prompt').value;$('save-prompt').disabled=true;$('save-prompt').textContent='Saving…';
  try{await request('configure',{prompt:submitted});dirty=$('prompt').value!==submitted;$('prompt-status').textContent=dirty?'Earlier version saved · new changes are unsaved':'Instructions saved';hideNotice();}
  catch(error){notice(error,{retry:()=>$('save-prompt').click()});}
  finally{$('save-prompt').disabled=false;$('save-prompt').textContent='Save instructions';}
};
$('restore-prompt').onclick = () => { $('prompt').value = defaultPrompt; dirty = true; $('prompt').oninput(); $('prompt-status').textContent = 'Default restored · save to apply'; };
$('approve').onclick = () => perform('confirm',{approved:true},{retry:false}); $('decline').onclick = () => perform('confirm',{approved:false},{retry:false});
$('excluded-apps').setAttribute('aria-describedby','privacy-help privacy-status');
$('excluded-apps').oninput = () => { privacyDirty = true; $('excluded-apps').removeAttribute('aria-invalid');$('privacy-status').classList.remove('field-error');$('privacy-status').setAttribute('role','status');$('privacy-status').textContent = 'Unsaved changes'; };
$('save-privacy').onclick = async () => {
  const submitted=$('excluded-apps').value,excludedApps=[...new Set(submitted.split(/[\n,;]+/).map(value=>value.trim()).filter(Boolean))];
  $('save-privacy').disabled=true;
  try{await request('configure',{excludedApps});privacyDirty=$('excluded-apps').value!==submitted;$('excluded-apps').removeAttribute('aria-invalid');$('privacy-status').classList.remove('field-error');$('privacy-status').setAttribute('role','status');$('privacy-status').textContent=privacyDirty?'Earlier list saved · new changes are unsaved':'Private apps saved.';hideNotice();}
  catch(error){$('excluded-apps').setAttribute('aria-invalid','true');$('privacy-status').classList.add('field-error');$('privacy-status').setAttribute('role','alert');$('privacy-status').textContent=userErrorMessage(error);$('excluded-apps').focus({preventScroll:true});$('excluded-apps').scrollIntoView({block:'center'});$('privacy-status').scrollIntoView({block:'nearest'});}
  finally{$('save-privacy').disabled=false;}
};
$('notice-snooze').onchange = () => { if ($('notice-snooze').value === 'active') return; const minutes = Number($('notice-snooze').value); perform('configure',{noticeSnoozeUntil:minutes ? Date.now() + minutes * 60000 : 0}); };
function voices() { $('voice').replaceChildren(new Option('Windows default',''),...speechSynthesis.getVoices().filter(voice => voice.localService).map(voice => new Option(`${voice.name} · ${voice.lang}`,voice.name))); $('voice').value = state.voice ?? ''; }
speechSynthesis.onvoiceschanged = voices; voices();
async function devices() { try { const list = await navigator.mediaDevices.enumerateDevices(); $('inputDevice').replaceChildren(new Option('Windows default','default'),...list.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications').map((device,index) => new Option(device.label || `Microphone ${index + 1}`,device.deviceId))); $('inputDevice').value = state.inputDevice ?? 'default'; } catch { /* A device permission error is explained by the voice status. */ } }
navigator.mediaDevices?.addEventListener('devicechange',devices);
async function initialize() {
  try {
    const initial = await request('init'); defaultPrompt = initial.defaultPrompt ?? ''; render(initial.state);
    for (const item of initial.messages ?? []) message(item,{restored:true});
    for (const item of initial.activities ?? []) telemetry.activity(item);
    telemetry.capabilities(initial.tools); $('startup').checked = initial.startAtLogin === true;
    for (const monitor of initial.monitors ?? []) $('monitor').add(new Option(`Monitor ${monitor.index + 1}${monitor.primary ? ' · primary' : ''}`,monitor.index));
    $('monitor').value = state.monitor ?? -1; if (initial.frame) setFrame(initial.frame);
    initialized = true; followConversation(true); devices();
  } catch (error) { notice(error,{title:'Could not load Hephaestus',retry:initialize}); }
}
await initialize();
window.hephaestusDashboardInspect = () => ({page:document.querySelector('[data-view]:not([hidden])')?.dataset.view,screenVisible:!$('screen-preview').hidden && !$('screen-context').hidden,screenCollapsed,frameAt:frame?.capturedAt,source:frame?.captureSource,imageWidth:frame?.width,prompt:$('prompt').value,input:dictation.inspect(),answers:messages.size,initialized,sendPending:localPending || state.sendPending === true,following,noticeVisible:!$('notice').hidden});
window.hephaestusDashboardLayout = () => {
  const content=document.querySelector('.content'),clip=content.getBoundingClientRect();
  const bounds=(element,inContent=true)=>{
    const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
      visible:r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=(inContent?clip.top:0)-1&&r.bottom<=(inContent?clip.bottom:innerHeight)+1};
  };
  const warning=$('notice'),text=$('notice-message'),retry=$('notice-retry'),stop=$('stop');
  return {viewport:{width:innerWidth,height:innerHeight,scale:devicePixelRatio},expanded:$('toggle-screen').getAttribute('aria-expanded')==='false',
    content:{height:content.clientHeight,scrollHeight:content.scrollHeight,scrollTop:content.scrollTop,noOverflow:content.scrollHeight<=content.clientHeight+1&&content.scrollTop<=1},
    warning:{...bounds(warning),lines:Math.round(text.clientHeight/parseFloat(getComputedStyle(text).lineHeight)),fullText:text.scrollHeight<=text.clientHeight+1&&text.scrollWidth<=text.clientWidth+1&&bounds(text).visible},
    warningActions:bounds(warning.querySelector('.notice-actions')),warningRetry:{hidden:retry.hidden,...bounds(retry)},warningDismiss:bounds($('notice-dismiss')),
    composer:bounds($('message-form')),input:bounds($('dashboard-input')),send:{...bounds($('send')),disabled:$('send').disabled},
    recovery:{...bounds(stop,false),disabled:stop.disabled,text:stop.textContent},
    screenControlsVisible:$('screen-context').hidden||['captureMode','monitor','refresh-screen','last-vision'].every(id=>bounds($(id)).visible)};
};
