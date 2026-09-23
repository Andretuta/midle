'use strict';
// Checagem minima do que pode quebrar calado: isolamento de credencial entre
// contas e a regra que aperta botao sozinha no personagem.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountOAuthProvider } = require('../oauth-store');
const vm = require('vm');
const { evaluate } = require('../rules');

const MIN = 60_000;
const base = (over = {}) => ({
  status: 'ready', statsAt: Date.now(), badSince: 0, lastMacroAt: 0,
  rules: { enabled: true, minXpPerMin: 200, graceMin: 5, cooldownMin: 15 },
  stats: { xpPerMin: 5000, manualMode: 0 }, ...over,
});

// --- isolamento por conta ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
const redirect = 'http://127.0.0.1:51380/callback';
const p1 = new AccountOAuthProvider('acc1', path.join(dir, 'acc1'), redirect, async () => {});
const p2 = new AccountOAuthProvider('acc2', path.join(dir, 'acc2'), redirect, async () => {});
p1.saveTokens({ access_token: 't1', refresh_token: 'r1' });
p2.saveTokens({ access_token: 't2', refresh_token: 'r2' });
assert.strictEqual(p1.tokens().access_token, 't1');
assert.strictEqual(p2.tokens().access_token, 't2', 'token de uma conta vazou para a outra');
assert.strictEqual(p1.state(), 'acc1', 'state precisa rotear o callback para a conta certa');
assert.notStrictEqual(p1.clientMetadata.client_name, p2.clientMetadata.client_name);
p1.saveCodeVerifier('v1');
assert.strictEqual(p1.codeVerifier(), 'v1');
assert.strictEqual(p2.tokens().access_token, 't2');
p1.invalidateCredentials('tokens');
assert.strictEqual(p1.tokens(), undefined);
assert.strictEqual(p2.tokens().access_token, 't2', 'limpar uma conta apagou a outra');
assert.strictEqual(fs.statSync(path.join(dir, 'acc2', 'tokens.json')).mode & 0o077, 0, 'token legivel por outros');
fs.rmSync(dir, { recursive: true, force: true });

// --- regra automatica ---
const now = Date.now();
assert.strictEqual(evaluate(base(), now).fire, false, 'farm saudavel nao pode disparar');
assert.strictEqual(evaluate(base({ stats: { manualMode: 1 } }), now).fire, false, 'precisa respeitar a espera');
assert.strictEqual(evaluate(base({ stats: { manualMode: 1 }, badSince: now - 6 * MIN }), now).fire, true, 'modo manual sustentado tem que religar');
assert.strictEqual(evaluate(base({ stats: { xpPerMin: 10 }, badSince: now - 6 * MIN }), now).fire, true, 'xp/min abaixo do minimo tem que religar');
assert.strictEqual(evaluate(base({ stats: { xpPerMin: 10 }, badSince: now - 6 * MIN, lastMacroAt: now - 2 * MIN }), now).fire, false, 'cooldown ignorado');
assert.strictEqual(evaluate(base({ stats: { manualMode: 1 }, badSince: now - 6 * MIN, statsAt: now - 5 * MIN }), now).fire, false, 'telemetria velha nao pode virar acao');
assert.strictEqual(evaluate(base({ stats: null, badSince: now - 6 * MIN }), now).fire, false, 'sem telemetria nao age');
assert.strictEqual(evaluate(base({ status: 'blocked', stats: { manualMode: 1 }, badSince: now - 6 * MIN }), now).fire, false, 'conta bloqueada no jogo nao entra em loop');
assert.strictEqual(evaluate(base({ rules: { enabled: false, minXpPerMin: 200, graceMin: 5, cooldownMin: 15 }, stats: { manualMode: 1 }, badSince: now - 6 * MIN }), now).fire, false, 'regra desligada disparou');

// --- motivo de nao disparar (o card mostra) ---
const code = (acc, opts) => evaluate(acc, now, opts).code;
assert.strictEqual(code(base(), { killSwitch: true }), 'kill');
assert.strictEqual(evaluate(base({ stats: { manualMode: 1 }, badSince: now - 6 * MIN }), now, { killSwitch: true }).fire, false, 'botao de panico ignorado');
assert.strictEqual(code(base({ rules: { enabled: false } })), 'off');
assert.strictEqual(code(base({ status: 'needs_auth' })), 'not_ready');
assert.strictEqual(code(base({ stats: null, statsAt: 0 })), 'no_telemetry');
assert.strictEqual(code(base({ statsAt: now - 5 * MIN })), 'stale');
assert.strictEqual(code(base()), 'ok');
const g = evaluate(base({ stats: { manualMode: 1 }, badSince: now - 2 * MIN }), now);
assert.strictEqual(g.code, 'grace');
assert.strictEqual(g.until, now + 3 * MIN, 'card precisa saber quanto falta da espera');
const cd = evaluate(base({ stats: { xpPerMin: 10 }, badSince: now - 6 * MIN, lastMacroAt: now - 2 * MIN }), now);
assert.strictEqual(cd.code, 'cooldown');
assert.strictEqual(cd.until, now + 13 * MIN);
assert.strictEqual(evaluate(base({ stats: { manualMode: 1 }, badSince: now - 6 * MIN }), now).code, 'fire');

// --- heartbeat do probe: estado parado nao pode virar telemetria velha ---
function loadProbe() {
  const sent = [];
  let tick = null;
  let clock = 1_000_000;
  class FakeWS {
    constructor() { this.readyState = FakeWS.OPEN; this.l = {}; }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    emit(t, ev) { for (const fn of this.l[t] || []) fn(ev); }
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const window = { WebSocket: FakeWS };
  const sandbox = {
    window, document: { body: { innerText: '' } }, Blob: class {}, ArrayBuffer,
    Date: { now: () => clock },
    setInterval: (fn) => { tick = fn; },
    require: () => ({ ipcRenderer: { sendToHost: (ch, d) => { if (ch === 'probe:stats') sent.push({ ...d }); } } }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'game-probe.js'), 'utf8'), sandbox);
  const ws = new window.WebSocket('wss://x');
  return {
    sent, ws,
    msg: (o) => ws.emit('message', { data: JSON.stringify(o) }),
    run: (seconds) => { for (let i = 0; i < seconds; i++) { clock += 1000; tick(); } },
  };
}
const pr = loadProbe();
pr.msg({ manualMode: 1, xpPerMin: 0 });
pr.run(1);
assert.strictEqual(pr.sent.length, 1, 'mudanca precisa sair no tick seguinte');
pr.run(60);
assert.ok(pr.sent.length >= 4, `estado parado precisa de heartbeat (so ${pr.sent.length} envios em 60s)`);
assert.strictEqual(pr.sent.at(-1).manualMode, 1);
pr.ws.readyState = 3;
const before = pr.sent.length;
pr.run(60);
assert.strictEqual(pr.sent.length, before, 'socket fechado nao pode fingir telemetria fresca');

console.log('selfcheck ok');
