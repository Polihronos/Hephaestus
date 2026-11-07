import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {wisprRouteCheck} from '../scripts/wispr-route-check.js';

test('dictation verification rejects normal and mismatched window profiles before changing anything',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hephaestus-route-guard-'));
 try{
  const expected=join(root,'runtime','route-verification'),normal=join(root,'normal-profile');
  await mkdir(expected,{recursive:true});await mkdir(normal);await writeFile(join(normal,'settings.json'),'Original settings');
  for(const [dataDir,windowDir] of[[normal,normal],[expected,normal]]){
   const mutations=[],submit=()=>mutations.push('submit'),c={dataDir,state:{},submit,configure:()=>mutations.push('configure')};
   const passed=await wisprRouteCheck({root,companion:c,app:{getPath:()=>windowDir},wisprKey:()=>mutations.push('shortcut'),showDashboard:()=>mutations.push('dashboard')});
   assert.equal(passed,false);assert.deepEqual(mutations,[]);assert.equal(c.submit,submit);
   assert.equal(await readFile(join(normal,'settings.json'),'utf8'),'Original settings');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
