'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LorvathAccount } = require('./lorvath-account');
const { evaluate } = require('./rules');

// Empacotado, __dirname vive dentro do app.asar (somente leitura): os dados vao
// para a pasta do usuario (%APPDATA%/Lovarth Fleet/data no Windows).
const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ACTION_LOG = path.join(DATA_DIR, 'actions.log');
const WS_SAMPLE = path.join(DATA_DIR, 'ws-sample.log');
const CALLBACK_PORT = 51380;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const POLL_MS = 60_000;

const accounts = new Map();      // id -> LorvathAccount
const authWindows = new Map();   // id -> BrowserWindow
let win = null;
let settings = { killSwitch: false, lightMode: false };
let macroQueue = Promise.resolve();   // ponytail: uma macro por vez no app inteiro

// ---------- persistencia ----------
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = readJson(ACCOUNTS_FILE, { accounts: [], settings });
  settings = { ...settings, ...(cfg.settings || {}) };
  return cfg.accounts || [];
}

function saveConfig() {
  const list = [...accounts.values()].map((a) => ({
    id: a.id, label: a.label, slot: a.slot, rules: a.rules,
  }));
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: list, settings }, null, 2));
}

function logAction(accId, msg) {
  const line = `${new Date().toISOString()} [${accId}] ${msg}\n`;
  fs.appendFileSync(ACTION_LOG, line);
  console.log(line.trim());
}

const DEFAULT_RULES = { enabled: true, minXpPerMin: 200, graceMin: 5, cooldownMin: 15 };

function addAccount(cfg) {
  const acc = new LorvathAccount(cfg, DATA_DIR, REDIRECT_URI, openAuthWindow);
  acc.rules = { ...DEFAULT_RULES, ...(cfg.rules || {}) };
  acc.badSince = 0;
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
    const reply = (msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><body style="font:16px system-ui;background:#111;color:#eee;padding:40px">${msg}</body>`);
    };
    if (!code || !acc) { reply('Callback invalido (sem code/state).'); return; }
    try {
      await acc.finishAuthorization(code);
      await acc.refreshAccount().catch(() => {});
      logAction(acc.id, 'autorizado no MCP');
      reply(`Conta <b>${acc.label}</b> autorizada. Pode fechar esta janela.`);
    } catch (err) {
      acc.status = 'error'; acc.lastError = String(err.message || err);
      reply(`Falhou: ${acc.lastError}`);
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

// ---------- poll + regras ----------
function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:state', {
    settings,
    accounts: [...accounts.values()].map((a) => ({ ...a.toJSON(), rules: a.rules })),
  });
}

async function pollOnce() {
  const list = [...accounts.values()];
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    // escalona: nao dispara 12 chamadas no mesmo instante
    setTimeout(async () => {
      try {
        if (acc.status === 'offline') await acc.connect();
        if (acc.status === 'ready') await acc.refreshAccount();
      } catch (err) {
        acc.lastError = String(err.message || err);
      }
      pushState();
    }, i * 1500);
  }
}

function evaluateRules() {
  if (settings.killSwitch) return;
  const now = Date.now();
  for (const acc of accounts.values()) {
    const { fire, badSince, why } = evaluate(acc, now);
    acc.badSince = badSince;
    if (fire) queueMacro(acc, `regra automatica: ${why}`);
  }
}

function queueMacro(acc, motivo) {
  acc.lastMacroAt = Date.now();   // reserva o cooldown ja na fila
  macroQueue = macroQueue.then(async () => {
    logAction(acc.id, `religando farm: ${motivo}`);
    try {
      const out = await acc.restartFarm();
      logAction(acc.id, out.ok ? `farm religado (${out.steps.map((s) => s[0]).join(' > ')})`
        : `abortado: ${out.hint}`);
      if (!out.ok) acc.status = 'blocked';
    } catch (err) {
      const msg = String(err.message || err);
      acc.lastError = msg;
      // "Player took control" nao tem solucao programatica: parar de tentar.
      if (/took control|released the assistant/i.test(msg)) acc.status = 'blocked';
      logAction(acc.id, `falhou: ${msg}`);
    }
    pushState();
  }).catch(() => {});
  return macroQueue;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('fleet:get', () => ({
    settings,
    accounts: [...accounts.values()].map((a) => ({ ...a.toJSON(), rules: a.rules })),
  }));

  ipcMain.handle('fleet:addAccount', (_e, label) => {
    const id = `acc${Date.now().toString(36)}`;
    const acc = addAccount({ id, label: label || `Conta ${accounts.size + 1}` });
    saveConfig();
    logAction(id, `conta criada (${acc.label})`);
    return acc.toJSON();
  });

  ipcMain.handle('fleet:removeAccount', (_e, id) => {
    accounts.delete(id);
    saveConfig();
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
    try { return { ok: true, ...(await acc.startAuthorization()) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('fleet:action', async (_e, { id, action }) => {
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: 'conta inexistente' };
    try {
      if (action === 'refresh') return { ok: true, data: await acc.refreshAccount() };
      if (action === 'restartFarm') { await queueMacro(acc, 'clique manual'); return { ok: true }; }
      if (action === 'sellTrash') { const d = await acc.sellTrash(); return { ok: true, data: d }; }
      if (action === 'reset') { acc.provider.invalidateCredentials('all'); acc._client = null; acc.status = 'needs_auth'; return { ok: true }; }
      return { ok: false, error: `acao desconhecida: ${action}` };
    } catch (err) {
      acc.lastError = String(err.message || err);
      return { ok: false, error: acc.lastError };
    } finally { pushState(); }
  });

  // telemetria vinda da webview de cada conta
  ipcMain.on('probe:stats', (_e, { id, stats }) => {
    const acc = accounts.get(id);
    if (!acc) return;
    acc.stats = { ...(acc.stats || {}), ...stats };
    acc.statsAt = Date.now();
  });

  ipcMain.on('probe:sample', (_e, { id, raw }) => {
    if (!process.env.DEBUG_WS) return;
    fs.appendFileSync(WS_SAMPLE, `--- ${id} ${new Date().toISOString()}\n${raw}\n`);
  });
}

// ---------- boot ----------
app.whenReady().then(() => {
  for (const cfg of loadConfig()) addAccount(cfg);
  registerIpc();
  startCallbackServer();

  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#0b0e14',
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

  for (const acc of accounts.values()) acc.connect().catch(() => {});
  setTimeout(pollOnce, 3000);
  setInterval(pollOnce, POLL_MS);
  setInterval(evaluateRules, 60_000);
  setInterval(pushState, 5000);
});

app.on('window-all-closed', () => app.quit());
