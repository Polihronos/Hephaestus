import {createHash} from 'node:crypto';
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const path=directory=>join(directory,'prompt-transaction.json');
export const promptHash=prompt=>createHash('sha256').update(prompt).digest('hex');
export async function writePromptTransaction(directory,transaction){
 await writeFile(path(directory)+'.tmp',JSON.stringify({version:1,...transaction}));
 await rename(path(directory)+'.tmp',path(directory));
}
export async function readPromptTransaction(directory,prompt){
 let saved;try{saved=JSON.parse(await readFile(path(directory),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('The interrupted instruction update could not be read.',{cause:error});}
 if(saved.version!==1||!['oldThread','newThread','oldPromptHash','newPromptHash'].every(key=>typeof saved[key]==='string'&&saved[key]))throw new Error('The interrupted instruction update is invalid.');
 const hash=promptHash(prompt),selected=hash===saved.newPromptHash?'new':hash===saved.oldPromptHash?'old':'fresh';
 return{...saved,selected,threadId:selected==='new'?saved.newThread:selected==='old'?saved.oldThread:null};
}
export async function clearPromptTransaction(directory){try{await unlink(path(directory));}catch(error){if(error.code!=='ENOENT')throw error;}}
