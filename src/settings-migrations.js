import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// SHA256 of the shipped default in 37f405a:assets/system-prompt.txt.
// Only line endings are normalized. Custom whitespace and wording stay significant.
export const KNOWN_PRIOR_DEFAULT_HASHES=Object.freeze([
 'f3077baa25d2ecd15f38296f600bdc1c8f61961058a59eaead8f09ba5e9cc8bc'
]);

export function promptHash(prompt){
 if(typeof prompt!=='string')throw new TypeError('A prompt must be text');
 return createHash('sha256').update(prompt.replace(/\r\n?/g,'\n'),'utf8').digest('hex');
}

export function defaultPromptHash(prompt,currentDefault){
 return typeof prompt==='string'&&typeof currentDefault==='string'&&promptHash(prompt)===promptHash(currentDefault)?promptHash(currentDefault):null;
}

export function migrateDefaultPrompt(savedPrompt,currentDefault,knownPriorHashes=KNOWN_PRIOR_DEFAULT_HASHES){
 if(typeof currentDefault!=='string'||!currentDefault.trim())throw new Error('The default prompt is unavailable; existing settings were left unchanged');
 if(savedPrompt===undefined)return{prompt:currentDefault,migrated:false};
 if(typeof savedPrompt!=='string')throw new Error('The saved prompt is invalid; existing settings were left unchanged');
 const hash=promptHash(savedPrompt);
 if(hash===promptHash(currentDefault))return{prompt:savedPrompt,migrated:false};
 if(knownPriorHashes.includes(hash))return{prompt:currentDefault,migrated:true};
 return{prompt:savedPrompt,migrated:false};
}

export async function readPromptSettings(path,currentDefault){
 let settings={};
 try{settings=JSON.parse(await readFile(path,'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw new Error('Settings could not be read; existing settings were left unchanged',{cause:error});}
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error('Settings are invalid; existing settings were left unchanged');
 return{settings,migration:migrateDefaultPrompt(settings.prompt,currentDefault)};
}
