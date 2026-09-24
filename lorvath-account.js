'use strict';
// Uma conta = um cliente MCP proprio apontando para o mesmo endpoint do Lorvath.
// Sem dependencia de Electron aqui: da para testar headless (test/selfcheck.js).
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { AccountOAuthProvider } = require('./oauth-store');
const { digestFrom, sampleFrom } = require('./telemetry');

const MCP_URL = 'https://lorvath.com/mcp/player';
const SITE_PADRAO = 'https://lorvath.com';

/** O painel so fala MCP com o Lorvath. Qualquer outro endereco e janela e mais nada:
 *  sem token, sem poll, sem regra automatica, sem sonda lendo o texto da pagina.
 *  E o que deixa o mesmo painel servir para outro jogo, um webmail ou um teste. */
function ehLorvath(site) {
  try { return /(^|\.)lorvath\.com$/i.test(new URL(site || SITE_PADRAO).hostname); }
  catch { return false; }
}

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

// Medido em 2026-09-15 (T053): quando alguem entra no jogo por fora, o servidor
// NAO invalida o controlEpoch e NAO devolve erro -- devolve esta frase no lugar do
// estado, como resultado bem-sucedido. Sucesso de chamada nao e prova de controle.
const DESCONECTADO = /disconnected assistant never automatically takes control back|Connect explicitly/i;

/** Perda de presenca, num formato so: e o que main.js conta para suspender. */
function perdaDePresenca(acc, detalhe) {
  acc.epoch = null;
  acc.epochLostAt = Date.now();
  acc.log(acc.id, `presenca perdida: ${detalhe}`);
  return new Error('presenca tomada por fora do painel');
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
  constructor(cfg, dataDir, redirectUri, openAuth, log = () => {}) {
    this.log = log;
    this.id = cfg.id;
    this.label = cfg.label || cfg.id;
    this.slot = cfg.slot ?? 0;
    this.site = cfg.site || SITE_PADRAO;
    this.generica = !ehLorvath(this.site);
    this.provider = new AccountOAuthProvider(this.id, path.join(dataDir, this.id), redirectUri, openAuth);
    this.status = 'offline';      // offline | needs_auth | ready | error | blocked | suspenso
    this.lastError = null;
    this.account = null;          // ultimo game_account
    this.stats = null;            // ultimo digest (janela em modo ver, game_state em gerenciar)
    this._tally = null;           // amostra anterior de tally, para calcular as taxas
    this.statsAt = 0;
    this.epoch = null;
    this.epochLostAt = 0;         // quando a presenca caiu
    this.lastRequestAt = 0;       // ultima chamada bem-sucedida: prova de que nao foi ociosidade
    this.unsolicitedLosses = 0;   // perdas seguidas nao solicitadas (FR-018)
    this.lastMacroAt = 0;
    this._client = null;
    this._pending = null;         // transport aguardando finishAuth
  }

  _newTransport() {
    return new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: this.provider });
  }

  /** Conecta usando token salvo. Nao abre navegador: se faltar token, marca needs_auth. */
  /**
   * Solta o canal de gerenciamento para a janela do jogo assumir.
   * NUNCA chama game_release: ele trava a reconexao com "Player took control".
   * O controlEpoch morre sozinho em ~2 min, que e o jeito suportado de soltar.
   */
  async disconnect() {
    const c = this._client;
    this._client = null;
    this.epoch = null;
    this.status = 'offline';
    if (c) { try { await c.close(); } catch { /* ja caiu: o estado local e o que importa */ } }
  }

  async connect() {
    if (this._client) return this._client;
    if (!(await this.provider.tokens())) { this.status = 'needs_auth'; return null; }
    const client = new Client({ name: 'midle', version: '0.1.0' }, { capabilities: {} });
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
    const client = new Client({ name: 'midle', version: '0.1.0' }, { capabilities: {} });
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
    // Falha sempre vira log: e a evidencia de que a janela do jogo tomou a presenca.
    // Chamada bem-sucedida so com DEBUG_MCP=1, senao o poll enche o arquivo.
    const t0 = Date.now();
    try {
      const out = parseResult(await client.callTool({ name, arguments: args }));
      // A perda de presenca chega aqui, disfarcada de sucesso. Uma guarda so, no
      // unico ponto por onde toda chamada passa.
      if (typeof out?.text === 'string' && DESCONECTADO.test(out.text)) {
        throw perdaDePresenca(this, `${name} respondeu "${out.text.slice(0, 70)}"`);
      }
      this.lastRequestAt = Date.now();   // o que distingue disputa de expiracao por ociosidade
      if (process.env.DEBUG_MCP) this.log(this.id, `mcp ok ${name} (${Date.now() - t0}ms)`);
      return out;
    } catch (err) {
      // Perda de presenca ja se explicou na linha acima; repetir como "mcp ERRO"
      // faz parecer defeito do painel, que e justamente o que nao e.
      if (!/presenca tomada por fora/.test(String(err.message || err))) {
        this.log(this.id, `mcp ERRO ${name} (${Date.now() - t0}ms): ${String(err.message || err)}`);
      }
      if (err instanceof UnauthorizedError) { this.status = 'needs_auth'; this._client = null; }
      throw err;
    }
  }

  /**
   * Telemetria do canal de gerenciamento. game_state nao recebe controlEpoch nem
   * requestId, entao e leitura pura -- nao toma controle. E o que permite a regra
   * automatica funcionar sem janela aberta.
   */
  async readState(section = 'overview') {
    const data = await this.call('game_state', section ? { section } : {});
    return data;
  }

  /**
   * Garante conexao de jogo. game_state so responde com uma ativa -- sem ela vem
   * "Connect explicitly". Em modo gerenciar isto e o esperado: nao ha janela
   * competindo, e o painel ser a presenca da conta e o que o modo significa.
   */
  async ensureConnected() {
    if (this.epoch) return this.epoch;
    const target = this.stats?.server || this.account?.servers?.[0] || 'webmu-1';
    const conn = await this.call('game_connect', { server: target });
    this.epoch = findEpoch(conn);
    if (!this.epoch) throw perdaDePresenca(this, 'game_connect respondeu sem controlEpoch');

    // Sem selecionar o personagem nao ha `character` no estado: game_state volta
    // so com metadados do servidor, e a telemetria fica vazia.
    const sel = await this.call('game_charSelect', {
      data: { slot: this.slot }, controlEpoch: this.epoch, requestId: reqId(this.id),
    });
    // O dono pode ter movido o personagem de servidor por fora.
    const moved = JSON.stringify(sel).match(/"serverChanged"[^}]*?"server"\s*:\s*"([^"]+)"/);
    if (moved && moved[1] !== target) {
      this.epoch = null;
      throw new Error(`personagem esta em ${moved[1]}, nao em ${target}`);
    }
    return this.epoch;
  }

  /**
   * Telemetria do canal de gerenciamento. Ler tambem mantem o controlEpoch vivo,
   * que morre com ~2 min sem requisicao -- o poll e o que segura a conexao.
   */
  async readTelemetry() {
    await this.ensureConnected();
    const overview = await this.readState('overview');
    const tally = await this.readState('tally');
    const digest = digestFrom(overview, tally, this._tally);
    this._tally = sampleFrom(tally) || this._tally;
    return digest;
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
    if (!this.epoch) throw perdaDePresenca(this, 'game_connect respondeu sem controlEpoch');

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
      site: this.site, generica: this.generica,
      status: this.status, lastError: this.lastError,
      char: char && { name: char.name, level: char.level, class: char.cls, slot: char.slot },
      chars: chars.map((c) => ({ name: c.name, level: c.level, class: c.cls, slot: c.slot })),
      servers: this.account?.servers || [],
      // Absoluto, nao idade: idade muda a cada push e faria o payload nunca ser
      // igual ao anterior, derrubando qualquer checagem de "mudou alguma coisa".
      stats: this.stats, statsAt: this.statsAt || null,
      lastMacroAt: this.lastMacroAt,
    };
  }
}

module.exports = { LorvathAccount, MCP_URL, SITE_PADRAO, ehLorvath, reqId, DESCONECTADO };
