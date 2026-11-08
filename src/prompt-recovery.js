import {createHash} from 'node:crypto';
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const path=directory=>join(directory,'prompt-transaction.json');
const identity=['version','oldThread','newThread','oldPromptHash','newPromptHash'];
const mutations=new Map();
function mutate(directory,operation){
 const absolute=resolve(directory),key=process.platform==='win32'?absolute.toLowerCase():absolute;
 const pending=(mutations.get(key)??Promise.resolve()).catch(()=>{}).then(operation);mutations.set(key,pending);
 const settled=()=>{if(mutations.get(key)===pending)mutations.delete(key);};pending.then(settled,settled);return pending;
}
function decode(contents){
 let saved;try{saved=JSON.parse(contents);}catch(error){throw new Error('The interrupted instruction update could not be read.',{cause:error});}
 if(saved?.version!==1||!identity.slice(1).every(key=>typeof saved[key]==='string'&&saved[key]))throw new Error('The interrupted instruction update is invalid.');
 return saved;
}
export const promptHash=prompt=>createHash('sha256').update(prompt).digest('hex');
export async function writePromptTransaction(directory,transaction){
 const saved=Object.freeze({version:1,...transaction}),contents=JSON.stringify(saved);
 return mutate(directory,async()=>{await writeFile(path(directory)+'.tmp',contents);await rename(path(directory)+'.tmp',path(directory));return saved;});
}
export async function readPromptTransaction(directory,prompt){
 let contents;try{contents=await readFile(path(directory),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw new Error('The interrupted instruction update could not be read.',{cause:error});}
 const saved=decode(contents);
 const hash=promptHash(prompt),selected=hash===saved.newPromptHash?'new':hash===saved.oldPromptHash?'old':'fresh';
 return{...saved,selected,threadId:selected==='new'?saved.newThread:selected==='old'?saved.oldThread:null};
}
export async function clearPromptTransaction(directory,expected){
 const selected=expected&&Object.fromEntries(identity.map(key=>[key,expected[key]]));
 return mutate(directory,async()=>{
  if(selected){let contents;try{contents=await readFile(path(directory),'utf8');}catch(error){if(error.code==='ENOENT')return true;throw error;}const saved=decode(contents);if(!identity.every(key=>saved[key]===selected[key]))return false;}
  try{await unlink(path(directory));}catch(error){if(error.code!=='ENOENT')throw error;}return true;
 });
}

/** Persist the prior committed conversation before a later journal can replace its recovery identity. */
export async function reconcilePromptTransaction(directory,{prompt,threadId,persistIdentity}){
 const recovery=await readPromptTransaction(directory,prompt);if(!recovery)return null;
 if(!recovery.threadId||recovery.threadId!==threadId)throw new Error('The saved instruction recovery does not match this conversation. Reconnect before saving instructions again.');
 try{await persistIdentity();if(!await clearPromptTransaction(directory,recovery))throw new Error('The pending instruction recovery changed.');}
 catch(error){throw Object.assign(new Error('The previous instruction update could not be reconciled. Its saved instructions remain recoverable; reconnect and try again.',{cause:error}),{code:error.code});}
 return recovery;
}
