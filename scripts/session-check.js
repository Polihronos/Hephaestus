import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const cancelled = new Set(['cancelled', 'interrupted', 'rolled_back']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => String(error?.message ?? error)
  .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
  .replace(/((?:access_?token|bearer_?token|authorization|session_?token)["'\s:=]+)[^\s,"'}]+/gi, '$1[redacted]')
  .slice(0, 1200);

// Uses the production windows and a real T3 session. The only injected faults are
// a missing local transcript entry and a clearly labelled, action-free approval.
// No microphone, desktop capture, fabricated reply, or daemon restart is involved.
export async function sessionCheck({ dashboard, mascot, bubble, companion: c, root, showDashboard, app }) {
  const out = join(root, 'artifacts', 'session-check');
  await mkdir(out, { recursive: true });
  const startedAt = Date.now(), deadline = startedAt + 300000;
  const marker = 'SESSION-' + randomUUID().slice(0, 8).toUpperCase();
  const report = {
    at: new Date(startedAt).toISOString(), marker, success: false,
    checks: [], requests: [], screenshots: [], transport: [], stateTransitions: [],
    limitations: ['This verifies a short isolated desktop session, not human speech or all-day proactive behaviour.'],
    faultInjections: [],
  };
  let phase = 'setup', previousStateKey = '', confirmationResult = null, injectedConfirmation = null;
  let observedClient = c.t3, transportEpoch = 0;
  const deltas = [], privacyViolations = [], toolEvents = [];
  let speechEvents = 0, flushEvents = 0, allowCleanup = false;

  function check(id, name, passed, kind, evidence = {}) {
    report.checks.push({ id, name, status: passed ? 'passed' : 'failed', kind, evidence });
    assert.ok(passed, name);
    console.log('SESSION_CHECK ' + id + ' passed');
  }
  function remaining(timeout) {
    const value = Math.min(timeout, deadline - Date.now());
    if (value <= 0) throw new Error('Session verification exceeded its five-minute deadline');
    return value;
  }
  async function bounded(promise, timeout, label) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), remaining(timeout));
      })]);
    } finally { clearTimeout(timer); }
  }
  async function until(condition, timeout, label) {
    const end = Date.now() + remaining(timeout);
    while (Date.now() < end) {
      const result = await condition();
      if (result) return result;
      await sleep(Math.min(100, Math.max(1, end - Date.now())));
    }
    throw new Error(label);
  }
  const ui = source => bounded(dashboard.webContents.executeJavaScript(source), 5000, 'The dashboard did not answer during ' + phase);
  const frames = () => ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const uiRequest = (command, params = {}) => ui(`window.companion.request(${JSON.stringify(command)},${JSON.stringify(params)})`);
  const projection = () => bounded(c.t3.call('orchestration.getThreadProjection', { threadId: c.t3ThreadId }, 10000), 12000, 'T3 did not return its real thread projection');
  const stateListener = state => {
    if (c.t3 !== observedClient) { observedClient = c.t3; transportEpoch++; }
    const item = { elapsedMs: Date.now() - startedAt, connection: state.connection, busy: state.busy === true,
      stopping: state.stopping === true, pending: state.sendPending === true, activity: state.activity,
      watching: state.watching === true, proactive: state.proactive === true, backgroundVision: state.backgroundVision === true, transportEpoch };
    const key = JSON.stringify({ ...item, elapsedMs: 0 });
    if (key !== previousStateKey) { previousStateKey = key; report.stateTransitions.push(item); }
    if (item.watching || item.proactive || item.backgroundVision) privacyViolations.push(item.elapsedMs);
  };
  const deltaListener = data => deltas.push({ at: Date.now(), runId: data.turnId, generation: data.generation, length: data.full?.length ?? 0 });
  const speechListener = () => { speechEvents++; };
  const flushListener = () => { flushEvents++; };
  const toolListener = event => { if (event.kind === 'tool' && event.status === 'running') toolEvents.push({ id: event.id, title: event.title, elapsedMs: Date.now() - startedAt }); };
  function assertPrivate() {
    assert.equal(c.state.watching, false, 'Screen sharing must stay disabled');
    assert.equal(c.state.backgroundVision, false, 'Background vision must stay disabled');
    assert.equal(c.state.proactive, false, 'Proactive observations must stay disabled');
    assert.equal(c.state.spokenReplies, false, 'Spoken replies must stay disabled');
    assert.equal(c.state.inputMode, 'wispr', 'Raw microphone listening must stay disabled');
    assert.equal(privacyViolations.length, 0, 'Sharing or proactivity was enabled during verification');
  }
  async function snapshot(name, target = dashboard) {
    assertPrivate();
    await frames();
    await bounded(writeFile(join(out, name), (await target.webContents.capturePage()).toPNG()), 5000, 'Could not save the session screenshot');
    report.screenshots.push(name);
  }
  function runFor(message) {
    return [...c.t3Runs.values()].find(run => run.userMessageId === message.t3MessageId);
  }
  function finalFor(runId) {
    return c.messages.filter(message => message.role === 'assistant' && message.turnId === runId && message.providerItemId).at(-1);
  }
  async function sendFromUI(text, id) {
    assertPrivate();
    await until(() => c.state.connection === 'connected' && !c.state.busy && !c.t3InFlight && !c.state.sendPending,
      45000, 'The session was not idle before ' + id);
    await showDashboard('companion', true);
    const before = new Set(c.messages.map(message => message.id)), at = Date.now();
    const pending = await ui(`(() => {
      const input = document.querySelector('#dashboard-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', {bubbles:true}));
      const send = document.querySelector('#send');
      if (send.disabled) throw new Error('The production Send button is disabled');
      send.click();
      return {draft:input.value, disabled:send.disabled, busy:document.querySelector('#message-form').getAttribute('aria-busy'), inspect:window.hephaestusDashboardInspect()};
    })()`);
    check(id + '-pending', 'The production composer keeps its text and blocks duplicates while sending',
      pending.draft === text && pending.disabled && pending.busy === 'true' && pending.inspect.sendPending,
      'real-ui-model', { draftPreserved: pending.draft === text, disabled: pending.disabled, ariaBusy: pending.busy });
    const message = await until(() => c.messages.find(message => !before.has(message.id) && message.role === 'user' && message.text === text && message.delivery === 'sent' && message.t3MessageId),
      45000, 'The production send was not accepted by T3');
    const run = await until(() => runFor(message), 15000, 'The accepted message did not acquire a real T3 run');
    await until(() => ui('!document.querySelector("#dashboard-input").value && !window.hephaestusDashboardInspect().sendPending'),
      5000, 'The composer did not clear after real dispatch acceptance');
    const entry = { id, userMessageId: message.id, t3MessageId: message.t3MessageId, runId: run.id, acceptedMs: Date.now() - at };
    report.requests.push(entry);
    check(id + '-accepted', 'The accepted message appears once with a real T3 identity',
      c.messages.filter(item => item.t3MessageId === message.t3MessageId).length === 1,
      'real-ui-model', { t3MessageId: message.t3MessageId, runId: run.id });
    return { message, runId: run.id, entry };
  }
  async function completed(run, expectedMarker, timeout = 90000) {
    const answer = await until(() => {
      const value = finalFor(run.runId);
      return value?.text?.includes(expectedMarker) && !c.state.busy && !c.t3InFlight ? value : false;
    }, timeout, 'A real completed reply was not restored for ' + run.entry.id);
    const canonical = await projection(), remoteRun = canonical.runs?.find(item => item.id === run.runId);
    assert.equal(toolEvents.length, 0, 'A text-only verification request unexpectedly invoked a tool');
    check(run.entry.id + '-complete', 'T3 completed the request and its actual answer is visible once',
      remoteRun?.status === 'completed' && await ui(`(() => {
        const rows = [...document.querySelectorAll('[data-message-id]')].filter(row => row.dataset.messageId === ${JSON.stringify(answer.id)});
        return rows.length === 1 && rows[0].textContent.includes(${JSON.stringify(expectedMarker)});
      })()`), 'real-transport-model', { runId: run.runId, status: remoteRun?.status, providerItemId: answer.providerItemId, answerCharacters: answer.text.length });
    Object.assign(run.entry, { providerItemId: answer.providerItemId, answerCharacters: answer.text.length, status: remoteRun?.status });
    return { answer, canonical };
  }
  async function disconnectClient(id) {
    const client = c.t3, socket = client.socket, threadId = c.t3ThreadId, at = Date.now();
    assert.equal(socket?.readyState, 1, 'Only an open app-client socket may be disconnected');
    const record = { id, atMs: at - startedAt, threadId, method: 'terminate app-owned WebSocket only', closed: false };
    report.transport.push(record);
    socket.once('close', () => { record.closed = true; });
    socket.terminate();
    await until(() => record.closed && c.state.connection !== 'connected', 10000, 'The real app socket did not disconnect');
    await snapshot(id + '-disconnected.png');
    await until(() => c.state.connection === 'connected' && c.t3 !== client && c.t3?.socket?.readyState === 1,
      60000, 'The app did not reconnect automatically to the running T3 daemon');
    Object.assign(record, { reconnectMs: Date.now() - at, sameThread: c.t3ThreadId === threadId, transportEpoch });
    check(id, 'The app reconnects automatically after its own real socket is disconnected',
      record.closed && record.sameThread, 'real-transport', { reconnectMs: record.reconnectMs, sameThread: record.sameThread });
    assertPrivate();
    return record;
  }

  try {
    const expected = resolve(root, 'runtime', 'session-verification');
    const expectedReal = await realpath(expected);
    const samePath = value => resolve(value).toLowerCase() === resolve(expectedReal).toLowerCase();
    check('isolated-profile', 'The verifier uses only its dedicated local data profile',
      samePath(await realpath(c.dataDir)) && samePath(await realpath(app.getPath('userData'))), 'environment', { directory: 'runtime/session-verification' });
    allowCleanup = true;
    await c.configure({ watching: false, backgroundVision: false, proactive: false, inputMode: 'wispr', spokenReplies: false, control: false, model: 'gpt-6-luna', effort: 'low' });
    c.on('state', stateListener); c.on('delta', deltaListener); c.on('speak', speechListener); c.on('speechFlush', flushListener); c.on('activity', toolListener); stateListener(c.state);
    assertPrivate();
    await until(() => c.state.connection === 'connected' && c.state.runtime === 't3' && !c.state.busy, 60000, 'The isolated real T3 session was not connected');
    report.runtime = { version: app.getVersion(), model: c.state.model, effort: c.state.effort, electron: process.versions.electron, platform: process.platform };
    dashboard.setSize(960, 620); await showDashboard('companion', true);
    await until(() => ui('window.hephaestusDashboardInspect?.().initialized'), 15000, 'The production dashboard did not initialize');
    await ui('(() => {const button=document.querySelector("#toggle-screen");if(button?.getAttribute("aria-expanded")==="false")button.click();})()');
    check('no-capture', 'The session has no shared screenshot or active microphone',
      await ui('!document.querySelector("#screen-preview").getAttribute("src") && !document.querySelector("#large-preview").getAttribute("src")') &&
      !(await bounded(mascot.webContents.executeJavaScript('window.hephaestusSpriteInspect().voice.microphoneActive'), 5000, 'The companion did not answer its audio inspection')),
      'real-ui', { screenSharing: false, backgroundVision: false, proactive: false, microphoneActive: false });

    phase = 'production-send';
    const firstToken = marker + '-FIRST';
    const first = await sendFromUI(`This is an isolated text-only application session verification. Please do not call tools, read files, inspect the desktop, or change any settings. Produce exactly an eight-item numbered list, with each item containing the token ${firstToken} followed by that item's number. Use one item per line, no preamble, no conclusion, and no extra explanation. The separate lines let the application verify its conversation reading position using a real response.`, 'initial-send');
    const firstResult = await completed(first, firstToken);
    await snapshot('01-real-reply.png');

    phase = 'missing-reply-restoration';
    const missing = firstResult.answer, beforeSpeech = speechEvents, beforeFlush = flushEvents, beforeDeltas = deltas.length;
    report.faultInjections.push({ kind: 'local-delivery-gap', providerItemId: missing.providerItemId, description: 'Removed one actual completed reply from local memory and reloaded the real dashboard before restoring the real T3 projection. The remote reply is unchanged.' });
    c.messages = c.messages.filter(message => message.providerItemId !== missing.providerItemId);
    let loaded, failed;
    try {
      await bounded(new Promise((resolve, reject) => {
        loaded = resolve;
        failed = (_event, code, description, _url, mainFrame) => {
          if (mainFrame) reject(new Error('The verification dashboard reload failed: ' + code + ' ' + description));
        };
        dashboard.webContents.once('did-finish-load', loaded);
        dashboard.webContents.on('did-fail-load', failed);
        dashboard.webContents.reload();
      }), 15000, 'The production dashboard reload did not finish');
    } finally {
      dashboard.webContents.off('did-finish-load', loaded);
      dashboard.webContents.off('did-fail-load', failed);
    }
    await until(() => ui('window.hephaestusDashboardInspect?.().initialized'), 15000, 'The dashboard did not reload its deliberately incomplete local transcript');
    await showDashboard('companion'); await frames();
    check('missing-local-reply', 'The injected local gap omits the actual reply from the reloaded UI',
      !await ui(`!!document.querySelector('[data-message-id="${missing.id}"]')`) && !c.messages.some(message => message.providerItemId === missing.providerItemId),
      'fault-injection', { providerItemId: missing.providerItemId, remoteReplyUntouched: true });
    const anchorBefore = await ui(`(() => {
      const answers=document.querySelector('#answers'),gap=answers.scrollHeight-answers.clientHeight;
      if(gap<90)throw new Error('The real transcript is too short to verify reading position');
      answers.focus();answers.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));answers.scrollTop=Math.min(20,gap-80);answers.dispatchEvent(new Event('scroll'));
      const row=[...answers.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>answers.getBoundingClientRect().top);
      return {top:answers.scrollTop,following:window.hephaestusDashboardInspect().following,anchorId:row?.dataset.messageId,anchorOffset:row?row.getBoundingClientRect().top-answers.getBoundingClientRect().top:null};
    })()`);
    assert.equal(anchorBefore.following, false, 'The reader must be above the latest message before restoration');
    const realProjection = await projection(); c.restoreProjection(realProjection); await frames();
    c.restoreProjection(realProjection); await frames();
    const repaired = c.messages.find(message => message.providerItemId === missing.providerItemId);
    const anchorAfter = await ui(`(() => {
      const answers=document.querySelector('#answers'),row=document.querySelector('[data-message-id="${anchorBefore.anchorId}"]');
      const ids=[...answers.querySelectorAll('[data-message-id]')].map(row=>row.dataset.messageId);
      return {top:answers.scrollTop,following:window.hephaestusDashboardInspect().following,anchorOffset:row?row.getBoundingClientRect().top-answers.getBoundingClientRect().top:null,ids,restoredRows:ids.filter(id=>id===${JSON.stringify(repaired?.id)}).length};
    })()`);
    check('restored-once', 'Repeated real T3 snapshots restore the missing reply exactly once',
      !!repaired && c.messages.filter(message => message.providerItemId === missing.providerItemId).length === 1 && anchorAfter.restoredRows === 1 && new Set(anchorAfter.ids).size === anchorAfter.ids.length,
      'real-projection-after-fault-injection', { providerItemId: missing.providerItemId, restoredRows: anchorAfter.restoredRows, visibleRows: anchorAfter.ids.length });
    check('reading-position', 'Restoring completed history preserves the current reading position',
      anchorAfter.following === false && Math.abs(anchorBefore.top - anchorAfter.top) <= 2 && anchorAfter.anchorOffset !== null && Math.abs(anchorBefore.anchorOffset - anchorAfter.anchorOffset) <= 2,
      'real-ui-after-fault-injection', { before: anchorBefore, after: { top: anchorAfter.top, following: anchorAfter.following, anchorOffset: anchorAfter.anchorOffset } });
    check('silent-history', 'History restoration emits no fresh speech or reply stream',
      speechEvents === beforeSpeech && flushEvents === beforeFlush && deltas.length === beforeDeltas,
      'real-projection-after-fault-injection', { speechEvents: speechEvents - beforeSpeech, flushEvents: flushEvents - beforeFlush, deltaEvents: deltas.length - beforeDeltas });
    await snapshot('02-restored-reading-position.png');

    phase = 'idle-socket-recovery';
    await disconnectClient('idle-reconnect');
    const afterReconnect = await projection(); c.restoreProjection(afterReconnect); c.restoreProjection(afterReconnect); await frames();
    check('reconnect-row-identity', 'Real reconnection retains one visible row per actual message',
      await ui('(() => {const ids=[...document.querySelectorAll("[data-message-id]")].map(row=>row.dataset.messageId);return ids.length===new Set(ids).size;})()') &&
      c.messages.filter(message => message.providerItemId === missing.providerItemId).length === 1,
      'real-transport-ui');

    phase = 'active-socket-recovery';
    const reconnectToken = marker + '-RECONNECT';
    const active = await sendFromUI(`Text-only session recovery verification. Do not call any tools. Start with ${reconnectToken}. Then produce 60 numbered practical tips for keeping a desktop workspace organized, at most eight words per item. Use a separate paragraph for each item so the application can observe a real stream while reconnecting.`, 'active-send');
    const activeProjection = await projection(), activeRemote = activeProjection.runs?.find(run => run.id === active.runId);
    assert.ok(activeRemote && !terminal.has(activeRemote.status), 'The request finished before its active connection could be tested');
    const transitionStart = report.stateTransitions.length;
    const activeReconnect = await disconnectClient('active-reconnect');
    const recoveredProjection = await projection(), recoveredRun = recoveredProjection.runs?.find(run => run.id === active.runId);
    assert.ok(recoveredRun, 'The real request was absent from the recovered T3 projection');
    const restoredBusy = report.stateTransitions.slice(transitionStart).some(state => state.transportEpoch === activeReconnect.transportEpoch && state.connection === 'connected' && state.busy) ||
      (c.state.connection === 'connected' && c.state.busy && c.t3InFlight && c.t3RunId === active.runId);
    if (recoveredRun && !terminal.has(recoveredRun.status)) {
      check('active-run-busy', 'A real running request is restored as busy after reconnection', restoredBusy && c.t3RunId === active.runId,
        'real-transport-model', { runId: active.runId, remoteStatus: recoveredRun.status, restoredBusy });
    } else if (restoredBusy) {
      check('active-run-busy', 'The reconnect restored busy state before the real run completed', true,
        'real-transport-model', { runId: active.runId, remoteStatus: recoveredRun?.status, restoredBusy });
    } else {
      report.checks.push({ id: 'active-run-busy', name: 'Restore busy state while a real request is still running', status: 'skipped', kind: 'real-transport-model', reason: 'The server completed this run while the client was disconnected.', evidence: { runId: active.runId, remoteStatus: recoveredRun?.status } });
      report.limitations.push('Active-run busy restoration was not observable because that real run completed during reconnection.');
    }
    await completed(active, reconnectToken);
    await snapshot('03-recovered-response.png');

    phase = 'runtime-cancellation';
    const cancelToken = marker + '-CANCEL';
    const stopping = await sendFromUI(`Text-only cancellation verification. Do not call tools or change anything. Start your answer with ${cancelToken}. Intentionally write a long answer: 160 numbered tips for keeping a desk tidy, each about ten words and each on its own paragraph. Continue the numbered list without compressing or summarizing it; the application will cancel this real response while it is generating.`, 'cancel-send');
    await until(() => c.state.busy && deltas.some(delta => delta.runId === stopping.runId && delta.length > 0), 60000, 'The long real response never began streaming');
    assert.equal(c.confirmation, null, 'A real approval was unexpectedly pending before fault injection');
    report.faultInjections.push({ kind: 'pending-local-confirmation', runId: stopping.runId, description: 'Injected an explicitly labelled, action-free local approval while the real model was generating. Runtime cancellation itself is real.' });
    injectedConfirmation = c.askConfirmation({ kind: 'verification', reason: 'Session verification fault injection: no desktop action will be performed.' })
      .then(() => { confirmationResult = 'approved'; }, () => { confirmationResult = 'declined'; });
    await until(() => ui('!document.querySelector("#confirmation").hidden'), 5000, 'The injected approval did not reach the production UI');
    await snapshot('04-generating-before-stop.png');
    const beforeStop = await projection(), runningBeforeStop = beforeStop.runs?.find(run => run.id === stopping.runId);
    check('cancel-live-generation', 'The cancellation targets a real streaming model request',
      !!runningBeforeStop && !terminal.has(runningBeforeStop.status) && deltas.some(delta => delta.runId === stopping.runId && delta.length > 0),
      'real-transport-model', { runId: stopping.runId, remoteStatus: runningBeforeStop?.status });
    const stopAt = Date.now(), stopTransitionStart = report.stateTransitions.length;
    await ui('(() => {const stop=document.querySelector("#stop");if(stop.disabled)throw new Error("The production Stop button is disabled");stop.click();})()');
    await until(() => !c.confirmation && confirmationResult === 'declined', 10000, 'Stopping the real run did not close the injected local approval');
    await until(() => !c.state.busy && !c.state.stopping && !c.t3InFlight, 45000, 'The cancelled runtime did not return to an idle state');
    const stoppedProjection = await projection(), stoppedRun = stoppedProjection.runs?.find(run => run.id === stopping.runId);
    check('runtime-stop-confirmed', 'The real T3 runtime confirms cancellation after the production Stop action',
      cancelled.has(stoppedRun?.status), 'real-transport-model', { runId: stopping.runId, status: stoppedRun?.status, confirmedMs: Date.now() - stopAt });
    check('stopping-feedback', 'The app reports Stopping before confirmed cancellation',
      report.stateTransitions.slice(stopTransitionStart).some(state => state.busy && state.stopping), 'real-ui-model');
    check('approval-closed', 'Stop declines and hides the injected pending approval',
      confirmationResult === 'declined' && c.confirmation === null && await ui('document.querySelector("#confirmation").hidden'),
      'fault-injection-integration', { approval: 'injected; no desktop action', result: confirmationResult });
    Object.assign(stopping.entry, { status: stoppedRun.status, cancelled: true });
    await snapshot('05-confirmed-stop.png');

    phase = 'post-cancellation-request';
    const finalToken = marker + '-RECOVERED';
    const followup = await sendFromUI(`Text-only session verification. Do not use tools. Reply with exactly this token and nothing else: ${finalToken}`, 'recovery-send');
    await completed(followup, finalToken);
    await snapshot('06-usable-recovered-session.png');
    await until(() => bounded(bubble.webContents.executeJavaScript(`window.hephaestusBubbleInspect().renderedText.includes(${JSON.stringify(finalToken)})`), 5000, 'The answer bubble did not answer'),
      5000, 'The real recovered answer did not reach the answer bubble');
    await snapshot('07-recovered-answer-bubble.png', bubble);
    check('session-clean', 'The recovered session is connected and ready with sharing disabled',
      c.state.connection === 'connected' && !c.state.busy && !c.state.stopping && !c.state.sendPending && !c.t3InFlight && c.confirmation === null && !c.state.error,
      'real-transport-ui', { connection: c.state.connection, busy: c.state.busy, stopping: c.state.stopping });
    assertPrivate(); report.success = true;
  } catch (error) {
    report.failure = { phase, message: safeError(error) };
    console.error('SESSION_CHECK failed during ' + phase + ': ' + safeError(error));
  } finally {
    if (allowCleanup) {
      try {
        c.confirm(false);
        await Promise.race([c.configure({ watching: false, backgroundVision: false, proactive: false, inputMode: 'wispr', spokenReplies: false, control: false }), sleep(5000).then(() => { throw new Error('Cleanup settings timed out'); })]);
        if (c.state.connection !== 'connected') {
          const end = Date.now() + 45000;
          while (Date.now() < end && c.state.connection !== 'connected') await sleep(100);
        }
        if (c.state.connection === 'connected' && c.t3?.socket?.readyState === 1) {
          const remote = await Promise.race([
            c.t3.call('orchestration.getThreadProjection', { threadId: c.t3ThreadId }, 10000),
            sleep(12000).then(() => { throw new Error('Cleanup projection timed out'); }),
          ]);
          if (remote.thread?.activeRunId || remote.runs?.some(run => !terminal.has(run.status))) c.restoreProjection(remote);
        }
        if (c.t3InFlight || c.state.busy) {
          await Promise.race([c.interrupt(), sleep(12000).then(() => { throw new Error('Cleanup cancellation timed out'); })]);
          const end = Date.now() + 15000;
          while (Date.now() < end && (c.state.busy || c.state.stopping)) await sleep(100);
        }
        await injectedConfirmation;
        await c.ledger?.flush();
        if (c.state.connection === 'connected' && c.t3?.socket?.readyState === 1) {
          const remote = await c.t3.call('orchestration.getThreadProjection', { threadId: c.t3ThreadId }, 10000);
          report.cleanupRemoteActive = !!remote.thread?.activeRunId || !!remote.runs?.some(run => !terminal.has(run.status));
          if (report.cleanupRemoteActive) throw new Error('A verification model request is still active in T3 after cleanup');
        }
      } catch (error) { report.cleanupError = safeError(error); report.success = false; }
      report.finalState = { connection: c.state.connection, busy: c.state.busy === true, stopping: c.state.stopping === true,
        sendPending: c.state.sendPending === true, confirmationPending: !!c.confirmation, watching: c.state.watching === true,
        backgroundVision: c.state.backgroundVision === true, proactive: c.state.proactive === true };
      if (report.finalState.connection !== 'connected' || report.finalState.busy || report.finalState.stopping || report.finalState.sendPending || report.finalState.confirmationPending || report.finalState.watching || report.finalState.backgroundVision || report.finalState.proactive) report.success = false;
    }
    c.off('state', stateListener); c.off('delta', deltaListener); c.off('speak', speechListener); c.off('speechFlush', flushListener); c.off('activity', toolListener);
    report.elapsedMs = Date.now() - startedAt;
    report.privacyViolations = privacyViolations.length;
    report.toolInvocations = toolEvents;
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log('SESSION_CHECK_RESULT ' + JSON.stringify({ success: report.success, checks: report.checks.map(({ id, status, kind }) => ({ id, status, kind })), failure: report.failure, elapsedMs: report.elapsedMs, report: 'artifacts/session-check/report.json' }));
  }
  return report.success;
}
