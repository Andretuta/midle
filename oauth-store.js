'use strict';
// OAuthClientProvider do SDK MCP, uma instancia por conta.
// Todo o segredo do multi-conta esta aqui: o SDK guarda credencial por instancia,
// entao basta apontar cada conta para uma pasta diferente.
const fs = require('fs');
const path = require('path');

const SCOPES = [
  'game.read', 'game.control', 'inventory.manage', 'inventory.sell', 'craft.execute',
  'market.manage', 'trade.manage', 'social.write', 'guild.manage', 'progression.spend',
  'account.manage',
].join(' ');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  restringir(file);
}

/**
 * O `mode` do writeFileSync **so vale para arquivo recem-criado** -- esta na
 * documentacao do Node, e e uma armadilha silenciosa: um token que ja exista com
 * permissao frouxa (build antiga, copia, umask de outro processo) fica frouxo para
 * sempre, porque toda gravacao seguinte ignora o `mode`. O chmod fecha isso e nao
 * custa nada; no Windows quem protege e a pasta do perfil, e chmod ali nao faz
 * sentido -- por isso a checagem de plataforma, e nao um try/catch mudo.
 */
function restringir(file) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(file, 0o600); } catch { /* sistema de arquivos sem permissao POSIX */ }
}

class AccountOAuthProvider {
  /**
   * @param {string} accountId
   * @param {string} dir            pasta de credenciais da conta
   * @param {string} redirectUri    loopback fixo, registrado no DCR
   * @param {(url: URL, accountId: string) => Promise<void>} openAuth  abre a pagina de autorizacao
   *        na sessao isolada da conta (Electron injeta; testes injetam um stub)
   */
  constructor(accountId, dir, redirectUri, openAuth) {
    this.accountId = accountId;
    this.dir = dir;
    this._redirectUri = redirectUri;
    this._openAuth = openAuth;
  }

  get redirectUrl() { return this._redirectUri; }

  get clientMetadata() {
    return {
      client_name: `MIDLE (${this.accountId})`,
      redirect_uris: [this._redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES,
    };
  }

  // Roteia o callback de volta para a conta certa: varias autorizacoes podem
  // estar abertas ao mesmo tempo compartilhando o mesmo redirect_uri.
  state() { return this.accountId; }

  clientInformation() { return readJson(path.join(this.dir, 'client.json')); }
  saveClientInformation(info) { writeJson(path.join(this.dir, 'client.json'), info); }

  tokens() { return readJson(path.join(this.dir, 'tokens.json')); }
  saveTokens(tokens) { writeJson(path.join(this.dir, 'tokens.json'), tokens); }

  saveCodeVerifier(v) { writeJson(path.join(this.dir, 'verifier.json'), { v }); }
  codeVerifier() {
    const d = readJson(path.join(this.dir, 'verifier.json'));
    if (!d) throw new Error(`sem code_verifier salvo para ${this.accountId}`);
    return d.v;
  }

  async redirectToAuthorization(url) { await this._openAuth(url, this.accountId); }

  invalidateCredentials(scope) {
    const drop = { all: ['client.json', 'tokens.json', 'verifier.json'], tokens: ['tokens.json'], verifier: ['verifier.json'] }[scope] || [];
    for (const f of drop) { try { fs.unlinkSync(path.join(this.dir, f)); } catch {} }
  }
}

module.exports = { AccountOAuthProvider, SCOPES, restringir };
