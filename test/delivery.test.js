import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictation } from '../ui/dictation.js';
import {userErrorMessage} from '../ui/errors.js';
import {Companion,MAX_MESSAGE_LENGTH} from '../src/companion.js';

class Input extends EventTarget {
  constructor(value) { super(); this.value = value; }
  focus() {}
}

test('Enter preserves an unfinished input-method composition until a later deliberate send', async () => {
  const input = new Input('  An unfinished composition'), sent = [];
  createDictation(input, async (command, params) => {
    sent.push({command, ...params});
    return {accepted:true};
  }, {manual:true});
  const enter = isComposing => {
    const event = new Event('keydown', {cancelable:true});
    Object.assign(event, {key:'Enter', shiftKey:false, isComposing});
    input.dispatchEvent(event);
    return event;
  };
  const commit = enter(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commit.defaultPrevented, false);
  assert.equal(sent.length, 0);
  assert.equal(input.value, '  An unfinished composition');
  input.value = '  A completed composition.\n';
  input.dispatchEvent(new Event('compositionend'));
  assert.equal(sent.length, 0);
  const send = enter(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(send.defaultPrevented, true);
  assert.deepEqual(sent, [{command:'send', text:'  A completed composition.\n', source:'text'}]);
  assert.equal(input.value, '');
});

test('double submit while acknowledgement is pending dispatches only once', async () => {
  const input = new Input('A real request');
  let sends = 0;
  let accept;
  const dictation = createDictation(input, async () => {
    sends++;
    return new Promise(resolve => { accept = resolve; });
  });
  const first = dictation.submit();
  await dictation.submit();
  assert.equal(sends, 1);
  assert.equal(input.value, 'A real request');
  accept({ accepted: true });
  await first;
  assert.equal(input.value, '');
});

test('dispatch rejection retains the exact input and permits retry', async () => {
  const input = new Input('Keep my words');
  let reject = true;
  let errors = 0;
  const dictation = createDictation(input, async () => {
    if (reject) throw new Error('Disconnected');
    return { accepted: true };
  }, { onError: () => errors++ });
  await dictation.submit();
  assert.equal(input.value, 'Keep my words');
  assert.equal(errors, 1);
  reject = false;
  await dictation.submit();
  assert.equal(input.value, '');
});

test('acceptance does not erase newer text entered while sending', async () => {
  const input = new Input('First message');
  let accept;
  const dictation = createDictation(input, () => new Promise(resolve => { accept = resolve; }));
  const send = dictation.submit();
  input.value = 'A new thought';
  accept({ accepted: true });
  await send;
  assert.equal(input.value, 'A new thought');
});

test('a pending send in another window prevents a second dispatch', async () => {
  const input = new Input('Another window');
  let sends = 0;
  const dictation = createDictation(input, async () => { sends++; });
  dictation.event('state', { sendPending: true });
  await dictation.submit();
  assert.equal(sends, 0);
  assert.equal(input.value, 'Another window');
});

test('transport error decoration is removed without losing actionable guidance',()=>{
  assert.equal(userErrorMessage(new Error("Error invoking remote method 'companion:request': Error: Enter executable process names, for example chrome.exe")),'Enter executable process names, for example chrome.exe');
  assert.equal(userErrorMessage(new RangeError('Shorten your message.')),'Shorten your message.');
  assert.equal(userErrorMessage('The window changed. Observe it again.'),'The window changed. Observe it again.');
});

test('oversized dictation retains its entire original text when the backend rejects it',async()=>{
  const raw='  '+ 'Я'.repeat(MAX_MESSAGE_LENGTH)+'\n',input=new Input(raw),c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  let failure;
  const dictation=createDictation(input,(_command,params)=>c.submit(params.text),{onError:error=>{failure=error;}});
  await dictation.submit('wispr');
  assert.equal(input.value,raw);assert.equal(failure.code,'MESSAGE_TOO_LONG');assert.equal(c.messages.length,0);
});

test('accepted input reaches the backend without losing formatting whitespace',async()=>{
  const raw='  an indented request\n',input=new Input(raw);let sent;
  const dictation=createDictation(input,async(_command,params)=>{sent=params.text;return{accepted:true};});
  await dictation.submit();assert.equal(sent,raw);assert.equal(input.value,'');
});
