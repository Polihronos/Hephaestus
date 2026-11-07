import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Companion} from '../src/companion.js';
import {KNOWN_PRIOR_DEFAULT_HASHES,promptHash,defaultPromptHash,migrateDefaultPrompt,readPromptSettings} from '../src/settings-migrations.js';

const previous='Previously shipped default.\nSecond paragraph.\n';
const current='Current shipped default.\nNew instructions.\n';
const known=[promptHash(previous)];
async function temporary(run){const dir=await mkdtemp(join(tmpdir(),'hephaestus-prompt-migration-'));try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('known previous defaults upgrade once and current defaults are idempotent',()=>{
 const first=migrateDefaultPrompt(previous,current,known);assert.equal(first.prompt,current);assert.equal(first.migrated,true);
 const again=migrateDefaultPrompt(first.prompt,current,known);assert.equal(again.prompt,current);assert.equal(again.migrated,false);
 assert.equal(KNOWN_PRIOR_DEFAULT_HASHES.length,1);assert.match(KNOWN_PRIOR_DEFAULT_HASHES[0],/^[a-f0-9]{64}$/);
});

test('only line-ending differences are normalized when identifying a shipped default',()=>{
 assert.equal(migrateDefaultPrompt(previous.replaceAll('\n','\r\n'),current,known).migrated,true);
 assert.equal(migrateDefaultPrompt(previous.replaceAll('\n','\r'),current,known).migrated,true);
 for(const custom of[previous+' ',previous.trimEnd(),previous.replace('shipped','personal'),previous.replace('Second','second')])assert.deepEqual(migrateDefaultPrompt(custom,current,known),{prompt:custom,migrated:false});
 const currentCrlf=current.replaceAll('\n','\r\n');assert.deepEqual(migrateDefaultPrompt(currentCrlf,current,known),{prompt:currentCrlf,migrated:false});
});

test('custom prompts remain byte-for-byte exact, including old prefix, whitespace and non-English text',()=>{
 for(const custom of['  Моите правила.\r\n  Καλημέρα.\n日本語\t\n','You are my spoken screen companion. My custom instructions.','', ' \r\n\t ']){
  const result=migrateDefaultPrompt(custom,current,known);assert.equal(result.migrated,false);assert.deepEqual(Buffer.from(result.prompt),Buffer.from(custom));assert.equal(defaultPromptHash(result.prompt,current),null);
 }
});

test('new installations initialize the default while invalid or uncertain prompt values fail safely',()=>{
 assert.deepEqual(migrateDefaultPrompt(undefined,current),{prompt:current,migrated:false});
 for(const invalid of[null,23,{},[]])assert.throws(()=>migrateDefaultPrompt(invalid,current),/left unchanged/);
 assert.throws(()=>migrateDefaultPrompt(previous,''),/left unchanged/);
});

test('settings loading never trusts a stale default hash marker to replace custom text',()=>temporary(async dir=>{
 const path=join(dir,'settings.json'),custom='  Προσωπικές οδηγίες\r\nDo exactly this.  ';
 await writeFile(path,JSON.stringify({promptVersion:4,prompt:custom,promptDefaultHash:KNOWN_PRIOR_DEFAULT_HASHES[0]}));
 const loaded=await readPromptSettings(path,current);assert.equal(loaded.migration.migrated,false);assert.equal(loaded.migration.prompt,custom);assert.equal(loaded.settings.promptVersion,4);
}));

test('a leftover temporary upgrade cannot supersede the original custom settings after restart',()=>temporary(async dir=>{
 const path=join(dir,'settings.json'),custom='\tМоят точен текст.\r\n';
 const original=JSON.stringify({promptVersion:4,prompt:custom});await writeFile(path,original);await writeFile(join(dir,'settings.tmp'),JSON.stringify({prompt:current}));
 const loaded=await readPromptSettings(path,current);assert.equal(loaded.migration.prompt,custom);assert.equal(await readFile(path,'utf8'),original);
}));

test('corrupt, unreadable and non-object settings are never silently reset',()=>temporary(async dir=>{
 const path=join(dir,'settings.json');
 for(const invalid of['{invalid','null','[]','42']){
  await writeFile(path,invalid);await assert.rejects(readPromptSettings(path,current),/left unchanged/);assert.equal(await readFile(path,'utf8'),invalid);
 }
 const directory=join(dir,'unreadable-settings');await mkdir(directory);await assert.rejects(readPromptSettings(directory,current),/left unchanged/);
 const fresh=await readPromptSettings(join(dir,'absent.json'),current);assert.equal(fresh.migration.prompt,current);
}));

test('saving an upgraded prompt atomically retains resumable thread identity and version 4',()=>temporary(async dir=>{
 const c=new Companion({root:process.cwd(),dataDir:dir});c.defaultPrompt=current;c.savedThread='resumable-thread';c.state.prompt=migrateDefaultPrompt(previous,current,known).prompt;
 await c.save();const saved=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));
 assert.equal(saved.prompt,current);assert.equal(saved.promptDefaultHash,promptHash(current));assert.equal(saved.promptVersion,4);assert.equal(saved.performanceRevision,2);assert.equal(saved.threadId,'resumable-thread');
 const restarted=await readPromptSettings(join(dir,'settings.json'),current);assert.equal(restarted.migration.migrated,false);assert.equal(restarted.migration.prompt,current);
 c.threadId='active-thread';await c.save();assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).threadId,'active-thread');
}));

test('a newer custom edit wins over an already queued default save and stays exact on restart',()=>temporary(async dir=>{
 const c=new Companion({root:process.cwd(),dataDir:dir});c.defaultPrompt=current;c.state.prompt=current;
 let release;const gate=new Promise(resolve=>release=resolve);c.saveQueue=gate;
 const first=c.save();const custom='\tЛични инструкции\r\n  Καλημέρα.  \n';c.state.prompt=custom;const second=c.save();release();await first;await second;
 const saved=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));assert.deepEqual(Buffer.from(saved.prompt),Buffer.from(custom));assert.equal(saved.promptDefaultHash,null);
 const restarted=await readPromptSettings(join(dir,'settings.json'),current);assert.equal(restarted.migration.prompt,custom);assert.equal(restarted.migration.migrated,false);
}));

test('failed settings writes leave the original custom prompt readable and the next save can recover',()=>temporary(async dir=>{
 const path=join(dir,'settings.json'),custom='  Original custom text\r\n';await writeFile(path,JSON.stringify({prompt:custom}));await mkdir(join(dir,'settings.tmp'));
 const c=new Companion({root:process.cwd(),dataDir:dir});c.defaultPrompt=current;c.state.prompt=custom;await assert.rejects(c.save());assert.equal((await readPromptSettings(path,current)).migration.prompt,custom);
 await rm(join(dir,'settings.tmp'),{recursive:true});await c.save();const restarted=await readPromptSettings(path,current);assert.equal(restarted.migration.prompt,custom);assert.equal(restarted.migration.migrated,false);
}));

test('production startup rejects unreadable settings before connecting or replacing any file',()=>temporary(async dir=>{
 const path=join(dir,'settings.json'),invalid='{custom settings interrupted';await writeFile(path,invalid);
 const c=new Companion({root:process.cwd(),dataDir:dir});let connected=false;c.startBridge=async()=>{connected=true;};
 await assert.rejects(c.start(),/left unchanged/);assert.equal(connected,false);assert.equal(await readFile(path,'utf8'),invalid);
}));
