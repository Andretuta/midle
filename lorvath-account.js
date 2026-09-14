'use strict';
// Uma conta = um cliente MCP proprio apontando para o mesmo endpoint do Lorvath.
// Sem dependencia de Electron aqui: da para testar headless (test/selfcheck.js).
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { AccountOAuthProvider } = require('./oauth-store');

const MCP_URL = 'https://lorvath.com/mcp/player';

// requestId e deduplicado no servidor de forma persistente (entre sessoes):
// id fixo queima na primeira chamada e nunca mais despacha.
let seq = 0;
const reqId = (accId) => `fleet-${accId}-${Date.now()}-${++seq}`;

// O epoch aparece em posicoes diferentes conforme a resposta; busca em profundidade.
function findEpoch(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (typeof node.controlEpoch === 'string') return node.controlEpoch;
  for (const v of Object.values(node)) {
    const found = findEpoch(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseResult(res) {
  const text = res?.content?.find?.((c) => c.type === 'text')?.text;
  if (!text) return res;
  try { return JSON.parse(text); } catch { return { text }; }
}

class LorvathAccount {
  /**
   * @param {{id:string,label:string,slot?:number}} cfg
   * @param {string} dataDir
   * @param {string} redirectUri
   * @param {(url:URL,accountId:string)=>Promise<void>} openAuth
   */
  constructor(cfg, dataDir, redirectUri, openAuth) {
    this.id = cfg.id;
    this.label = cfg.label || cfg.id;
    this.slot = cfg.slot ?? 0;
    this.provider = new AccountOAuthProvider(this.id, path.join(dataDir, this.id), redirectUri, openAuth);
    this.status = 'offline';      // offline | needs_auth | ready | error | blocked
    this.lastError = null;
    this.account = null;          // ultimo game_account
    this.stats = null;            // ultimo digest do websocket da janela
    this.statsAt = 0;
    this.epoch = null;
    this.lastMacroAt = 0;
    this._client = null;
    this._pending = null;         // transport aguardando finishAuth
  }

  _newTransport() {
    return new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: this.provider });
  }

  /** Conecta usando token salvo. Nao abre navegador: se faltar token, marca needs_auth. */
  async connect() {
    if (this._client) return this._client;
    if (!(await this.provider.tokens())) { this.status = 'needs_auth'; return null; }
    const client = new Client({ name: 'lorvath-fleet', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(this._newTransport());
      this._client = client;
      this.status = 'ready';
      this.lastError = null;
      return client;
    } catch (err) {
      if (err instanceof UnauthorizedError) this.status = 'needs_auth';
      else { this.status = 'error'; this.lastError = String(err.message || err); }
      return null;
    }
  }

  /** Passo 1 da autorizacao: dispara o fluxo, que abre a pagina na sessao da conta. */
  async startAuthorization() {
    const client = new Client({ name: 'lorvath-fleet', version: '0.1.0' }, { capabilities: {} });
    const transport = this._newTransport();
    try {
      await client.connect(transport);
      this._client = client;        // ja tinha token valido
      this.status = 'ready';
      return { authorized: true };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      this._pending = { client, transport };
      this.status = 'needs_auth';
      return { authorized: false };
    }
  }

  /** Passo 2: chega o code no loopback. */
  async finishAuthorization(code) {
    if (!this._pending) throw new Error('nenhuma autorizacao pendente');
    const { client, transport } = this._pending;
    await transport.finishAuth(code);
    this._pending = null;
    await client.connect(this._newTransport());
    this._client = client;
    this.status = 'ready';
    this.lastError = null;
  }

  async call(name, args = {}) {
    const client = this._client || (await this.connect());
    if (!client) throw new Error(`conta ${this.id} sem sessao MCP (${this.status})`);
    try {
      return parseResult(await client.callTool({ name, arguments: args }));
    } catch (err) {
      if (err instanceof UnauthorizedError) { this.status = 'needs_auth'; this._client = null; }
      throw err;
    }
  }

  /** Leitura barata e segura: nao toma controle do personagem. */
  async refreshAccount() {
    const data = await this.call('game_account', {});
    this.account = data;
    this.status = 'ready';
    return data;
  }

  /**
   * Macro "religar farm". Toma controle de verdade -> so em acao explicita ou regra.
   * Nunca chama game_release: ele bloqueia reconexao com "Player took control".
   * O epoch morre sozinho em ~2 min e o bot idle volta a farmar.
   */
  async restartFarm({ server, spot = 'here' } = {}) {
    const steps = [];
    const target = server || this.stats?.server || this.account?.servers?.[0] || 'webmu-1';
    if (!target) throw new Error('sem servidor conhecido para conectar');
    const conn = await this.call('game_connect', { server: target });
    this.epoch = findEpoch(conn);
    steps.push(['game_connect', target, !!this.epoch]);
    if (!this.epoch) throw new Error('game_connect nao devolveu controlEpoch');

    // Os schemas sao additionalProperties:false: so data/requestId/controlEpoch.
    const sel = await this.call('game_charSelect', {
      data: { slot: this.slot }, controlEpoch: this.epoch, requestId: reqId(this.id),
    });
    steps.push(['game_charSelect', this.slot, true]);

    // Personagem pode ter sido movido de servidor pelo dono/bot no meio do caminho.
    const moved = JSON.stringify(sel).match(/"serverChanged"[^}]*?"server"\s*:\s*"([^"]+)"/);
    if (moved && moved[1] !== target) {
      steps.push(['serverChanged', moved[1], false]);
      return { ok: false, steps, hint: `personagem esta em ${moved[1]}` };
    }

    await this.call('game_setting', {
      data: { key: 'hunt.spot', value: spot }, controlEpoch: this.epoch, requestId: reqId(this.id),
    });
    steps.push(['hunt.spot', spot, true]);

    await this.call('game_mode', {
      data: { mode: 'farm' }, controlEpoch: this.epoch, requestId: reqId(this.id),
    });
    steps.push(['game_mode', 'farm', true]);

    this.lastMacroAt = Date.now();
    return { ok: true, steps };
  }

  async sellTrash() {
    if (!this.epoch) await this.restartFarm();
    return this.call('game_sellTrash', { data: {}, controlEpoch: this.epoch, requestId: reqId(this.id) });
  }

  toJSON() {
    const chars = this.account?.characters || [];
    const char = chars.find((c) => c.slot === this.slot) || chars[0] || null;
    return {
      id: this.id, label: this.label, slot: this.slot,
      status: this.status, lastError: this.lastError,
      char: char && { name: char.name, level: char.level, class: char.cls, slot: char.slot },
      chars: chars.map((c) => ({ name: c.name, level: c.level, class: c.cls, slot: c.slot })),
      servers: this.account?.servers || [],
      stats: this.stats, statsAge: this.statsAt ? Date.now() - this.statsAt : null,
      lastMacroAt: this.lastMacroAt,
    };
  }
}

module.exports = { LorvathAccount, MCP_URL, reqId };
