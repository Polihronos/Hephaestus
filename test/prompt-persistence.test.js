import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';

test('an incidental save cannot overwrite a committed prompt while activation is finishing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hephaestus-prompt-save-'));
 try{
  const c=new Companion({root:process.cwd(),dataDir:dir});Object.assign(c.state,{connection:'connected',running:false,prompt:'Previous instructions'});
  let release,entered;const gate=new Promise(resolve=>release=resolve),persisted=new Promise(resolve=>entered=resolve);
  await c.save();c.replacePrompt=async(prompt,{persist})=>{await persist();entered();await gate;c.state.prompt=prompt;};
  const changing=c.configure({prompt:'New instructions'});await persisted;
  let incidentalDone=false;const incidental=c.save().then(()=>incidentalDone=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(incidentalDone,false);
  await assert.rejects(c.configure({spokenReplies:true}),/already being saved/);
  await c.configure({running:false});assert.equal(c.state.running,false);
  release();await changing;await incidental;
  assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).prompt,'New instructions');
  assert.equal(c.state.prompt,'New instructions');assert.equal(c.state.spokenReplies,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
