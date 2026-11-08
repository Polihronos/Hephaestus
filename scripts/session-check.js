import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, lstat, readdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { signToolOrigin, TOOL_ORIGIN_FIELD } from '../src/tool-origin.js';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const cancelled = new Set(['cancelled', 'interrupted', 'rolled_back']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => String(error?.message ?? error)
  .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
  .replace(/((?:access_?token|bearer_?token|authorization|session_?token)["'\s:=]+)[^\s,"'}]+/gi, '$1[redacted]')
  .slice(0, 1200);

// Uses the production windows and a real T3 session. The only injected faults are
// a missing local entry, an action-free approval, a signed obsolete origin, and
// an owned empty directory blocking the isolated Stop recovery file write.
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
    faultInjections: [], cancellationAttempts: [],
  };
  let phase = 'setup', previousStateKey = '', confirmationResult = null, injectedConfirmation = null;
  let observedClient = c.t3, transportEpoch = 0;
  let cancellationTarget = null, offlineStopWatch = null, offlineStopAccepted = false;
  let verifiedProfile = null, stopCacheFault = null;
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
  const intentSnapshot = intent => intent ? Object.fromEntries(['threadId', 'messageId', 'runId', 'accepted', 'requestedAt', 'sent', 'retryId'].filter(key => intent[key] !== undefined).map(key => [key, intent[key]])) : null;
  const stateListener = state => {
    if (c.t3 !== observedClient) { observedClient = c.t3; transportEpoch++; }
    const item = { elapsedMs: Date.now() - startedAt, connection: state.connection, busy: state.busy === true,
      stopping: state.stopping === true, pending: state.sendPending === true, activity: state.activity,
      watching: state.watching === true, proactive: state.proactive === true, backgroundVision: state.backgroundVision === true, transportEpoch,
      clientPresent: !!c.t3, clientSocketOpen: c.t3?.socket?.readyState === 1,
      desktopActionsRevoked: c.desktopActionsRevoked === true, t3StopIntent: intentSnapshot(c.t3StopIntent), t3Outstanding: intentSnapshot(c.t3Outstanding) };
    Object.assign(item, { stopPersistenceError: state.stopPersistenceError ?? null, stopRetryAvailable: state.stopRetryAvailable === true, stopRequestPending: state.stopRequestPending === true });
    const offline = offlineStopWatch;
    if (offline) item.monitoredRunStatus = c.t3Runs?.get(offline.runId)?.status ?? null;
    const key = JSON.stringify({ ...item, elapsedMs: 0 });
    if (key !== previousStateKey) { previousStateKey = key; report.stateTransitions.push(item); }
    if (item.watching || item.proactive || item.backgroundVision) privacyViolations.push(item.elapsedMs);
    if (offline) {
      if (state.connection === 'reconnecting' && !offline.stopPromise && c.t3 === offline.client) {
        offline.record.offlineBeforeStop = { ...item };
        offline.record.stopQueuedAt = Date.now();
        offline.stopTransitionStart = report.stateTransitions.length;
        offline.stopPromise = ui(`(() => {const stop=document.querySelector('#stop');if(stop.disabled)throw new Error('Stop is disabled while the accepted request is offline');const at=Date.now();stop.click();return {clicked:true,at};})()`)
          .then(result => { offline.record.stopUI = result; return result; }, error => { offline.stopError = error; offline.record.stopError = safeError(error); return null; });
      }
      if (item.t3StopIntent?.runId === offline.runId && state.connection !== 'connected' && item.stopping && item.busy) {
        offline.record.offlineAfterStop ??= { ...item };
      }
      if (state.activity === 'Ready') offline.record.readyTransitions.push({ ...item });
    }
  };
  const deltaListener = data => {
    // A final-only reply also emits delta. Capture the provider item's streaming
    // flag now: the same map entry will become non-streaming when it completes.
    const item = c.t3Seen?.get(data.itemId);
    const delta = { at: Date.now(), itemId: data.itemId, runId: data.turnId, generation: data.generation,
      length: data.full?.length ?? 0, streaming: item?.streaming === true, providerTurnId: item?.providerTurnId };
    deltas.push(delta);
    const target = cancellationTarget;
    if (!target || target.startup || target.stopPromise || !target.approvalReady || !delta.streaming || !delta.length ||
        target.t3MessageId !== c.t3MessageId || delta.runId !== c.t3RunId) return;
    target.record.firstStreamingDelta = delta;
    queueStop(target, { mode: 'streaming', runId: delta.runId, at: delta.at });
  };
  function queueStop(target, trigger) {
    if (target.stopPromise) return;
    assert.ok(stopCacheFault?.record === target.record && stopCacheFault.owned, 'The isolated Stop write fault must be armed before the production Stop click');
    target.record.trigger = trigger;
    target.record.stopQueuedAt = Date.now();
    target.stopTransitionStart = report.stateTransitions.length;
    // Dispatch the production Stop click directly from the genuine streaming
    // callback. No screenshot, projection call, or polling precedes the click.
    target.stopPromise = ui(`(() => {
      const stop=document.querySelector('#stop'),approvalVisible=!document.querySelector('#confirmation').hidden;
      if(stop.disabled)return {clicked:false,approvalVisible,reason:'Stop was already disabled',at:Date.now()};
      const at=Date.now();stop.click();return {clicked:true,approvalVisible,at};
    })()`).then(result => { target.record.stopUI = result; return result; }, error => {
      target.stopError = error; target.record.stopError = safeError(error); return null;
    });
  }
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
  const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
  const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  async function faultIO(promise, label, cleanup = false) {
    if (!cleanup) return bounded(promise, 2000, label);
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 2000); })]); }
    finally { clearTimeout(timer); }
  }
  async function guardFaultProfile(cleanup = false) {
    assert.ok(allowCleanup && verifiedProfile, 'Stop write fault requires the validated isolated session profile');
    const [data, userData] = await faultIO(Promise.all([realpath(c.dataDir), realpath(app.getPath('userData'))]), 'Could not verify the Stop fault profile', cleanup);
    assert.ok(samePath(data, verifiedProfile) && samePath(userData, verifiedProfile), 'The isolated Stop fault profile changed');
  }
  async function armStopCacheFault(record) {
    assert.equal(stopCacheFault, null, 'A previous Stop write fault has not been removed');
    await guardFaultProfile();
    await bounded(c.t3SaveQueue ?? Promise.resolve(), 5000, 'Existing recovery writes did not settle before Stop fault injection');
    const file = join(verifiedProfile, 't3-runtime.json'), block = file + '.tmp';
    const [info, existing, fileReal] = await faultIO(Promise.all([lstat(file), exists(block), realpath(file)]), 'Could not inspect the isolated recovery file');
    assert.ok(info.isFile() && !info.isSymbolicLink() && samePath(fileReal, file), 'Stop recovery must be a regular file in the isolated profile');
    assert.equal(existing, null, 'An existing recovery temporary path cannot be used as this check’s fault');
    const saved = JSON.parse(await faultIO(readFile(file, 'utf8'), 'Could not read the real recovery identity'));
    assert.equal(saved.threadId, c.t3ThreadId, 'The recovery file does not identify the current real session');
    assert.ok(!saved.stopIntent && !c.t3StopIntent && !c.t3StopPersistenceDirty, 'The session already has unresolved Stop recovery');
    const evidence = { kind: 'stop-recovery-write-filesystem-fault', attempt: record.attempt, path: 'runtime/session-verification/t3-runtime.json.tmp',
      description: 'An owned empty directory at the actual isolated recovery temporary-file path makes the production Stop write fail. No provider result is substituted.', outcome: 'armed' };
    const fault = stopCacheFault = { record, file, block, owned: false, evidence, creation: null };
    fault.creation = mkdir(block).then(async () => { fault.owned = true; fault.identity = await lstat(block); });
    await faultIO(fault.creation, 'Could not create the isolated Stop write fault');
    assert.ok(fault.identity.isDirectory() && !fault.identity.isSymbolicLink(), 'The owned Stop fault is not a normal directory');
    report.faultInjections.push(evidence);record.recoveryWriteFault = evidence;
  }
  async function removeStopCacheFault(cleanup = false) {
    const fault = stopCacheFault;if (!fault) return;
    if (fault.creation) await faultIO(fault.creation.catch(() => {}), 'Stop fault creation did not settle before cleanup', cleanup);
    if (!fault.owned) { stopCacheFault = null; return; }
    await guardFaultProfile(cleanup);
    const current = await faultIO(exists(fault.block), 'Could not inspect the owned Stop fault directory', cleanup);
    assert.ok(current?.isDirectory() && !current.isSymbolicLink() && fault.identity && current.dev === fault.identity.dev && current.ino === fault.identity.ino,
      'The owned Stop fault directory changed identity; it will not be removed');
    assert.ok(samePath(await faultIO(realpath(fault.block), 'Could not resolve the Stop fault directory', cleanup), fault.block), 'The Stop fault path no longer resolves inside the isolated profile');
    assert.equal((await faultIO(readdir(fault.block), 'Could not inspect Stop fault directory contents', cleanup)).length, 0, 'The owned Stop fault directory is no longer empty');
    await faultIO(rmdir(fault.block), 'Could not remove the owned empty Stop fault directory', cleanup);
    fault.owned = false;fault.evidence.directoryRemoved = true;stopCacheFault = null;
  }
  async function recoverStopCacheFault(target, required) {
    const fault = stopCacheFault;assert.equal(fault?.record, target.record, 'Stop fault ownership does not match this cancellation attempt');
    const record = target.record, transitions = report.stateTransitions.slice(target.stopTransitionStart ?? report.stateTransitions.length);
    if (required) {
      await until(() => !!c.state.stopPersistenceError && c.t3StopPersistenceDirty && c.state.stopRetryAvailable && !c.state.stopRequestPending, 5000, 'The real Stop write failure did not expose retryable persistence status');
      const writeError = await bounded(c.t3SaveQueue.then(() => null, error => error), 2000, 'The injected recovery write did not settle');
      const actualFault = ['EISDIR', 'EACCES', 'EPERM'].includes(writeError?.code) && (!writeError.path || samePath(writeError.path, fault.block));
      const view = await until(() => ui(`(() => {
        const status=document.querySelector('#stop-persistence-status'),stop=document.querySelector('#stop'),notice=document.querySelector('#notice'),r=status?.getBoundingClientRect();
        return status&&!status.hidden&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+1&&!notice.hidden&&!stop.disabled&&stop.textContent==='Save Stop recovery'&&document.querySelector('#notice-message').textContent===${JSON.stringify(c.state.stopPersistenceError)}
          ? {warning:document.querySelector('#notice-message').textContent,status:status.textContent,button:stop.textContent}:false;
      })()`), 5000, 'The actual Stop UI did not retain its separate persistence warning and recovery-save retry');
      const revoked = transitions.some(state => state.busy && state.stopping && state.desktopActionsRevoked && state.t3StopIntent?.messageId === target.t3MessageId);
      const predicates = { actualFilesystemFault:actualFault, immediateRevocation:revoked, actionsStillRevoked:c.desktopActionsRevoked === true, intentCleared:!c.t3StopIntent, idle:!c.state.busy && !c.state.stopping, warningMatches:view.warning === c.state.stopPersistenceError };
      Object.assign(fault.evidence, { outcome: 'write-rejected-remote-cancellation-confirmed', filesystemCode: writeError?.code, runId: record.runId, cancellationMode: record.mode, desktopActionsRevoked: c.desktopActionsRevoked === true, visibleStatus: view.status, retry: view.button });
      check('stop-recovery-write-fault', 'A real recovery-write failure does not prevent remote cancellation, local revocation or a visible retry',
        actualFault && revoked && c.desktopActionsRevoked === true && !c.t3StopIntent && !c.state.busy && !c.state.stopping && view.warning === c.state.stopPersistenceError,
        'fault-injection-real-filesystem-transport-ui', { runId: record.runId, cancellationMode: record.mode, filesystemCode: writeError?.code, visibleStatus: view.status, retry: view.button, predicates, visibleWarning:view.warning, expectedWarning:c.state.stopPersistenceError });
      const warningLayoutBefore={bounds:dashboard.getBounds(),minimum:dashboard.getMinimumSize(),expanded:await ui(`document.querySelector('#toggle-screen').getAttribute('aria-expanded')`)};
      try{
        dashboard.setMinimumSize(0,0);
        for(const[width,height]of[[960,620],[1280,840]])for(const mode of['split','expanded']){
          dashboard.setContentSize(width,height);await showDashboard('companion');
          await ui(`(()=>{const button=document.querySelector('#toggle-screen');if((button.getAttribute('aria-expanded')==='false')!==${mode==='expanded'})button.click();})()`);
          const sizing={requested:{width,height},calibration:[]};
          try{await until(async()=>{await frames();sizing.window={bounds:dashboard.getBounds(),contentBounds:dashboard.getContentBounds()};sizing.viewport=await ui('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})');if(sizing.viewport.width===width&&sizing.viewport.height===height)return true;if(sizing.calibration.length<3){const before=dashboard.getSize(),next=[before[0]+width-sizing.viewport.width,before[1]+height-sizing.viewport.height];sizing.calibration.push({before,viewport:sizing.viewport,next});dashboard.setSize(...next);}return false;},3000,'The real Stop warning window did not finish exact client sizing');}
          catch(error){report.stopWarningLayoutFailure={mode,...sizing};await snapshot(`05a-stop-warning-${width}-${mode}-sizing-failed.png`);throw error;}
          const geometry=await ui('window.hephaestusDashboardLayout()');await snapshot(`05a-stop-warning-${width}-${mode}.png`);
          check(`stop-warning-layout-${width}-${mode}`,`The real Stop warning, retry, composer and Send fit ${width}×${height} (${mode})`,
            geometry.content.noOverflow&&geometry.warning.visible&&geometry.warning.fullText&&geometry.warningActions.visible&&!geometry.warningRetry.hidden&&geometry.warningRetry.visible&&geometry.warningDismiss.visible&&geometry.composer.visible&&geometry.input.visible&&geometry.send.visible&&geometry.recovery.visible&&!geometry.recovery.disabled&&geometry.screenControlsVisible,
            'real-ui-after-filesystem-transport-fault',{runId:record.runId,width,height,mode,sizing,geometry});
        }
      }finally{
        const restoration=report.stopWarningLayoutRestoration={boundsBefore:warningLayoutBefore.bounds,minimumBefore:warningLayoutBefore.minimum,calibration:[]};let requested={...warningLayoutBefore.bounds};
        try{for(let attempt=0;attempt<4;attempt++){dashboard.setBounds(requested);await frames();const actual=dashboard.getBounds();if(JSON.stringify(actual)===JSON.stringify(warningLayoutBefore.bounds))break;restoration.calibration.push({requested:{...requested},actual});requested=Object.fromEntries(Object.keys(requested).map(key=>[key,requested[key]+warningLayoutBefore.bounds[key]-actual[key]]));}}finally{dashboard.setMinimumSize(...warningLayoutBefore.minimum);}
        await ui(`(()=>{const button=document.querySelector('#toggle-screen');if(button.getAttribute('aria-expanded')!==${JSON.stringify(warningLayoutBefore.expanded)})button.click();})()`);await frames();Object.assign(restoration,{boundsAfter:dashboard.getBounds(),minimumAfter:dashboard.getMinimumSize()});assert.deepEqual(restoration.boundsAfter,warningLayoutBefore.bounds,'The Stop warning did not restore native window bounds');assert.deepEqual(restoration.minimumAfter,warningLayoutBefore.minimum,'The Stop warning did not restore native minimum size');
      }
      await snapshot('05a-stop-recovery-write-fault.png');
    } else fault.evidence.outcome = 'not-counted-cancellation-not-exercised';
    await removeStopCacheFault();
    if (c.t3StopPersistenceDirty || c.state.stopPersistenceError) {
      await until(() => !c.state.busy && !c.state.stopping && !c.t3InFlight && !c.t3StopIntent && !c.state.stopRequestPending, 5000, 'Recovery-save retry requires the already confirmed terminal request');
      const before = { threadId: c.t3ThreadId, runs: [...c.t3Runs.keys()], messages: c.messages.map(message => message.id) };
      const retry = await ui(`(() => {const stop=document.querySelector('#stop');if(stop.disabled||stop.textContent!=='Save Stop recovery')throw new Error('The production recovery-save retry is unavailable');stop.click();return true;})()`);
      await until(() => !c.t3StopPersistenceDirty && !c.state.stopPersistenceError && !c.state.stopRetryAvailable && !c.state.stopRequestPending, 5000, 'The production recovery-save retry did not clear the persistence failure');
      const fileInfo = await faultIO(lstat(fault.file), 'Could not inspect the retried recovery file');
      assert.ok(fileInfo.isFile() && !fileInfo.isSymbolicLink() && samePath(await faultIO(realpath(fault.file), 'Could not resolve the retried recovery file'), fault.file), 'The retried recovery file is not a normal isolated file');
      const saved = JSON.parse(await faultIO(readFile(fault.file, 'utf8'), 'Could not read the retried recovery file'));
      await until(() => ui(`document.querySelector('#stop-persistence-status').hidden&&document.querySelector('#stop').disabled&&document.querySelector('#notice').hidden`), 5000, 'The recovered Stop UI did not clear its warning');
      const noNewWork = before.threadId === c.t3ThreadId && JSON.stringify(before.runs) === JSON.stringify([...c.t3Runs.keys()]) && JSON.stringify(before.messages) === JSON.stringify(c.messages.map(message => message.id));
      assert.ok(retry && !saved.stopIntent && saved.threadId === before.threadId && noNewWork && c.desktopActionsRevoked === true, 'Saving Stop recovery changed the real session or left its durable intent behind');
      fault.evidence.recoveredThroughProductionUI = true;fault.evidence.durableStopIntent = null;
      if (required) check('stop-recovery-save-retry', 'The production recovery-save retry clears the warning and durable intent without another request', true,
        'real-ui-filesystem-after-fault-injection', { threadUnchanged: true, noNewWork, durableStopIntent: null, desktopActionsRevoked: c.desktopActionsRevoked });
    } else assert.equal(required, false, 'The injected Stop write fault disappeared before recovery saving was exercised');
  }
  function runFor(message) {
    return [...c.t3Runs.values()].find(run => run.userMessageId === message.t3MessageId);
  }
  function finalFor(runId) {
    return c.messages.filter(message => message.role === 'assistant' && message.turnId === runId && message.providerItemId).at(-1);
  }
  function nativeOriginForRun(canonical,runId) {
    const attempts=new Set((canonical.attempts??[]).filter(attempt=>attempt.runId===runId).map(attempt=>attempt.id));
    const turn=[...(canonical.providerTurns??[])].reverse().find(turn=>attempts.has(turn.runAttemptId)&&turn.status==='completed'&&turn.nativeTurnRef?.nativeId);
    const thread=(canonical.providerThreads??[]).find(thread=>thread.id===turn?.providerThreadId);
    assert.ok(turn?.nativeTurnRef?.nativeId&&thread?.nativeThreadRef?.nativeId,'The completed real request did not expose its native originating turn');
    return Object.freeze({nativeSessionId:thread.nativeThreadRef.nativeId,nativeTurnId:turn.nativeTurnRef.nativeId});
  }
  async function sendFromUI(text, id, { onAccepted, onRun } = {}) {
    assertPrivate();
    await until(() => c.state.connection === 'connected' && !c.state.busy && !c.t3InFlight && !c.state.sendPending,
      45000, 'The session was not idle before ' + id);
    await showDashboard('companion', true);
    const before = new Set(c.messages.map(message => message.id)), at = Date.now();
    let acceptanceError, acceptanceSeen = false;
    const acceptedListener = message => {
      if (!onAccepted || acceptanceSeen || before.has(message.id) || message.role !== 'user' || message.text !== text || message.delivery !== 'sent') return;
      acceptanceSeen = true;
      try { onAccepted(message); } catch (error) { acceptanceError = error; }
    };
    if (onAccepted) c.on('messageUpdated', acceptedListener);
    try {
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
    if (acceptanceError) throw acceptanceError;
    if (onAccepted) assert.ok(acceptanceSeen, 'The real send acknowledgement was not observed before streaming');
    const run = await until(() => runFor(message), 15000, 'The accepted message did not acquire a real T3 run');
    onRun?.(run);
    await until(() => ui('!document.querySelector("#dashboard-input").value && !window.hephaestusDashboardInspect().sendPending'),
      5000, 'The composer did not clear after real dispatch acceptance');
    const entry = { id, userMessageId: message.id, t3MessageId: message.t3MessageId, runId: run.id, acceptedMs: Date.now() - at };
    report.requests.push(entry);
    check(id + '-accepted', 'The accepted message appears once with a real T3 identity',
      c.messages.filter(item => item.t3MessageId === message.t3MessageId).length === 1,
      'real-ui-model', { t3MessageId: message.t3MessageId, runId: run.id });
    return { message, runId: run.id, entry };
    } finally { if (onAccepted) c.off('messageUpdated', acceptedListener); }
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
    const transitionStart = report.stateTransitions.length;
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
    const connected = report.stateTransitions.slice(transitionStart).filter(state => state.connection === 'connected');
    check(id + '-connected-truth', 'Every connected transition has a real open app-client socket',
      connected.length > 0 && connected.every(state => state.clientPresent && state.clientSocketOpen),
      'real-transport', { connectedTransitions: connected.length });
    assertPrivate();
    return record;
  }

  try {
    const expected = resolve(await realpath(root), 'runtime', 'session-verification');
    const expectedReal = await realpath(expected);
    check('isolated-profile', 'The verifier uses only its dedicated local data profile',
      samePath(expectedReal, expected) && samePath(await realpath(c.dataDir), expectedReal) && samePath(await realpath(app.getPath('userData')), expectedReal), 'environment', { directory: 'runtime/session-verification' });
    verifiedProfile = expectedReal;
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
    const firstNativeOrigin = nativeOriginForRun(firstResult.canonical,first.runId);
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
    const staleOriginFault={kind:'fault-injection-real-transport',oldRunId:first.runId,
      oldRunStatus:firstResult.canonical.runs?.find(run=>run.id===first.runId)?.status,currentRunId:active.runId,currentRunStatus:activeRemote?.status??null,
      description:'An explicitly constructed signed payload uses the completed first request native IDs. This is not a provider hook or human call.'};
    report.faultInjections.push(staleOriginFault);
    const currentActive=()=>c.state.connection==='connected'&&c.state.busy&&c.t3InFlight&&c.t3RunId===active.runId&&!terminal.has(c.t3Runs.get(active.runId)?.status);
    if(activeRemote&&!terminal.has(activeRemote.status)&&currentActive()){
      assert.ok(allowCleanup&&samePath(await realpath(c.dataDir),expectedReal),'The stale-origin transport check requires the validated isolated profile');
      const bridgePath=join(c.dataDir,'desktop-bridge.json');
      assert.equal(resolve(await realpath(bridgePath)).toLowerCase(),resolve(expectedReal,'desktop-bridge.json').toLowerCase(),'Only the isolated desktop bridge configuration may be read');
      const bridge=JSON.parse(await readFile(bridgePath,'utf8'));
      assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/tool$/.test(bridge.url)&&typeof bridge.token==='string'&&typeof bridge.originSecret==='string','The isolated desktop bridge configuration is invalid');
      const proof=signToolOrigin({secret:bridge.originSecret,tool:'screen_windows',args:{},...firstNativeOrigin,toolUseId:'verification-stale-'+marker});
      const payload=Object.freeze({name:'screen_windows',arguments:Object.freeze({[TOOL_ORIGIN_FIELD]:proof})});
      const serialized=JSON.stringify(payload),metrics=c.desktopServer?.metrics;
      assert.ok(metrics&&Number.isFinite(metrics.originsAuthorized)&&metrics.tools,'The actual desktop bridge metrics are unavailable');
      const before={originsAuthorized:metrics.originsAuthorized,tools:{...metrics.tools}},generation=c.generation;
      if(currentActive()){
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining(5000));
        let response;
        try{
          response=await fetch(bridge.url,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},
            body:serialized,signal:controller.signal,redirect:'error'});
          await response.arrayBuffer();
        }finally{clearTimeout(timer);}
        const afterFault=await projection(),afterRun=afterFault.runs?.find(run=>run.id===active.runId);
        staleOriginFault.currentRunStatus=afterRun?.status??null;staleOriginFault.httpStatus=response.status;
        const unchanged=metrics.originsAuthorized===before.originsAuthorized&&JSON.stringify(metrics.tools)===JSON.stringify(before.tools);
        assert.equal(response.status,400,'The actual desktop bridge did not reject the completed-run tool origin');
        assert.ok(unchanged,'The stale-origin fault unexpectedly authorized or invoked a desktop tool');
        if(afterRun&&!terminal.has(afterRun.status)&&currentActive()&&c.generation===generation){
          check('stale-origin-http-rejected','A signed completed-run call cannot borrow the newer active request authority',response.status===400&&unchanged,
            'fault-injection-real-transport',{oldRunId:first.runId,oldRunStatus:staleOriginFault.oldRunStatus,currentRunId:active.runId,currentRunStatus:afterRun.status,httpStatus:response.status,noInvoke:unchanged});
          staleOriginFault.outcome='rejected-during-new-active-run';
        }else{
          staleOriginFault.outcome='not-exercised';staleOriginFault.reason='The newer real request completed before active-run rejection could be confirmed.';
        }
      }else{
        staleOriginFault.outcome='not-exercised';staleOriginFault.reason='The newer real request completed before the stale-origin payload could be sent.';
      }
    }else{
      staleOriginFault.outcome='not-exercised';staleOriginFault.reason='The newer real request was no longer active when the stale-origin check began.';
    }
    if(staleOriginFault.outcome==='not-exercised'){
      report.checks.push({id:'stale-origin-http-rejected',name:'Reject a completed-run HTTP tool call while a newer request is active',status:'not-exercised',
        kind:'fault-injection-real-transport',reason:staleOriginFault.reason,evidence:{oldRunId:first.runId,oldRunStatus:staleOriginFault.oldRunStatus,currentRunId:active.runId,currentRunStatus:staleOriginFault.currentRunStatus}});
      report.limitations.push('Stale-origin real-HTTP rejection was not exercised while a newer request remained active; no negative pass is claimed.');
    }
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
    let cancelledAttempt = null;
    // A final-only answer cannot exercise live cancellation. Permit one more
    // real request to test startup cancellation, labelled separately.
    for (let attempt = 1; attempt <= 2 && !cancelledAttempt; attempt++) {
      const cancelToken = marker + '-CANCEL-' + attempt;
      const record = { attempt, marker: cancelToken, mode: attempt === 1 ? 'streaming' : 'startup', outcome: 'pending' };
      report.cancellationAttempts.push(record);
      const target = { record, startup: attempt === 2, approvalReady: false, stopPromise: null, t3MessageId: null };
      await armStopCacheFault(record);
      cancellationTarget = target; confirmationResult = null;
      const prompt = attempt === 1
        ? `Write a substantial practical guide of about 1,600 words about setting up a calm, useful desktop workspace. Use twelve sections with several concrete paragraphs per section. Begin the first sentence with ${cancelToken} and immediately continue with useful advice, rather than putting the token on a separate line. Explain tradeoffs, maintenance habits, and specific examples. This is text only: do not use tools, inspect the computer, or change settings. Give the substantive guide itself without a preamble or a promise to continue.`
        : `Write a detailed, practical guide to organizing an ordinary home office for focused work, with clear sections, tradeoffs, and concrete examples. Start the first sentence with ${cancelToken} and continue with the guide itself. This is text only: do not use tools, read files, inspect the desktop, or change any settings.`;
      const stopping = await sendFromUI(prompt, attempt === 1 ? 'cancel-send' : 'cancel-retry-send', {
        onAccepted(message) {
          assert.equal(c.confirmation, null, 'A real approval was unexpectedly pending before fault injection');
          target.t3MessageId = message.t3MessageId;
          record.approvalReadyAt = Date.now();
          report.faultInjections.push({ kind: 'pending-local-confirmation', attempt, t3MessageId: message.t3MessageId,
            description: 'Injected an explicitly labelled, action-free approval synchronously on real send acceptance, before the first genuine streaming callback.' });
          injectedConfirmation = c.askConfirmation({ kind: 'verification', reason: 'Session verification fault injection: no desktop action will be performed.' })
            .then(() => { confirmationResult = 'approved'; }, () => { confirmationResult = 'declined'; });
          target.approvalReady = true;
        },
        onRun(run) {
          if (target.startup && !terminal.has(run.status) && c.state.busy && c.t3InFlight) {
            queueStop(target, { mode: 'startup', runId: run.id, status: run.status, at: Date.now(), accepted: true });
          }
        },
      });
      record.runId = stopping.runId;
      await until(() => target.stopPromise || (terminal.has(c.t3Runs.get(stopping.runId)?.status) && !c.state.busy && !c.t3InFlight),
        60000, 'The substantive response neither streamed nor completed within the cancellation observation window');
      if (target.stopPromise) {
        await target.stopPromise;
        if (target.stopError) throw target.stopError;
        await until(() => !c.state.busy && !c.state.stopping && !c.t3InFlight, 45000, 'The runtime did not return to idle after Stop');
      }
      const stoppedProjection = await projection(), stoppedRun = stoppedProjection.runs?.find(run => run.id === stopping.runId);
      assert.ok(stoppedRun, 'The cancellation attempt is absent from the real T3 projection');
      const streamEvents = deltas.filter(delta => delta.runId === stopping.runId);
      const actualStreams = streamEvents.filter(delta => delta.streaming && delta.length > 0);
      const attempts = (stoppedProjection.attempts ?? []).filter(item => item.runId === stopping.runId);
      const attemptIds = new Set(attempts.map(item => item.id));
      const providerTurns = (stoppedProjection.providerTurns ?? []).filter(turn => attemptIds.has(turn.runAttemptId) || turn.id === record.firstStreamingDelta?.providerTurnId);
      const interrupt = (stoppedProjection.turnItems ?? []).find(item => item.runId === stopping.runId && item.type === 'run_interrupt_request');
      const interruptAt = Date.parse(interrupt?.startedAt ?? interrupt?.createdAt ?? interrupt?.completedAt);
      const completedAt = Date.parse(stoppedRun.completedAt);
      const naturalCompletion = stoppedRun.status === 'completed' && (!interrupt ||
        (Number.isFinite(completedAt) && Number.isFinite(interruptAt) && completedAt <= interruptAt) ||
        (!cancelled.has(stoppedRun.status) && providerTurns.length > 0 && providerTurns.every(turn => turn.status === 'completed' && Number.isFinite(Date.parse(turn.completedAt)) && Date.parse(turn.completedAt) <= interruptAt)));
      Object.assign(record, { runStatus: stoppedRun.status, actualStreamingEvents: actualStreams.length,
        finalOnlyDeltaEvents: streamEvents.filter(delta => !delta.streaming).length,
        interruptRequestedAt: interrupt?.startedAt ?? null, runCompletedAt: stoppedRun.completedAt ?? null,
        providerTurns: providerTurns.map(turn => ({ id: turn.id, status: turn.status, completedAt: turn.completedAt })) });
      const exercised = target.startup ? record.trigger?.mode === 'startup' && record.trigger.accepted && !terminal.has(record.trigger.status) : actualStreams.length > 0;
      const realCancellation = !!record.stopUI?.clicked && !!interrupt && exercised &&
        !naturalCompletion && (cancelled.has(stoppedRun.status) || providerTurns.some(turn => cancelled.has(turn.status)));
      if (!realCancellation && (naturalCompletion || (!actualStreams.length && stoppedRun.status === 'completed'))) {
        record.outcome = 'not-exercised';
        record.reason = !target.startup && !actualStreams.length ? 'The model delivered a final-only answer; no genuine streaming callback occurred.' : 'The runtime completed naturally before the Stop request could interrupt it.';
        report.checks.push({ id: 'cancellation-attempt-' + attempt, name: target.startup ? 'Cancel a real request during startup' : 'Interrupt a genuinely streaming model response', status: 'not-exercised', kind: 'real-transport-model',
          reason: record.reason, evidence: { runId: stopping.runId, runStatus: stoppedRun.status, actualStreamingEvents: actualStreams.length,
            runCompletedAt: record.runCompletedAt, interruptRequestedAt: record.interruptRequestedAt } });
        c.confirm(false); await injectedConfirmation;
        record.approvalResult = 'declined by verifier cleanup; not evidence of Stop';
        Object.assign(stopping.entry, { status: stoppedRun.status, cancelled: false, cancellationOutcome: 'not-exercised' });
        await recoverStopCacheFault(target, false);
        cancellationTarget = null;
        if (attempt === 1) continue;
        break;
      }
      if (target.startup) {
        check('cancel-startup-active', 'Stop targets an accepted real request before it completes', exercised,
          'real-transport-model', { runId: stopping.runId, trigger: record.trigger, streamingEventsObserved: actualStreams.length });
        report.limitations.push('Streaming cancellation was not exercised; real runtime cancellation was instead verified during request startup.');
      } else {
        check('cancel-live-generation', 'Stop targets a genuinely streaming provider item after approval setup',
          actualStreams.length > 0 && !!record.firstStreamingDelta && record.approvalReadyAt <= record.firstStreamingDelta.at,
          'real-transport-model', { runId: stopping.runId, firstStreamingDelta: record.firstStreamingDelta, approvalReadyAt: record.approvalReadyAt });
      }
      check('runtime-stop-confirmed', 'The real runtime confirms cancellation after the production Stop action',
        realCancellation, 'real-transport-model', { runId: stopping.runId, runStatus: stoppedRun.status,
          providerStatuses: providerTurns.map(turn => turn.status), interruptRequestedAt: record.interruptRequestedAt,
          confirmedMs: Date.now() - record.stopQueuedAt });
      await until(() => !c.confirmation && confirmationResult === 'declined', 10000, 'Stopping the real run did not close the injected local approval');
      check('stopping-feedback', 'The app reports Stopping before confirmed cancellation',
        report.stateTransitions.slice(target.stopTransitionStart).some(state => state.busy && state.stopping), 'real-ui-model');
      check('approval-closed', 'Stop declines and hides the injected pending approval',
        record.stopUI.approvalVisible && confirmationResult === 'declined' && c.confirmation === null && await ui('document.querySelector("#confirmation").hidden'),
        'fault-injection-integration', { approval: 'injected on real acceptance; no desktop action', result: confirmationResult });
      await recoverStopCacheFault(target, true);
      record.outcome = 'cancelled'; record.approvalResult = confirmationResult;
      Object.assign(stopping.entry, { status: stoppedRun.status, cancelled: true });
      cancelledAttempt = record; cancellationTarget = null;
    }
    check('genuine-cancellation-required', 'At least one real model request was cancelled', !!cancelledAttempt,
      'real-transport-model', { attempts: report.cancellationAttempts.length, outcomes: report.cancellationAttempts.map(attempt => attempt.outcome) });
    await snapshot('05-confirmed-stop.png');

    phase = 'offline-stop-recovery';
    const offlineRecord = { mode: 'stop-while-offline', readyTransitions: [], outcome: 'pending',
      contract: ['t3Outstanding', 't3StopIntent', 't3StopIntent.requestedAt', 't3StopIntent.sent', 'desktopActionsRevoked'] };
    report.offlineStop = offlineRecord;
    const offlineToken = marker + '-OFFLINE-STOP';
    const offlineRequest = await sendFromUI(`Write a substantive 1,500-word practical guide to making a home office comfortable and useful over time. Use ten sections with several detailed paragraphs and specific examples in each. Begin the first sentence with ${offlineToken}, then immediately continue with the actual guide; do not respond with only the token or a short summary. Give the guide itself, without tools, file access, screenshots, desktop interaction, or settings changes.`, 'offline-stop-send', {
      onRun(run) {
        assert.ok(!terminal.has(run.status) && c.state.busy && c.t3InFlight, 'The extra real request completed before offline Stop could be observed');
        const client = c.t3, socket = client?.socket;
        assert.equal(socket?.readyState, 1, 'The offline Stop scenario requires the actual open app-client socket');
        Object.assign(offlineRecord, { runId: run.id, threadId: c.t3ThreadId, messageId: run.userMessageId,
          disconnectedAt: Date.now(), preDisconnect: report.stateTransitions.at(-1), transitionStart: report.stateTransitions.length });
        const watch = { record: offlineRecord, client, socket, runId: run.id, stopPromise: null };
        watch.closedListener = () => { offlineRecord.socketClosed = true; };
        offlineStopWatch = watch;
        socket.once('close', watch.closedListener);
        // Only this app client's transport is interrupted. The real daemon and
        // the model run continue until the queued production Stop is replayed.
        socket.terminate();
      },
    });
    const offlineWatch = offlineStopWatch;
    assert.ok(offlineWatch, 'The offline Stop observation was not armed');
    await until(() => offlineWatch.stopPromise, 10000, 'The app did not expose reconnecting state for the offline Stop action');
    await offlineWatch.stopPromise;
    if (offlineWatch.stopError) throw offlineWatch.stopError;
    await until(() => offlineRecord.offlineAfterStop, 5000, 'Offline Stop did not immediately retain a stopping intent');
    const offlineState = offlineRecord.offlineAfterStop;
    check('offline-stop-immediate', 'Offline Stop immediately blocks actions and retains the accepted request identity',
      offlineRecord.stopUI?.clicked && offlineState.desktopActionsRevoked && offlineState.busy && offlineState.stopping &&
      offlineState.activity !== 'Ready' && offlineState.connection !== 'connected' &&
      offlineState.t3StopIntent?.threadId === offlineRecord.threadId && offlineState.t3StopIntent?.messageId === offlineRecord.messageId &&
      offlineState.t3StopIntent?.runId === offlineRequest.runId && Number.isFinite(offlineState.t3StopIntent?.requestedAt),
      'real-transport-ui', { stopQueuedAt: offlineRecord.stopQueuedAt, observed: offlineState });
    const savedIntent = await until(async () => {
      try { const saved = JSON.parse(await readFile(join(c.dataDir, 't3-runtime.json'), 'utf8')); return saved.stopIntent?.runId === offlineRequest.runId ? intentSnapshot(saved.stopIntent) : false; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 5000, 'The offline Stop intent was not persisted before automatic recovery');
    offlineRecord.persistedStopIntent = savedIntent;
    await snapshot('05b-offline-stop-pending.png');
    await until(() => c.state.connection === 'connected' && c.t3 !== offlineWatch.client && c.t3?.socket?.readyState === 1 &&
      !c.state.busy && !c.state.stopping && !c.t3InFlight && !c.t3StopIntent, 60000, 'The saved offline Stop was not reconciled to a confirmed terminal state');
    offlineRecord.reconnectedAt = Date.now();
    const offlineProjection = await projection(), offlineRun = offlineProjection.runs?.find(run => run.id === offlineRequest.runId);
    assert.ok(offlineRun, 'The offline request is absent from the recovered canonical projection');
    const offlineInterrupt = (offlineProjection.turnItems ?? []).find(item => item.runId === offlineRequest.runId && item.type === 'run_interrupt_request');
    const offlineInterruptAt = Date.parse(offlineInterrupt?.startedAt ?? offlineInterrupt?.createdAt ?? offlineInterrupt?.completedAt);
    const offlineCompletedAt = Date.parse(offlineRun.completedAt);
    const offlineAttempts = new Set((offlineProjection.attempts ?? []).filter(attempt => attempt.runId === offlineRequest.runId).map(attempt => attempt.id));
    const offlineTurns = (offlineProjection.providerTurns ?? []).filter(turn => offlineAttempts.has(turn.runAttemptId));
    const offlineCancelled = cancelled.has(offlineRun.status) || offlineTurns.some(turn => cancelled.has(turn.status));
    const naturalBeforeReplay = offlineRun.status === 'completed' && !offlineCancelled && (!offlineInterrupt ||
      (Number.isFinite(offlineCompletedAt) && Number.isFinite(offlineInterruptAt) && offlineCompletedAt <= offlineInterruptAt));
    const replayed = !!offlineInterrupt && Number.isFinite(offlineInterruptAt) && offlineInterruptAt >= savedIntent.requestedAt;
    Object.assign(offlineRecord, { postRecovery: report.stateTransitions.at(-1), runStatus: offlineRun.status,
      runCompletedAt: offlineRun.completedAt ?? null, interruptItemId: offlineInterrupt?.id ?? null,
      interruptRequestedAt: offlineInterrupt?.startedAt ?? null, replayObserved: replayed, cancellationObserved: offlineCancelled,
      providerStatuses: offlineTurns.map(turn => turn.status) });
    const offlineTransitions = report.stateTransitions.slice(offlineRecord.transitionStart);
    const offlineConnected = offlineTransitions.filter(state => state.connection === 'connected');
    check('offline-connected-truth', 'Recovery reports connected only with its replacement client and open socket',
      offlineRecord.socketClosed && c.t3 !== offlineWatch.client && offlineConnected.length > 0 &&
      offlineConnected.every(state => state.clientPresent && state.clientSocketOpen), 'real-transport', { connectedTransitions: offlineConnected.length });
    check('offline-no-premature-ready', 'Ready appears only after the offline request is canonically terminal and Stop intent is cleared',
      terminal.has(offlineRun.status) && offlineRecord.readyTransitions.length > 0 &&
      offlineRecord.readyTransitions.every(state => state.connection === 'connected' && state.clientSocketOpen &&
        !state.busy && !state.stopping && !state.t3StopIntent && terminal.has(state.monitoredRunStatus)),
      'real-transport-ui', { readyTransitions: offlineRecord.readyTransitions });
    await bounded(c.t3SaveQueue ?? Promise.resolve(), 5000, 'The cleared Stop intent was not saved');
    const savedAfterStop = JSON.parse(await readFile(join(c.dataDir, 't3-runtime.json'), 'utf8'));
    check('offline-stop-intent-cleared', 'Confirmed terminal recovery clears the persisted Stop intent while desktop actions remain blocked',
      !savedAfterStop.stopIntent && !c.t3StopIntent && c.desktopActionsRevoked === true && !offlineProjection.thread?.activeRunId,
      'real-transport-ui', { runStatus: offlineRun.status, stopIntent: null, desktopActionsRevoked: c.desktopActionsRevoked });
    if (naturalBeforeReplay) {
      offlineRecord.outcome = 'not-exercised';
      offlineRecord.reason = 'The real request completed while disconnected, before the stop replay could interrupt it.';
      report.checks.push({ id: 'offline-stop-replay', name: 'Replay the offline Stop intent against an active runtime request', status: 'not-exercised',
        kind: 'real-transport-model', reason: offlineRecord.reason, evidence: { runId: offlineRequest.runId, runStatus: offlineRun.status,
          runCompletedAt: offlineRecord.runCompletedAt, interruptRequestedAt: offlineRecord.interruptRequestedAt } });
      report.limitations.push('Offline stop replay has an observational gap: the request completed before recovery, so this scenario does not count as a replay/cancellation pass.');
    } else {
      check('offline-stop-replay', 'The replacement client replays Stop and confirms the canonical terminal request',
        replayed && terminal.has(offlineRun.status), 'real-transport-model', { runId: offlineRequest.runId, runStatus: offlineRun.status,
          interruptItemId: offlineRecord.interruptItemId, interruptRequestedAt: offlineRecord.interruptRequestedAt, cancellationObserved: offlineCancelled });
      offlineRecord.outcome = 'replayed-and-confirmed'; offlineStopAccepted = true;
    }
    Object.assign(offlineRequest.entry, { status: offlineRun.status, offlineStopOutcome: offlineRecord.outcome, cancelled: offlineCancelled });
    await snapshot('05c-offline-stop-recovered.png');
    offlineWatch.socket.off('close', offlineWatch.closedListener); offlineStopWatch = null;

    phase = 'post-cancellation-request';
    const finalToken = marker + '-RECOVERED';
    const followup = await sendFromUI(`Text-only session verification. Do not use tools. Reply with exactly this token and nothing else: ${finalToken}`, 'recovery-send');
    await completed(followup, finalToken);
    await snapshot('06-usable-recovered-session.png');
    await until(() => bounded(bubble.webContents.executeJavaScript(`window.hephaestusBubbleInspect().renderedText.includes(${JSON.stringify(finalToken)})`), 5000, 'The answer bubble did not answer'),
      5000, 'The real recovered answer did not reach the answer bubble');
    await snapshot('07-recovered-answer-bubble.png', bubble);
    check('session-clean', 'The recovered session is connected and ready with sharing disabled',
      c.state.connection === 'connected' && !c.state.busy && !c.state.stopping && !c.state.sendPending && !c.t3InFlight && c.confirmation === null && !c.state.error && !c.state.stopPersistenceError && !c.t3StopPersistenceDirty && !stopCacheFault,
      'real-transport-ui', { connection: c.state.connection, busy: c.state.busy, stopping: c.state.stopping });
    check('offline-stop-replay-required', 'The offline Stop scenario supplied actual replay evidence', offlineStopAccepted,
      'real-transport-model', { outcome: offlineRecord.outcome, replayObserved: offlineRecord.replayObserved });
    assertPrivate(); report.success = true;
  } catch (error) {
    report.failure = { phase, message: safeError(error) };
    console.error('SESSION_CHECK failed during ' + phase + ': ' + safeError(error));
  } finally {
    cancellationTarget = null;
    if (offlineStopWatch) { offlineStopWatch.socket.off('close', offlineStopWatch.closedListener); offlineStopWatch = null; }
    if (allowCleanup) {
      try { await removeStopCacheFault(true); }
      catch (error) { report.cleanupError = safeError(error); report.success = false; }
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
      } catch (error) { report.cleanupError = [report.cleanupError, safeError(error)].filter(Boolean).join('; '); report.success = false; }
      report.finalState = { connection: c.state.connection, busy: c.state.busy === true, stopping: c.state.stopping === true,
        sendPending: c.state.sendPending === true, confirmationPending: !!c.confirmation, watching: c.state.watching === true,
        backgroundVision: c.state.backgroundVision === true, proactive: c.state.proactive === true,
        stopPersistenceError: c.state.stopPersistenceError ?? null, stopPersistenceDirty: c.t3StopPersistenceDirty === true, stopFaultDirectoryOwned: stopCacheFault?.owned === true };
      if (report.finalState.connection !== 'connected' || report.finalState.busy || report.finalState.stopping || report.finalState.sendPending || report.finalState.confirmationPending || report.finalState.watching || report.finalState.backgroundVision || report.finalState.proactive || report.finalState.stopPersistenceError || report.finalState.stopPersistenceDirty || report.finalState.stopFaultDirectoryOwned) report.success = false;
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
