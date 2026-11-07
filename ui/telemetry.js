import {createUsage} from './usage.js';
export function createTelemetry(request, onError = () => {}) {
  const usage = createUsage(request);
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'telemetry.css'; document.head.append(style);
  const tokenCard = document.createElement('button'); tokenCard.type = 'button'; tokenCard.className = 'token-card'; tokenCard.innerHTML = '<small>Recorded tokens <span aria-hidden="true">↗</span></small><strong>Loading…</strong><span class="token-breakdown"></span>';
  tokenCard.setAttribute('aria-label','View recorded token usage'); document.querySelector('.subscription').after(tokenCard);
  const progress = document.createElement('details'); progress.className = 'live-progress'; progress.innerHTML = '<summary><span class="progress-label">Thinking &amp; tools</span><span class="progress-state">Ready</span></summary><div class="progress-list"><p class="progress-empty">Request activity will appear here.</p></div>';
  document.querySelector('.conversation-scroll').before(progress);
  const effort = document.createElement('label'); effort.className = 'setting-row'; effort.innerHTML = '<span>Reasoning effort<small>Higher effort gives the model more time to work through a request.</small></span><select id="effort" aria-label="Reasoning effort"></select>'; document.getElementById('model').closest('label').after(effort);
  const inventory = document.createElement('details'); inventory.className = 'settings-card tool-inventory'; inventory.innerHTML = '<summary>Available tools <span>Desktop &amp; workspace</span></summary><p>Hephaestus uses these desktop tools alongside the tools available in your connected workspace.</p><div></div>'; document.querySelector('[data-view="activity"]').append(inventory);
  const requestButton = document.createElement('button'); requestButton.textContent = 'Open request in workspace'; requestButton.className = 'progress-workspace'; requestButton.hidden = true; requestButton.onclick = () => window.dispatchEvent(new CustomEvent('hephaestus-workspace',{detail:'thread'})); progress.append(requestButton);
  const activities = new Map(); let key = '', state = {};
  effort.querySelector('select').onchange = event => request('configure',{effort:event.target.value}).catch(error => { effort.querySelector('select').value = state.effort ?? 'low'; onError(error); });
  function updateState(next) {
    state = next; requestButton.hidden = next.activity !== 'Waiting for your answer'; usage.updateState(next);
    if (next.tokens) {
      tokenCard.querySelector('strong').textContent = (next.tokens.totalTokens ?? 0).toLocaleString();
      tokenCard.querySelector('.token-breakdown').textContent = `${(next.tokens.inputTokens ?? 0).toLocaleString()} input · ${(next.tokens.outputTokens ?? 0).toLocaleString()} output`;
      tokenCard.title = `${(next.tokens.cachedInputTokens ?? 0).toLocaleString()} cached input tokens (included in input). ${(next.tokens.reasoningOutputTokens ?? 0).toLocaleString()} reasoning tokens (included in output). ${(next.tokens.threadCount ?? 0).toLocaleString()} recorded sessions. Open the full usage breakdown.`;
    }
    const values = next.models?.find(model => model.id === next.model)?.efforts ?? ['low','medium','high','xhigh'];
    if (values.join() !== key) { key = values.join(); effort.querySelector('select').replaceChildren(...values.map(value => new Option({low:'Low · quicker',medium:'Medium',high:'High',xhigh:'Extra high'}[value] ?? value,value))); }
    effort.querySelector('select').value = next.effort ?? 'low';
    progress.querySelector('.progress-state').textContent = next.stopping ? 'Stopping…' : next.busy ? next.background ? 'Screen check' : next.activity || 'Thinking…' : 'Ready';
    progress.dataset.active = String(next.busy === true && next.background !== true);
    if (!next.busy) for (const row of activities.values()) if (row.dataset.status === 'running') { row.dataset.status = 'ended'; row.querySelector('small').textContent = 'Ended'; }
  }
  function activity(event) {
    if (!event?.id) return;
    progress.querySelector('.progress-empty')?.remove();
    if (event.status === 'running' && !event.background && state.busy && !state.background) progress.querySelector('.progress-state').textContent = event.title;
    let row = activities.get(event.id);
    if (!row) { row = document.createElement('div'); row.className = 'progress-event'; row.innerHTML = '<div><b></b><small></small></div><p></p>'; activities.set(event.id,row); progress.querySelector('.progress-list').prepend(row); }
    row.dataset.status = event.status;
    row.querySelector('b').textContent = event.title;
    row.querySelector('small').textContent = (event.status === 'running' && !state.busy ? 'Ended' : {running:'Running',completed:'Done',failed:'Failed',cancelled:'Cancelled'}[event.status] ?? event.status) + (event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : '');
    row.querySelector('p').textContent = event.text ?? ''; row.querySelector('p').hidden = !event.text;
    while (activities.size > 6) { const oldest = progress.querySelector('.progress-list').lastElementChild; const id = [...activities.entries()].find(([,value]) => value === oldest)?.[0]; if (id) activities.delete(id); oldest?.remove(); }
    let journal = document.getElementById('activity-' + event.id);
    if (!journal) { journal = document.createElement('div'); journal.id = 'activity-' + event.id; journal.className = 'activity-item'; journal.append(document.createElement('time'),document.createElement('span')); document.getElementById('activity-list').prepend(journal); }
    journal.querySelector('time').textContent = new Date(event.at ?? Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    journal.querySelector('span').textContent = `${event.title} · ${event.status}${event.text ? ' — ' + event.text : ''}`; document.getElementById('activity-empty').hidden = true;
    const list = document.getElementById('activity-list'); while (list.childElementCount > 100) list.lastElementChild.remove();
  }
  function capabilities(tools = []) {
    const list = inventory.querySelector('div'); list.replaceChildren();
    for (const tool of tools) { const row = document.createElement('div'), name = document.createElement('b'), description = document.createElement('p'); name.textContent = tool.name; description.textContent = tool.description; row.append(name,description); list.append(row); }
    if (!tools.length) { const empty = document.createElement('p'); empty.textContent = 'Tool information is not available yet.'; list.append(empty); }
  }
  tokenCard.onclick = () => document.querySelector('[data-page="usage"]').click();
  return {updateState,activity,capabilities,usage};
}
