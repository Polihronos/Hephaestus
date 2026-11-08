import {readFile,stat,realpath} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';

const supportedShims=new Set(['.cmd','.ps1']);
const javascript=new Set(['.js','.mjs','.cjs']);
const unsupported=path=>new Error(`Unsupported Codex launcher: ${path}. Use a native codex.exe or an official @openai/codex npm codex.cmd/codex.ps1 launcher with a valid JavaScript bin.codex entry.`);
async function isFile(path){try{return(await stat(path)).isFile();}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error;}}

async function npmEntry(shim){
 if(basename(shim,extname(shim)).toLowerCase()!=='codex')throw unsupported(shim);
 const directory=dirname(shim);
 const packages=[join(directory,'node_modules','@openai','codex')];
 if(basename(directory).toLowerCase()==='.bin'&&basename(dirname(directory)).toLowerCase()==='node_modules')packages.unshift(join(dirname(directory),'@openai','codex'));
 for(const packageRoot of packages){
  let metadata;
  try{metadata=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));}
  catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))continue;throw unsupported(shim);}
  const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.codex;
  if(metadata.name!=='@openai/codex'||typeof bin!=='string'||!bin||isAbsolute(bin)||/^[a-z]:[\\/]/i.test(bin)||/^[\\/]{2}/.test(bin))throw unsupported(shim);
  const entry=resolve(packageRoot,...bin.split(/[\\/]/)),inside=relative(resolve(packageRoot),entry);
  if(inside==='..'||inside.startsWith('..\\')||inside.startsWith('../')||isAbsolute(inside)||!javascript.has(extname(entry).toLowerCase())||!await isFile(entry))throw unsupported(shim);
  const realRoot=await realpath(packageRoot),realEntry=await realpath(entry),realInside=relative(realRoot,realEntry);
  if(realInside==='..'||realInside.startsWith('..\\')||realInside.startsWith('../')||isAbsolute(realInside))throw unsupported(shim);
  return entry;
 }
 throw unsupported(shim);
}

/** Resolve installed files; never execute or parse a shell wrapper. */
export async function resolveCodexLauncher(command='codex',{cwd=process.cwd(),env=process.env,execPath=process.execPath,platform=process.platform}={}){
 if(typeof command!=='string'||!command.trim()||command!==command.trim()||command.includes('\0'))throw new TypeError('Codex launcher must be a file path or the command codex');
 if(/^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s/i.test(command))throw unsupported(command);
 const windows=platform==='win32',extension=extname(command).toLowerCase(),explicit=isAbsolute(command)||/[\\/]/.test(command);
 const native=path=>({command:path,args:[],runAsNode:false,kind:'native'});
 const inspect=async path=>{
  if(!await isFile(path))return null;
  const suffix=extname(path).toLowerCase();
  if(suffix==='.exe'||!windows&&!suffix)return native(path);
  if(supportedShims.has(suffix)){const entry=await npmEntry(path);return{command:execPath,args:[entry],runAsNode:true,kind:'npm'};}
  throw unsupported(path);
 };
 if(explicit){
  const path=resolve(cwd,command);
  for(const candidate of windows&&!extension?[path+'.exe',path+'.cmd',path+'.ps1']:[path]){const found=await inspect(candidate);if(found)return found;}
  throw new Error(`Codex launcher was not found: ${command}`);
 }
 if(!['codex','codex.exe','codex.cmd','codex.ps1'].includes(command.toLowerCase()))throw unsupported(command);
 const pathKey=Object.keys(env).find(key=>key.toUpperCase()==='PATH');
 const directories=String(env[pathKey]??'').split(windows?';':':').map(path=>path.trim().replace(/^"(.*)"$/,'$1')).filter(Boolean).map(path=>resolve(cwd,path));
 // Prefer a native installation across PATH, even when an npm prefix is earlier.
 const names=command.toLowerCase()==='codex'?(windows?['codex.exe','codex.cmd','codex.ps1']:['codex','codex.exe','codex.cmd','codex.ps1']):[command];
 let invalidShim;
 for(const name of names)for(const directory of directories){
  try{const found=await inspect(join(directory,name));if(found)return found;}
  catch(error){if(supportedShims.has(extname(name).toLowerCase())){invalidShim??=error;continue;}throw error;}
 }
 if(invalidShim)throw invalidShim;
 throw new Error('Codex CLI was not found on PATH. Install the native Codex CLI or the official @openai/codex npm package, or configure its explicit launcher path.');
}
