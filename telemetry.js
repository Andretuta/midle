'use strict';
// Telemetria do modo gerenciar, calculada a partir do canal de jogo.
//
// A janela do jogo alimentava o painel raspando o HUD -- fragil, e ja leu o nivel
// do monstro no lugar do personagem. Sem janela nao havia telemetria nenhuma, e a
// regra automatica nunca disparava. Aqui a fonte e `game_state`, que devolve
// contadores acumulados: as taxas saem da diferenca entre duas leituras.
//
// Modulo puro como rules.js, hud-parse.js e modes.js: sem I/O, `now` injetado.

/** Um contador que anda para tras significa sessao nova: comparar seria mentira. */
const reiniciou = (a, b) =>
  b.seconds < a.seconds || b.kills < a.kills || b.xpGained < a.xpGained;

/**
 * Taxas por minuto entre duas leituras de `tally`.
 * @param {{seconds:number, kills:number, xpGained:number}|null} anterior
 * @param {{seconds:number, kills:number, xpGained:number}|null} atual
 * @returns {{xpPerMin:number, killsPerMin:number}|null} nulo quando nao da para saber
 */
function ratesFrom(anterior, atual) {
  if (!anterior || !atual) return null;
  for (const k of ['seconds', 'kills', 'xpGained']) {
    if (typeof anterior[k] !== 'number' || typeof atual[k] !== 'number') return null;
  }
  if (reiniciou(anterior, atual)) return null;
  const dt = atual.seconds - anterior.seconds;
  if (dt <= 0) return null;   // sem tempo decorrido nao ha taxa, e dividir por zero e pior
  const min = dt / 60;
  const taxas = {
    xpPerMin: Math.round((atual.xpGained - anterior.xpGained) / min),
    killsPerMin: Math.round(((atual.kills - anterior.kills) / min) * 10) / 10,
  };
  // Zen so vira taxa quando os dois lados tem o contador acumulado. O `zen` da
  // janela e o da bolsa -- numero diferente, que nao pode ser subtraido deste.
  if (typeof anterior.zenEarned === 'number' && typeof atual.zenEarned === 'number'
      && atual.zenEarned >= anterior.zenEarned) {
    taxas.zenPerHour = Math.round(((atual.zenEarned - anterior.zenEarned) / dt) * 3600);
  }
  return taxas;
}

/**
 * Digest que o painel e a regra automatica consomem.
 * @param {object} overview resposta de game_state section=overview
 * @param {object} tally    resposta de game_state section=tally
 * @param {object|null} anteriorTally amostra anterior, para as taxas
 */
function digestFrom(overview, tally, anteriorTally) {
  const ov = overview?.untrustedGameState || overview || {};
  const ta = tally?.untrustedGameState || tally || {};
  const self = ov.character?.self || ov.self || {};

  const d = {};
  if (typeof self.level === 'number') d.level = self.level;
  if (typeof self.hpPct === 'number') d.hpPct = self.hpPct;
  if (typeof self.state === 'string') d.state = self.state;
  if (typeof ov.character?.map === 'string') d.map = ov.character.map;
  if (typeof overview?.server === 'string') d.server = overview.server;
  // `zenGanho` e o acumulado da sessao. NAO e o dinheiro da bolsa, que vem da
  // janela como `zenBolsa` -- somar os dois daria um numero sem significado.
  if (typeof ta.zenEarned === 'number') d.zenGanho = ta.zenEarned;

  const taxas = ratesFrom(anteriorTally, ta);
  if (taxas) Object.assign(d, taxas);
  return d;
}

/** So os campos que interessam para a proxima comparacao. */
function sampleFrom(tally) {
  const ta = tally?.untrustedGameState || tally || {};
  if (typeof ta.seconds !== 'number') return null;
  const amostra = { seconds: ta.seconds, kills: ta.kills, xpGained: ta.xpGained };
  // Chave ausente e diferente de chave com undefined: a comparacao seguinte olha
  // a forma da amostra, nao so os valores.
  if (typeof ta.zenEarned === 'number') amostra.zenEarned = ta.zenEarned;
  return amostra;
}

module.exports = { ratesFrom, digestFrom, sampleFrom };
