'use strict';

/**
 * itqan Shield — Electron main process.
 *
 * Responsibilities:
 *  - Tray icon + menu (the app lives in the tray; closing the window keeps it running)
 *  - Hidden main window with the status UI
 *  - Owns the local proxy process lifecycle (starts on launch, stops on quit)
 *  - "Filter active" toggle routes the OS through the proxy (reverted on quit)
 *  - IPC surface for the renderer (status, toggle, install CA, open log…)
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

const DEFAULT_PORT = 8080;

let mainWindow = null;
let tray = null;
let proxy = null;
let filterActive = false; // OS is routed through the proxy
let quitting = false;

const dataDir = () => path.join(app.getPath('userData'));
const logger = console;

// ------------------------------------------------------------- window / tray

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
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
    // Tray app: hide instead of quitting.
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
  // macOS: template image (black + alpha). Windows/Linux: pick by theme.
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
    // Headless/CI environments may have no system tray — the app still works.
    logger.warn(`[shield] tray unavailable: ${err.message}`);
  }
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

// ------------------------------------------------------------- proxy control

async function ensureProxy() {
  if (proxy) return proxy;
  proxy = await startProxy({ port: DEFAULT_PORT, dataDir: dataDir(), logger });
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

// ------------------------------------------------------------- IPC surface

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shield:status-changed', { filterActive, port: proxy ? proxy.port : null });
  }
}

async function statusPayload() {
  const ca = loadOrCreateCA(dataDir());
  const sys = await getSystemProxyState();
  return {
    filterActive,
    running: !!proxy,
    port: proxy ? proxy.port : null,
    caPath: ca.paths.cert,
    caExists: true,
    platform: process.platform,
    sysProxy: sys.ok ? { enabled: sys.enabled, detail: sys.server || sys.services || null } : { error: sys.error },
  };
}

ipcMain.handle('shield:status', () => statusPayload());
ipcMain.handle('shield:toggle-filter', (_e, enabled) => toggleFilter(!!enabled));
ipcMain.handle('shield:install-ca', () => installCaAction());
ipcMain.handle('shield:remove-ca', () => uninstallCaAction());
ipcMain.handle('shield:open-window', () => showWindow());

// ------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    createWindow();
    createTray();
    try {
      await ensureProxy();
    } catch (err) {
      logger.error(`[shield] proxy failed to start: ${err.message}`);
    }
    notifyRenderer();

    // Smoke test hook for CI/headless: print status JSON and exit.
    if (process.env.SHIELD_SMOKE_TEST === '1') {
      try {
        const payload = await statusPayload();
        console.log('SMOKE_OK ' + JSON.stringify(payload));
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
    app.quit();
  });
}
