'use strict';
// Le o HUD que o jogo desenha em texto. Fica separado do preload para poder ser
// testado sem Electron: foi aqui que o parser ja leu o nivel do monstro no lugar
// do personagem, e a ordem das regras e o que impede isso de voltar.

// "Lv 138" e o HUD do personagem, no topo da tela.
// "Nivel 84" e o painel do alvo que esta sendo cacado.
// A ordem importa: personagem primeiro, alvo so como ultimo recurso.
const LEVEL_CHAR = /\bLv\.?\s*(\d+)/i;
const LEVEL_FALLBACK = /N[ií]vel\s*(\d+)/i;
const XP_PER_MIN = /XP\s*\/\s*min[^0-9]*([\d.,]+)/i;

/** "24.759" -> 24759 (separador de milhar pt-BR, nao decimal). */
function num(s) {
  return Number(String(s).replace(/[.,]/g, ''));
}

/**
 * @param {string} text innerText da pagina do jogo
 * @returns {{level?:number, xpPerMin?:number}} so as chaves que deram match
 */
function parseHud(text) {
  const t = typeof text === 'string' ? text : '';
  const out = {};
  const lv = t.match(LEVEL_CHAR) || t.match(LEVEL_FALLBACK);
  if (lv) out.level = Number(lv[1]);
  const xp = t.match(XP_PER_MIN);
  if (xp) out.xpPerMin = num(xp[1]);
  return out;
}

module.exports = { parseHud };
