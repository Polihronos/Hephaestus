import {renderMarkdown} from './markdown.js';
const request = window.companion.request, text = document.getElementById('bubble-text'), mode = document.getElementById('bubble-mode'), dots = document.getElementById('thinking-dots'), wave = document.getElementById('speech-wave');
let state = {}, generation = -1, pending = '', renderFrame = 0, following = true;
const activeTools = new Map();
function display(value, final = false) {
  pending = value;
  if (final) document.getElementById('bubble-announcer').textContent = 'Hephaestus: ' + value;
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderMarkdown(text,pending); if (following) text.scrollTop = text.scrollHeight; });
}
text.addEventListener('scroll',() => { following = text.scrollHeight - text.clientHeight - text.scrollTop < 45; });
function render(next) {
  state = next;
  const thinking = next.busy === true && next.background !== true && next.speaking !== true;
  if (!thinking || next.stopping) activeTools.clear();
  const activeTool = [...activeTools.values()].at(-1);
  mode.textContent = next.stopping ? 'Stopping…' : next.speaking ? 'Speaking' : next.sendPending ? 'Sending…' : activeTool ? 'Using ' + activeTool : thinking ? 'Thinking…' : next.running === false ? 'Paused' : 'Here with you';
  mode.title = mode.textContent; dots.hidden = !thinking || !!next.stopping; wave.hidden = !next.speaking;
  document.body.classList.toggle('talking',next.speaking === true); document.body.classList.toggle('thinking',thinking);
}
window.companion.onEvent((event,data) => {
  if (event === 'state') render(data);
  if (event === 'responseStart') { generation = data.generation; activeTools.clear(); following = true; display(''); render(state); }
  if (event === 'activity' && data.kind === 'tool' && !data.background) { if (data.status === 'running' && state.busy && !state.background) activeTools.set(data.id,data.title); else activeTools.delete(data.id); render(state); }
  if (event === 'delta') { if (data.generation < generation) return; generation = data.generation; display(data.full); }
  if (event === 'message' && data.role === 'assistant') { activeTools.clear(); display(data.toolWarning ? 'Action failed: ' + data.toolWarning + '\n\n' + data.text : data.text,true); render(state); }
  if (event === 'placement') { document.body.classList.toggle('below',data.below); document.documentElement.style.setProperty('--tail',data.tail + 'px'); }
});
document.getElementById('bubble-open').onclick = () => request('show-dashboard',{page:'companion',focusInput:true}).catch(() => {});
document.getElementById('bubble-dismiss').onclick = () => request('toggle-bubble').catch(() => {});
document.addEventListener('keydown',event => { if (event.key === 'Escape') request('toggle-bubble').catch(() => {}); });
let lastHeight = 0;
new ResizeObserver(() => { const height = document.getElementById('answer-bubble').offsetHeight; if (height !== lastHeight) { lastHeight = height; request('bubble-size',{height}).catch(() => {}); } }).observe(document.getElementById('answer-bubble'));
try { const initial = await request('init'); render(initial.state); const message = initial.messages.filter(item => item.role === 'assistant').at(-1); if (message) display(message.toolWarning ? 'Action failed: ' + message.toolWarning + '\n\n' + message.text : message.text); }
catch { mode.textContent = 'Reconnecting'; display('Open the conversation window to check the connection.'); }
window.hephaestusBubbleInspect = () => ({text:pending,renderedText:text.textContent,thinking:!dots.hidden,talking:!wave.hidden,hasInput:!!document.querySelector('input,textarea'),cardCount:document.querySelectorAll('#answer-bubble').length});
