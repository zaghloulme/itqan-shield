'use strict';

/**
 * OS-level system proxy control (Windows + macOS).
 *
 * Windows: HKCU Internet Settings registry — no admin needed, instant apply
 *          for most apps (browsers may need a restart or settings refresh).
 * macOS:   `networksetup` per network service — may prompt for admin.
 *
 * Both remember the prior state in <data-dir>/system-proxy.json so disabling
 * restores exactly what was there before the app touched it.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function statePath(dataDir) {
  return path.join(dataDir, 'system-proxy.json');
}

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2));
  } catch (err) {
    /* best effort */
  }
}

// ---------------------------------------------------------------- Windows

async function winQuery() {
  const r = await run('reg', ['query', WIN_KEY]);
  if (r.err) return { ok: false, error: r.stderr.trim() || r.err.message };
  const out = { ProxyEnable: null, ProxyServer: null, ProxyOverride: null };
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.+)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return { ok: true, values: out };
}

async function winEnable(port, dataDir) {
  const prior = await winQuery();
  const set = [
    ['ProxyEnable', 'REG_DWORD', '1'],
    ['ProxyServer', 'REG_SZ', `127.0.0.1:${port}`],
    ['ProxyOverride', 'REG_SZ', '<local>'],
  ];
  for (const [v, t, d] of set) {
    const r = await run('reg', ['add', WIN_KEY, '/v', v, '/t', t, '/d', d, '/f']);
    if (r.err) return { ok: false, error: `reg add ${v}: ${r.stderr.trim() || r.err.message}` };
  }
  // record prior only if we haven't already stored state (idempotent enable)
  if (prior.ok && !readState(dataDir)) {
    writeState(dataDir, { platform: 'win32', prior: prior.values });
  }
  return { ok: true };
}

async function winDisable(dataDir) {
  const state = readState(dataDir);
  if (state && state.prior) {
    const p = state.prior;
    if (p.ProxyEnable === '0x0' || p.ProxyEnable === '0' || p.ProxyEnable === null) {
      await run('reg', ['add', WIN_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    } else {
      if (p.ProxyEnable) {
        await run('reg', ['add', WIN_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', p.ProxyEnable, '/f']);
      }
      if (p.ProxyServer) {
        await run('reg', ['add', WIN_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', p.ProxyServer, '/f']);
      }
      if (p.ProxyOverride) {
        await run('reg', ['add', WIN_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', p.ProxyOverride, '/f']);
      }
    }
    fs.unlinkSync(statePath(dataDir));
  } else {
    await run('reg', ['add', WIN_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  }
  return { ok: true };
}

// ----------------------------------------------------------------- macOS

async function darwinServices() {
  const r = await run('networksetup', ['-listallnetworkservices']);
  if (r.err) return { ok: false, error: r.stderr.trim() || r.err.message };
  const services = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('*'));
  return { ok: true, services };
}

async function darwinGetProxy(svc, kind) {
  const flag = kind === 'web' ? '-getwebproxy' : '-getsecurewebproxy';
  const r = await run('networksetup', [flag, svc]);
  const out = { enabled: false, server: '', port: 0 };
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^Enabled:\s*(Yes|No)$/.exec(line.trim());
    if (m) out.enabled = m[1] === 'Yes';
    const s = /^Server:\s*(.+)$/.exec(line.trim());
    if (s) out.server = s[1].trim();
    const p = /^Port:\s*(\d+)$/.exec(line.trim());
    if (p) out.port = parseInt(p[1], 10);
  }
  return out;
}

async function darwinSetProxy(svc, kind, port) {
  const set = kind === 'web' ? '-setwebproxy' : '-setsecurewebproxy';
  const state = kind === 'web' ? '-setwebproxystate' : '-setsecurewebproxystate';
  const r1 = await run('networksetup', [set, svc, '127.0.0.1', String(port)]);
  if (r1.err) return { ok: false, error: `${svc} ${set}: ${r1.stderr.trim() || r1.err.message}` };
  const r2 = await run('networksetup', [state, svc, 'on']);
  if (r2.err) return { ok: false, error: `${svc} ${state}: ${r2.stderr.trim() || r2.err.message}` };
  return { ok: true };
}

async function darwinRestoreProxy(svc, kind, prior) {
  const state = kind === 'web' ? '-setwebproxystate' : '-setsecurewebproxystate';
  if (prior && prior.enabled) {
    const set = kind === 'web' ? '-setwebproxy' : '-setsecurewebproxy';
    await run('networksetup', [set, svc, prior.server || '127.0.0.1', String(prior.port || 8080)]);
    await run('networksetup', [state, svc, 'on']);
  } else {
    await run('networksetup', [state, svc, 'off']);
  }
  return { ok: true };
}

async function darwinEnable(port, dataDir) {
  const svcs = await darwinServices();
  if (!svcs.ok) return svcs;
  const prior = {};
  let firstError = null;
  for (const svc of svcs.services) {
    prior[svc] = {
      web: await darwinGetProxy(svc, 'web'),
      secure: await darwinGetProxy(svc, 'secure'),
    };
    const r1 = await darwinSetProxy(svc, 'web', port);
    if (!r1.ok && !firstError) firstError = r1.error;
    const r2 = await darwinSetProxy(svc, 'secure', port);
    if (!r2.ok && !firstError) firstError = r2.error;
  }
  if (!readState(dataDir)) {
    writeState(dataDir, { platform: 'darwin', prior });
  }
  if (firstError) return { ok: false, error: firstError };
  return { ok: true };
}

async function darwinDisable(dataDir) {
  const state = readState(dataDir);
  const svcs = await darwinServices();
  if (!svcs.ok) return svcs;
  for (const svc of svcs.services) {
    const prior = state && state.prior ? state.prior[svc] : null;
    await darwinRestoreProxy(svc, 'web', prior ? prior.web : null);
    await darwinRestoreProxy(svc, 'secure', prior ? prior.secure : null);
  }
  try {
    fs.unlinkSync(statePath(dataDir));
  } catch {
    /* ignore */
  }
  return { ok: true };
}

// ------------------------------------------------------------------ public

async function enableSystemProxy(port, { dataDir, platform = process.platform } = {}) {
  if (platform === 'win32') return winEnable(port, dataDir);
  if (platform === 'darwin') return darwinEnable(port, dataDir);
  return { ok: false, error: `system proxy not supported on ${platform} (dev: use curl -x)` };
}

async function disableSystemProxy({ dataDir, platform = process.platform } = {}) {
  if (platform === 'win32') return winDisable(dataDir);
  if (platform === 'darwin') return darwinDisable(dataDir);
  return { ok: false, error: `system proxy not supported on ${platform}` };
}

async function getSystemProxyState({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const q = await winQuery();
    if (!q.ok) return { ok: false, error: q.error };
    return { ok: true, enabled: q.values.ProxyEnable === '0x1', server: q.values.ProxyServer };
  }
  if (platform === 'darwin') {
    const svcs = await darwinServices();
    if (!svcs.ok) return svcs;
    const states = [];
    for (const svc of svcs.services) {
      const web = await darwinGetProxy(svc, 'web');
      if (web.enabled) states.push({ service: svc, web });
    }
    return { ok: true, enabled: states.length > 0, services: states };
  }
  return { ok: false, error: `system proxy not supported on ${platform}` };
}

module.exports = { enableSystemProxy, disableSystemProxy, getSystemProxyState };
