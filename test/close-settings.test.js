import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';

async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-close-settings-'));
 try{await run(new Companion({root:process.cwd(),dataDir:directory}),directory);}
 finally{await rm(directory,{recursive:true,force:true});}
}

test('quit drains an already accepted settings change before closing helpers without refreshing the screen',()=>fixture(async(c,directory)=>{
 const events=[];let entered,release;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),save=c.save.bind(c);
 c.interrupt=async()=>{};
 c.bridge={call:async()=>{events.push('capture');throw Error('No capture may start while quitting');},close:()=>events.push('helper closed')};
 c.save=async options=>{entered();await gate;await save(options);events.push('committed');};
 const changing=c.configure({opacity:.67});await started;
 let finished=false;const closing=c.close().then(()=>finished=true);
 try{await new Promise(resolve=>setImmediate(resolve));assert.equal(c.closed,true);assert.equal(finished,false);assert.deepEqual(events,[]);}
 finally{release();await changing;await closing;}
 assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).opacity,.67);
 assert.deepEqual(events,['committed','helper closed']);
}));

test('a failed last settings write still closes every helper while reporting the persistence failure',()=>fixture(async(c,directory)=>{
 c.state.running=false;c.interrupt=async()=>{};const closed=[];
 for(const name of ['rpc','speech','bridge'])c[name]={close:()=>closed.push(name)};
 await mkdir(join(directory,'settings.tmp'));
 await assert.rejects(c.configure({spokenReplies:true}),/settings could not be saved/);
 assert.equal(c.state.spokenReplies,false);
 await assert.rejects(c.close(),/settings could not be saved/);
 assert.deepEqual(closed,['rpc','speech','bridge']);assert.equal(c.closed,true);
}));
