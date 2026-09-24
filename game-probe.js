'use strict';
// Preload da webview do jogo. Le o HUD que o jogo desenha em texto e manda para o
// painel, sem gastar chamada MCP e sem tomar controle do personagem.
//
// Ja tentou espelhar o websocket do jogo para colher nivel, zen e joias direto do
// protocolo. **Nao funcionava, e nunca funcionou** -- medido em 16/09/2026: o
// preload roda em MUNDO ISOLADO, e o Electron 33 nao deixa mais desligar isso por
// atributo do webview. Envolver `window.WebSocket` aqui patcheia um `window` que a
// pagina do jogo nao usa, entao nenhuma mensagem jamais passou por ali.
//
// Consequencias que valem lembrar:
//   - toda a telemetria do modo ver sempre veio DESTA leitura de texto;
//   - joias nunca chegaram por aqui, e por isso aparecem ausentes no painel de farm;
//   - o DOM e compartilhado entre os mundos, por isso ler texto funciona.
//
// Quem precisar mexer na pagina de verdade tem que usar `webview.executeJavaScript`,
// que roda no mundo principal -- e o caminho que o limitador de quadros usa.
const { ipcRenderer } = require('electron');
const { parseHud } = require('./hud-parse');

let digest = {};
let dirty = false;

function scrapeDom() {
  for (const [k, v] of Object.entries(parseHud(document.body?.innerText || ''))) {
    if (digest[k] !== v) { digest[k] = v; dirty = true; }
  }
}

setInterval(() => {
  scrapeDom();
  if (!dirty) return;
  dirty = false;
  ipcRenderer.sendToHost('probe:stats', digest);
}, 1000);
