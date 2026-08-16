'use strict';

/**
 * itqan Shield — Electron main process.
 *
 * Responsibilities:
 *  - Tray icon + menu (the app lives in the tray)
 *  - Hidden main window (status, agents, keywords, log)
 *  - Local proxy lifecycle; filter engine wired into the inspector seam
 *  - Ask-each-time dialog (fail-closed decision provider)
 *  - Settings + keyword store persistence; decision log
 *  - "Filter active" routes the OS through the proxy (reverted on quit)
 */

const { app, BrowserWindow, Tray, Menu, nativeTheme, ipcMain, dialog } = require('electron');
const path = require('path');
const { startProxy } = require('../proxy/server');
const { loadOrCreateCA, CA_CN } = require('../proxy/ca');
const { installCa, uninstallCa } = require('../proxy/ca-trust');
const {
  enableSystemProxy,
  disableSystemProxy,
  getSystemProxyState,
} = require('../proxy/system-proxy');
const settingsStore = require('./settings');
const keywordStore = require('../filter/keywords');
const { createEngine } = require('../filter/engine');
const { createAskProvider } = require('./ask-dialog');
const logStore = require('./log');
const { KNOWN_AGENTS, customAgentFromInput } = require('../filter/agent-registry');

const DEFAULT_PORT = 8080;

let mainWindow = null;
let tray = null;
let proxy = null;
let filterActive = false;
let quitting = false;
let settings = null;
let kwStore = null;
let engine = null;
let askProvider = null;

const logger = console;

const dataDir = () => app.getPath('userData');

// ------------------------------------------------------------- window / tray

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 720,
    show: false,
    title: 'itqan Shield',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function trayIconPath() {
  if (process.platform === 'darwin') {
    return path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');
  }
  const dark = nativeTheme.shouldUseDarkColors;
  return path.join(__dirname, '..', '..', 'assets', dark ? 'tray.png' : 'tray-dark.png');
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(trayIconPath());
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open itqan Shield', click: showWindow },
    {
      label: 'Filter active',
      type: 'checkbox',
      checked: filterActive,
      click: (item) => toggleFilter(item.checked),
    },
    { type: 'separator' },
    { label: 'Install CA (trust this device)', click: () => installCaAction() },
    { label: 'Remove CA', click: () => uninstallCaAction() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  try {
    tray = new Tray(trayIconPath());
    tray.setToolTip('itqan Shield');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);
    nativeTheme.on('updated', refreshTray);
  } catch (err) {
    logger.warn(`[shield] tray unavailable: ${err.message}`);
  }
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

// ------------------------------------------------------------- filter wiring

function buildEngine() {
  askProvider = createAskProvider({
    logger,
    onLog: (entry) => logStore.append(dataDir(), { type: 'ask', ...entry }),
  });

  engine = createEngine({
    store: kwStore,
    settings,
    askForDecision: (q) => askProvider.askForDecision(q),
    onDecision: (entry) => logStore.append(dataDir(), { type: 'decision', ...entry }),
    askTimeoutMs: settings.askTimeoutMs || 30000,
    logger,
  });

  // The proxy's inspector seam: engine.inspectRequest + recordDecision.
  return {
    failOpen: true,
    inspectRequest: (ctx) => engine.inspectRequest(ctx),
    recordDecision: () => {},
  };
}

// ------------------------------------------------------------- proxy control

async function ensureProxy() {
  if (proxy) return proxy;
  const inspector = buildEngine();
  proxy = await startProxy({ port: DEFAULT_PORT, dataDir: dataDir(), logger, inspector });
  logger.info(`[shield] proxy running on 127.0.0.1:${proxy.port}`);
  return proxy;
}

async function toggleFilter(enabled) {
  if (enabled === filterActive) return;
  const p = await ensureProxy();
  if (enabled) {
    const r = await enableSystemProxy(p.port, { dataDir: dataDir() });
    if (!r.ok) {
      dialog.showErrorBox('itqan Shield', `Could not enable system proxy:\n${r.error}`);
      refreshTray();
      return;
    }
    filterActive = true;
  } else {
    const r = await disableSystemProxy({ dataDir: dataDir() });
    if (!r.ok) {
      dialog.showErrorBox('itqan Shield', `Could not disable system proxy:\n${r.error}`);
      refreshTray();
      return;
    }
    filterActive = false;
  }
  refreshTray();
  notifyRenderer();
}

async function installCaAction() {
  const r = await installCa(dataDir());
  dialog.showMessageBox(mainWindow, {
    type: r.ok ? 'info' : 'error',
    title: 'itqan Shield — CA',
    message: r.ok ? 'Certificate installed' : 'Install failed',
    detail: r.ok ? r.message : `${r.error}\n\n${r.hint || ''}`,
  });
}

async function uninstallCaAction() {
  const r = await uninstallCa(dataDir());
  dialog.showMessageBox(mainWindow, {
    type: r.ok ? 'info' : 'error',
    title: 'itqan Shield — CA',
    message: r.ok ? 'Certificate removed' : 'Removal failed',
    detail: r.ok ? r.message : `${r.error}\n\n${r.hint || ''}`,
  });
}

// ------------------------------------------------------------- state / IPC

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shield:state-changed', {
      filterActive,
      port: proxy ? proxy.port : null,
    });
  }
}

function persist() {
  try {
    settingsStore.save(dataDir(), settings);
    keywordStore.save(dataDir(), kwStore);
  } catch (err) {
    logger.warn(`[shield] persist failed: ${err.message}`);
  }
}

function getState() {
  const ca = loadOrCreateCA(dataDir());
  const agents = KNOWN_AGENTS.map((a) => ({
    ...a,
    enabled: settings.agents[a.id] === undefined ? true : settings.agents[a.id].enabled,
  }));
  return {
    runtime: {
      filterActive,
      running: !!proxy,
      port: proxy ? proxy.port : null,
      caPath: ca.paths.cert,
      platform: process.platform,
    },
    config: {
      agents,
      customAgents: settings.customAgents || [],
      keywords: kwStore,
      askTimeoutMs: settings.askTimeoutMs || 30000,
    },
  };
}

ipcMain.handle('shield:get-state', () => getState());
ipcMain.handle('shield:get-log', (_e, limit) => logStore.recent(dataDir(), limit || 100));
ipcMain.handle('shield:toggle-filter', (_e, enabled) => toggleFilter(!!enabled));
ipcMain.handle('shield:install-ca', () => installCaAction());
ipcMain.handle('shield:remove-ca', () => uninstallCaAction());
ipcMain.handle('shield:open-window', () => showWindow());

ipcMain.handle('shield:set-agent-enabled', (_e, id, enabled) => {
  settings.agents[id] = { enabled: !!enabled };
  persist();
  return getState();
});

ipcMain.handle('shield:add-custom-agent', (_e, name, input) => {
  const id = `custom-${Date.now().toString(36)}`;
  settings.customAgents = settings.customAgents || [];
  settings.customAgents.push(customAgentFromInput(id, name, input));
  persist();
  return getState();
});

ipcMain.handle('shield:remove-custom-agent', (_e, id) => {
  settings.customAgents = (settings.customAgents || []).filter((a) => a.id !== id);
  persist();
  return getState();
});

ipcMain.handle('shield:add-keyword', (_e, input) => {
  const rule = keywordStore.addLocalRule(kwStore, input);
  persist();
  return { rule, state: getState() };
});

ipcMain.handle('shield:remove-keyword', (_e, id) => {
  keywordStore.removeLocalRule(kwStore, id);
  persist();
  return getState();
});

ipcMain.handle('shield:set-keyword-enabled', (_e, id, enabled) => {
  for (const r of [...kwStore.central, ...kwStore.local]) {
    if (r.id === id) r.enabled = !!enabled;
  }
  persist();
  return getState();
});

ipcMain.handle('shield:ask-decision', (_e, id, verdict) => {
  return askProvider ? askProvider.resolveDecision(id, verdict) : false;
});

// ------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    settings = settingsStore.load(dataDir());
    kwStore = keywordStore.load(dataDir());

    // Cloud sync seam: apply central keywords when a backend exists.
    try {
      const remote = await require('./sync').syncKeywords();
      if (remote.central && remote.central.length) kwStore.central = remote.central;
    } catch (err) {
      logger.warn(`[shield] sync unavailable: ${err.message}`);
    }

    createWindow();
    createTray();
    try {
      await ensureProxy();
    } catch (err) {
      logger.error(`[shield] proxy failed to start: ${err.message}`);
    }
    notifyRenderer();

    if (process.env.SHIELD_SMOKE_TEST === '1') {
      try {
        console.log('SMOKE_OK ' + JSON.stringify({ port: proxy ? proxy.port : null, agents: KNOWN_AGENTS.length }));
      } catch (err) {
        console.error('SMOKE_FAIL ' + err.message);
        process.exitCode = 1;
      } finally {
        quitting = true;
        app.quit();
      }
    }
  });

  app.on('window-all-closed', () => {
    // Tray app: keep running on all platforms.
  });

  app.on('before-quit', async (e) => {
    if (quitting || proxy === null) return;
    e.preventDefault();
    quitting = true;
    if (filterActive) {
      await disableSystemProxy({ dataDir: dataDir() });
    }
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
    persist();
    app.quit();
  });
}
