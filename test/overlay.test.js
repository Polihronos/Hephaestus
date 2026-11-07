import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import{Companion,dynamicTools}from'../src/companion.js';
import{DictationSession,dictationDestination,readWisprShortcuts}from'../src/wispr.js';
import{validateAnnotation,framePoint}from'../src/annotations.js';

test('known editors retain dictation and the companion is the default elsewhere',()=>{
 assert.equal(dictationDestination({editable:true}),'external');assert.equal(dictationDestination({editable:null}),'companion');assert.equal(dictationDestination({editable:false}),'companion');assert.equal(dictationDestination({ownSettings:true,editable:false}),'external');assert.equal(dictationDestination({ownChat:true,editable:true}),'companion');
});
test('dictation requires an intentional shortcut and supports PTT and hands-free',()=>{
 const d=new DictationSession();assert.equal(d.active,false);assert.equal(d.key({phase:'start',at:1000}),'start');assert.equal(d.key({phase:'end',at:3000}),'finish');assert.equal(d.active,false);assert.equal(d.key({phase:'toggle',at:5000}),'start');assert.equal(d.sticky,true);assert.equal(d.key({phase:'toggle',at:7000}),'finish');assert.equal(d.key({phase:'cancel'}),'cancel');assert.equal(d.armed,false);
});
test('Caps Lock double tap enters hands-free and the next press ends it',()=>{
 const d=new DictationSession();d.key({phase:'start',at:1000});assert.equal(d.key({phase:'end',at:1100}),'tap');d.key({phase:'start',at:1200});assert.equal(d.sticky,true);assert.equal(d.key({phase:'end',at:1300}),'none');assert.equal(d.key({phase:'start',at:2200}),'finish');assert.equal(d.key({phase:'end',at:2300}),'none');
});
test('the actual Wispr configuration is read without transcript history or credentials',async()=>{const w=await readWisprShortcuts();assert.equal(w.found,true);assert.ok(w.bindings.some(b=>b.keys.includes(20)));assert.ok(w.labels.some(b=>b.label==='Caps Lock'));});
test('prompt saving replaces the sole app instruction with exactly the entered text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'companion-prompt-'));try{const c=new Companion({root:process.cwd(),dataDir:dir});Object.assign(c.state,{running:false,connection:'connected',prompt:'previous'});c.threadId='thread';let p;c.rpc={call:async(method,params)=>{if(method==='thread/start'){p=params;return {thread:{id:'new-thread'}};}return {};}};const prompt='You are my mathematics tutor. Use Greek when I ask.';await c.configure({prompt});assert.equal(p.baseInstructions,prompt);assert.equal(p.developerInstructions,'');assert.equal(p.config.project_doc_max_bytes,0);assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,prompt);}finally{await rm(dir,{recursive:true,force:true});}
});
test('vision, zoom, native app controls and spontaneous observations are exposed',()=>{assert.deepEqual(dynamicTools.map(t=>t.name),['screen_observe','screen_annotate','move_attention','screen_zoom','screen_windows','screen_action','companion_notice']);});
test('annotation coordinates scale across monitors and invalid paths are rejected',()=>{const f={width:1920,height:1080,bounds:{x:-3840,y:0,width:3840,height:2160}};assert.deepEqual(framePoint(f,960,540),{x:-1920,y:1080});assert.throws(()=>validateAnnotation({kind:'arrow',x:0,y:0,x2:1921,y2:0},f));assert.throws(()=>validateAnnotation({kind:'path',x:0,y:0,points:[{x:NaN,y:3}]},f));assert.equal(validateAnnotation({kind:'circle',x:10,y:20,ttl:999999},f).ttl,60000);});
test('always-on capture requires system-wide cancellation and never mutes desktop audio',async()=>{const [r,m,b]=await Promise.all([readFile('ui/listener.js','utf8'),readFile('src/main.js','utf8'),readFile('ui/bubble.html','utf8')]);assert.match(r,/echoCancellation:\{exact:'all'\}/);assert.match(m,/contents===mascot.webContents/);assert.doesNotMatch(m,/audio-duck|audio-restore|quietPlayback/);assert.doesNotMatch(b,/<textarea|<input/);});
