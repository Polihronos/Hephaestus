import test from 'node:test';
import assert from 'node:assert/strict';
import {fastCommand,coordinates,validateAction,screenDifference} from '../src/commands.js';
import {VoiceActivity} from '../ui/audio-utils.js';

test('only unambiguous short commands use the immediate path',()=>{
  assert.equal(fastCommand('Go to the next tab.')?.key,'Ctrl+Tab');
  assert.equal(fastCommand('Please click here.')?.atCursor,true);
  assert.equal(fastCommand('Explain what the next tab does'),null);
  assert.equal(fastCommand('Do not click here'),null);
  assert.equal(fastCommand('Stop now!')?.kind,'stop');
});
test('screen coordinates map correctly on a scaled display with a negative origin',()=>{
  const f={width:1440,height:810,bounds:{x:-3840,y:0,width:3840,height:2160}};
  assert.deepEqual(coordinates(f,720,405),{screenX:-1920,screenY:1080});
  assert.throws(()=>coordinates(f,1440,20));assert.throws(()=>coordinates(f,NaN,20));
});
test('actions cannot introduce arbitrary executables or unsupported shortcuts',()=>{
  assert.throws(()=>validateAction({kind:'shell',text:'anything'}));
  assert.throws(()=>validateAction({kind:'key',key:'Win+R'}));
  assert.throws(()=>validateAction({kind:'type',text:'a'.repeat(8001)}));
  assert.equal(validateAction({kind:'key',key:'Ctrl+Tab'}).kind,'key');
});
test('screen change comparison avoids sending unchanged frames',()=>{
  assert.equal(screenDifference(Buffer.from([40,50]),Buffer.from([40,50])),0);
  assert.equal(screenDifference(Buffer.from([20,40]),Buffer.from([30,50])),10);
});
test('continuous VAD waits for speech and emits a complete utterance after silence',()=>{
  let starts=0,audio;const vad=new VoiceActivity({onStart:()=>starts++,onEnd:a=>audio=a});
  const frame=new Float32Array(320);
  for(let i=0;i<50;i++)vad.push(frame,.001);
  assert.equal(starts,0);
  for(let i=0;i<20;i++)vad.push(frame,.04);
  assert.equal(starts,1);assert.equal(audio,undefined);
  for(let i=0;i<25;i++)vad.push(frame,.001);
  assert.ok(audio instanceof Float32Array);assert.ok(audio.length>=20*320);assert.equal(vad.active,false);
});
test('short clicks/coughs do not become speech requests',()=>{
  let ended=0;const vad=new VoiceActivity({onEnd:()=>ended++});const frame=new Float32Array(320);
  for(let i=0;i<3;i++)vad.push(frame,.04);for(let i=0;i<30;i++)vad.push(frame,.001);
  assert.equal(ended,0);
});

test('a short noise releases the speech interruption state',()=>{
 let hearing=false;const vad=new VoiceActivity({onStart:()=>hearing=true,onCancel:()=>hearing=false});const frame=new Float32Array(320);for(let i=0;i<3;i++)vad.push(frame,.04);assert.equal(hearing,true);for(let i=0;i<30;i++)vad.push(frame,.001);assert.equal(hearing,false);
});
