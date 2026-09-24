'use strict';
// Decisao da regra automatica, isolada do Electron para ser testavel.
// Conservadora de proposito: sem telemetria fresca da janela, nao dispara nada.
const STALE_MS = 120_000;

/**
 * @returns {{fire:boolean, badSince:number, why?:string}}
 */
function evaluate(acc, now = Date.now()) {
  const r = acc.rules || {};
  if (!r.enabled || acc.status !== 'ready') return { fire: false, badSince: 0 };
  const s = acc.stats;
  if (!s || !acc.statsAt || now - acc.statsAt > STALE_MS) return { fire: false, badSince: 0 };

  const manual = s.manualMode === 1 || s.manualMode === true;
  const slow = typeof s.xpPerMin === 'number' && s.xpPerMin < r.minXpPerMin;
  if (!manual && !slow) return { fire: false, badSince: 0 };

  const badSince = acc.badSince || now;
  if (now - badSince < (r.graceMin || 0) * 60_000) return { fire: false, badSince };
  if (now - (acc.lastMacroAt || 0) < (r.cooldownMin || 0) * 60_000) return { fire: false, badSince };
  return { fire: true, badSince: 0, why: manual ? 'personagem em modo manual' : `xp/min ${s.xpPerMin} < ${r.minXpPerMin}` };
}

module.exports = { evaluate, STALE_MS };
