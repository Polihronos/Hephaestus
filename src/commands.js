export function normalize(text) { return text.toLowerCase().replace(/[.!?,]/g,'').replace(/\s+/g,' ').trim(); }

export function fastCommand(text) {
  const t=normalize(text).replace(/^please /,'');
  if (/^(stop|stop now|cancel|cancel that|be quiet|quiet)$/.test(t)) return {kind:'stop'};
  if (/^(pause listening|stop listening|mute microphone|mute yourself)$/.test(t)) return {kind:'mute'};
  if (/^(go to |switch to |go to the |switch to the )?(next tab)$/.test(t)) return {kind:'key',key:'Ctrl+Tab',browser:true,label:'Next tab'};
  if (/^(go to |switch to |go to the |switch to the )?(previous tab|last tab)$/.test(t)) return {kind:'key',key:'Ctrl+Shift+Tab',browser:true,label:'Previous tab'};
  if (/^(open |open a |create |create a )new tab$/.test(t)) return {kind:'key',key:'Ctrl+T',browser:true,label:'New tab'};
  if (/^(scroll down|go down|scroll down a bit)$/.test(t)) return {kind:'scroll',delta:-480,label:'Scrolled down'};
  if (/^(scroll up|go up|scroll up a bit)$/.test(t)) return {kind:'scroll',delta:480,label:'Scrolled up'};
  if (/^(click here|click there|click this|click at the cursor)$/.test(t)) return {kind:'click',atCursor:true,label:'Clicked at your pointer'};
  if (/^(go to |switch to |open |go to the |switch to the |open the )browser$/.test(t)) return {kind:'browser',label:'Browser'};
  return null;
}

export function screenDifference(a,b) {
  if(!a||!b||a.length!==b.length)return 255;
  let total=0;for(let i=0;i<a.length;i++)total+=Math.abs(a[i]-b[i]);return total/a.length;
}

export function coordinates(frame,x,y) {
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=frame.width||y>=frame.height)throw new Error('Click coordinates are outside the observed image');
  return {screenX:Math.round(frame.bounds.x+x*frame.bounds.width/frame.width),screenY:Math.round(frame.bounds.y+y*frame.bounds.height/frame.height)};
}

export function validateAction(action) {
  if(!action||typeof action!=='object')throw new Error('Invalid action');
  if(!['click','doubleclick','rightclick','scroll','key','type','focus','browser'].includes(action.kind))throw new Error('Unsupported action');
  if(action.kind==='key'&&(!/^[\w+]+$/.test(action.key??'')||/meta|super|cmd/i.test(action.key)||(/win/i.test(action.key)&&!['win','win+e','win+d','win+tab','win+i'].includes(action.key.toLowerCase()))))throw new Error('Unsupported shortcut');
  if(action.kind==='type'&&(typeof action.text!=='string'||action.text.length>8000))throw new Error('Invalid text');
  return action;
}
