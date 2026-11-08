import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureProjectTrust} from '../src/project-trust.js';

const contextDir='C:/Users/niki_/AppData/Local/ScreenCompanion/resources/app/runtime/quality-verification/context';
const folder='C:\\Users\\niki_\\AppData\\Local\\ScreenCompanion\\resources\\app\\runtime\\quality-verification\\context\\.codex';
const canonical='c:\\users\\niki_\\appdata\\local\\screencompanion\\resources\\app\\runtime\\quality-verification\\context';

function fixture({context=contextDir,dotCodexFolder=folder,key=canonical,active=false}={}){
 const state={model:'unchanged-model',projects:{[context]:{trust_level:'trusted'},'C:/Other Project':{trust_level:'untrusted'}},apps:{example:{enabled:false}}};
 const calls=[];let trusted=active;
 const rpc={async call(method,params){
  calls.push({method,params});
  if(method==='config/read')return{config:structuredClone(state),layers:[{name:{type:'user',file:'C:\\Users\\niki_\\.codex\\config.toml'},version:'user-version',config:{}},{name:{type:'project',dotCodexFolder},version:'project-version',config:{},disabledReason:trusted?null:'Add the canonical app-owned directory as a trusted project.'}]};
  if(method==='config/batchWrite'){
   for(const edit of params.edits){const match=/^projects\.(.+)\.trust_level$/.exec(edit.keyPath);assert.ok(match);const project=JSON.parse(match[1]);state.projects[project]={...state.projects[project],trust_level:edit.value};if(project===key)trusted=true;}
   return{status:'ok'};
  }
  throw new Error('Unexpected configuration API');
 }};
 return{rpc,state,calls,context};
}

test('native lowercase Windows trust keys activate the exact layer that mixed-case forward-slash keys did not',async()=>{
 const f=fixture(),before=structuredClone(f.state),result=await ensureProjectTrust({rpc:f.rpc,contextDir});
 assert.equal(result.projectPath,canonical);assert.equal(result.dotCodexFolder,folder);assert.equal(result.trusted,true);
 assert.deepEqual(f.calls.map(call=>call.method),['config/read','config/batchWrite','config/read']);
 assert.deepEqual(f.calls[1].params,{edits:[{keyPath:'projects.'+JSON.stringify(canonical)+'.trust_level',value:'trusted',mergeStrategy:'upsert'}],reloadUserConfig:true});
 const added=f.state.projects[canonical];delete f.state.projects[canonical];assert.deepEqual(f.state,before);assert.deepEqual(added,{trust_level:'trusted'});
 assert.equal(f.calls[0].params.includeLayers,true);assert.equal(f.calls[0].params.cwd,'C:\\Users\\niki_\\AppData\\Local\\ScreenCompanion\\resources\\app\\runtime\\quality-verification\\context');
});

test('an already active exact project layer needs no configuration write',async()=>{
 const f=fixture({active:true});await ensureProjectTrust({rpc:f.rpc,contextDir});assert.deepEqual(f.calls.map(call=>call.method),['config/read']);
});

test('POSIX project identities preserve case and use the same narrow supported configuration edit',async()=>{
 const context='/srv/Hephaestus/context',f=fixture({context,dotCodexFolder:context+'/.codex',key:context});
 const result=await ensureProjectTrust({rpc:f.rpc,contextDir:context});assert.equal(result.projectPath,context);assert.equal(result.dotCodexFolder,context+'/.codex');
 assert.equal(f.calls[1].params.edits[0].keyPath,'projects.'+JSON.stringify(context)+'.trust_level');
});

test('unknown, ambiguous or foreign project-layer identities never receive a trust write',async()=>{
 const changes=[
  result=>{delete result.layers;},
  result=>{result.layers=[];},
  result=>{result.layers[1].name.dotCodexFolder={path:folder};},
  result=>{result.layers[1].name.dotCodexFolder='C:\\Other Project\\.codex';},
  result=>{result.layers[1].name.dotCodexFolder=folder.replace('context\\.codex','context-sibling\\.codex');},
  result=>{result.layers[1].name.dotCodexFolder='relative/.codex';},
  result=>{result.layers[1].name.type='user';},
  result=>{result.layers.push(structuredClone(result.layers[1]));},
  result=>{result.layers[1].disabledReason={unknown:true};}
 ];
 for(const change of changes){const f=fixture(),original=f.rpc.call;f.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='config/read')change(result);return result;};await assert.rejects(ensureProjectTrust({rpc:f.rpc,contextDir}),/workspace trust/);assert.equal(f.calls.some(call=>call.method==='config/batchWrite'),false);}
});

test('a disabled layer after an ineffective trust write stops startup explicitly',async()=>{
 const f=fixture(),original=f.rpc.call;f.rpc.call=async(method,params)=>method==='config/batchWrite'?(f.calls.push({method,params}),{status:'ok'}):original(method,params);
 await assert.rejects(ensureProjectTrust({rpc:f.rpc,contextDir}),/still disables/);assert.equal(f.calls.filter(call=>call.method==='config/batchWrite').length,1);
});

test('a changed canonical layer identity after writing cannot silently trust another project',async()=>{
 const f=fixture(),original=f.rpc.call;let reads=0;f.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='config/read'&&++reads===2)result.layers[1].name.dotCodexFolder='C:\\Other Project\\.codex';return result;};
 await assert.rejects(ensureProjectTrust({rpc:f.rpc,contextDir}),/exact app-owned/);assert.equal(f.calls.filter(call=>call.method==='config/batchWrite').length,1);assert.equal(f.state.projects['C:/Other Project'].trust_level,'untrusted');
});

test('configuration API failures produce actionable errors without copying response details',async()=>{
 for(const failing of['config/read','config/batchWrite']){const f=fixture(),original=f.rpc.call;f.rpc.call=async(method,params)=>{if(method===failing)throw new Error('Private configuration detail');return original(method,params);};await assert.rejects(ensureProjectTrust({rpc:f.rpc,contextDir}),error=>/workspace trust/.test(error.message)&&/reconnect/.test(error.message)&&!error.message.includes('Private configuration detail'));}
});

test('relative context paths are rejected before any configuration API call',async()=>{
 const f=fixture();for(const context of['context','',null])await assert.rejects(ensureProjectTrust({rpc:f.rpc,contextDir:context}),/absolute app-owned/);assert.equal(f.calls.length,0);
});
