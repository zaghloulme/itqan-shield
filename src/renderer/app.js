'use strict';

/* itqan Shield — renderer logic (thin: status + toggle + CA actions). */

const els = {
  toggle: document.getElementById('filter-toggle'),
  filterSub: document.getElementById('filter-sub'),
  filterNote: document.getElementById('filter-note'),
  caPath: document.getElementById('ca-path'),
  caInstall: document.getElementById('ca-install'),
  caRemove: document.getElementById('ca-remove'),
  platformLine: document.getElementById('platform-line'),
};

let current = { filterActive: false, running: false, port: null };

function renderStatus() {
  els.toggle.checked = current.filterActive;
  if (current.running) {
    els.filterSub.textContent = `Local proxy running on 127.0.0.1:${current.port}`;
  } else {
    els.filterSub.textContent = 'Proxy stopped';
  }
  if (current.filterActive) {
    els.filterNote.textContent = 'Device AI traffic is being routed through itqan Shield and inspected locally.';
  } else {
    els.filterNote.textContent = 'Proxy is up but the OS is not routed through it yet. Flip the switch to filter device traffic.';
  }
  els.toggle.disabled = !current.running;
  els.platformLine.textContent = `platform: ${current.platform} · CA: ${current.caPath || 'n/a'}`;
}

async function refresh() {
  try {
    current = await window.shield.getStatus();
    renderStatus();
  } catch (err) {
    els.filterSub.textContent = 'Status unavailable';
  }
}

els.toggle.addEventListener('change', async () => {
  els.toggle.disabled = true;
  try {
    await window.shield.toggleFilter(els.toggle.checked);
  } catch (err) {
    els.toggle.checked = !els.toggle.checked;
  }
  await refresh();
});

els.caInstall.addEventListener('click', async () => {
  await window.shield.installCa();
});

els.caRemove.addEventListener('click', async () => {
  await window.shield.removeCa();
});

window.shield.onStatusChanged(() => refresh());

refresh();
