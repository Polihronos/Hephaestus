import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';
import {preserveFailedVoiceInput} from '../src/input-recovery.js';
import {createDictation} from '../ui/dictation.js';

test('unaccepted Wispr text is saved exactly as a recoverable failed request',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hephaestus-voice-recovery-'));
  try{
    const c=new Companion({root:process.cwd(),dataDir:dir}),text='  Запази целия текст.\n';
    await preserveFailedVoiceInput(c,{text,source:'wispr',error:new Error('Not connected'),startedAt:Date.now()});
    const saved=JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).messages;
    assert.equal(saved.length,1);assert.equal(saved[0].text,text);assert.equal(saved[0].delivery,'failed');assert.equal(saved[0].source,'wispr');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('an existing failed voice request is not recorded twice',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.save=async()=>{};
  const startedAt=Date.now(),message=c.message('user','Keep this',{source:'wispr',delivery:'failed'});
  assert.equal(await preserveFailedVoiceInput(c,{text:'Keep this',source:'wispr',error:new Error('Failed'),startedAt}),message);
  assert.equal(c.messages.length,1);
});

test('a later intentional retry remains separate from an older failed request',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.save=async()=>{};
  c.messages=[{id:'older',role:'user',source:'wispr',text:'Same words',delivery:'failed',at:1}];
  await preserveFailedVoiceInput(c,{text:'Same words',source:'wispr',error:new Error('Failed'),startedAt:2});
  assert.equal(c.messages.length,2);
});

test('a recovered hidden input clears only the exact persisted draft',()=>{
  const input=new EventTarget();input.value='Recovered words';input.focus=()=>{};
  const dictation=createDictation(input,async()=>{});
  dictation.event('dictationRecovered',{text:'Recovered words'});assert.equal(input.value,'');
  input.value='A newer draft';dictation.event('dictationRecovered',{text:'Recovered words'});assert.equal(input.value,'A newer draft');
});

test('failed persistence leaves the renderer draft available for recovery',async()=>{
  const c=new Companion({root:process.cwd(),dataDir:process.cwd()});c.save=async()=>{throw new Error('Disk unavailable');};
  await assert.rejects(preserveFailedVoiceInput(c,{text:'Still in memory',source:'wispr',error:new Error('Failed'),startedAt:Date.now()}),/Disk unavailable/);
  assert.equal(c.messages[0].text,'Still in memory');assert.equal(c.messages[0].delivery,'failed');
});
