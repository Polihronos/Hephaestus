// Process names are explicit user choices, never inferred from window content.
export class PrivacyBlockedError extends Error {
 constructor(message='Screen sharing is blocked for this app') { super(message);this.name='PrivacyBlockedError';this.code='SCREEN_PRIVACY_BLOCKED'; }
}

export function processName(value) {
 return String(value??'').trim().split(/[\\/]/).at(-1).replace(/\.exe$/i,'').toLocaleLowerCase();
}

export function excludedApps(value) {
 if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v.trim()||v.length>160||/[\\/\r\n]/.test(v)))throw new Error('Enter executable process names, for example chrome.exe');
 const names=value.map(processName);if(names.some(name=>!name))throw new Error('Enter executable process names, for example chrome.exe');return [...new Set(names)].sort();
}

export function excludedProcess(target,apps=[]) {
 const name=processName(target?.process);return name&&apps.some(app=>processName(app)===name)?name:null;
}
