'use strict';

/* itqan Shield — main window logic: filter, agents, keywords, log. */

const els = {
  toggle: document.getElementById('filter-toggle'),
  filterSub: document.getElementById('filter-sub'),
  filterNote: document.getElementById('filter-note'),
  agentList: document.getElementById('agent-list'),
  customAgentInput: document.getElementById('custom-agent-input'),
  customAgentAdd: document.getElementById('custom-agent-add'),
  keywordInput: document.getElementById('keyword-input'),
  keywordMode: document.getElementById('keyword-mode'),
  keywordAdd: document.getElementById('keyword-add'),
  keywordList: document.getElementById('keyword-list'),
  logList: document.getElementById('log-list'),
  logRefresh: document.getElementById('log-refresh'),
  caPath: document.getElementById('ca-path'),
  caInstall: document.getElementById('ca-install'),
  caRemove: document.getElementById('ca-remove'),
  platformLine: document.getElementById('platform-line'),
};

let state = null;

// ---------------------------------------------------------------- rendering

function renderFilter() {
  els.toggle.checked = state.runtime.filterActive;
  if (state.runtime.running) {
    els.filterSub.textContent = `Local proxy running on 127.0.0.1:${state.runtime.port}`;
  } else {
    els.filterSub.textContent = 'Proxy stopped';
  }
  els.filterNote.textContent = state.runtime.filterActive
    ? 'Device AI traffic is routed through itqan Shield and inspected locally.'
    : 'Proxy is up but the OS is not routed through it yet. Flip the switch to filter device traffic.';
  els.toggle.disabled = !state.runtime.running;
  els.platformLine.textContent = `platform: ${state.runtime.platform} · CA: ${state.runtime.caPath || 'n/a'}`;
  els.caPath.textContent = state.runtime.caPath || '…';
}

function renderAgents() {
  const list = state.config.agents;
  const custom = state.config.customAgents || [];
  els.agentList.innerHTML = '';
  for (const a of list) {
    els.agentList.appendChild(agentRow(a, false));
  }
  for (const a of custom) {
    els.agentList.appendChild(agentRow(a, true));
  }
}

function agentRow(agent, custom) {
  const li = document.createElement('li');
  let label = document.createElement('span');
  label.textContent = agent.name;
  if (custom) {
    const hosts = document.createElement('span');
    hosts.className = 'muted small';
    hosts.textContent = agent.hosts.join(', ');
    const wrap = document.createElement('span');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.appendChild(label);
    wrap.appendChild(hosts);
    label = wrap;
  }
  li.appendChild(label);

  const right = document.createElement('span');
  right.className = 'agent-right';
  if (custom) {
    const rm = document.createElement('button');
    rm.className = 'btn ghost mini';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      state = await window.shield.removeCustomAgent(agent.id);
      renderAll();
    });
    right.appendChild(rm);
  }
  const toggle = document.createElement('label');
  toggle.className = 'switch small-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!agent.enabled;
  input.addEventListener('change', async () => {
    state = await window.shield.setAgentEnabled(agent.id, input.checked);
    renderAll();
  });
  const slider = document.createElement('span');
  slider.className = 'slider';
  toggle.appendChild(input);
  toggle.appendChild(slider);
  right.appendChild(toggle);
  li.appendChild(right);
  return li;
}

function renderKeywords() {
  const rules = [...state.config.keywords.central, ...state.config.keywords.local];
  els.keywordList.innerHTML = '';
  if (!rules.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'No keywords yet — add one above.';
    els.keywordList.appendChild(li);
    return;
  }
  for (const r of rules) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = r.text || r.pattern;
    if (r.source === 'central') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'cloud';
      label.appendChild(tag);
    }
    const mode = document.createElement('span');
    mode.className = 'muted small';
    mode.textContent = `${r.mode} · ${r.action}`;
    li.appendChild(label);
    li.appendChild(mode);

    const right = document.createElement('span');
    right.className = 'agent-right';
    if (r.source === 'local') {
      const rm = document.createElement('button');
      rm.className = 'btn ghost mini';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        state = await window.shield.removeKeyword(r.id);
        renderAll();
      });
      right.appendChild(rm);
    }
    const toggle = document.createElement('label');
    toggle.className = 'switch small-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = r.enabled !== false;
    input.addEventListener('change', async () => {
      state = await window.shield.setKeywordEnabled(r.id, input.checked);
      renderAll();
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    toggle.appendChild(input);
    toggle.appendChild(slider);
    right.appendChild(toggle);
    li.appendChild(right);
    els.keywordList.appendChild(li);
  }
}

function renderLog(entries) {
  els.logList.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'No activity yet.';
    els.logList.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    const ts = new Date(e.ts).toLocaleTimeString();
    const badge = document.createElement('span');
    badge.className = `log-badge ${e.decision}`;
    badge.textContent = e.decision;
    const text = document.createElement('span');
    text.textContent = `${ts} · ${e.agent || e.host || '?'} · ${e.keyword || e.reason || ''}`;
    li.appendChild(badge);
    li.appendChild(text);
    els.logList.appendChild(li);
  }
}

function renderAll() {
  if (!state) return;
  renderFilter();
  renderAgents();
  renderKeywords();
}

async function refreshLog() {
  const entries = await window.shield.getLog(50);
  renderLog(entries);
}

// ------------------------------------------------------------------ events

els.toggle.addEventListener('change', async () => {
  els.toggle.disabled = true;
  try {
    await window.shield.toggleFilter(els.toggle.checked);
  } catch {
    els.toggle.checked = !els.toggle.checked;
  }
  state = await window.shield.getState();
  renderAll();
});

els.customAgentAdd.addEventListener('click', async () => {
  const input = els.customAgentInput.value.trim();
  if (!input) return;
  state = await window.shield.addCustomAgent('', input);
  els.customAgentInput.value = '';
  renderAll();
});

els.keywordAdd.addEventListener('click', async () => {
  const text = els.keywordInput.value.trim();
  if (!text) return;
  const mode = els.keywordMode.value;
  await window.shield.addKeyword({ text, mode, action: 'ask', category: 'blocked' });
  els.keywordInput.value = '';
  state = await window.shield.getState();
  renderAll();
});

els.keywordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.keywordAdd.click();
});

els.caInstall.addEventListener('click', async () => window.shield.installCa());
els.caRemove.addEventListener('click', async () => window.shield.removeCa());
els.logRefresh.addEventListener('click', refreshLog);

window.shield.onStateChanged(async () => {
  state = await window.shield.getState();
  renderAll();
  refreshLog();
});

(async () => {
  state = await window.shield.getState();
  renderAll();
  refreshLog();
})();
