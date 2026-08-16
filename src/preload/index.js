'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shield', {
  getStatus: () => ipcRenderer.invoke('shield:status'),
  toggleFilter: (enabled) => ipcRenderer.invoke('shield:toggle-filter', enabled),
  installCa: () => ipcRenderer.invoke('shield:install-ca'),
  removeCa: () => ipcRenderer.invoke('shield:remove-ca'),
  openWindow: () => ipcRenderer.invoke('shield:open-window'),
  onStatusChanged: (cb) => {
    ipcRenderer.on('shield:status-changed', (_e, payload) => cb(payload));
  },
});
