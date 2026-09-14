'use strict';
// Preload da webview do jogo. Espelha o websocket do Lorvath para alimentar os
// cards sem gastar chamada MCP e sem tomar controle do personagem.
// Precisa de contextIsolation=no na webview para enxergar o window da pagina.
// ponytail: le o protocolo interno do jogo por heuristica de chaves; se o Lorvath
// mudar o formato, o fallback de DOM assume e o MCP (game_account) continua correto.
const { ipcRenderer } = require('electron');

const KEYS = new Set([
  'level', 'xp', 'xpMax', 'xpPerMin', 'killsPerMin', 'manualMode', 'zen', 'map', 'server',
  'name', 'hp', 'maxHp', 'mp', 'vipUntil', 'targetId', 'autoPotion', 'autoSell', 'autoRepair',
]);
const JEWELS = ['bless', 'soul', 'chaos', 'creation'];

let digest = {};
let dirty = false;
let sampled = 0;

function harvest(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) { for (const v of node.slice(0, 50)) harvest(v, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    if (v !== null && typeof v === 'object') {
      if (k === 'jewels') {
        for (const j of JEWELS) if (typeof v[j] === 'number') { digest[`jewel_${j}`] = v[j]; dirty = true; }
      }
      harvest(v, depth + 1);
    } else if (KEYS.has(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
      if (digest[k] !== v) { digest[k] = v; dirty = true; }
    }
  }
}

function ingest(raw) {
  if (typeof raw !== 'string' || raw[0] !== '{' && raw[0] !== '[') return;
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (sampled < 25) { sampled++; ipcRenderer.sendToHost('probe:sample', raw.slice(0, 4000)); }
  harvest(obj);
}

const NativeWS = window.WebSocket;
function PatchedWS(url, protocols) {
  const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  ws.addEventListener('message', (ev) => {
    try {
      if (typeof ev.data === 'string') ingest(ev.data);
      else if (ev.data instanceof Blob && sampled < 25) { sampled++; ipcRenderer.sendToHost('probe:sample', `<binary blob ${ev.data.size}b>`); }
      else if (ev.data instanceof ArrayBuffer && sampled < 25) { sampled++; ipcRenderer.sendToHost('probe:sample', `<binary buffer ${ev.data.byteLength}b>`); }
    } catch {}
  });
  return ws;
}
PatchedWS.prototype = NativeWS.prototype;
for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) PatchedWS[k] = NativeWS[k];
try { window.WebSocket = PatchedWS; } catch {}

// Fallback: se o websocket for binario/ilegivel, le o HUD que o jogo desenha em texto.
function scrapeDom() {
  if (Object.keys(digest).length) return;
  const t = document.body?.innerText || '';
  const xp = t.match(/XP\s*\/\s*min[^0-9]*([\d.,]+)/i);
  const lv = t.match(/N[ií]vel\s*(\d+)/i) || t.match(/\bLv\.?\s*(\d+)/i);
  if (xp) { digest.xpPerMin = Number(xp[1].replace(/[.,]/g, '')); dirty = true; }
  if (lv) { digest.level = Number(lv[1]); dirty = true; }
}

setInterval(() => {
  scrapeDom();
  if (!dirty) return;
  dirty = false;
  ipcRenderer.sendToHost('probe:stats', digest);
}, 1000);
