const number = value => (value ?? 0).toLocaleString();
const money = value => value === null ? 'Unpriced' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:4,maximumFractionDigits:4}).format(value ?? 0);
const purposeLabel = {'conversation':'Conversation & tasks','screen refresh':'Proactive screen checks','verification':'Verification','unclassified':'Unclassified history'};
export function createUsage(request) {
  const nav = document.createElement('button'); nav.dataset.page = 'usage'; nav.innerHTML = '<span aria-hidden="true">▥</span> Usage'; document.querySelector('nav').append(nav);
  const view = document.createElement('section'); view.dataset.view = 'usage'; view.className = 'view usage-view'; view.hidden = true; view.setAttribute('aria-labelledby','usage-heading');
  view.innerHTML = `<div class="usage-heading"><div><span class="eyebrow">USAGE</span><h1 id="usage-heading">A clear picture of your usage.</h1><p class="intro">Recorded Hephaestus activity, covered by your Codex subscription.</p></div><button id="open-t3-usage" class="soft-button">Workspace cost view ↗</button></div>
  <div class="usage-toolbar"><label>Period<select id="usage-window"><option value="7">Last 7 days</option><option value="1">Today</option><option value="30">Last 30 days</option><option value="all" selected>All time</option></select></label><label>Activity<select id="usage-purpose"><option value="">All activity</option>${Object.entries(purposeLabel).map(([key,value]) => `<option value="${key}">${value}</option>`).join('')}</select></label><label>Model<select id="usage-model"><option value="">All models</option></select></label><button id="usage-refresh" class="soft-button">↻ Refresh</button></div>
  <div id="usage-status" role="status">Loading your recorded usage…</div><div class="usage-stats" id="usage-stats"></div><div class="usage-chart-card"><div class="usage-chart-heading"><b>Activity over time</b><div role="group" aria-label="Chart measure"><button id="usage-chart-cost" class="selected" aria-pressed="true">API value</button><button id="usage-chart-tokens" aria-pressed="false">Tokens</button></div></div><div id="usage-chart" class="usage-chart" aria-label="Recorded daily usage"></div><small id="usage-pricing-note"></small></div>
  <div class="usage-groups"><div><h2>By purpose</h2><div id="usage-by-purpose"></div></div><div><h2>By model</h2><div id="usage-by-model"></div></div></div>
  <div class="usage-table-heading"><h2>Usage history</h2><small id="usage-count"></small></div><p class="footnote">Cached input is included in input; reasoning is included in output. Expand a row to see its request and tools.</p><div class="usage-table-wrap" tabindex="0" aria-label="Usage history table"><table class="usage-table"><thead><tr><th scope="col">When / purpose</th><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cached</th><th scope="col">Output</th><th scope="col">API value</th></tr></thead><tbody id="usage-rows"></tbody></table></div><div class="usage-pagination"><button id="usage-previous">← Previous</button><span id="usage-page"></span><button id="usage-next">Next →</button></div>`;
  document.querySelector('.content').append(view);
  let report, chartMode = 'cost', offset = 0, sequence = 0, loading = false, lastTotal = -1, refreshTimer;
  const $ = id => document.getElementById(id);
  const options = () => { const days = $('usage-window').value; let since; if (days !== 'all') { const date = new Date(); date.setHours(0,0,0,0); date.setDate(date.getDate() - Number(days) + 1); since = date.toISOString(); } return {since,purpose:$('usage-purpose').value,model:$('usage-model').value,offset,limit:50,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}; };
  function controls() {
    $('usage-refresh').disabled = loading; $('usage-refresh').textContent = loading ? 'Refreshing…' : '↻ Refresh';
    $('usage-previous').disabled = loading || offset === 0;
    $('usage-next').disabled = loading || !report || offset + 50 >= report.count;
    view.setAttribute('aria-busy',String(loading));
  }
  async function refresh() {
    const id = ++sequence; loading = true; controls(); $('usage-status').textContent = report ? 'Updating usage…' : 'Loading your recorded usage…'; $('usage-status').dataset.error = 'false';
    try { const next = await request('usage-report',options()); if (id !== sequence) return; report = next; render(); $('usage-status').textContent = ''; }
    catch (error) { if (id !== sequence) return; $('usage-status').dataset.error = 'true'; $('usage-status').textContent = 'Usage could not be loaded. ' + error.message + ' Use Refresh to try again.'; }
    finally { if (id === sequence) { loading = false; controls(); } }
  }
  function chart() {
    const root = $('usage-chart'); root.replaceChildren();
    const points = report.byDay.filter(point => point.key !== 'Unknown date').slice(-31), max = Math.max(...points.map(point => chartMode === 'cost' ? point.costUsd : point.tokens),1e-9);
    if (!points.length) { const empty = document.createElement('p'); empty.className = 'usage-empty'; empty.textContent = 'No dated usage in this range.'; root.append(empty); return; }
    for (const point of points) {
      const column = document.createElement('div'); column.className = 'usage-column'; column.tabIndex = 0;
      const bar = document.createElement('div'), label = document.createElement('small'), tooltip = document.createElement('span');
      const value = chartMode === 'cost' ? point.costUsd : point.tokens; bar.style.height = Math.max(2,value / max * 124) + 'px';
      const description = `${point.key} · ${money(point.costUsd)} API value · ${number(point.tokens)} tokens`;
      column.title = description; column.setAttribute('aria-label',description); tooltip.textContent = chartMode === 'cost' ? money(point.costUsd) : number(point.tokens); tooltip.className = 'usage-tooltip';
      label.textContent = point.key.slice(5); column.append(tooltip,bar,label); root.append(column);
    }
  }
  function group(id, rows, labels = {}) {
    const root = $(id); root.replaceChildren(); const max = Math.max(...rows.map(row => row.costUsd),1e-9);
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'usage-empty'; empty.textContent = 'No usage in this range.'; root.append(empty); return; }
    for (const row of [...rows].sort((a,b) => b.costUsd - a.costUsd)) {
      const item = document.createElement('div'); item.className = 'usage-group-row'; const label = document.createElement('span'), value = document.createElement('b'), bar = document.createElement('i');
      label.textContent = labels[row.key] ?? row.key; value.textContent = money(row.costUsd); bar.style.width = Math.max(1,row.costUsd / max * 100) + '%'; bar.setAttribute('aria-hidden','true'); item.title = number(row.tokens) + ' tokens'; item.append(label,value,bar); root.append(item);
    }
  }
  function render() {
    const totals = report.totals; $('usage-stats').replaceChildren();
    for (const [label,value,detail] of [['Estimated API value',money(totals.costUsd),'Comparison value · no extra API bill'],['Tokens processed',number(totals.totalTokens),number(totals.requests) + ' recorded model calls'],['Input',number(totals.inputTokens),number(totals.cachedInputTokens) + ' cached tokens included'],['Output',number(totals.outputTokens),number(totals.reasoningOutputTokens) + ' reasoning tokens included'],['Cache savings',money(totals.cacheSavingsUsd),'Compared with uncached input']]) {
      const card = document.createElement('div'); card.className = 'usage-stat'; const small = document.createElement('small'), strong = document.createElement('strong'), text = document.createElement('span'); small.textContent = label; strong.textContent = value; text.textContent = detail; card.append(small,strong,text); $('usage-stats').append(card);
    }
    $('usage-pricing-note').textContent = `Estimated USD at current ${report.pricing.source} rates (${new Date(report.pricing.asOf).toLocaleDateString()}). API value is a comparison with API pricing, not an API bill.${totals.unpricedTokens ? ' ' + number(totals.unpricedTokens) + ' tokens have no known price and are excluded from dollar totals.' : ''}`;
    const model = $('usage-model'), selected = model.value;
    for (const row of report.byModel) if (![...model.options].some(option => option.value === row.key)) model.add(new Option(row.key,row.key)); model.value = selected;
    chart(); group('usage-by-purpose',report.byPurpose,purposeLabel); group('usage-by-model',report.byModel); $('usage-count').textContent = number(report.count) + ' calls'; $('usage-rows').replaceChildren();
    for (const entry of report.entries) {
      const row = document.createElement('tr'), when = document.createElement('td'), stamp = document.createElement('b'), detail = document.createElement('details'), summary = document.createElement('summary'), description = document.createElement('p');
      stamp.textContent = entry.at ? new Date(entry.at).toLocaleString() : 'Unknown date'; summary.textContent = purposeLabel[entry.purpose] ?? entry.purpose;
      description.textContent = (entry.request || 'No request text was retained.') + (entry.tools?.length ? '\n\nTools: ' + entry.tools.join(', ') : '') + '\n\nSource: ' + (entry.source ?? 'Recorded usage'); detail.append(summary,description); when.append(stamp,detail); row.append(when);
      for (const value of [entry.model,number(entry.usage.inputTokens),number(entry.usage.cachedInputTokens),number(entry.usage.outputTokens),money(entry.cost?.usd ?? null)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } $('usage-rows').append(row);
    }
    if (!report.entries.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'usage-empty'; cell.textContent = 'No recorded calls match these filters.'; row.append(cell); $('usage-rows').append(row); }
    $('usage-page').textContent = report.count ? `${offset + 1}–${Math.min(offset + 50,report.count)} of ${number(report.count)}` : 'No usage in this range'; controls();
  }
  for (const id of ['usage-window','usage-purpose','usage-model']) $(id).onchange = () => { offset = 0; refresh(); };
  $('usage-refresh').onclick = refresh; $('usage-next').onclick = () => { offset += 50; refresh(); }; $('usage-previous').onclick = () => { offset = Math.max(0,offset - 50); refresh(); };
  for (const mode of ['cost','tokens']) $('usage-chart-' + mode).onclick = () => { chartMode = mode; for (const value of ['cost','tokens']) { $('usage-chart-' + value).classList.toggle('selected',value === mode); $('usage-chart-' + value).setAttribute('aria-pressed',String(value === mode)); } if (report) chart(); };
  $('open-t3-usage').onclick = () => window.dispatchEvent(new CustomEvent('hephaestus-workspace',{detail:'usage'})); controls();
  return {refresh,updateState(state) { if (state.tokens?.totalTokens !== lastTotal) { lastTotal = state.tokens?.totalTokens; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!view.hidden) refresh(); },1000); } }};
}
