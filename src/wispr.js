import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const keyName=k=>({16:'Shift',17:'Ctrl',18:'Alt',20:'Caps Lock',32:'Space',91:'Win',160:'Shift',161:'Shift',162:'Ctrl',163:'Ctrl',164:'Alt',165:'Alt'}[k]??String.fromCharCode(k));
export async function readWisprShortcuts(appData=process.env.APPDATA){try{const c=JSON.parse(await readFile(join(appData,'Wispr Flow','config.json'),'utf8'));const bindings=Object.entries(c.prefs?.user?.shortcuts??{}).filter(([,a])=>['ptt','popo'].includes(a)).map(([id,a])=>({id,mode:a==='ptt'?'ptt':'toggle',keys:id.split('+').map(Number)})).filter(b=>b.keys.every(Number.isInteger));return {found:bindings.length>0,bindings,labels:bindings.map(b=>({mode:b.mode,label:b.keys.map(keyName).join(' + ')}))};}catch{return {found:false,bindings:[],labels:[]};}}
export function dictationDestination({ownChat=false,ownSettings=false,editable}){if(ownSettings)return 'external';if(ownChat)return 'companion';return editable===true?'external':'companion';}
export class DictationSession{
  constructor(){this.reset();}
  reset(){this.active=false;this.armed=false;this.sticky=false;this.stopping=false;this.started=0;this.lastRelease=0;this.version=(this.version??0)+1;}
  key(e){const now=e.at??Date.now();if(e.phase==='cancel'){this.reset();return 'cancel';}if(e.phase==='toggle'){if(this.active){this.active=false;return 'finish';}this.active=true;this.sticky=true;this.started=now;this.version++;return 'start';}if(e.phase==='start'){if(this.sticky&&this.active){this.active=false;this.sticky=false;this.stopping=true;return 'finish';}this.active=true;this.started=now;this.sticky=this.lastRelease>0&&now-this.lastRelease<500;this.version++;return 'start';}if(e.phase==='end'){if(this.stopping){this.stopping=false;return 'none';}this.lastRelease=now;if(this.sticky)return 'none';this.active=false;return now-this.started<350?'tap':'finish';}return 'none';}
}
