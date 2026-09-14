'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('fleet', {
  probeUrl: pathToFileURL(path.join(__dirname, '..', 'game-probe.js')).toString(),
  get: () => ipcRenderer.invoke('fleet:get'),
  addAccount: (label) => ipcRenderer.invoke('fleet:addAccount', label),
  removeAccount: (id) => ipcRenderer.invoke('fleet:removeAccount', id),
  updateAccount: (id, patch) => ipcRenderer.invoke('fleet:updateAccount', { id, patch }),
  setSettings: (patch) => ipcRenderer.invoke('fleet:setSettings', patch),
  authorize: (id) => ipcRenderer.invoke('fleet:authorize', id),
  action: (id, action) => ipcRenderer.invoke('fleet:action', { id, action }),
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, s) => cb(s)),
  sendStats: (id, stats) => ipcRenderer.send('probe:stats', { id, stats }),
  sendSample: (id, raw) => ipcRenderer.send('probe:sample', { id, raw }),
});
