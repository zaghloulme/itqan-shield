'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shield', {
  // runtime
  getState: () => ipcRenderer.invoke('shield:get-state'),
  getLog: (limit) => ipcRenderer.invoke('shield:get-log', limit),
  toggleFilter: (enabled) => ipcRenderer.invoke('shield:toggle-filter', enabled),
  installCa: () => ipcRenderer.invoke('shield:install-ca'),
  removeCa: () => ipcRenderer.invoke('shield:remove-ca'),
  openWindow: () => ipcRenderer.invoke('shield:open-window'),
  onStateChanged: (cb) => {
    ipcRenderer.on('shield:state-changed', (_e, payload) => cb(payload));
  },

  // agents
  setAgentEnabled: (id, enabled) => ipcRenderer.invoke('shield:set-agent-enabled', id, enabled),
  addCustomAgent: (name, input) => ipcRenderer.invoke('shield:add-custom-agent', name, input),
  removeCustomAgent: (id) => ipcRenderer.invoke('shield:remove-custom-agent', id),

  // keywords
  addKeyword: (input) => ipcRenderer.invoke('shield:add-keyword', input),
  removeKeyword: (id) => ipcRenderer.invoke('shield:remove-keyword', id),
  setKeywordEnabled: (id, enabled) => ipcRenderer.invoke('shield:set-keyword-enabled', id, enabled),

  // ask dialog
  onAskPrompt: (cb) => {
    ipcRenderer.on('ask:prompt', (_e, payload) => cb(payload));
  },
  askDecision: (id, verdict) => ipcRenderer.invoke('shield:ask-decision', id, verdict),
});
