export function createWorkspace(request,navigate,onError = () => {}) {
  const nav = document.createElement('button'); nav.dataset.page = 'workspace'; nav.innerHTML = '<span aria-hidden="true">⌘</span> Workspace'; document.querySelector('nav').append(nav);
  const view = document.createElement('section'); view.dataset.view = 'workspace'; view.className = 'view'; view.hidden = true; view.setAttribute('aria-label','Connected workspace');
  view.innerHTML = '<div class="workspace-topline"><p>Your full conversation, tools, files, and requests in the connected workspace.</p><button id="workspace-conversation" class="soft-button">Open conversation</button></div><div class="workspace-error" role="status" hidden></div><div id="native-workspace-slot" aria-label="Connected T3 workspace"></div>'; document.querySelector('.content').append(view);
  let route = 'thread', active = false, selectCost = false, navigateRequested = false, scheduled = false, lastKey = '', lastConnection = '';
  const slot = view.querySelector('#native-workspace-slot'), error = view.querySelector('.workspace-error');
  async function sync() {
    scheduled = false;
    const bounds = slot.getBoundingClientRect(), openCost = selectCost, openRoute = navigateRequested;
    const params = {visible:active,route,selectCost:openCost,navigateToRoute:openRoute,bounds:{x:Math.round(bounds.x),y:Math.round(bounds.y),width:Math.round(bounds.width),height:Math.round(bounds.height)}};
    const key = JSON.stringify(params); if (key === lastKey && !openRoute && !openCost) return;
    lastKey = key; selectCost = false; navigateRequested = false;
    try { await request('runtime-view',params); error.hidden = true; }
    catch (failure) { lastKey = ''; error.textContent = 'The workspace could not be opened. ' + failure.message; error.hidden = !active; if (active) onError(failure); }
  }
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(sync); }
  new ResizeObserver(schedule).observe(slot); window.addEventListener('resize',schedule); document.querySelector('.content').addEventListener('scroll',() => { if (active) schedule(); });
  window.addEventListener('hephaestus-workspace',event => { route = event.detail ?? 'thread'; selectCost = route === 'usage'; navigateRequested = true; navigate('workspace'); });
  document.getElementById('workspace-conversation').onclick = () => { route = 'thread'; navigateRequested = true; schedule(); };
  return {navigate(page) { active = page === 'workspace'; if (active) navigateRequested = true; schedule(); },updateState(state) { if (lastConnection !== state.connection) { lastConnection = state.connection; lastKey = ''; if (active && state.connection === 'connected') schedule(); } }};
}
