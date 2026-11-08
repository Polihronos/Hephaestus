import {posix,win32} from 'node:path';

const windowsPath=value=>typeof value==='string'&&(/^[a-z]:[\\/]/i.test(value)||/^\\\\[^\\]/.test(value));
const failure=detail=>new Error(`Hephaestus could not verify its workspace trust: ${detail} Update Codex if its configuration APIs are unavailable, then reconnect.`);

function ownedPath(contextDir){
 if(typeof contextDir!=='string'||!contextDir||/[\u0000-\u001f\u007f]/.test(contextDir))throw failure('An absolute app-owned context directory is required.');
 const windows=windowsPath(contextDir),paths=windows?win32:posix;
 if(!paths.isAbsolute(contextDir))throw failure('An absolute app-owned context directory is required.');
 const context=paths.resolve(contextDir),folder=paths.join(context,'.codex');
 const compare=value=>windows?paths.resolve(value).toLowerCase():paths.resolve(value);
 return{paths,windows,context,folder,compare};
}

function projectLayer(result,owned){
 if(!Array.isArray(result?.layers))throw failure('Codex did not return configuration layer identities.');
 const matches=result.layers.filter(layer=>{
  const folder=layer?.name?.dotCodexFolder;
  return layer?.name?.type==='project'&&typeof folder==='string'&&!/[\u0000-\u001f\u007f]/.test(folder)&&windowsPath(folder)===owned.windows&&owned.paths.isAbsolute(folder)&&owned.compare(folder)===owned.compare(owned.folder);
 });
 if(matches.length!==1)throw failure('The exact app-owned .codex configuration layer was not identified.');
 const layer=matches[0];
 if(layer.disabledReason!==undefined&&layer.disabledReason!==null&&typeof layer.disabledReason!=='string')throw failure('Codex returned an unsupported project-layer trust status.');
 const projectPath=owned.paths.dirname(owned.paths.resolve(layer.name.dotCodexFolder));
 // Codex's Windows trust lookup uses a case-folded native path, unlike TOML's literal keys.
 const key=owned.windows?projectPath.toLowerCase():projectPath;
 if(owned.compare(projectPath)!==owned.compare(owned.context))throw failure('The discovered configuration layer belongs to another project.');
 return{layer,key};
}

async function readLayers(rpc,contextDir){
 try{return await rpc.call('config/read',{cwd:contextDir,includeLayers:true});}catch{throw failure('Codex config/read failed.');}
}

/** Trust only the context directory identified by Codex, preserving every other project entry. */
export async function ensureProjectTrust({rpc,contextDir}){
 if(typeof rpc?.call!=='function')throw failure('An initialized Codex connection is required.');
 const owned=ownedPath(contextDir);
 let selected=projectLayer(await readLayers(rpc,owned.context),owned);
 if(selected.layer.disabledReason!==undefined&&selected.layer.disabledReason!==null){
  try{await rpc.call('config/batchWrite',{edits:[{keyPath:'projects.'+JSON.stringify(selected.key)+'.trust_level',value:'trusted',mergeStrategy:'upsert'}],reloadUserConfig:true});}catch{throw failure('Codex could not save trust for the app-owned context directory.');}
  const verified=projectLayer(await readLayers(rpc,owned.context),owned);
  if(verified.key!==selected.key||verified.layer.disabledReason!==undefined&&verified.layer.disabledReason!==null)throw failure('Codex still disables the app-owned project configuration layer.');
  selected=verified;
 }
 return{projectPath:selected.key,dotCodexFolder:selected.layer.name.dotCodexFolder,trusted:true};
}
