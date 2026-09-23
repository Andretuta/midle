'use strict';
// O card e construido uma vez por conta e depois so atualizado em texto:
// recriar o DOM a cada push recarregaria a webview do jogo a cada 5s.
const grid = document.getElementById('grid');
const live = new Set(JSON.parse(localStorage.getItem('live') || '[]'));  // contas com janela aberta
const cards = new Map();   // id -> { el, update, viewOpen }
let state = { accounts: [], settings: {} };

const saveLive = () => localStorage.setItem('live', JSON.stringify([...live]));
const num = (n) => (typeof n === 'number' ? n.toLocaleString('pt-BR') : '—');
const statusLabel = (a) => ({ ready: 'ok', needs_auth: 'precisa autorizar', offline: 'offline',
  error: 'erro', blocked: 'bloqueado no jogo' }[a.status] || a.status);
const mins = (ms) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

// Traduz a ultima decisao da regra (rules.js) em uma frase para o card.
// A janela aberta e o modo leve so o renderer sabe, por isso o texto nasce aqui.
function ruleLine(acc, windowOpen, lightMode) {
  const r = acc.rule;
  if (!r) return { tone: 'dim', text: 'regra: aguardando a primeira checagem' };
  const left = r.until ? mins(r.until - Date.now()) : '';
  const blind = r.code === 'no_telemetry' || r.code === 'stale';
  if (blind && lightMode) return { tone: 'warn', text: 'regra em pausa: o modo leve fecha a janela do jogo e, sem os dados dela, a regra não age' };
  if (blind && !windowOpen) return { tone: 'warn', text: 'regra em pausa: janela do jogo fechada. Abra o jogo para a regra enxergar o personagem' };
  switch (r.code) {
    case 'kill': return { tone: 'warn', text: 'regra em pausa: "parar regras automáticas" está ligado' };
    case 'off': return { tone: 'dim', text: 'regra desligada' };
    case 'not_ready': return { tone: 'warn', text: `regra em pausa: MCP não está pronto (${statusLabel(acc)})` };
    case 'no_telemetry': return { tone: 'dim', text: 'regra: aguardando os primeiros dados da janela do jogo' };
    case 'stale': return { tone: 'warn', text: `regra em pausa: a janela não manda dados há ${mins(acc.statsAge ?? 0)} (jogo desconectado?)` };
    case 'ok': return { tone: 'ok', text: 'regra vigiando: farm ok' };
    case 'grace': return { tone: 'warn', text: `${r.why}: religa em ${left} se continuar assim` };
    case 'cooldown': return { tone: 'warn', text: `${r.why}: em cooldown, nova tentativa em ${left}` };
    case 'fire': return { tone: 'ok', text: `regra disparou: religando farm (${r.why})` };
    default: return { tone: 'dim', text: `regra: ${r.code}` };
  }
}

function makeCard(a) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="chead">
      <span class="dot"></span>
      <span class="name" contenteditable spellcheck="false"></span>
      <span class="who" style="color:var(--dim)"></span>
      <span class="spacer"></span>
      <button data-act="toggleView">abrir jogo</button>
    </div>
    <div class="stats">
      <span>XP/min <b data-f="xpPerMin">—</b></span>
      <span>kills/min <b data-f="killsPerMin">—</b></span>
      <span>zen <b data-f="zen">—</b></span>
      <span>mapa <b data-f="map">—</b></span>
      <span>server <b data-f="server">—</b></span>
      <span>modo <b data-f="mode">—</b></span>
    </div>
    <div class="view"><div class="parked">janela fechada — a conta continua farmando offline
      <button data-act="toggleView">abrir jogo</button></div></div>
    <div class="actions">
      <button data-act="authorize" class="gold">autorizar MCP</button>
      <button data-act="restartFarm" class="gold" hidden>religar farm</button>
      <button data-act="sellTrash" hidden>vender lixo</button>
      <button data-act="refresh" hidden>ler conta</button>
      <button data-act="slot">slot 0 →</button>
      <button data-act="reset">limpar token</button>
      <button data-act="remove" class="danger">remover</button>
    </div>
    <div class="rules">
      <label><input type="checkbox" data-rule="enabled"> regra auto</label>
      <span>XP/min mínimo <input data-rule="minXpPerMin"></span>
      <span>espera <input data-rule="graceMin"> min</span>
      <span>cooldown <input data-rule="cooldownMin"> min</span>
      <span class="rulestate"></span>
    </div>
    <div class="err" hidden></div>`;

  const q = (sel) => el.querySelector(sel);
  const f = (name) => el.querySelector(`[data-f="${name}"]`);
  const btn = (act) => el.querySelector(`.actions [data-act="${act}"]`);
  const view = q('.view');

  function mountView(open) {
    if (open === !!view.querySelector('webview')) return;
    view.textContent = '';
    if (!open) {
      view.innerHTML = `<div class="parked">janela fechada — a conta continua farmando offline
        <button data-act="toggleView">abrir jogo</button></div>`;
      return;
    }
    const wv = document.createElement('webview');
    wv.setAttribute('partition', `persist:acc-${a.id}`);
    wv.setAttribute('src', 'https://lorvath.com');
    wv.setAttribute('preload', window.fleet.probeUrl);
    wv.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no');   // o probe precisa ver o window do jogo
    wv.setAttribute('allowpopups', '');
    wv.addEventListener('ipc-message', (ev) => {
      if (ev.channel === 'probe:stats') window.fleet.sendStats(a.id, ev.args[0]);
      else if (ev.channel === 'probe:sample') window.fleet.sendSample(a.id, ev.args[0]);
    });
    view.appendChild(wv);
  }

  function update(acc) {
    a = acc;
    const s = acc.stats || {};
    el.className = 'card' + (acc.status === 'blocked' ? ' blocked' : '');
    q('.dot').className = `dot ${acc.status}`;
    q('.dot').title = statusLabel(acc);
    if (document.activeElement !== q('.name')) q('.name').textContent = acc.label;
    q('.who').textContent = acc.char
      ? `${acc.char.name} · Lv ${acc.char.level ?? '?'}${acc.char.class ? ' · ' + acc.char.class : ''}`
      : statusLabel(acc);
    f('xpPerMin').textContent = num(s.xpPerMin);
    f('killsPerMin').textContent = num(s.killsPerMin);
    f('zen').textContent = num(s.zen);
    f('map').textContent = s.map || '—';
    f('server').textContent = s.server || '—';
    f('mode').textContent = s.manualMode ? 'MANUAL' : s.manualMode === 0 ? 'farm' : '—';

    const ready = acc.status === 'ready';
    btn('authorize').hidden = ready;
    for (const act of ['restartFarm', 'sellTrash', 'refresh']) btn(act).hidden = !ready;
    btn('slot').textContent = `slot ${acc.slot} →`;
    const err = q('.err');
    err.hidden = !acc.lastError;
    err.textContent = acc.lastError || '';

    for (const input of el.querySelectorAll('[data-rule]')) {
      if (document.activeElement === input) continue;
      const v = (acc.rules || {})[input.dataset.rule];
      if (input.type === 'checkbox') input.checked = !!v; else input.value = v ?? '';
    }
    const open = live.has(acc.id) && !state.settings.lightMode;
    const rs = ruleLine(acc, open, !!state.settings.lightMode);
    q('.rulestate').className = `rulestate ${rs.tone}`;
    q('.rulestate').textContent = rs.text;
    mountView(open);
    q('.chead [data-act="toggleView"]').textContent = open ? 'fechar jogo' : 'abrir jogo';
  }

  q('.name').addEventListener('blur', (e) => {
    const label = e.target.textContent.trim();
    if (label && label !== a.label) window.fleet.updateAccount(a.id, { label });
  });

  el.addEventListener('click', async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'toggleView') { live.has(a.id) ? live.delete(a.id) : live.add(a.id); saveLive(); return update(a); }
    if (act === 'remove') { if (confirm(`Remover ${a.label}?`)) { live.delete(a.id); saveLive(); await window.fleet.removeAccount(a.id); refresh(); } return; }
    if (act === 'authorize') { const r = await window.fleet.authorize(a.id); if (!r.ok) alert(r.error); return; }
    if (act === 'slot') { await window.fleet.updateAccount(a.id, { slot: (a.slot + 1) % 5 }); return refresh(); }
    e.target.disabled = true;
    const r = await window.fleet.action(a.id, act);
    e.target.disabled = false;
    if (!r.ok) alert(`${a.label}: ${r.error}`);
    refresh();
  });

  el.addEventListener('change', (e) => {
    const key = e.target.dataset?.rule;
    if (!key) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    window.fleet.updateAccount(a.id, { rules: { [key]: value } });
  });

  return { el, update };
}

function render() {
  const seen = new Set();
  for (const acc of state.accounts) {
    seen.add(acc.id);
    let c = cards.get(acc.id);
    if (!c) { c = makeCard(acc); cards.set(acc.id, c); grid.appendChild(c.el); }
    c.update(acc);
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }

  const empty = document.getElementById('empty');
  if (!state.accounts.length && !empty) {
    grid.insertAdjacentHTML('beforeend', '<div class="empty" id="empty">Nenhuma conta ainda. Clique em <b>+ Conta</b>, abra o jogo, faça login (Kick / Twitch / Discord / QR) e depois <b>autorizar MCP</b>.</div>');
  } else if (state.accounts.length && empty) empty.remove();

  for (const el of [document.getElementById('lightMode'), document.getElementById('killSwitch')]) {
    if (document.activeElement !== el) el.checked = !!state.settings[el.id];
  }
  const ready = state.accounts.filter((a) => a.status === 'ready').length;
  document.getElementById('summary').textContent =
    `${state.accounts.length} contas · ${ready} no MCP · ${[...live].length} janelas abertas`;
}

let booted = false;
async function refresh() {
  state = await window.fleet.get();
  render();
  if (!booted) { booted = true; console.log(`ui pronta: ${state.accounts.length} contas`); }
}

document.getElementById('add').onclick = async () => {
  const label = prompt('Nome da conta (ex: Conta 1 / email):');
  if (label === null) return;
  await window.fleet.addAccount(label);
  refresh();
};
document.getElementById('refreshAll').onclick = async () => {
  for (const a of state.accounts) if (a.status === 'ready') await window.fleet.action(a.id, 'refresh');
  refresh();
};
document.getElementById('lightMode').onchange = (e) => window.fleet.setSettings({ lightMode: e.target.checked });
document.getElementById('killSwitch').onchange = (e) => window.fleet.setSettings({ killSwitch: e.target.checked });

window.fleet.onState((s) => { state = s; render(); });
refresh();
