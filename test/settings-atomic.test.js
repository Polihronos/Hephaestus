import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
const disk=c=>readFile(join(c.dataDir,'settings.json'),'utf8').then(JSON.parse);
async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-settings-atomic-'));
 const c=new Companion({root:process.cwd(),dataDir:directory});Object.assign(c.state,{connection:'connected',running:false,watching:false,prompt:'Local filesystem test instructions'});
 c.interrupt=async()=>{c.interruptions=(c.interruptions??0)+1;};c.sample=async()=>{};c.startSpeech=async()=>{};
 try{await c.save();await run(c);}
 finally{await c.configureQueue?.catch(()=>{});await c.saveQueue?.catch(()=>{});await rm(directory,{recursive:true,force:true});}
}

test('a rejected enable cannot leak into active settings or a later unrelated save',()=>fixture(async c=>{
 const original=await readFile(join(c.dataDir,'settings.json'),'utf8');await mkdir(join(c.dataDir,'settings.tmp'));
 await assert.rejects(c.configure({spokenReplies:true}),/settings could not be saved/);
 assert.equal(c.state.spokenReplies,false);assert.equal(await readFile(join(c.dataDir,'settings.json'),'utf8'),original);
 await rm(join(c.dataDir,'settings.tmp'),{recursive:true});await c.configure({opacity:.7});
 assert.equal(c.state.opacity,.7);assert.equal(c.state.spokenReplies,false);assert.equal((await disk(c)).spokenReplies,false);assert.equal((await disk(c)).opacity,.7);
}));

test('a queued enable stays inactive until its real file commit succeeds',()=>fixture(async c=>{
 const gate=deferred();c.saveQueue=gate.promise;const updating=c.configure({spokenReplies:true});
 try{await tick();assert.equal(c.state.spokenReplies,false);assert.equal((await disk(c)).spokenReplies,false);}
 finally{gate.resolve();await updating;}
 assert.equal(c.state.spokenReplies,true);assert.equal((await disk(c)).spokenReplies,true);
}));

test('concurrent settings and an incidental queued save preserve every committed field',()=>fixture(async c=>{
 const gate=deferred();c.saveQueue=gate.promise;const first=c.configure({spokenReplies:true});await tick();
 const incidental=c.save(),second=c.configure({opacity:.65}),third=c.configure({opacity:.8,backgroundInterval:45000});
 gate.resolve();await Promise.all([first,incidental,second,third]);
 const saved=await disk(c);for(const[key,value]of Object.entries({spokenReplies:true,opacity:.8,backgroundInterval:45000})){assert.equal(c.state[key],value);assert.equal(saved[key],value);}
}));

test('failed privacy and microphone reductions stay active with explicit unsaved guidance',()=>fixture(async c=>{
 Object.assign(c.state,{running:true,watching:true,control:true,inputMode:'always',spokenReplies:true,excludedApps:['original'],backgroundVision:true,proactive:true,autoSend:true});await c.save();
 c.voiceAudioQueue=['old audio'];const epoch=c.voiceEpoch??0,until=Date.now()+60000;await mkdir(join(c.dataDir,'settings.tmp'));
 const update=c.configure({watching:false,control:false,inputMode:'wispr',spokenReplies:false,excludedApps:['private.exe'],backgroundVision:false,proactive:false,autoSend:false,noticeSnoozeUntil:until});
 assert.equal(c.state.watching,false);assert.equal(c.state.control,false);assert.equal(c.state.inputMode,'wispr');assert.equal(c.state.spokenReplies,false);assert.deepEqual(c.state.excludedApps,['original','private']);assert.ok(c.voiceEpoch>epoch);assert.deepEqual(c.voiceAudioQueue,[]);assert.equal(c.interruptions,1);
 await assert.rejects(update,/remain active for this session, but were not saved/);assert.match(c.state.error,/Retry before restarting/);
 const before=await disk(c);assert.equal(before.watching,true);assert.equal(before.control,true);assert.equal(before.inputMode,'always');assert.deepEqual(before.excludedApps,['original']);
 await rm(join(c.dataDir,'settings.tmp'),{recursive:true});await c.configure({opacity:.6});
 const saved=await disk(c);assert.equal(saved.watching,false);assert.equal(saved.control,false);assert.equal(saved.inputMode,'wispr');assert.equal(saved.spokenReplies,false);assert.equal(saved.backgroundVision,false);assert.equal(saved.proactive,false);assert.equal(saved.autoSend,false);assert.equal(saved.noticeSnoozeUntil,until);assert.deepEqual(saved.excludedApps,['original','private']);assert.equal(c.state.error,null);
}));

test('failed removal of a private app cannot authorize its screen or silently enable speech',()=>fixture(async c=>{
 c.state.excludedApps=['private'];await c.save();await mkdir(join(c.dataDir,'settings.tmp'));
 await assert.rejects(c.configure({excludedApps:[],spokenReplies:true}),/were not saved/);
 assert.deepEqual(c.state.excludedApps,['private']);assert.equal(c.state.spokenReplies,false);assert.deepEqual((await disk(c)).excludedApps,['private']);
 await rm(join(c.dataDir,'settings.tmp'),{recursive:true});await c.configure({opacity:.75});assert.deepEqual((await disk(c)).excludedApps,['private']);assert.equal((await disk(c)).spokenReplies,false);
}));

test('emergency pause revokes immediately while another settings save is pending',()=>fixture(async c=>{
 c.state.running=true;c.state.inputMode='always';c.voiceAudioQueue=['queued'];const epoch=c.voiceEpoch??0;
 const gate=deferred();c.saveQueue=gate.promise;const updating=c.configure({opacity:.7});await tick();
 let paused=false;const pausing=c.configure({running:false}).then(()=>paused=true);
 try{assert.equal(c.state.running,false);assert.ok(c.voiceEpoch>epoch);assert.deepEqual(c.voiceAudioQueue,[]);assert.equal(c.interruptions,1);await tick();assert.equal(paused,true);assert.equal(c.state.opacity,1);}
 finally{gate.resolve();await Promise.all([updating,pausing]);}
 assert.equal(c.state.running,false);assert.equal(c.state.opacity,.7);assert.equal((await disk(c)).opacity,.7);
}));

test('a revoke arriving at the real commit boundary supersedes an older enable',()=>fixture(async c=>{
 const save=c.save.bind(c);let revoking;
 c.save=options=>save({...options,onSaved:settings=>{
  if(!revoking&&settings.watching===true){revoking=c.configure({watching:false});assert.equal(c.state.watching,false);}
  options?.onSaved?.(settings);
 }});
 await c.configure({watching:true});await revoking;
 assert.ok(revoking);assert.equal(c.state.watching,false);assert.equal((await disk(c)).watching,false);
}));
