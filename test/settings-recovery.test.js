import test from 'node:test';
import assert from 'node:assert/strict';
import {Companion} from '../src/companion.js';

test('instruction edits during recovery are rejected without changing active or saved settings',async()=>{
 for(const connection of['connecting','reconnecting']){
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});
  Object.assign(c.state,{connection,prompt:'Current instructions',busy:true,stopping:true});
  let replaced=0,saved=0;c.replacePrompt=async()=>replaced++;c.save=async()=>saved++;
  await assert.rejects(c.configure({prompt:'Edited instructions',spokenReplies:true}),/connection to recover/);
  assert.equal(c.state.prompt,'Current instructions');assert.equal(c.state.spokenReplies,false);assert.equal(replaced,0);assert.equal(saved,0);
 }
});

test('a failed connected instruction replacement preserves all configuration for retry',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',prompt:'Current instructions',running:false});
 let saved=0;c.save=async()=>saved++;c.replacePrompt=async()=>{throw new Error('Still stopping');};
 await assert.rejects(c.configure({prompt:'Edited instructions'}),/Still stopping/);
 assert.equal(c.state.prompt,'Current instructions');assert.equal(saved,0);
 let applied;c.replacePrompt=async(prompt,{persist})=>{applied=prompt;await persist();};await c.configure({prompt:'Edited instructions'});
 assert.equal(applied,'Edited instructions');assert.equal(c.state.prompt,'Edited instructions');assert.equal(saved,1);
});

test('instruction persistence uses the complete next settings once before applying them',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',prompt:'Current instructions',running:false});
 const writes=[];c.save=async options=>writes.push(options);c.replacePrompt=async(prompt,{persist})=>{assert.equal(c.state.prompt,'Current instructions');assert.equal(c.state.spokenReplies,false);await persist({threadId:'replacement-thread'});};
 await c.configure({prompt:'Edited instructions',spokenReplies:true,opacity:.7});
 assert.equal(writes.length,1);assert.equal(writes[0].threadId,'replacement-thread');assert.equal(writes[0].settings.prompt,'Edited instructions');assert.equal(writes[0].settings.spokenReplies,true);assert.equal(writes[0].settings.opacity,.7);assert.equal(c.state.prompt,'Edited instructions');assert.equal(c.state.spokenReplies,true);assert.equal(c.state.instructionsSaving,false);
});

test('messages and another instruction save cannot start while durable instruction persistence is pending',async()=>{
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()});Object.assign(c.state,{connection:'connected',prompt:'Current instructions',running:false});
 let release,entered,saved=0,interrupted=0,dispatched=0;const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve);
 c.save=async()=>{saved++;entered();await gate;};c.replacePrompt=async(_prompt,{persist})=>persist();c.interrupt=async()=>interrupted++;c.turn=async()=>dispatched++;
 const update=c.configure({prompt:'Edited instructions'});
 try{
  await waiting;assert.equal(c.state.instructionsSaving,true);assert.equal(c.state.prompt,'Current instructions');
  await assert.rejects(c.submit('A new question'),/Instructions are still being saved/);
  await assert.rejects(c.submit('next tab'),/Instructions are still being saved/);
  await assert.rejects(c.configure({prompt:'Another edit'}),/already being saved/);
  assert.equal(c.messages.length,0);assert.equal(interrupted,0);assert.equal(dispatched,0);assert.equal(saved,1);
 }finally{release();await update;}
 assert.equal(c.state.instructionsSaving,false);assert.equal(c.state.prompt,'Edited instructions');
});
