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
 let applied;c.replacePrompt=async prompt=>applied=prompt;await c.configure({prompt:'Edited instructions'});
 assert.equal(applied,'Edited instructions');assert.equal(c.state.prompt,'Edited instructions');assert.equal(saved,1);
});
