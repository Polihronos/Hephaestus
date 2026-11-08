import test from 'node:test';
import assert from 'node:assert/strict';
import {Companion} from '../src/companion.js';

async function recognition(text,spoken,{at=Date.now()}={}){
 const c=new Companion({root:process.cwd(),dataDir:process.cwd()}),sent=[];
 Object.assign(c.state,{inputMode:'always',speech:'ready'});
 c.spokenHistory=[{text:spoken,at}];
 c.speech={call:async()=>({text,elapsedMs:4})};
 c.submit=async(value,{source})=>sent.push({text:value,source});
 await c.transcribe('isolated-recognition-fixture');
 return{c,sent};
}

test('recent English, Greek and Bulgarian playback is rejected before model dispatch',async()=>{
 for(const text of ['This is the answer I read aloud.','Αυτή είναι η απάντηση που διάβασα δυνατά.','Това е отговорът, който прочетох на глас.']){
  const {c,sent}=await recognition(text,text);
  assert.deepEqual(sent,[]);assert.equal(c.state.voiceActivity,'Playback echo rejected');
 }
});

test('canonically equivalent Greek spelling and punctuation still match recent playback',async()=>{
 const text='Αυτή είναι η απάντηση που διάβασα δυνατά.';
 const {c,sent}=await recognition(text.toLowerCase().normalize('NFD'),text.toUpperCase().replace('.','!'));
 assert.deepEqual(sent,[]);assert.equal(c.state.voiceActivity,'Playback echo rejected');
});

test('a different Greek request sharing an English project name is delivered intact',async()=>{
 const text='Άνοιξε το project MyVet τώρα.';
 const {c,sent}=await recognition(text,'Το project MyVet είναι έτοιμο για χρήση.');
 assert.deepEqual(sent,[{text,source:'voice'}]);assert.notEqual(c.state.voiceActivity,'Playback echo rejected');
});

test('a different Bulgarian request is delivered intact after Bulgarian playback',async()=>{
 const text='Покажи следващия раздел в приложението.';
 const {sent}=await recognition(text,'Това е отговорът, който прочетох на глас.');
 assert.deepEqual(sent,[{text,source:'voice'}]);
});

test('expired playback and short acknowledgements keep their existing delivery behavior',async()=>{
 const text='Αυτή είναι η απάντηση που διάβασα δυνατά.';
 assert.deepEqual((await recognition(text,text,{at:Date.now()-11000})).sent,[{text,source:'voice'}]);
 assert.deepEqual((await recognition('Ναι','Ναι')).sent,[{text:'Ναι',source:'voice'}]);
});
