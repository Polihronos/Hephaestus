import test from 'node:test';
import assert from 'node:assert/strict';
import {createListener} from '../ui/listener.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function drain(){for(let i=0;i<4;i++)await tick();}
const initial={inputMode:'always',running:true,inputDevice:'default',speech:'ready',dictating:false,voiceEpoch:0};

// These labelled media/WebAudio doubles deliver synthetic frames to the real
// listener and VoiceActivity; no browser, microphone, or recognizer is opened.
async function fixture(run){
 const names=['navigator','AudioContext','AudioWorkletNode'];
 const originals=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const events=[],streams=[],contexts=[],captures=[],mediaCalls=[],mediaPlan=[],resumePlan=[],gates=[];
 const makeStream=label=>{
  const stream={label,active:true};
  const track={stopCalls:0,stop(){this.stopCalls++;stream.active=false;},getSettings:()=>({echoCancellation:'all'})};
  Object.assign(stream,{track,getTracks:()=>[track],getAudioTracks:()=>[track]});streams.push(stream);return stream;
 };
 const gate=fallback=>{let resolve;const promise=new Promise(done=>resolve=done),entry={promise,resolve:result=>resolve(result),fallback};gates.push(entry);return entry;};
 const makeNode=()=>({connections:[],disconnectCalls:0,connect(target){this.connections.push(target);},disconnect(){this.disconnectCalls++;}});
 class FakeAudioContext{
  constructor({sampleRate}){this.sampleRate=sampleRate;this.destination={};this.sources=[];this.closeCalls=0;this.audioWorklet={addModule:async()=>{}};contexts.push(this);}
  async resume(){await resumePlan.shift();}
  createMediaStreamSource(stream){const node=Object.assign(makeNode(),{stream});this.sources.push(node);return node;}
  async close(){this.closeCalls++;}
 }
 class FakeAudioWorkletNode{
  constructor(context,name){Object.assign(this,makeNode(),{context,name,port:{}});captures.push(this);}
 }
 const globals={navigator:{mediaDevices:{async getUserMedia(constraints){const call={constraints};mediaCalls.push(call);call.stream=await(mediaPlan.length?mediaPlan.shift():makeStream(`synthetic-stream-${mediaCalls.length}`));return call.stream;}}},AudioContext:FakeAudioContext,AudioWorkletNode:FakeAudioWorkletNode};
 for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:globals[name]});
 const listener=createListener(async(command,params)=>{events.push({command,params});});
 try{await run({listener,events,streams,contexts,captures,mediaCalls,mediaPlan,resumePlan,makeStream,gate});}
 finally{
  try{
   listener.stop();for(const pending of gates)pending.resolve(pending.fallback);await drain();listener.stop();
   for(const stream of streams)stream.track.stop();for(const context of contexts)await context.close();
  }finally{for(const name of names){const descriptor=originals.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
 }
}

const frames=(capture,count,value,rms=value)=>{for(let i=0;i<count;i++)capture.port.onmessage({data:{samples:new Float32Array(320).fill(value),rms}});};
const utterance=(capture,value=.04)=>{frames(capture,10,value);frames(capture,33,.001);};
const audioEvents=events=>events.filter(event=>event.command==='audio');
const sample=value=>new Float32Array([value])[0];

test('real listener binds synthetic utterances to the capture epoch and drops old worklet callbacks',()=>fixture(async({listener,events,captures,streams,contexts})=>{
 listener.configure(initial);await drain();assert.equal(captures.length,1);const old=captures[0];
 frames(old,3,.04);frames(old,33,.001);
 assert.deepEqual(events.filter(event=>event.command==='voice-idle').map(event=>event.params.epoch),[0]);
 utterance(old);assert.equal(audioEvents(events).length,1);assert.equal(audioEvents(events)[0].params.epoch,0);
 assert.equal(new Float32Array(audioEvents(events)[0].params.audio)[0],sample(.04));
 frames(old,10,.05);listener.configure({...initial,voiceEpoch:1});await drain();
 assert.equal(streams[0].active,false);assert.ok(contexts[0].closeCalls>0);assert.equal(captures.length,2);
 utterance(old,.09);frames(captures[1],33,.001);
 assert.equal(audioEvents(events).length,1,'Neither a detached callback nor a reset partial utterance may dispatch audio.');
 utterance(captures[1],.06);
 assert.deepEqual(audioEvents(events).map(event=>event.params.epoch),[0,1]);
 const fresh=new Float32Array(audioEvents(events)[1].params.audio);
 assert.ok(fresh.includes(sample(.06)));assert.ok(fresh.every(value=>value===sample(.06)||value===sample(.001)));
 assert.deepEqual(events.filter(event=>event.command==='voice-start').map(event=>event.params.epoch),[0,0,0,1]);
}));

test('dictation closes listening and calibration resources, then resumes a fresh capture',()=>fixture(async({listener,events,captures,streams,contexts,mediaCalls})=>{
 listener.configure(initial);await drain();await listener.beginCalibration();const oldClean=captures[0],oldRaw=captures[1];
 frames(oldClean,10,.04);frames(oldRaw,1,.03);
 listener.configure({...initial,dictating:true,voiceEpoch:1});await drain();
 assert.equal(mediaCalls.length,2,'Dictation must not open another always-on stream.');
 assert.ok(streams.every(stream=>!stream.active));assert.ok(contexts[0].closeCalls>0);
 assert.ok(oldClean.disconnectCalls>0);assert.ok(oldRaw.disconnectCalls>0);
 assert.ok(contexts[0].sources.every(source=>source.disconnectCalls>0));
 assert.equal(listener.finishCalibration(),null);assert.equal(listener.inspect().microphoneActive,false);
 utterance(oldClean,.09);frames(oldRaw,1,.09);assert.equal(audioEvents(events).length,0);
 listener.configure({...initial,voiceEpoch:2});await drain();assert.equal(mediaCalls.length,3);
 utterance(captures[2],.06);assert.deepEqual(audioEvents(events).map(event=>event.params.epoch),[2]);
}));

test('speech becoming unavailable resets a voiced fragment and idles its captured epoch without restarting capture',()=>fixture(async({listener,events,captures,mediaCalls})=>{
 listener.configure({...initial,voiceEpoch:7});await drain();const capture=captures[0];
 frames(capture,10,.04);assert.deepEqual(events.filter(event=>event.command==='voice-start').map(event=>event.params.epoch),[7]);
 listener.configure({...initial,voiceEpoch:7,speech:'loading'});frames(capture,1,.04);
 assert.equal(mediaCalls.length,1);assert.equal(captures.length,1);
 assert.deepEqual(events.filter(event=>event.command==='voice-idle').map(event=>event.params.epoch),[7]);
 listener.configure({...initial,voiceEpoch:7});frames(capture,33,.001);
 assert.equal(audioEvents(events).length,0,'The interrupted synthetic fragment must not dispatch after speech becomes ready again.');
}));

test('a delayed old getUserMedia result is stopped without replacing the newer epoch capture',()=>fixture(async({listener,events,captures,streams,mediaCalls,mediaPlan,makeStream,gate})=>{
 const old=makeStream('delayed-old-synthetic-stream'),pending=gate(old);mediaPlan.push(pending.promise);
 listener.configure(initial);await drain();assert.equal(captures.length,0);
 listener.configure({...initial,voiceEpoch:1});await drain();assert.equal(captures.length,1);const fresh=mediaCalls[1].stream;
 pending.resolve(old);await drain();assert.equal(old.active,false);assert.equal(fresh.active,true);
 assert.equal(captures.length,1);assert.equal(streams.filter(stream=>stream.active).length,1);
 utterance(captures[0],.06);assert.deepEqual(audioEvents(events).map(event=>event.params.epoch),[1]);
}));

test('a suspended old AudioContext cannot attach capture after a newer epoch starts',()=>fixture(async({listener,events,captures,contexts,streams,resumePlan,gate})=>{
 const pending=gate();resumePlan.push(pending.promise);listener.configure(initial);await drain();
 assert.equal(contexts.length,1);assert.equal(captures.length,0);
 listener.configure({...initial,voiceEpoch:1});await drain();assert.equal(captures.length,1);
 pending.resolve();await drain();assert.equal(captures.length,1);assert.equal(contexts[0].sources.length,0);
 assert.equal(streams[0].active,false);assert.ok(contexts[0].closeCalls>0);
 utterance(captures[0],.06);assert.deepEqual(audioEvents(events).map(event=>event.params.epoch),[1]);
}));

test('delayed calibration media is rejected and stopped when dictation ends its owning session',()=>fixture(async({listener,captures,mediaPlan,makeStream,gate})=>{
 listener.configure(initial);await drain();const raw=makeStream('delayed-raw-synthetic-stream'),pending=gate(raw);mediaPlan.push(pending.promise);
 const calibrating=listener.beginCalibration();const rejected=assert.rejects(calibrating,/microphone session ended/i);
 listener.configure({...initial,dictating:true,voiceEpoch:1});pending.resolve(raw);await rejected;await drain();
 assert.equal(raw.active,false);assert.equal(captures.length,1);assert.equal(listener.finishCalibration(),null);
 listener.configure({...initial,voiceEpoch:2});await drain();assert.equal(captures.length,2);
}));

test('a detached raw calibration callback cannot contaminate a newer calibration',()=>fixture(async({listener,captures})=>{
 listener.configure(initial);await drain();await listener.beginCalibration();const oldRaw=captures[1];
 listener.configure({...initial,dictating:true,voiceEpoch:1});listener.configure({...initial,voiceEpoch:2});await drain();
 await listener.beginCalibration();const freshRaw=captures[3];
 frames(oldRaw,1,.09);frames(freshRaw,1,.02);
 const result=listener.finishCalibration();assert.equal(result.raw.samples,320);
 const samples=new Float32Array(Uint8Array.from(Buffer.from(result.raw.audio,'base64')).buffer);
 assert.ok(samples.every(value=>value===sample(.02)),'Only the current synthetic calibration signal belongs in its result.');
}));
