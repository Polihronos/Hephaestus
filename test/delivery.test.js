import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictation } from '../ui/dictation.js';

class Input extends EventTarget {
  constructor(value) { super(); this.value = value; }
  focus() {}
}

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
