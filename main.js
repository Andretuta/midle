'use strict';
const { app, BrowserWindow, ipcMain, session, safeStorage, net, shell, powerSaveBlocker, Notification, Menu, dialog, screen } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LorvathAccount } = require('./lorvath-account');
const { evaluate } = require('./rules');
const modes = require('./modes');
const grade = require('./grade');
const proxy = require('./proxy');
const { AiStore } = require('./ai-store');
const { criarChat, buscarModelos } = require('./ai-chat');

// Uma instancia so. Dois paineis abertos escrevem no mesmo accounts.json e no
// mesmo token de cada conta: o segundo a gravar apaga o trabalho do primeiro, e a
// conta pode acabar com credencial pela metade.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Empacotado, __dirname vive dentro do app.asar (somente leitura): os dados vao
// para a pasta do usuario (%APPDATA%/MIDLE/data no Windows).
const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ACTION_LOG = path.join(DATA_DIR, 'actions.log');
const PROXY_FILE = path.join(DATA_DIR, 'proxies.json');
const EXCLUIDAS_FILE = path.join(DATA_DIR, 'excluidas.json');   // contas excluidas cuja pasta de sessao ainda nao saiu do disco
// Icone da janela e da barra de tarefas. O do executavel e build/icon.ico, que
// o electron-builder pega sozinho; os dois saem de build/icon.svg.
const ICONE = path.join(__dirname, 'renderer', 'icone.png');
const CALLBACK_PORT = 51380;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
// O controlEpoch morre com ~2 min sem requisicao e o poll e quem o mantem vivo.
// 45s da margem para uma chamada lenta sem deixar a conexao cair.
const POLL_MS = 45_000;

const accounts = new Map();      // id -> LorvathAccount
const authWindows = new Map();   // id -> BrowserWindow
let win = null;
let settings = { killSwitch: false, maxWindows: grade.LIMITE_PADRAO };
let aiStore = null;
let chat = null;
let macroQueue = Promise.resolve();   // ponytail: uma macro por vez no app inteiro

// ---------- persistencia ----------
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = readJson(ACCOUNTS_FILE, { accounts: [], settings });
  const { lightMode, ...guardadas } = cfg.settings || {};   // lightMode virou acao, nao estado
  settings = { ...settings, ...guardadas };
  return cfg.accounts || [];
}

function saveConfig() {
  const list = [...accounts.values()].map((a) => ({
    id: a.id, label: a.label, slot: a.slot, site: a.site, rules: a.rules, mode: a.mode,
    levelDia: a.levelDia, levelBase: a.levelBase,
    // Suspensa tem que continuar suspensa depois de reabrir o painel: senao o
    // primeiro poll reconecta e rouba a tela de quem esta jogando.
    suspended: a.status === 'suspenso',
    soltaLimites: a.soltaLimites,
  }));
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: list, settings }, null, 2));
}

const hojeISO = () => new Date().toISOString().slice(0, 10);

/** Guarda o nivel com que a conta comecou o dia, para o painel dizer "+N hoje". */
function marcarNivel(acc) {
  const nivel = acc.stats?.level;
  if (typeof nivel !== 'number') return;
  const hoje = hojeISO();
  if (acc.levelDia !== hoje || typeof acc.levelBase !== 'number') {
    acc.levelDia = hoje;
    acc.levelBase = nivel;
    saveConfig();
  }
}

function logAction(accId, msg) {
  const line = `${new Date().toISOString()} [${accId}] ${msg}\n`;
  fs.appendFileSync(ACTION_LOG, line);
  console.log(line.trim());
}

/**
 * O modo "o painel gerencia" esta DESLIGADO por decisao de produto (18/09/2026).
 *
 * Nada foi apagado: o cliente MCP, a telemetria pelo canal de jogo, a regra
 * automatica, a suspensao por presenca externa e as specs 001 e 002 continuam
 * inteiras. Com este interruptor em false, o painel simplesmente nao usa nada
 * disso -- ele vira um gerenciador de janelas com sessao isolada por conta, e
 * "gerenciar" passa a significar apenas "janela fechada".
 *
 * Consequencia que vale dizer: sem gerenciamento, o painel NAO fala com o
 * servidor do jogo em momento nenhum. A divergencia com o Principio II que a
 * emenda v1.1.0 legalizou fica dormente enquanto isto for false.
 *
 * Para voltar: true aqui e em `renderer/app.js`. Os dois precisam concordar.
 */
const GERENCIAMENTO = false;

const DEFAULT_RULES = { enabled: true, minXpPerMin: 200, graceMin: 5, cooldownMin: 15 };

function addAccount(cfg) {
  const acc = new LorvathAccount(cfg, DATA_DIR, REDIRECT_URI, openAuthWindow, logAction);
  acc.rules = { ...DEFAULT_RULES, ...(cfg.rules || {}) };
  acc.badSince = 0;
  acc.mode = cfg.mode === 'ver' ? 'ver' : 'gerenciar';   // padrao economico
  // Janela generica nao tem o que gerenciar: so existe aberta. Marcar aqui evita
  // que o poll, a regra e o boot tentem falar MCP com um site que nao e o jogo.
  if (acc.generica || !GERENCIAMENTO) acc.status = 'navegador';
  if (acc.generica) acc.mode = 'ver';
  acc.pendingMode = null;
  acc.switchingSince = 0;
  acc.unsolicitedLosses = 0;
  acc.solta = null;                              // BrowserWindow quando a conta esta fora do painel
  acc.soltaLimites = cfg.soltaLimites || null;   // tamanho e posicao que voce escolheu da ultima vez
  acc.levelDia = cfg.levelDia || null;
  acc.levelBase = typeof cfg.levelBase === 'number' ? cfg.levelBase : null;
  if (cfg.suspended) acc.status = 'suspenso';
  accounts.set(acc.id, acc);
  return acc;
}

// ---------- OAuth: janela na sessao isolada da conta + loopback ----------
async function openAuthWindow(url, accountId) {
  const old = authWindows.get(accountId);
  if (old && !old.isDestroyed()) old.destroy();
  const w = new BrowserWindow({
    width: 520, height: 760, title: `Autorizar ${accountId}`,
    webPreferences: { partition: `persist:acc-${accountId}` },  // mesma sessao do jogo
  });
  authWindows.set(accountId, w);
  w.on('closed', () => authWindows.delete(accountId));
  await w.loadURL(url.toString());
}

function startCallbackServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const code = u.searchParams.get('code');
    const accId = u.searchParams.get('state');
    const acc = accounts.get(accId);
    // Rotulo e mensagem de erro sao texto que veio de fora; entram escapados.
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const reply = (msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><body style="font:16px system-ui;background:#111;color:#eee;padding:40px">${msg}</body>`);
    };
    if (!code || !acc) { reply('Callback invalido (sem code/state).'); return; }
    try {
      await acc.finishAuthorization(code);
      await acc.refreshAccount().catch(() => {});
      logAction(acc.id, 'autorizado no MCP');
      reply(`Conta <b>${esc(acc.label)}</b> autorizada. Pode fechar esta janela.`);
    } catch (err) {
      const msg = String(err.message || err);
      // Callback repetido, ou que chegou depois de o painel reiniciar, nao e defeito
      // da conta: a autorizacao anterior simplesmente nao existe mais. Marcar a conta
      // como "error" por isso deixa um ponto vermelho eterno numa conta que funciona,
      // com jargao interno na tela. Aqui a conta fica como estava.
      if (/nenhuma autorizacao pendente/.test(msg)) {
        logAction(acc.id, 'callback de autorizacao sem pedido em aberto; ignorado');
        reply('Esta autorização não vale mais. Volte ao painel e clique em <b>Autorizar</b> de novo.');
      } else {
        acc.status = 'error'; acc.lastError = msg;
        reply(`Falhou: ${esc(msg)}`);
      }
    }
    const w = authWindows.get(accId);
    if (w && !w.isDestroyed()) w.destroy();
    pushState();
  });
  server.on('error', (err) => {
    console.error(`porta ${CALLBACK_PORT} indisponivel (${err.code}): o callback do OAuth nao vai voltar. ` +
      'Feche quem estiver usando a porta e reabra o app.');
  });
  server.listen(CALLBACK_PORT, '127.0.0.1');
  return server;
}

// ---------- blindagem das janelas de jogo ----------
// O jogo roda numa pagina que nao e nossa. Tudo que ele pode pedir ao sistema
// operacional passa por aqui, e a resposta padrao e nao.
const PERMISSOES_NEGADAS = new Set([
  'media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial',
  'usb', 'bluetooth', 'idle-detection', 'clipboard-read', 'window-management',
  'local-fonts', 'display-capture', 'screen-wake-lock',
]);

const blindadas = new WeakSet();
function blindarSessao(ses) {
  if (!ses || blindadas.has(ses)) return;
  blindadas.add(ses);
  ses.setPermissionRequestHandler((_wc, permissao, cb) => cb(!PERMISSOES_NEGADAS.has(permissao)));
  ses.setPermissionCheckHandler((_wc, permissao) => !PERMISSOES_NEGADAS.has(permissao));
  ses.webRequest.onBeforeRequest({ urls: RASTREIO }, (_det, cb) => cb({ cancel: true }));
}

// Pixel de rastreio da pagina do jogo. O proprio CSP da pagina ja barra, e o
// Chromium escreve UMA linha de erro por tentativa -- com varias contas isso vira
// milhares de linhas no terminal. Pior: se o console do Windows estiver com texto
// selecionado (QuickEdit), a escrita bloqueia e o app inteiro congela. Barrar
// antes de sair e mais barato que o erro. Login social do Facebook (facebook.com
// sem /tr) continua passando.
const RASTREIO = [
  '*://*.facebook.com/tr*', '*://connect.facebook.net/*',
  '*://*.google-analytics.com/*', '*://*.googletagmanager.com/*',
  '*://*.doubleclick.net/*', '*://*.analytics.google.com/*',
];
app.on('session-created', blindarSessao);

// Login social do jogo abre popup (Kick, Twitch, Discord, Google). Sem tratador,
// `allowpopups` deixa o jogo abrir QUALQUER janela do Electron -- o proprio
// Electron avisava isso no nosso log a cada abertura.
const AUTENTICACAO = /accounts\.google\.com|discord\.com|twitch\.tv|kick\.com|appleid\.apple\.com|(oauth|login|signin|auth)/i;

app.on('web-contents-created', (_e, contents) => {
  // Webview aninhado nao herda privilegio nenhum, e ninguem desliga a seguranca web.
  contents.on('will-attach-webview', (_ev, prefs, params) => {
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.allowRunningInsecureContent = false;
    delete params.disablewebsecurity;
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (AUTENTICACAO.test(url)) {
      // Popup de login continua sendo janela filha: precisa do opener e dos
      // cookies da conta para o login terminar.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 700, center: true, title: 'Entrar na conta',
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };   // link comum vai para o navegador do sistema
  });

  // Menu de botao direito nas janelas de jogo: o que falta quando nao ha barra.
  if (contents.getType?.() === 'webview') {
    contents.on('context-menu', () => {
      Menu.buildFromTemplate([
        { label: 'Voltar', enabled: contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.(), click: () => contents.navigationHistory?.goBack?.() ?? contents.goBack?.() },
        { label: 'Recarregar', click: () => contents.reload() },
        { type: 'separator' },
        { label: 'Copiar link da página', click: () => require('electron').clipboard.writeText(contents.getURL()) },
        { label: 'Abrir no navegador do sistema', click: () => shell.openExternal(contents.getURL()).catch(() => {}) },
      ]).popup();
    });
  }
});

/** Aviso do sistema: chega mesmo com o painel atras de outra janela. */
function avisarSistema(titulo, corpo) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: String(corpo).slice(0, 220) });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch { /* sistema sem suporte a notificacao */ }
}

// ---------- proxy por conta ----------
// Cada conta sai por um endereco fixo. A senha do proxy e credencial: vai para o
// disco criptografada pelo sistema (DPAPI no Windows, Chaveiro no Mac) e NUNCA
// volta para a interface -- mesma regra da chave do provedor de IA.
let proxyCfg = { ativo: false, proxies: [], atribuicao: {} };

function carregarProxies() {
  const cru = readJson(PROXY_FILE, null);
  if (!cru) return;
  proxyCfg = {
    ativo: !!cru.ativo,
    atribuicao: cru.atribuicao || {},
    proxies: (cru.proxies || []).map((p) => ({ ...p, pass: destravarSenha(p) })),
  };
}

function destravarSenha(p) {
  if (p.passEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(p.passEnc, 'base64')); } catch { /* chave do sistema mudou */ }
  }
  return p.pass || '';
}

function salvarProxies() {
  const cifrado = proxyCfg.proxies.map(({ pass, ...resto }) => {
    if (pass && safeStorage.isEncryptionAvailable()) {
      return { ...resto, passEnc: safeStorage.encryptString(pass).toString('base64') };
    }
    return pass ? { ...resto, pass } : resto;   // sem cofre do sistema: guarda como veio, e o status avisa
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROXY_FILE, JSON.stringify({ ativo: proxyCfg.ativo, proxies: cifrado, atribuicao: proxyCfg.atribuicao }, null, 2), { mode: 0o600 });
}

const proxyDaConta = (id) => {
  const i = proxyCfg.atribuicao[id];
  return proxyCfg.ativo && Number.isInteger(i) && i >= 0 ? proxyCfg.proxies[i] || null : null;
};

/** Aplica na sessao da conta. Sem proxy atribuido, sai pela rede normal. */
async function aplicarProxy(id) {
  const ses = session.fromPartition(`persist:acc-${id}`);
  const p = proxyDaConta(id);
  try {
    await ses.setProxy(p ? proxy.regra(p) : { mode: 'direct' });
    await ses.closeAllConnections();   // conexao viva ignoraria o proxy novo
  } catch (err) {
    logAction(id, `falha ao aplicar proxy: ${err.message}`);
  }
}

async function aplicarProxyEmTodas() {
  proxyCfg.atribuicao = proxy.atribuir([...accounts.keys()], proxyCfg.proxies.length, proxyCfg.atribuicao);
  salvarProxies();
  for (const id of accounts.keys()) await aplicarProxy(id);
}

// O 407 do proxy chega aqui. Sem este tratador a janela conecta e fica em branco,
// sem erro visivel -- o modo mais caro de descobrir que o proxy pede senha.
app.on('login', (event, wc, details, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return;
  const part = wc?.session === session.defaultSession ? '' : null;
  for (const id of accounts.keys()) {
    if (session.fromPartition(`persist:acc-${id}`) !== wc.session) continue;
    const p = proxyDaConta(id);
    if (p && p.user) { event.preventDefault(); callback(p.user, p.pass); }
    return;
  }
  void part;
});

/** Pergunta a um servico publico qual IP a conta esta usando. */
function ipDaConta(id) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: 'https://api.ipify.org', session: session.fromPartition(`persist:acc-${id}`) });
    const prazo = setTimeout(() => { try { req.abort(); } catch { /* ja caiu */ } reject(new Error('sem resposta em 12s')); }, 12_000);
    req.on('login', (authInfo, cb) => {
      const p = proxyDaConta(id);
      if (authInfo.isProxy && p && p.user) cb(p.user, p.pass); else cb();
    });
    req.on('response', (res) => {
      if (res.statusCode === 407) { clearTimeout(prazo); reject(new Error('o proxy recusou usuário ou senha (407)')); return; }
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => { clearTimeout(prazo); resolve(corpo.trim().slice(0, 45)); });
    });
    req.on('error', (err) => { clearTimeout(prazo); reject(err); });
    req.end();
  });
}

/** O que a interface pode ver do proxy: tudo menos a senha (mesma regra da chave de IA). */
function statusProxy() {
  return {
    ativo: proxyCfg.ativo,
    total: proxyCfg.proxies.length,
    cofre: safeStorage.isEncryptionAvailable(),
    contas: [...accounts.values()].map((a) => {
      const i = proxyCfg.atribuicao[a.id];
      const p = Number.isInteger(i) && i >= 0 ? proxyCfg.proxies[i] : null;
      return { id: a.id, label: a.label, proxy: p ? proxy.resumir(p, i) : null };
    }),
  };
}

// ---------- poll + regras ----------
const STALE_MS = 120_000;   // mesma janela de frescor que rules.js exige

/** Estado propagado para a interface: ela consome, nao decide. */
/**
 * Quanto cada janela aberta esta custando AGORA, em MB. O piso de 400 MB e a janela
 * em mapa comum; em area de boss, com o servidor inteiro num ponto so, a mesma
 * janela passa de 1 GB -- e foi medido em 16/09/2026 que a guarda com numero fixo
 * deixaria abrir quase o dobro do que cabe nesse caso. Aqui ela pergunta ao
 * processo em vez de acreditar na media.
 * @returns {number} MB por janela, ou o piso quando nao ha janela para observar
 */
function custoPorJanela() {
  const abertas = [...accounts.values()].filter((a) => a.mode === 'ver').length;
  if (abertas < 1) return grade.CUSTO_JANELA_MB;
  try {
    let kb = 0;
    for (const m of app.getAppMetrics()) kb += m.memory?.workingSetSize || 0;
    return (kb / 1024 - grade.BASE_PAINEL_MB) / abertas;
  } catch {
    return grade.CUSTO_JANELA_MB;   // sem metrica, vale o piso
  }
}

const livreMB = () => os.freemem() / (1024 * 1024);

function fleetState() {
  const list = [...accounts.values()];
  const modo = modes.resolve(list, Date.now());
  return {
    settings,
    accounts: list.map((a) => {
      const m = modo.get(a.id) || { effective: 'gerenciar', switching: false, reason: '' };
      const suspended = a.status === 'suspenso';
      return {
        ...a.toJSON(), rules: a.rules,
        levelBase: typeof a.levelBase === 'number' && a.levelDia === hojeISO() ? a.levelBase : null,
        effective: m.effective, switching: m.switching, reason: m.reason, suspended,
        canManage: modes.canManage({ effective: m.effective, switching: m.switching, status: a.status }),
        stale: !a.stats || Date.now() - (a.statsAt || 0) > STALE_MS,
        solta: !!(a.solta && !a.solta.isDestroyed()),
      };
    }),
  };
}

let ultimoEstado = '';

/** O intervalo de 5s existe para o painel nao ficar velho. Mandar o estado inteiro
 *  toda vez, mudando ou nao, fazia a interface se repintar sozinha o tempo todo. */
/** Aviso temporario na interface. Um aviso pode nomear varias contas (FR-011):
 *  fechar todas as janelas nao deve cuspir doze avisos seguidos. */
function aviso(texto, contas = []) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:notice', { texto, contas });
}

function pushState({ force = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const estado = fleetState();
  const serial = JSON.stringify(estado);
  if (!force && serial === ultimoEstado) return;
  ultimoEstado = serial;
  win.webContents.send('fleet:state', estado);
}

// Perda de presenca nao solicitada (FR-018). O sinal foi medido em 2026-09-15:
// nao e erro nem epoch invalidado, e a frase de desconexao vindo no lugar do estado
// -- LorvathAccount.call a transforma nesta excecao. Ver research.md, Unknown 5.
const PERDA = /presenca tomada por fora do painel/;

// Quando o painel mexe na presenca -- abre o app, fecha uma janela do jogo, troca
// de modo -- o servidor leva ate ~1 min para soltar a sessao antiga, e nesse
// intervalo ele aceita conexao sem devolver controle. Medido. Contar isso como
// disputa suspenderia a conta toda vez que voce fechasse a janela.
let presencaMexidaEm = Date.now();

function registrarPerda(acc, err, origem) {
  if (!PERDA.test(String(err && err.message))) return false;
  if (Date.now() - presencaMexidaEm < modes.OCIOSIDADE_MS) {
    logAction(acc.id, 'presenca ainda assentando depois de mexida nossa; nao conta como disputa');
    return true;
  }
  const r = modes.countLoss(acc, origem);
  acc.unsolicitedLosses = r.losses;
  if (r.suspend) {
    acc.status = 'suspenso';
    acc.lastError = null;             // suspensao nao e defeito do painel
    saveConfig();
    logAction(acc.id, `suspensa: ${r.reason}`);
    avisarSistema(`${acc.label}: gerenciamento pausado`, `${r.reason}. O painel espera você decidir.`);
  } else if (r.reason) {
    logAction(acc.id, `presenca: ${r.reason} (${r.losses})`);
  }
  return true;
}

async function pollOnce() {
  const list = [...accounts.values()];
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    // escalona: nao dispara 12 chamadas no mesmo instante
    setTimeout(async () => {
      try {
        // Quem pode ser conectada pela verificacao periodica e decisao pura, com
        // assercao: e a condicao que sustenta a emenda v1.1.0 da constituicao.
        if (!GERENCIAMENTO || !modes.podeConectarNoPoll(acc).ok) return;
        if (acc.status === 'offline') await acc.connect();
        if (acc.status !== 'ready') return;
        await acc.refreshAccount();
        // Depois de uma perda, NAO reconectar: readTelemetry chamaria game_connect e
        // roubaria a tela de quem esta jogando. Sonda so leitura -- se a presenca
        // ainda for de outro, a propria resposta confirma a segunda perda.
        if (acc.unsolicitedLosses > 0 && !acc.epoch) {
          await acc.readState('overview');
          acc.unsolicitedLosses = 0;      // respondeu estado de verdade: a presenca voltou
          logAction(acc.id, 'presenca de volta com o painel');
          return pushState();
        }
        // Em gerenciar o painel e a presenca da conta: le a telemetria pelo canal
        // de jogo, que e o que faz a regra automatica ter sobre o que decidir.
        const digest = await acc.readTelemetry();
        if (digest && Object.keys(digest).length) {
          acc.stats = { ...(acc.stats || {}), ...digest };
          acc.statsAt = Date.now();
          marcarNivel(acc);
        }
      } catch (err) {
        // Sem acao pedida pelo painel: se foi perda de presenca, foi de fora.
        if (!registrarPerda(acc, err, 'nenhuma')) acc.lastError = String(err.message || err);
      }
      pushState();
    }, i * 1500);
  }
}

function evaluateRules() {
  if (!GERENCIAMENTO || settings.killSwitch) return;
  const now = Date.now();
  const modo = modes.resolve([...accounts.values()], now);
  for (const acc of accounts.values()) {
    if (acc.generica) continue;   // janela de outro site nao tem farm para religar
    const m = modo.get(acc.id);
    // Em "ver" voce esta jogando: o painel nao aperta botao por cima. Em troca ou
    // suspensa, tambem nao. Mesma checagem que a interface e o chat usam.
    if (!modes.canManage({ effective: m.effective, switching: m.switching, status: acc.status }).ok) continue;
    const { fire, badSince, why } = evaluate(acc, now);
    acc.badSince = badSince;
    if (fire) queueMacro(acc, `regra automatica: ${why}`, 'regra');
  }
}

function queueMacro(acc, motivo, origem = 'usuario') {
  acc.lastMacroAt = Date.now();   // reserva o cooldown ja na fila
  macroQueue = macroQueue.then(async () => {
    logAction(acc.id, `religando farm: ${motivo}`);
    try {
      const out = await acc.restartFarm();
      logAction(acc.id, out.ok ? `farm religado (${out.steps.map((s) => s[0]).join(' > ')})`
        : `abortado: ${out.hint}`);
      if (out.ok) acc.unsolicitedLosses = 0;   // acao solicitada deu certo: a contagem recomeca
      if (!out.ok) acc.status = 'blocked';
    } catch (err) {
      const msg = String(err.message || err);
      if (registrarPerda(acc, err, origem)) { pushState(); return; }
      acc.lastError = msg;
      // "Player took control" nao tem solucao programatica: parar de tentar.
      if (/took control|released the assistant/i.test(msg)) acc.status = 'blocked';
      logAction(acc.id, `falhou: ${msg}`);
    }
    pushState();
  }).catch(() => {});
  return macroQueue;
}

// ---------- troca de modo ----------
// Sequencia estrita: encerra um canal ANTES de abrir o outro. O servidor aceitaria
// os dois juntos, mas coexistir custa farm -- ver "Limites do jogo" no README.
/** Apagar conta e um caminho so: o botao do painel e o menu de botao direito da
 *  linha chamam esta funcao. Duas copias seriam duas chances de esquecer os
 *  cookies num dos lados. */
async function removerConta(id) {
  const acc = accounts.get(id);
  // Encerra o canal de gerenciamento antes de sumir com a conta. A janela some
  // junto porque a interface deixa de receber a conta no estado.
  if (acc) { try { await acc.disconnect(); } catch { /* ja estava fora */ } }
  if (acc?.solta && !acc.solta.isDestroyed()) acc.solta.destroy();
  accounts.delete(id);
  saveConfig();
  // Remover a conta tem que levar a credencial junto: token OAuth, cliente
  // registrado, verifier e os cookies da sessao do jogo. Antes ficava tudo no
  // disco para sempre, inclusive de conta que o usuario achava que tinha apagado.
  try { fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true }); }
  catch (err) { logAction(id, `falha ao apagar credenciais: ${err.message}`); }
  try { await session.fromPartition(`persist:acc-${id}`).clearStorageData(); }
  catch (err) { logAction(id, `falha ao limpar cookies: ${err.message}`); }
  // A pasta da sessao fica presa pelo Chromium enquanto o painel roda; anota para
  // o proximo boot apagar. Ver grade.particoesExcluidas.
  try { fs.writeFileSync(EXCLUIDAS_FILE, JSON.stringify([...new Set([...readJson(EXCLUIDAS_FILE, []), id])])); }
  catch (err) { logAction(id, `falha ao anotar exclusao: ${err.message}`); }
  logAction(id, 'conta removida (credenciais e cookies apagados)');
}

async function trocarModo(acc, destino, { avisar = true } = {}) {
  // Uma troca por conta. Sem esta guarda, dois cliques rapidos rodam duas trocas
  // ao mesmo tempo e o finally da primeira limpa o estado da segunda -- a conta
  // fica marcada como parada enquanto ainda esta trocando.
  if (acc.switchingSince) return { ok: false, reason: 'troca de modo em andamento' };

  const anterior = acc.mode;
  const comecou = Date.now();
  presencaMexidaEm = Date.now();   // fomos nos que mexemos na presenca desta conta
  acc.pendingMode = destino;
  acc.switchingSince = Date.now();
  pushState();

  // O prazo nao pode existir so na exibicao: sem cortar aqui, uma troca travada
  // deixa a conta em "trocando" para sempre e nenhuma acao volta a ser aceita.
  const estouro = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('troca de modo demorou mais de 2 minutos')), modes.TROCA_MS));

  try {
    await Promise.race([(async () => {
      // Espera a macro em voo terminar: desconectar no meio dela deixa o personagem
      // num estado que ninguem pediu e ainda registra um erro que nao e culpa de nada.
      await macroQueue.catch(() => {});
      if (destino === 'ver') {
        // Quantas janelas cabem e escolha sua, nao do painel: cada uma custa ~400 MB
        // e o orcamento de memoria e seu. Cheio, o painel recusa e diz -- fechar a
        // janela de outra pessoa sem avisar e pior do que dizer nao.
        const abertas = [...accounts.values()].filter((o) => o !== acc && o.mode === 'ver');
        const cabe = grade.cabeJanela(abertas.length, settings.maxWindows, livreMB(), custoPorJanela());
        if (!cabe.ok) throw new Error(cabe.reason);
        await acc.disconnect();
      }
      acc.mode = destino;
      if (destino === 'gerenciar' && acc.solta && !acc.solta.isDestroyed()) acc.solta.destroy();
      if (destino === 'gerenciar' && GERENCIAMENTO && !acc.generica && acc.status !== 'suspenso') {
        // Sem isto a conta fica ate 60s sem sessao esperando o poll, com os botoes
        // habilitados e falhando com erro interno quando alguem clica. Suspensa fica
        // de fora: conectar aqui seria sair da suspensao sem o usuario ter retomado.
        await acc.connect().catch(() => {});
      }
    })(), estouro]);
    logAction(acc.id, `modo alterado para ${destino}`);
    if (avisar) aviso(destino === 'ver' ? 'Agora você joga' : 'Agora o painel gerencia', [acc.label]);
    return { ok: true, reason: '' };
  } catch (err) {
    // Volta ao anterior, como o spec manda (FR-008) -- a menos que o usuario
    // tenha mandado fechar tudo a forca no meio desta troca. Ai o pedido dele
    // vale mais do que o estado de onde a troca saiu, e a janela fica fechada.
    if (!(acc.forcaEm > comecou)) acc.mode = anterior;
    const motivo = String(err.message || err);
    logAction(acc.id, `troca de modo falhou, voltou para ${anterior}: ${motivo}`);
    if (avisar) aviso(`Não consegui trocar: ${motivo}`, [acc.label]);
    return { ok: false, reason: motivo };
  } finally {
    acc.pendingMode = null;
    acc.switchingSince = 0;
    saveConfig();
    pushState();
  }
}

// ---------- janela solta ----------
// Uma conta pode sair do painel e virar janela propria do Windows: voce escolhe
// tamanho e lugar, inclusive em outro monitor. Volta arrastando ate a BARRA de
// cima do painel, ou pelo X dela. Nunca existem as duas ao mesmo tempo -- a
// celula da grade vira vaga enquanto a solta esta aberta, senao seriam duas
// presencas da mesma conta disputando o jogo.
//
// Ao sair e ao voltar a pagina recarrega: e outra janela, com a mesma sessao,
// entao o login fica e o jogo reconecta. Repetir, Voltar sozinho e Quadros
// valem so para as janelas dentro do painel.
const BARRA_PX = 40;   // mesma altura do titleBarOverlay

function soltarJanela(acc) {
  if (acc.solta && !acc.solta.isDestroyed()) { acc.solta.focus(); return { ok: true }; }
  if (acc.mode !== 'ver') return { ok: false, reason: 'abra a janela antes de soltar' };
  const telas = screen.getAllDisplays().map((d) => d.workArea);
  const w = new BrowserWindow({
    ...grade.limitesSolta(acc.soltaLimites, telas),
    minWidth: 320, minHeight: 240,
    title: acc.label, backgroundColor: '#0B0A1A', autoHideMenuBar: true, icon: ICONE,
    webPreferences: { partition: `persist:acc-${acc.id}`, contextIsolation: true, sandbox: true },
  });
  acc.solta = w;
  const guardar = () => { if (!w.isDestroyed() && !w.isMinimized() && !w.isMaximized()) acc.soltaLimites = w.getBounds(); };
  let sobre = false;
  const avisarAlvo = (v) => {
    if (v === sobre || !win || win.isDestroyed()) return;
    sobre = v;
    win.webContents.send('fleet:alvoSolta', v);
  };
  const naBarra = () => win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() &&
    grade.soltaNaBarra(screen.getCursorScreenPoint(), win.getContentBounds(), BARRA_PX);
  // `move` corre durante o arrasto (acende o alvo); `moved` vem uma vez, quando
  // voce solta o mouse -- e ai que decide voltar.
  w.on('move', () => avisarAlvo(naBarra()));
  w.on('moved', () => {
    const volta = naBarra();
    avisarAlvo(false);
    if (volta) { w.close(); return; }
    guardar();
  });
  w.on('resized', guardar);
  w.on('close', guardar);
  w.on('closed', () => {
    avisarAlvo(false);
    if (acc.solta === w) acc.solta = null;
    saveConfig();
    pushState();
  });
  w.loadURL(acc.site || 'https://lorvath.com').catch((err) => logAction(acc.id, `janela solta: ${err.message}`));
  logAction(acc.id, 'janela solta do painel');
  pushState();
  return { ok: true };
}

function recolherJanela(acc) {
  if (acc.solta && !acc.solta.isDestroyed()) acc.solta.close();
  return { ok: true };
}

// ---------- despacho unico ----------
/**
 * Caminho unico de acao: botao do painel e chat de IA passam por aqui. Sem isto
 * a interface e o chat divergem sobre o que esta permitido -- e o que diverge e
 * sempre o lado que ninguem testou.
 * @param {'usuario'|'chat'} origem
 */
async function despacharAcao(acc, action, origem = 'usuario') {
  const m = modes.resolve([acc], Date.now()).get(acc.id);
  const pode = modes.canManage({ effective: m.effective, switching: m.switching, status: acc.status });
  if (!pode.ok) return { ok: false, error: pode.reason };
  // O botao de panico para a automacao, e o chat conta como automacao (FR-031).
  // Clique do usuario continua passando: parar regras nao e travar o painel.
  if (origem === 'chat' && settings.killSwitch) {
    return { ok: false, error: 'botao de panico ligado: acoes automaticas estao paradas' };
  }
  try {
    if (action === 'refresh') return { ok: true, data: await acc.refreshAccount() };
    if (action.startsWith('readState')) return { ok: true, data: await acc.readState(action.split(':')[1] || 'overview') };
    if (action === 'restartFarm') { await queueMacro(acc, origem === 'chat' ? 'pedido no chat' : 'clique manual', 'usuario'); return { ok: true }; }
    if (action === 'sellTrash') { const d = await acc.sellTrash(); return { ok: true, data: d }; }
    if (action === 'reset') { acc.provider.invalidateCredentials('all'); acc._client = null; acc.status = 'needs_auth'; return { ok: true }; }
    return { ok: false, error: `acao desconhecida: ${action}` };
  } catch (err) {
    acc.lastError = String(err.message || err);
    return { ok: false, error: acc.lastError };
  } finally { pushState(); }
}

// ---------- ponte do chat com o painel ----------
// Resolve o alvo por rotulo ou id, e aceita "todas". Contas em ver ficam de fora
// por decisao explicita, nao por acidente: quem esta em ver e voce jogando.
function alvos(conta) {
  const todos = [...accounts.values()];
  const q = String(conta || '').trim().toLowerCase();
  if (!q || q === 'todas' || q === 'todos' || q === 'all') return todos;
  return todos.filter((a) => a.id === conta || a.label.toLowerCase() === q);
}

/** Resumo que o provedor enxerga. Nunca inclui credencial de conta nenhuma. */
function frotaResumida() {
  const modo = modes.resolve([...accounts.values()], Date.now());
  return [...accounts.values()].map((a) => {
    const m = modo.get(a.id);
    const pode = modes.canManage({ effective: m.effective, switching: m.switching, status: a.status });
    const j = a.toJSON();   // `char` nasce aqui: lido do account, nao e campo da instancia
    return {
      conta: a.label, modo: m.effective, aceitaAcao: pode.ok, motivo: pode.reason || undefined,
      personagem: j.char?.name, nivel: j.char?.level,
      xpPorMin: a.stats?.xpPerMin, killsPorMin: a.stats?.killsPerMin,
      acao: a.stats?.state, mapa: a.stats?.map,
    };
  });
}

/** Executa uma escolha do provedor pelo MESMO caminho do botao equivalente. */
async function executarDoChat(nome, args) {
  const contas = alvos(args.conta);
  if (!contas.length) return { ok: false, erro: `nao achei conta "${args.conta}"` };
  const saida = [];
  for (const acc of contas) {
    if (nome === 'trocar_modo') {
      saida.push({ conta: acc.label, ...(await trocarModo(acc, args.modo)) });
      continue;
    }
    const acao = { religar_farm: 'restartFarm', vender_lixo: 'sellTrash', ler_conta: 'refresh' }[nome];
    if (!acao) { saida.push({ conta: acc.label, ok: false, erro: 'acao desconhecida' }); continue; }
    saida.push({ conta: acc.label, ...(await despacharAcao(acc, acao, 'chat')) });
  }
  return { resultados: saida };
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('fleet:get', () => fleetState());

  ipcMain.handle('fleet:addAccount', (_e, arg) => {
    const { label, site } = typeof arg === 'string' || !arg ? { label: arg, site: null } : arg;
    const id = `acc${Date.now().toString(36)}`;
    const acc = addAccount({ id, site, label: label || `Conta ${accounts.size + 1}` });
    // Janela comum nasce aberta e nao passa por trocarModo: sem esta checagem,
    // criar conta seria o caminho que fura o limite e o orcamento de memoria.
    let recusa = '';
    if (acc.generica) {
      const abertas = [...accounts.values()].filter((o) => o !== acc && o.mode === 'ver').length;
      const cabe = grade.cabeJanela(abertas, settings.maxWindows, livreMB(), custoPorJanela());
      // Nasce fechada em vez de nao nascer: a conta e util mesmo sem janela agora.
      if (!cabe.ok) { acc.mode = 'gerenciar'; recusa = cabe.reason; }
    }
    saveConfig();
    logAction(id, `conta criada (${acc.label}) em ${acc.site}${recusa ? ` — janela fechada: ${recusa}` : ''}`);
    return { ...acc.toJSON(), recusa };
  });

  ipcMain.handle('ai:status', () => aiStore.status());

  ipcMain.handle('ai:save', (_e, { provider, model, key }) => {
    try {
      aiStore.save({ provider, model, key });
      chat = null;   // troca de provedor comeca conversa nova
      logAction('ai', `provedor configurado: ${provider} (${model || 'padrao'})`);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });

  ipcMain.handle('ai:clear', () => {
    aiStore.clear();
    chat = null;
    logAction('ai', 'provedor removido e chave apagada');
    return { ok: true };
  });

  ipcMain.handle('ai:models', async (_e, provider) => {
    try { return await buscarModelos(provider); }
    catch (err) { return { ok: false, erro: String(err.message || err) }; }
  });

  ipcMain.handle('ai:chat', async (_e, texto) => {
    if (!aiStore.read()) return { ok: false, reply: 'Configure um provedor de IA nas configurações.' };
    if (!chat) {
      chat = criarChat({
        config: () => aiStore.read(),
        frota: frotaResumida,
        executar: executarDoChat,
        log: (m) => logAction('ai', m),
      });
    }
    try {
      logAction('ai', `pedido: ${String(texto).slice(0, 200)}`);
      return await chat.enviar(texto);
    } catch (err) {
      return { ok: false, reply: String(err.message || err) };
    }
  });

  ipcMain.handle('ai:reset', () => { chat?.limpar(); return { ok: true }; });

  ipcMain.handle('fleet:setMode', async (_e, id, destino) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false, reason: 'conta nao encontrada' };
    if (destino !== 'ver' && destino !== 'gerenciar') return { ok: false, reason: 'modo invalido' };
    if (acc.mode === destino && !acc.switchingSince) return { ok: true, reason: '' };   // idempotente
    return await trocarModo(acc, destino);
  });

  // Fechar e a direcao segura: NUNCA pode ser recusado. A versao anterior pulava
  // conta no meio de uma troca de modo, e como uma troca travada so estoura em 2
  // minutos, a pessoa ficava com a janela na cara sem botao que a tirasse de la.
  // Agora nao espera nada -- nem a macro em voo, nem o prazo: marca fechada,
  // derruba a sessao por cima e segue. O estado final e o mesmo que o caminho
  // educado alcancaria; o que se perde e a ordem, e ordem nao vale uma tela
  // presa. O caminho educado continua no X de cada conta e no menu da linha.
  ipcMain.handle('fleet:closeAllWindows', async () => {
    const emVer = [...accounts.values()].filter((a) => a.mode === 'ver');
    const presas = [];
    for (const acc of emVer) {
      if (acc.switchingSince) presas.push(acc.label);
      // A marca de forca e lida pelo `catch` do trocarModo em voo: sem ela, uma
      // troca que falhe DEPOIS daqui devolve `mode = 'ver'` e a janela ressuscita.
      acc.forcaEm = Date.now();
      acc.pendingMode = null;
      acc.switchingSince = 0;
      acc.mode = 'gerenciar';
      Promise.resolve(acc.disconnect?.()).catch(() => {});   // sem await: ninguem espera para fechar
      logAction(acc.id, 'janela fechada a forca');
    }

    // Popup de login (Kick, Twitch, Discord, Google) e janela do Electron sem
    // conta nenhuma registrada: nao aparece na lista, nao tem X do painel e, se
    // travar no meio do login, nao ha por onde sair. Vai junto.
    const orfas = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
    for (const w of orfas) { try { w.destroy(); } catch { /* ja estava fechando */ } }

    saveConfig();
    pushState();
    const fechadas = emVer.map((a) => a.label);
    if (fechadas.length || orfas.length) {
      aviso(orfas.length ? `Janelas fechadas e ${orfas.length} popup de login` : 'Janelas fechadas', fechadas);
    }
    return { ok: true, contas: fechadas, presas, popups: orfas.length };
  });

  // Menu de botao direito na linha da conta. Nativo, e nao desenhado por mim: a
  // coluna e estreita e pode estar recolhida a 38px -- menu HTML ali dentro ou
  // vazaria ou seria cortado. O do sistema nao tem essa fronteira.
  //
  // Excluir mora aqui porque antes so existia no painel da direita: para apagar
  // uma conta era preciso primeiro seleciona-la, o que abre a janela dela.
  ipcMain.handle('fleet:soltar', (_e, id) => {
    const acc = accounts.get(id);
    return acc ? soltarJanela(acc) : { ok: false, reason: 'conta nao encontrada' };
  });
  ipcMain.handle('fleet:recolher', (_e, id) => {
    const acc = accounts.get(id);
    return acc ? recolherJanela(acc) : { ok: false, reason: 'conta nao encontrada' };
  });

  ipcMain.handle('fleet:menuConta', (e, id) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false };
    const aberta = acc.mode === 'ver';
    const janela = BrowserWindow.fromWebContents(e.sender) || win;

    Menu.buildFromTemplate([
      { label: acc.label, enabled: false },
      { type: 'separator' },
      {
        label: aberta ? 'Fechar janela' : 'Abrir janela',
        click: async () => {
          const r = await trocarModo(acc, aberta ? 'gerenciar' : 'ver');
          if (!r.ok) aviso(`Não consegui: ${r.reason}`, [acc.label]);
        },
      },
      { label: 'Recarregar a janela', enabled: aberta && !acc.solta, click: () => e.sender.send('fleet:recarregar', id) },
      acc.solta && !acc.solta.isDestroyed()
        ? { label: 'Trazer de volta ao painel', click: () => recolherJanela(acc) }
        : { label: 'Soltar do painel', enabled: aberta, click: () => soltarJanela(acc) },
      { type: 'separator' },
      {
        label: 'Excluir conta…',
        click: async () => {
          // Confirmacao com o peso certo: apagar leva token, cookies e login
          // junto e nao volta. Por isso o botao de perigo nao e o padrao, e
          // fechar a caixa no X tambem cancela.
          const { response } = await dialog.showMessageBox(janela, {
            type: 'warning',
            buttons: ['Cancelar', 'Excluir'],
            defaultId: 0,
            cancelId: 0,
            title: 'Excluir conta',
            message: `Excluir ${acc.label}?`,
            detail: 'A autorização, os cookies e o login desta conta são apagados do disco. Não dá para desfazer.',
          });
          if (response !== 1) return;
          await removerConta(id);
          aviso('Conta excluída', [acc.label]);
        },
      },
    ]).popup({ window: janela });
    return { ok: true };
  });

  // ---------- proxy ----------
  ipcMain.handle('proxy:status', () => statusProxy());

  ipcMain.handle('proxy:save', async (_e, { texto, ativo }) => {
    const lido = proxy.analisar(texto);
    proxyCfg.proxies = lido.proxies;
    proxyCfg.ativo = !!ativo && lido.proxies.length > 0;
    await aplicarProxyEmTodas();
    logAction('proxy', `lista com ${lido.proxies.length} proxy(s), ${proxyCfg.ativo ? 'ligado' : 'desligado'}`);
    pushState({ force: true });
    return { ok: true, erros: lido.erros, avisos: lido.avisos, ...statusProxy() };
  });

  ipcMain.handle('proxy:clear', async () => {
    proxyCfg = { ativo: false, proxies: [], atribuicao: {} };
    try { fs.rmSync(PROXY_FILE, { force: true }); } catch { /* ja nao existia */ }
    for (const id of accounts.keys()) await aplicarProxy(id);
    logAction('proxy', 'lista removida e senhas apagadas do disco');
    return { ok: true, ...statusProxy() };
  });

  ipcMain.handle('proxy:test', async (_e, id) => {
    try { return { ok: true, ip: await ipDaConta(id) }; }
    catch (err) { return { ok: false, erro: String(err.message || err) }; }
  });

  // ---------- consumo real do app ----------
  // getAppMetrics ja soma todos os processos do Electron; medir por fora com
  // PowerShell pegava tambem qualquer outro Electron aberto na maquina.
  ipcMain.handle('system:metrics', () => {
    let cpu = 0, ramKb = 0;
    for (const m of app.getAppMetrics()) {
      if (typeof m.cpu?.percentCPUUsage === 'number') cpu += m.cpu.percentCPUUsage;
      if (typeof m.memory?.workingSetSize === 'number') ramKb += m.memory.workingSetSize;
    }
    // O estado da GPU vem do proprio Chromium. So e confiavel depois que ele
    // termina de sondar o hardware -- antes disso devolve objeto vazio.
    let gpu = 'apurando';
    try {
      const st = app.getGPUFeatureStatus() || {};
      const comp = String(st.gpu_compositing || st.gpu || '');
      if (comp) gpu = /enabled/.test(comp) ? 'ativa' : 'software';
    } catch { /* ainda nao sondou */ }
    return {
      gerenciamento: GERENCIAMENTO,
      cpu: Math.round(cpu),
      ram: Math.round(ramKb / 1024),
      gpu,
      janelas: [...accounts.values()].filter((a) => a.mode === 'ver').length,
    };
  });

  ipcMain.handle('system:clearCache', async () => {
    let limpas = 0;
    for (const id of accounts.keys()) {
      try {
        const ses = session.fromPartition(`persist:acc-${id}`);
        await ses.clearCache();
        // Só cache: cookie fica: limpar cookie aqui deslogaria a conta do jogo.
        await ses.clearStorageData({ storages: ['cache', 'shadercache'] });
        limpas++;
      } catch { /* sessao ainda nao existe */ }
    }
    logAction('sistema', `cache limpo em ${limpas} conta(s)`);
    return { ok: true, limpas };
  });

  ipcMain.handle('fleet:resumeAccount', (_e, id) => {
    const acc = accounts.get(id);
    if (!acc || acc.status !== 'suspenso') return { ok: false, reason: 'conta nao esta suspensa' };
    acc.status = 'offline';           // o poll reconecta a partir daqui
    acc.unsolicitedLosses = 0;
    saveConfig();                     // a suspensao e persistida: retomar tem que apaga-la
    logAction(id, 'gerenciamento retomado pelo usuario');
    pushState();
    return { ok: true, reason: '' };
  });

  // Sair da conta do jogo sem remover a conta do painel: apaga cookie e
  // armazenamento daquela sessao e mais nada. O token do MCP nao e tocado --
  // sao dois logins diferentes, e misturar os dois surpreenderia o usuario.
  ipcMain.handle('fleet:logoutGame', async (_e, id) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false, reason: 'conta nao encontrada' };
    try {
      await session.fromPartition(`persist:acc-${id}`).clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem'],
      });
      logAction(id, 'login do jogo apagado (a autorização do painel continua)');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  });

  ipcMain.handle('fleet:removeAccount', async (_e, id) => {
    await removerConta(id);
    return true;
  });


  ipcMain.handle('fleet:updateAccount', (_e, { id, patch }) => {
    const acc = accounts.get(id);
    if (!acc) return false;
    if (patch.label != null) acc.label = patch.label;
    if (patch.slot != null) acc.slot = Number(patch.slot);
    if (patch.rules) acc.rules = { ...acc.rules, ...patch.rules };
    saveConfig();
    pushState();
    return true;
  });

  ipcMain.handle('fleet:setSettings', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveConfig();
    pushState();
    return settings;
  });

  ipcMain.handle('fleet:authorize', async (_e, id) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: 'conta inexistente' };
    if (!GERENCIAMENTO) return { ok: false, error: 'o gerenciamento pelo painel está desligado' };
    if (acc.generica) return { ok: false, error: 'janela comum não se autoriza no jogo' };
    try { return { ok: true, ...(await acc.startAuthorization()) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('fleet:action', async (_e, { id, action }) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: 'conta inexistente' };
    return despacharAcao(acc, action, 'usuario');
  });

  // telemetria vinda da webview de cada conta
  ipcMain.on('probe:stats', (_e, { id, stats }) => {
    const acc = accounts.get(id);
    if (!acc) return;
    acc.stats = { ...(acc.stats || {}), ...stats };
    acc.statsAt = Date.now();
    marcarNivel(acc);
  });
}

// Conta excluida deixa a pasta da sessao no disco (ver grade.particoesExcluidas).
// Roda no boot, antes de qualquer sessao abrir: depois disso o Chromium segura
// os arquivos. Falha aqui nao impede o painel de subir -- e so disco.
function varrerParticoesExcluidas() {
  const excluidas = readJson(EXCLUIDAS_FILE, []);
  if (!Array.isArray(excluidas) || !excluidas.length) return;
  const dir = path.join(app.getPath('userData'), 'Partitions');
  let pastas;
  try { pastas = fs.readdirSync(dir); } catch { pastas = []; }
  const alvo = grade.particoesExcluidas(pastas, excluidas, [...accounts.keys()]);
  const presas = [];
  for (const p of alvo) {
    try { fs.rmSync(path.join(dir, p), { recursive: true, force: true }); } catch { presas.push(p.slice(4)); }
  }
  // O que saiu (ou ja nao existia) deixa a lista; o que ficou preso tenta de novo.
  try { fs.writeFileSync(EXCLUIDAS_FILE, JSON.stringify(presas)); } catch { /* tenta na proxima */ }
  if (alvo.length) console.log(`sessoes de contas excluidas apagadas do disco: ${alvo.length - presas.length}`);
}

// ---------- boot ----------
app.whenReady().then(() => {
  aiStore = new AiStore(DATA_DIR);
  for (const cfg of loadConfig()) addAccount(cfg);
  varrerParticoesExcluidas();
  registerIpc();
  startCallbackServer();

  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 560, backgroundColor: '#0B0A1A',
    icon: ICONE,
    // Barra propria: o resumo da frota mora nela. Os botoes do Windows continuam
    // nativos por cima, entao snap, duplo clique e acessibilidade seguem do sistema.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#17152E', symbolColor: '#ABA6CC', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      webviewTag: true,
      sandbox: false,   // o preload precisa de path/url; o renderer so carrega arquivo local
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // erros do renderer no mesmo terminal: sem isso, falha de UI morre calada
  win.webContents.on('console-message', (...args) => {
    const d = args.find((x) => x && typeof x === 'object' && 'message' in x);
    console.log('[ui]', d ? d.message : args[2]);
  });

  // sessoes isoladas por conta ja existem via partition; so pre-aquece.
  for (const acc of accounts.values()) session.fromPartition(`persist:acc-${acc.id}`);

  // Proxy antes de qualquer janela de jogo nascer: aplicar depois vazaria o IP
  // real na primeira requisicao, que e justamente o que o recurso evita.
  // Maquina dormindo para o farm. O painel so segura o sono enquanto esta aberto.
  try { powerSaveBlocker.start('prevent-app-suspension'); } catch { /* sem suporte */ }
  try { blindarSessao(session.defaultSession); } catch { /* sessao ainda nao existe */ }

  carregarProxies();
  aplicarProxyEmTodas().catch((err) => console.error('proxy:', err.message));

  // Suspensa fica de fora: conectar aqui marcaria a conta como pronta e apagaria
  // a suspensao que acabou de ser lida do disco.
  for (const acc of accounts.values()) {
    if (GERENCIAMENTO && !acc.generica && acc.status !== 'suspenso') acc.connect().catch(() => {});
  }
  setTimeout(pollOnce, 3000);
  setInterval(pollOnce, POLL_MS);
  setInterval(evaluateRules, 60_000);
  setInterval(pushState, 5000);
});

app.on('window-all-closed', () => app.quit());
