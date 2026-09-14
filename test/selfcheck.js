'use strict';
// Checagem minima do que pode quebrar calado: isolamento de credencial entre
// contas e a regra que aperta botao sozinha no personagem.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountOAuthProvider } = require('../oauth-store');
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

console.log('selfcheck ok');
