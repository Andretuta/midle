'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
// Decisoes puras chegam a interface por aqui. O renderer roda isolado e nao tem
// require; a ponte e o unico caminho, e e o certo: a tela consome decisao, nao decide.
const { colunas, ganhoDoDia } = require('../grade');
const { ultimaTentativa, podeTentar, marcaDepois, VIGIA_REPOUSO_MS, VIGIA_TENTATIVAS_MAX } = require('../trilha');

contextBridge.exposeInMainWorld('fleet', {
  colunas,
  ganhoDoDia,
  ultimaTentativa,
  podeTentar,
  marcaDepois,
  VIGIA_REPOUSO_MS,
  VIGIA_TENTATIVAS_MAX,
  probeUrl: pathToFileURL(path.join(__dirname, '..', 'game-probe.js')).toString(),
  get: () => ipcRenderer.invoke('fleet:get'),
  addAccount: (cfg) => ipcRenderer.invoke('fleet:addAccount', cfg),
  removeAccount: (id) => ipcRenderer.invoke('fleet:removeAccount', id),
  updateAccount: (id, patch) => ipcRenderer.invoke('fleet:updateAccount', { id, patch }),
  setSettings: (patch) => ipcRenderer.invoke('fleet:setSettings', patch),
  authorize: (id) => ipcRenderer.invoke('fleet:authorize', id),
  action: (id, action) => ipcRenderer.invoke('fleet:action', { id, action }),
  setMode: (id, modo) => ipcRenderer.invoke('fleet:setMode', id, modo),
  closeAllWindows: () => ipcRenderer.invoke('fleet:closeAllWindows'),
  menuConta: (id) => ipcRenderer.invoke('fleet:menuConta', id),
  soltar: (id) => ipcRenderer.invoke('fleet:soltar', id),
  recolher: (id) => ipcRenderer.invoke('fleet:recolher', id),
  onAlvoSolta: (cb) => ipcRenderer.on('fleet:alvoSolta', (_e, v) => cb(v)),
  onRecarregar: (cb) => ipcRenderer.on('fleet:recarregar', (_e, id) => cb(id)),
  resumeAccount: (id) => ipcRenderer.invoke('fleet:resumeAccount', id),
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, s) => cb(s)),
  onNotice: (cb) => ipcRenderer.on('fleet:notice', (_e, n) => cb(n)),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSave: (cfg) => ipcRenderer.invoke('ai:save', cfg),
  aiClear: () => ipcRenderer.invoke('ai:clear'),
  aiModels: (p) => ipcRenderer.invoke('ai:models', p),
  aiChat: (t) => ipcRenderer.invoke('ai:chat', t),
  aiReset: () => ipcRenderer.invoke('ai:reset'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxySave: (cfg) => ipcRenderer.invoke('proxy:save', cfg),
  proxyClear: () => ipcRenderer.invoke('proxy:clear'),
  proxyTest: (id) => ipcRenderer.invoke('proxy:test', id),
  metrics: () => ipcRenderer.invoke('system:metrics'),
  clearCache: () => ipcRenderer.invoke('system:clearCache'),
  logoutGame: (id) => ipcRenderer.invoke('fleet:logoutGame', id),
  sendStats: (id, stats) => ipcRenderer.send('probe:stats', { id, stats }),
});
