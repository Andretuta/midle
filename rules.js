'use strict';
// Decisao da regra automatica, isolada do Electron para ser testavel.
// Conservadora de proposito: sem telemetria fresca da janela, nao dispara nada.
// Toda resposta traz um `code` dizendo por que disparou ou nao, para o card mostrar.
const STALE_MS = 120_000;

/**
 * code: kill | off | not_ready | no_telemetry | stale | ok | grace | cooldown | fire
 * @param {object} acc
 * @param {number} [now]
 * @param {{killSwitch?:boolean}} [settings]
 * @returns {{fire:boolean, badSince:number, code:string, why?:string, until?:number}}
 */
function evaluate(acc, now = Date.now(), settings = {}) {
  const r = acc.rules || {};
  if (settings.killSwitch) return { fire: false, badSince: 0, code: 'kill' };
  if (!r.enabled) return { fire: false, badSince: 0, code: 'off' };
  if (acc.status !== 'ready') return { fire: false, badSince: 0, code: 'not_ready' };
  const s = acc.stats;
  if (!s || !acc.statsAt) return { fire: false, badSince: 0, code: 'no_telemetry' };
  if (now - acc.statsAt > STALE_MS) return { fire: false, badSince: 0, code: 'stale' };

  const manual = s.manualMode === 1 || s.manualMode === true;
  const slow = typeof s.xpPerMin === 'number' && s.xpPerMin < r.minXpPerMin;
  if (!manual && !slow) return { fire: false, badSince: 0, code: 'ok' };
  const why = manual ? 'personagem em modo manual' : `xp/min ${s.xpPerMin} < ${r.minXpPerMin}`;

  const badSince = acc.badSince || now;
  const graceEnd = badSince + (r.graceMin || 0) * 60_000;
  if (now < graceEnd) return { fire: false, badSince, code: 'grace', why, until: graceEnd };
  const cooldownEnd = (acc.lastMacroAt || 0) + (r.cooldownMin || 0) * 60_000;
  if (now < cooldownEnd) return { fire: false, badSince, code: 'cooldown', why, until: cooldownEnd };
  return { fire: true, badSince: 0, code: 'fire', why };
}

module.exports = { evaluate, STALE_MS };
