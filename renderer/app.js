'use strict';
// Casca do painel: lista de contas a esquerda, uma conta em detalhe a direita.
// So o detalhe monta webview -- e o que faz 12 contas caberem na memoria, e e o
// mesmo motivo pelo qual "ver" e exclusivo na frota: um jogo na tela por vez.

let state = { settings: {}, accounts: [] };
let booted = false;
let selected = null;
try { selected = localStorage.getItem('sel'); } catch {}

// O que ja esta na tela. Reconstruir o palco a cada push recarrega a janela do
// jogo do zero -- medido: 5 pushes em 20s viravam 4 recargas, e o jogo nunca saia
// da tela de servidor. So reconstroi quando a conta ou o modo mudam de verdade.
let montado = { id: null, palco: null };
const linhas = new Map();   // id -> elemento da lista

const $ = (s) => document.querySelector(s);
const list = $('#list');
const pane = $('#pane');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (typeof v === 'number' ? v.toLocaleString('pt-BR') : '—');
const byId = (id) => state.accounts.find((a) => a.id === id) || null;

const MOTIVO_STATUS = {
  offline: 'Sem sessão de gerenciamento ainda.',
  needs_auth: 'Precisa autorizar o gerenciamento nesta conta.',
  error: 'A última chamada falhou.',
  blocked: 'Bloqueada no jogo. Destrave na janela do jogo e tente de novo.',
  suspenso: 'Alguém entrou nesta conta por fora do painel. Retome quando quiser.',
};

// ---------- lista ----------

function renderList() {
  const vivos = new Set(state.accounts.map((a) => a.id));
  for (const [id, el] of linhas) if (!vivos.has(id)) { el.remove(); linhas.delete(id); }

  const vazio = list.querySelector('.hint');
  if (!state.accounts.length) {
    if (!vazio) list.insertAdjacentHTML('beforeend',
      '<p class="hint vazio">Cada conta aqui ganha sessão e login próprios.<br>' +
      'Comece por <b>+ Conta</b>, embaixo.</p>');
    return;
  }
  if (vazio) vazio.remove();

  for (const a of state.accounts) {
    let el = linhas.get(a.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('role', 'listitem');
      el.dataset.id = a.id;
      el.innerHTML = '<span class="nm somivel"><i class="dot"></i><span class="txt"></span></span>' +
        '<span class="lvl num somivel"></span><span class="meta somivel"></span>';
      el.onclick = () => { selected = a.id; try { localStorage.setItem('sel', a.id); } catch {} render(); };
      // Botao direito abre o menu da conta SEM seleciona-la: selecionar abre a
      // janela, e quem vai excluir uma conta nao quer abri-la antes.
      el.oncontextmenu = (ev) => { ev.preventDefault(); window.fleet.menuConta(el.dataset.id); };
      linhas.set(a.id, el);
      list.appendChild(el);
    }
    const modo = a.suspended ? 'suspenso' : a.effective || 'gerenciar';
    const cls = `row ${modo}${a.id === selected ? ' sel' : ''}`;
    if (el.className !== cls) el.className = cls;
    el.setAttribute('aria-current', a.id === selected ? 'true' : 'false');
    troca(el.querySelector('.dot'), 'className', `dot ${a.suspended ? 'suspenso' : a.status}`);
    troca(el.querySelector('.txt'), 'textContent', a.label);
    // Recolhida, a linha e so um traco de cor: o nome tem que chegar de algum
    // jeito, e passar o mouse e o unico que sobra sem largura.
    troca(el, 'title', `${a.label} — ${rotuloModo(a)}`);
    troca(el.querySelector('.lvl'), 'textContent', a.char ? 'Lv ' + a.char.level : '');
    troca(el.querySelector('.meta'), 'textContent', rotuloModo(a));
  }
}

/** "google.com" a partir da URL inteira: e o que cabe na linha da conta. */
function hostDe(url) {
  try {
    const u = new URL(url);
    // Arquivo local nao tem host: mostra o nome do arquivo, senao a linha fica vazia.
    return u.hostname.replace(/^www\./, '') || decodeURIComponent(u.pathname.split('/').pop()) || 'arquivo local';
  } catch { return 'janela'; }
}

/**
 * O modo "o painel gerencia" esta DESLIGADO (18/09/2026). Espelha a constante de
 * mesmo nome em `main.js` -- as duas precisam concordar. Com ela em false, toda
 * conta e apenas uma janela: aberta ou fechada. Nada foi apagado; o caminho de
 * gerenciamento continua no codigo e nas specs, so nao e usado.
 */
const GERENCIAMENTO = false;

/** Esta conta e gerenciada pelo painel, ou e so uma janela? */
const gerenciada = (a) => GERENCIAMENTO && !a.generica;

/** So escreve no DOM quando o valor mudou: evita repaint e nao rouba o cursor. */
function troca(el, prop, valor) { if (el && el[prop] !== valor) el[prop] = valor; }

function rotuloModo(a) {
  if (!gerenciada(a)) {
    const onde = a.generica ? hostDe(a.site) : 'janela';
    return a.effective === 'ver' ? onde : `${onde} · fechada`;
  }
  if (a.suspended) return 'suspensa';
  if (a.switching) return a.reason || 'trocando…';
  return a.effective === 'ver' ? 'você joga' : 'painel gerencia';
}

// ---------- grade de janelas ----------
// Varias contas na tela ao mesmo tempo, como um monitor de frota. A regra dura:
// cada webview nasce uma vez e nunca muda de pai -- reparentar recarrega o jogo.
const janelas = new Map();     // id -> celula ja montada
const vagas = new Map();       // id -> cartao de conta sem janela
const dormindo = new Set();    // ids em Modo Eco; preferencia de quem olha, nao estado da conta
let grade = false;
try { grade = localStorage.getItem('grade') === '1'; } catch {}

// colunas e ganhoDoDia vem de grade.js pela ponte: decisao pura mora em modulo
// com assercao, nunca dentro da tela (Principio IV).
const colunas = (n) => window.fleet.colunas(n);

function renderGrade() {
  let g = pane.querySelector('#grade');
  if (!g) {
    montado = { id: null, palco: 'grade' };
    janelas.clear();
    pane.classList.add('grade');
    pane.innerHTML = '<div id="grade"></div>';
    g = pane.querySelector('#grade');
  }
  // Solta fica de fora: a janela dela mora fora do painel, e ter as duas abertas
  // seriam duas presencas da mesma conta no jogo.
  const abertas = state.accounts.filter((a) => a.effective === 'ver' && !a.suspended && !a.solta);

  for (const [id, cel] of janelas) {
    if (!abertas.some((a) => a.id === id)) { cel.remove(); janelas.delete(id); dormindo.delete(id); }
  }
  for (const a of abertas) {
    let cel = janelas.get(a.id);
    if (!cel) {
      cel = criarCelula(a);
      janelas.set(a.id, cel);
      g.appendChild(cel);
      // So depois de estar no DOM: o anexo espera o palco ter altura, e palco fora
      // da arvore nunca mede nada -- era por isso que a grade nascia vazia.
      anexarQuandoMedir(cel.querySelector('.tela'), a);
    }
    atualizarCelula(cel, a);
  }
  // A grade mostra a FROTA, nao so as janelas. Ativar a grade com uma conta
  // aberta e outra gerenciada mostrava uma janela e calava sobre a outra -- da
  // cadeira de quem clicou, "ativei a grade e nao apareceu grade". Cada conta
  // sem janela ganha uma vaga que diz o que ela esta fazendo e oferece a unica
  // acao que a traz para ca. Vaga nao cria <webview>: nao custa memoria.
  //
  // Suspensa fica de fora, por FR-011 da spec 002: ela aparece na coluna, com
  // traco vermelho e no contador do cabecalho.
  const semJanela = state.accounts.filter((a) => (a.effective !== 'ver' || a.solta) && !a.suspended);

  for (const [id, v] of vagas) {
    if (!semJanela.some((a) => a.id === id)) { v.remove(); vagas.delete(id); }
  }
  for (const a of semJanela) {
    let v = vagas.get(a.id);
    if (!v) { v = criarVaga(a); vagas.set(a.id, v); }
    g.appendChild(v);          // sempre depois das celulas: janela viva vem antes
    atualizarVaga(v, a);
  }

  g.style.setProperty('--cols', colunas(abertas.length + semJanela.length));

  const vazio = g.querySelector('.hint');
  if (!state.accounts.length && !vazio) {
    g.insertAdjacentHTML('beforeend',
      '<p class="hint" style="padding:20px;grid-column:1/-1">Nenhuma conta ainda. ' +
      'Use <b>+ Conta</b> na coluna da esquerda.</p>');
  } else if (state.accounts.length && vazio) { vazio.remove(); }
}

/** Cartao de uma conta que existe mas nao esta na tela. */
function criarVaga(a) {
  const v = document.createElement('div');
  v.className = 'cel vaga';
  v.dataset.id = a.id;
  v.innerHTML = '<div class="top"><span class="nm"></span><span class="spacer"></span></div>' +
    '<div class="corpo"><span class="rot"></span><span class="sub"></span>' +
    '<button class="abrir" type="button"></button></div>';
  v.querySelector('.abrir').onclick = async () => {
    const acao = v.dataset.acao;
    if (acao === 'autorizar') { await window.fleet.authorize(a.id); return refresh(); }
    if (acao === 'retomar') { await window.fleet.resumeAccount(a.id); return refresh(); }
    if (acao === 'recolher') { await window.fleet.recolher(a.id); return refresh(); }
    const r = await window.fleet.setMode(a.id, 'ver');
    if (!r.ok) mostrarErro(a, r.reason);
    refresh();
  };
  return v;
}

function atualizarVaga(v, a) {
  troca(v.querySelector('.nm'), 'textContent', a.label);
  // Cada estado tem UMA acao que faz sentido, e e a unica que o cartao oferece.
  const plano = a.solta
    ? { rot: 'Janela solta', sub: 'Está fora do painel. Arraste-a até a barra de cima para trazer de volta.', btn: 'Trazer de volta', acao: 'recolher' }
    : !gerenciada(a)
    ? { rot: 'Janela fechada', sub: a.generica ? hostDe(a.site) : 'Fechada não ocupa memória. A sessão continua guardada.', btn: 'Abrir', acao: 'abrir' }
    : a.status === 'needs_auth'
      ? { rot: 'Precisa de autorização', sub: 'Entre no jogo e autorize o painel a agir nesta conta.', btn: 'Autorizar', acao: 'autorizar' }
      : a.switching
        ? { rot: a.reason || 'Trocando de modo', sub: 'Pode levar até 2 minutos.', btn: 'Aguarde', acao: '' }
        : { rot: 'O painel gerencia', sub: 'O personagem continua farmando sem janela.', btn: 'Abrir janela', acao: 'abrir' };
  troca(v.querySelector('.rot'), 'textContent', plano.rot);
  troca(v.querySelector('.sub'), 'textContent', plano.sub);
  const b = v.querySelector('.abrir');
  troca(b, 'textContent', plano.btn);
  b.disabled = !plano.acao;
  v.dataset.acao = plano.acao;
}

function criarCelula(a) {
  const cel = document.createElement('div');
  cel.className = 'cel';
  cel.dataset.id = a.id;
  cel.innerHTML = `
    <div class="top">
      <span class="nm"></span><span class="lv"></span><span class="spacer"></span>
      <button data-cel="eco" aria-label="Repouso: parar de desenhar esta janela" title="Repouso: para de desenhar esta janela">◐</button>
      <button data-cel="menos" aria-label="Diminuir o zoom desta janela" title="Diminuir o zoom desta janela">−</button>
      <button data-cel="mais" aria-label="Aumentar o zoom desta janela" title="Aumentar o zoom desta janela">+</button>
      <button data-cel="recarregar" aria-label="Recarregar esta janela" title="Recarregar">⟳</button>
      <button data-cel="mudo" aria-label="Silenciar esta janela" title="Mudo">♪</button>
      <button data-cel="soltar" aria-label="Soltar esta janela do painel" title="Soltar do painel: vira uma janela sua, do tamanho que quiser. Para voltar, arraste até a barra de cima do painel.">⧉</button>
      <button data-cel="fechar" aria-label="Fechar esta janela" title="Fechar esta janela">✕</button>
    </div>
    <div class="tela"></div>`;
  cel.querySelector('.tela').dataset.conta = a.id;
  return cel;
}

function atualizarCelula(cel, a) {
  troca(cel.querySelector('.nm'), 'textContent', a.label);
  troca(cel.querySelector('.lv'), 'textContent', a.char ? 'Lv ' + a.char.level : '');
  const eco = dormindo.has(a.id);
  cel.classList.toggle('eco', eco);
  cel.querySelector('[data-cel=eco]').classList.toggle('on', eco);
  const wv = cel.querySelector('webview');
  if (wv) wv.style.display = eco ? 'none' : '';
  let card = cel.querySelector('.dorme');
  if (eco && !card) {
    card = document.createElement('div');
    card.className = 'dorme';
    card.innerHTML = `<div class="hora">--:--:--</div>
      <div class="selo">MODO ECO · ${esc(a.label)}</div>
      <div class="sub">O personagem continua farmando. Clique para voltar ao jogo.</div>
      <div class="nota">Economiza processador, não memória: a página segue carregada.
      Para economizar memória, deixe a conta em GERENCIAR.</div>`;
    card.onclick = () => { dormindo.delete(a.id); render(); };
    cel.querySelector('.tela').appendChild(card);
  } else if (!eco && card) { card.remove(); }
}

/** Um relogio so para a grade inteira. */
setInterval(() => {
  if (!dormindo.size) return;
  const t = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  for (const el of document.querySelectorAll('.dorme .hora')) troca(el, 'textContent', t);
}, 1000);

// ---------- detalhe ----------

function renderPane() {
  if (grade) return renderGrade();
  if (pane.classList.contains('grade')) {   // saindo da grade: o detalhe se reconstroi
    pane.classList.remove('grade');
    janelas.clear();
    montado = { id: null, palco: null };
  }
  const a = byId(selected) || state.accounts[0] || null;
  if (a) selected = a.id;
  if (!a) {
    montado = { id: null, palco: null };
    pane.innerHTML = '<div class="msg"><span class="big">Nenhuma conta selecionada</span>' +
      '<span class="sub">Adicione uma conta para começar. Cada conta ganha login próprio e sessão isolada.</span></div>';
    return;
  }
  const ver = a.effective === 'ver' && !a.switching && !a.suspended;
  // A chave de reconstrucao tem que ser exatamente aquilo em que montarPalco se
  // ramifica. Quando era so `ver`, autorizar uma conta deixava a tela "Autorize"
  // para sempre, e suspender deixava o painel de gerenciamento de uma conta parada.
  const palco = qualPalco(a, ver);
  if (montado.id !== a.id || montado.palco !== palco) {
    // Antes de construir: o anexo do webview espera frames e checa montado.id para
    // saber se a conta ainda e a mesma. Marcar depois fazia ele desistir na hora.
    montado = { id: a.id, palco };
    construirPainel(a, ver);
  }
  atualizarPainel(a, ver);
}

/** Estrutura fixa. Chamado so quando a conta ou o modo mudam: e aqui que a janela
 *  do jogo nasce ou morre, entao rodar isto a toa recarrega o jogo. */
function construirPainel(a, ver) {
  pane.innerHTML = `
    <div id="phead">
      <span class="nm" contenteditable spellcheck="false"></span>
      <span class="spacer"></span>
      <div class="modesw" role="group" aria-label="Modo da conta">
        <button data-mode="ver">VER</button>
        <button data-mode="gerenciar">GERENCIAR</button>
      </div>
      <button data-act="remove" title="Remover conta">Remover</button>
    </div>
    <div class="switching" hidden><i class="spin"></i><span class="txt"></span></div>
    <div id="stage"></div>
    <div id="pfoot">
      <div class="stats"></div>
      <div class="actions"></div>
      <div class="rules"></div>
      <div class="err" hidden></div>
    </div>`;

  montarPalco(a, ver);

  pane.querySelector('#phead .nm').addEventListener('blur', (e) => {
    const label = e.target.textContent.trim();
    const atual = byId(montado.id);
    if (label && atual && label !== atual.label) window.fleet.updateAccount(atual.id, { label });
  });
  for (const b of pane.querySelectorAll('.modesw button')) {
    b.onclick = async () => {
      const r = await window.fleet.setMode(montado.id, b.dataset.mode);
      if (!r.ok) mostrarErro(byId(montado.id), r.reason);
      refresh();
    };
  }
}

/** Só os valores que mudam. Nunca toca no palco. */
function atualizarPainel(a, ver) {
  const nm = pane.querySelector('#phead .nm');
  if (document.activeElement !== nm) troca(nm, 'textContent', a.label);

  for (const b of pane.querySelectorAll('.modesw button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === 'ver' ? ver : !ver));
    b.disabled = !!a.switching;
    if (!gerenciada(a)) troca(b, 'textContent', b.dataset.mode === 'ver' ? 'ABRIR' : 'FECHAR');
  }

  // Janela comum nao tem stats, acao nem regra de farm: o rodape do jogo sairia
  // vazio e as regras prometeriam algo que o painel nao faz fora do Lorvath.
  const foot = pane.querySelector('#pfoot');
  if (foot) foot.hidden = !gerenciada(a);
  if (!gerenciada(a)) { pane.querySelector('.switching').hidden = true; return; }

  const sw = pane.querySelector('.switching');
  sw.hidden = !a.switching;
  if (a.switching) troca(sw.querySelector('.txt'), 'textContent',
    `${a.reason || 'Trocando de modo'} — pode levar até 2 minutos.`);

  montarStats(a);
  montarAcoes(a, a.canManage || { ok: false, reason: '' });
  montarRegras(a);

  const err = pane.querySelector('.err');
  err.hidden = !a.lastError;
  troca(err, 'textContent', a.lastError || '');
}

/** Qual das telas do palco esta valendo. Fonte unica da ramificacao. */
function qualPalco(a, ver) {
  if (a.suspended) return 'suspenso';
  if (ver && a.solta) return 'solta';
  if (a.status === 'needs_auth') return 'auth';
  return ver ? 'ver' : 'gerenciar';
}

function montarPalco(a, ver) {
  const stage = pane.querySelector('#stage');
  stage.dataset.conta = a.id;
  if (a.suspended) {
    stage.innerHTML = `<div class="msg"><span class="big">Gerenciamento pausado</span>
      <span class="sub">${esc(MOTIVO_STATUS.suspenso)}</span>
      <button data-act="resume">Retomar gerenciamento</button></div>`;
    return;
  }
  if (a.status === 'needs_auth') {
    stage.innerHTML = `<div class="msg"><span class="big">Autorize o gerenciamento</span>
      <span class="sub">Abra o jogo, faça login, e autorize o painel a agir nesta conta.</span>
      <button class="gold" data-act="authorize">Autorizar</button></div>`;
    return;
  }
  if (ver && a.solta) {
    stage.innerHTML = `<div class="msg"><span class="big">Janela solta</span>
      <span class="sub">${esc(a.label)} está numa janela própria, fora do painel. Arraste-a até a
      barra de cima do painel para trazer de volta.</span>
      <button data-act="recolher">Trazer de volta</button></div>`;
    return;
  }
  if (!ver && !gerenciada(a)) {
    stage.innerHTML = `<div class="msg"><span class="big">Janela fechada</span>
      <span class="sub">Fechada ela não ocupa memória. Clique em <b>ABRIR</b> para trazer
      ${esc(a.generica ? hostDe(a.site) : a.label)} de novo — a sessão e o login continuam guardados.</span></div>`;
    return;
  }
  if (!ver) {
    stage.innerHTML = `<div class="msg"><span class="big">O painel está gerenciando</span>
      <span class="sub">O personagem continua farmando no servidor. Mude para <b>VER</b> quando quiser jogar com as próprias mãos.</span></div>`;
    return;
  }
  // O guest congela o tamanho que enxerga ao nascer. Anexar no mesmo instante em
  // que o innerHTML foi trocado pega o palco com altura 0 -- o jogo carrega
  // inteiro e nao desenha nada. Espera o layout existir antes de anexar.
  anexarQuandoMedir(stage, a);
}

function anexarQuandoMedir(stage, a, tentativa = 0) {
  // O palco precisa continuar na tela E continuar sendo o desta conta: no detalhe
  // quem responde e `montado`, na grade e a propria celula.
  if (!stage.isConnected || stage.dataset.conta !== a.id) return;
  if (stage.clientHeight < 1 && tentativa < 30) {
    return requestAnimationFrame(() => anexarQuandoMedir(stage, a, tentativa + 1));
  }
  const wv = document.createElement('webview');
  wv.setAttribute('partition', `persist:acc-${a.id}`);
  wv.setAttribute('src', a.site || 'https://lorvath.com');
  // A sonda le o texto da pagina. Num site que nao e o jogo isso seria bisbilhotar
  // sem motivo -- e nao haveria HUD para ler de qualquer jeito.
  if (!a.generica) wv.setAttribute('preload', window.fleet.probeUrl);
  wv.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no');
  wv.setAttribute('allowpopups', '');
  // Sem autosize o guest nunca mais muda de tamanho depois de nascer, entao a
  // janela do app deixaria de acompanhar o resize. Medido nos dois cenarios.
  wv.setAttribute('autosize', 'on');
  wv.setAttribute('minwidth', '320'); wv.setAttribute('minheight', '240');
  wv.setAttribute('maxwidth', '6000'); wv.setAttribute('maxheight', '6000');
  // A janela nasce sem saber do teto de quadros: conta assim que ela responde.
  wv.addEventListener('dom-ready', () => { aplicarFps(wv); gravarCliques(wv); });
  wv.addEventListener('ipc-message', (ev) => {
    if (ev.channel === 'probe:stats') window.fleet.sendStats(a.id, ev.args[0]);
  });
  stage.appendChild(wv);
}

function montarStats(a) {
  const s = a.stats || {};
  const campos = [
    ['XP/min', num(s.xpPerMin)], ['Kills/min', num(s.killsPerMin)],
    ['Zen (bolsa)', num(s.zenBolsa)], ['Zen ganho', num(s.zenGanho)],
    ['HP', typeof s.hpPct === 'number' ? `${s.hpPct}%` : '—'],
    ['Mapa', s.map || '—'], ['Servidor', s.server || '—'],
    // `state` vem do canal de jogo e substitui o antigo manualMode, que nunca era
    // preenchido: diz direto se o personagem esta atacando ou parado.
    ['Ação', atividade(s)],
  ];
  const box = pane.querySelector('.stats');
  box.classList.toggle('stale', !!a.stale);
  // Estrutura fixa, valores remendados: reescrever o bloco inteiro fazia a linha
  // piscar a cada push mesmo quando nenhum numero tinha mudado.
  if (box.children.length !== campos.length + 1) {
    box.innerHTML = campos.map(([k]) => `<span class="stat">${k}<b></b></span>`).join('') +
      '<span class="stat velha" hidden style="color:var(--warn)"></span>';
  }
  campos.forEach(([, v], i) => troca(box.children[i].querySelector('b'), 'textContent', String(v)));
  // Numero velho sem idade engana: em modo gerenciar estes valores sao restos da
  // ultima vez que a janela esteve aberta, e podem ser de horas atras.
  const velha = box.querySelector('.velha');
  velha.hidden = !a.stale;
  if (a.stale) troca(velha, 'textContent', a.statsAt ? `medido ${idade(a.statsAt)} atrás` : 'sem telemetria');
}

/** Traduz o estado cru do jogo para o que o usuário precisa saber. */
function atividade(s) {
  if (typeof s.state !== 'string') return s.manualMode ? 'manual' : '—';
  return s.state === 'attacking' ? 'farmando' : s.state;
}

/** "3 min", "2 h" — o suficiente para saber se o numero ainda vale alguma coisa. */
function idade(quando) {
  const seg = Math.max(0, Math.round((Date.now() - quando) / 1000));
  if (seg < 90) return `${seg} s`;
  const min = Math.round(seg / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

function montarAcoes(a, pode) {
  const acoes = [['restartFarm', 'Religar farm'], ['sellTrash', 'Vender lixo'], ['refresh', 'Ler conta']];
  const box = pane.querySelector('.actions');
  const html = acoes.map(([act, txt]) =>
    `<button data-act="${act}" ${pode.ok ? '' : 'disabled'} title="${esc(pode.ok ? '' : pode.reason)}">${txt}</button>`).join('') +
    `<button data-act="slot">Personagem: slot ${a.slot}</button>` +
    `<button data-act="clearToken" class="danger">Limpar autorização</button>` +
    (pode.ok ? '' : `<span class="hint" style="align-self:center">${esc(pode.reason || MOTIVO_STATUS[a.status] || '')}</span>`);
  troca(box, 'innerHTML', html);
}

function montarRegras(a) {
  const r = a.rules || {};
  // Se o usuario esta digitando num campo de regra, nao reescreve a linha por baixo dele.
  if (pane.querySelector('.rules')?.contains(document.activeElement)) return;
  const html =
    `<label class="toggle"><input type="checkbox" data-rule="enabled" ${r.enabled ? 'checked' : ''}> Religar farm sozinho</label>` +
    `<label class="toggle">XP/min mínimo <input type="number" data-rule="minXpPerMin" value="${r.minXpPerMin ?? ''}"></label>` +
    `<label class="toggle">Espera <input type="number" data-rule="graceMin" value="${r.graceMin ?? ''}"> min</label>` +
    `<label class="toggle">Cooldown <input type="number" data-rule="cooldownMin" value="${r.cooldownMin ?? ''}"> min</label>` +
    (a.effective === 'ver' ? '<span class="hint">Suspensa enquanto você joga.</span>' : '');
  troca(pane.querySelector('.rules'), 'innerHTML', html);
}

// ---------- eventos do painel ----------

// Botoes da celula da grade. Ficam antes do resto porque a grade nao tem `selected`:
// quem manda e a celula em que voce clicou.
pane.addEventListener('click', async (e) => {
  const cmd = e.target.dataset?.cel;
  if (!cmd) return;
  const cel = e.target.closest('.cel');
  const id = cel?.dataset.id;
  if (!id) return;
  const wv = cel.querySelector('webview');
  if (cmd === 'eco') { dormindo.has(id) ? dormindo.delete(id) : dormindo.add(id); return render(); }
  if (cmd === 'recarregar') { try { wv?.reload(); } catch { /* ainda nascendo */ } return; }
  if (cmd === 'mais' || cmd === 'menos') {
    try {
      // Passo de 10% com teto: o jogo some abaixo de 50% e estoura o layout acima de 150%.
      const z = Math.min(1.5, Math.max(0.5, wv.getZoomFactor() + (cmd === 'mais' ? 0.1 : -0.1)));
      wv.setZoomFactor(z);
      mostrarAviso(`Zoom ${Math.round(z * 100)}%`);
    } catch { /* ainda nascendo */ }
    return;
  }
  if (cmd === 'mudo') {
    try { const m = !wv.isAudioMuted(); wv.setAudioMuted(m); e.target.classList.toggle('on', m); } catch {}
    return;
  }
  if (cmd === 'soltar') {
    const r = await window.fleet.soltar(id);
    if (!r.ok) mostrarErro(byId(id), r.reason);
    else mostrarAviso('Janela solta — arraste até a barra de cima do painel para trazer de volta');
    return refresh();
  }
  if (cmd === 'fechar') {
    const r = await window.fleet.setMode(id, 'gerenciar');
    if (!r.ok) mostrarErro(byId(id), r.reason);
    return refresh();
  }
});

pane.addEventListener('click', async (e) => {
  const act = e.target.dataset?.act;
  const a = byId(selected);
  if (!act || !a) return;
  if (act === 'remove') {
    if (!confirm(`Remover ${a.label}? A autorização e os cookies desta conta são apagados.`)) return;
    await window.fleet.removeAccount(a.id);
    selected = null;
    return refresh();
  }
  if (act === 'authorize') { const r = await window.fleet.authorize(a.id); if (!r.ok) mostrarErro(a, r.error); return; }
  if (act === 'resume') { await window.fleet.resumeAccount(a.id); return refresh(); }
  if (act === 'recolher') { await window.fleet.recolher(a.id); return refresh(); }
  if (act === 'slot') { await window.fleet.updateAccount(a.id, { slot: (a.slot + 1) % 5 }); return refresh(); }
  e.target.disabled = true;
  const r = await window.fleet.action(a.id, act);
  e.target.disabled = false;
  // Falha de acao e rotina, nao emergencia: modal bloqueante para isso e castigo.
  if (!r.ok) mostrarErro(a, r.error);
  refresh();
});

pane.addEventListener('change', (e) => {
  const key = e.target.dataset?.rule;
  if (!key || !selected) return;
  const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  window.fleet.updateAccount(selected, { rules: { [key]: value } });
});

// ---------- recolher a coluna de contas ----------
// Anima a faixa da grade em vez de deslizar a coluna para fora: o palco precisa
// GANHAR a largura de verdade, senao as janelas do jogo ficam do mesmo tamanho com
// um pedaco escondido atras. Como ninguem reparenta o <webview>, o jogo nao
// recarrega -- e e por isso que a animacao pode existir.
let recolhido = false;
try { recolhido = localStorage.getItem('recolhido') === '1'; } catch { /* modo privado */ }

function pintarPuxador() {
  document.body.classList.toggle('recolhido', recolhido);
  const b = $('#puxador');
  b.setAttribute('aria-expanded', String(!recolhido));
  b.title = recolhido ? 'Mostrar a coluna de contas (Ctrl+B)' : 'Recolher a coluna de contas (Ctrl+B)';
  // A coluna recolhida nao deve engolir o foco do teclado num conteudo invisivel.
  for (const el of document.querySelectorAll('#rail .somivel')) el.inert = recolhido;
}

function alternarColuna() {
  recolhido = !recolhido;
  try { localStorage.setItem('recolhido', recolhido ? '1' : '0'); } catch { /* modo privado */ }
  pintarPuxador();
}

$('#puxador').onclick = alternarColuna;
pintarPuxador();

// ---------- nova janela ----------
// O painel serve para o Lorvath e para qualquer outra pagina. Quem escolhe e quem
// abre: Lorvath vira conta gerenciada, o resto vira navegador com sessao propria.
// Destinos sugeridos para janela comum. O Lorvath nao esta na lista: ele e uma
// das duas cartas, porque escolher entre "conta de jogo" e "janela qualquer" e
// uma decisao de outra natureza, nao mais um item de menu.
const SITES = [
  ['https://www.google.com', 'Google'],
  ['https://www.youtube.com', 'YouTube'],
  ['https://web.whatsapp.com', 'WhatsApp Web'],
  ['https://mail.google.com', 'Gmail'],
  ['', 'Outro endereço…'],
];
const LORVATH = 'https://lorvath.com';
const nova = $('#nova');
let tipoNovo = 'jogo';

/** Uma so funcao decide o que a janela mostra, para as tres pecas nunca discordarem. */
function pintarEscolha() {
  for (const c of nova.querySelectorAll('.carta')) {
    c.setAttribute('aria-pressed', String(c.dataset.tipo === tipoNovo));
  }
  const comum = tipoNovo === 'comum';
  $('#novoSiteBox').hidden = !comum;
  $('#novoUrlBox').hidden = !comum || !!$('#novoSite').value;
  $('#novoHint').textContent = !comum
    ? (GERENCIAMENTO
      ? 'O painel vai pedir autorização nesta conta na primeira vez.'
      : 'O gerenciamento está desligado, então ela entra como janela do jogo — sem automação.')
    : $('#novoSite').value ? 'Sessão isolada e login próprio, como toda janela do painel.'
      : 'Cole o endereço completo, com https://';
}

$('#add').onclick = () => {
  tipoNovo = 'jogo';
  $('#novoNome').value = '';
  $('#novoNome').placeholder = `Conta ${state.accounts.length + 1}`;
  $('#novoSite').innerHTML = SITES.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  $('#novoUrl').value = '';
  pintarEscolha();
  nova.showModal();
  $('#novoNome').focus();
};

for (const c of nova.querySelectorAll('.carta')) {
  c.onclick = () => { tipoNovo = c.dataset.tipo; pintarEscolha(); };
}
$('#novoSite').onchange = pintarEscolha;

$('#novoCancelar').onclick = () => nova.close();

$('#novoCriar').onclick = async (e) => {
  e.preventDefault();
  const site = tipoNovo === 'jogo' ? LORVATH : ($('#novoSite').value || $('#novoUrl').value.trim());
  if (!site) return void ($('#novoHint').textContent = 'Falta o endereço.');
  try { new URL(site); } catch { return void ($('#novoHint').textContent = 'Endereço inválido — comece com https://'); }
  nova.close();
  const acc = await window.fleet.addAccount({ label: $('#novoNome').value.trim() || null, site });
  selected = acc.id;
  try { localStorage.setItem('sel', acc.id); } catch {}
  await refresh();
  const nm = pane.querySelector('#phead .nm');
  if (nm && !acc.generica) { nm.focus(); getSelection().selectAllChildren(nm); }
};
// Saida de emergencia: fecha tudo sem perguntar nada a ninguem, inclusive o que
// esta travado trocando de modo e o popup de login que nao pertence a conta
// nenhuma. Nao ha confirmacao de proposito -- confirmacao e mais um clique entre
// voce e a tela presa, e fechar janela nao perde conta: ela vira vaga.
$('#closeAll').onclick = async () => {
  const r = await window.fleet.closeAllWindows();
  await refresh();
  const n = r.contas.length;
  if (!n && !r.popups) return mostrarAviso('Nenhuma janela aberta');
  const partes = [`${n} janela${n === 1 ? '' : 's'} fechada${n === 1 ? '' : 's'}`];
  if (r.presas.length) partes.push(`${r.presas.length} estava${r.presas.length === 1 ? '' : 'm'} travada${r.presas.length === 1 ? '' : 's'}`);
  if (r.popups) partes.push(`${r.popups} popup de login`);
  mostrarAviso(partes.join(' — '));
};

$('#verGrade').onclick = () => {
  grade = !grade;
  try { localStorage.setItem('grade', grade ? '1' : '0'); } catch {}
  render();
};

$('#maxWindows').onchange = (e) => window.fleet.setSettings({ maxWindows: Number(e.target.value) });

// Eco de tudo de uma vez: e assim que ele e usado, deixar a maquina quieta e sair.
$('#modoEco').onclick = () => {
  const abertas = state.accounts.filter((a) => a.effective === 'ver' && !a.suspended);
  const ligar = abertas.some((a) => !dormindo.has(a.id));
  for (const a of abertas) { ligar ? dormindo.add(a.id) : dormindo.delete(a.id); }
  render();
};
$('#killSwitch').onclick = () => window.fleet.setSettings({ killSwitch: !state.settings.killSwitch });

/** Erro de acao aparece onde o usuario ja olha, sem travar a janela. */
function mostrarErro(a, texto) {
  const err = pane.querySelector('.err');
  if (err) { err.hidden = false; err.textContent = texto; }
  const box = document.getElementById('avisos');
  const el = document.createElement('div');
  el.className = 'aviso';
  el.style.borderLeftColor = 'var(--bad)';
  el.innerHTML = `<b>${esc(texto)}</b>` + (a ? `<span class="quem">${esc(a.label)}</span>` : '');
  box.appendChild(el);
  setTimeout(() => { el.classList.add('saindo'); setTimeout(() => el.remove(), 400); }, 4200);
}

// ---------- configuracao do provedor de IA ----------

const cfg = $('#cfg');
let cfgAtual = null;

async function abrirCfg() {
  cfgAtual = await window.fleet.aiStatus();
  $('#provedores').innerHTML = cfgAtual.provedores.map((p) =>
    `<label><input type="radio" name="prov" value="${p.id}" ${p.id === (cfgAtual.provider || 'openrouter') ? 'checked' : ''}>${esc(p.nome)}</label>`).join('');
  // A chave nunca volta do processo principal (FR-033): o campo comeca vazio e
  // so e gravado se voce digitar algo novo.
  $('#cfgKey').value = '';
  $('#cfgKey').placeholder = cfgAtual.configured ? 'chave guardada — digite para trocar' : 'cole a chave aqui';
  $('#cfgModel').value = cfgAtual.model || modeloPadrao();
  $('#cfgRemover').hidden = !cfgAtual.configured;
  dica('');
  for (const r of cfg.querySelectorAll('input[name=prov]')) {
    r.onchange = () => { $('#cfgModel').value = modeloPadrao(); $('#modelos').innerHTML = ''; dica(''); };
  }
  cfg.showModal();
}

const provEscolhido = () => cfg.querySelector('input[name=prov]:checked')?.value || 'openrouter';
const modeloPadrao = () => cfgAtual?.provedores.find((p) => p.id === provEscolhido())?.padrao || '';
const dica = (t, ruim) => { const el = $('#cfgHint'); el.textContent = t; el.style.color = ruim ? 'var(--bad)' : 'var(--faint)'; };

$('#abrirCfg').onclick = abrirCfg;
$('#cfgCancelar').onclick = () => cfg.close();

$('#cfgFetch').onclick = async () => {
  const p = provEscolhido();
  dica('Buscando modelos…');
  const r = await window.fleet.aiModels(p);
  if (!r.ok) return dica(r.erro, true);
  $('#modelos').innerHTML = r.modelos.map((m) => `<option value="${esc(m.id)}">${esc(m.nome)}</option>`).join('');
  dica(`${r.modelos.length} modelos disponíveis — comece a digitar para filtrar.`);
};

$('#cfgSalvar').onclick = async () => {
  const key = $('#cfgKey').value.trim();
  const provider = provEscolhido();
  // Sem chave so da para salvar se ja houver uma guardada para ESTE provedor --
  // e o caso de quem buscou a lista e so quer trocar de modelo.
  if (!key && !(cfgAtual.configured && cfgAtual.provider === provider)) {
    return dica('Cole a chave do provedor.', true);
  }
  const r = await window.fleet.aiSave({ provider, model: $('#cfgModel').value.trim(), key });
  if (!r.ok) return dica(r.reason, true);
  cfg.close();
};

$('#cfgRemover').onclick = async () => {
  if (!confirm('Remover o provedor? A chave guardada é apagada do disco.')) return;
  await window.fleet.aiClear();
  cfg.close();
};

// ---------- chat ----------

const chatEl = $('#chat');
const chatlog = $('#chatlog');

function bolha(classe, texto, feitos) {
  const el = document.createElement('div');
  el.className = classe;
  el.textContent = texto;
  if (feitos?.length) {
    const d = document.createElement('div');
    d.className = 'feitos';
    d.textContent = feitos.map((a) => {
      const r = a.resultado?.resultados;
      if (!Array.isArray(r)) return a.nome;
      return r.map((x) => `${x.conta}: ${x.ok ? 'ok' : x.error || x.reason || 'falhou'}`).join(' · ');
    }).join('\n');
    el.appendChild(d);
  }
  chatlog.appendChild(el);
  chatlog.scrollTop = chatlog.scrollHeight;
  return el;
}

$('#abrirChat').onclick = async () => {
  chatEl.setAttribute('open', '');
  const st = await window.fleet.aiStatus();
  if (!st.configured && !chatlog.children.length) {
    bolha('msg-a', 'Configure um provedor de IA primeiro — botão Configurações, aqui em cima.');
  }
  $('#chatin').focus();
};
$('#chatFechar').onclick = () => chatEl.removeAttribute('open');
$('#chatLimpar').onclick = async () => { await window.fleet.aiReset(); chatlog.textContent = ''; };

$('#chatform').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chatin');
  const texto = input.value.trim();
  if (!texto) return;
  input.value = '';
  bolha('msg-u', texto);
  const pensando = bolha('msg-a', 'pensando…');
  const btn = $('#chatform button');
  btn.disabled = true;
  const r = await window.fleet.aiChat(texto);
  btn.disabled = false;
  pensando.remove();
  bolha(r.ok ? 'msg-a' : 'msg-a erro', r.reply || '(sem resposta)', r.actions);
  refresh();
};

// ---------- análise de farm ----------
// Soma o que as contas ja reportam. Nada aqui e estimado: campo sem dado aparece
// como travessao, porque numero inventado num painel de farm e pior que nenhum.
const farmEl = $('#farm');
const JOIAS = [['jewel_bless', 'Bless'], ['jewel_soul', 'Soul'], ['jewel_chaos', 'Chaos'],
               ['jewel_creation', 'Creation'], ['jewel_life', 'Life']];

const hojeISO = () => new Date().toISOString().slice(0, 10);
const soma = (lista, f) => lista.reduce((t, a) => { const v = f(a); return typeof v === 'number' ? t + v : t; }, 0);
const temAlgum = (lista, f) => lista.some((a) => typeof f(a) === 'number');
const compacto = (v) => {
  if (typeof v !== 'number') return '—';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + 'M';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + 'k';
  return num(v);
};

function renderFarm() {
  if (farmEl.hidden) return;
  const contas = state.accounts;
  const online = contas.filter((a) => !a.suspended && (a.effective === 'ver' || a.status === 'ready'));
  // Joia so existe pelo canal da janela. Conta gerenciada mostra ausencia, nao zero.
  const temJoia = contas.some((a) => JOIAS.some(([k]) => typeof a.stats?.[k] === 'number'));
  const joias = soma(contas, (a) => JOIAS.reduce((t, [k]) => t + (a.stats?.[k] || 0), 0));
  const zenHora = temAlgum(contas, (a) => a.stats?.zenPerHour) ? soma(contas, (a) => a.stats?.zenPerHour) : null;
  const niveis = contas.filter((a) => typeof a.levelBase === 'number' && typeof a.stats?.level === 'number');

  const kpis = [
    ['ONLINE', `${online.length} / ${contas.length}`],
    // Bolsa e ganho sao grandezas diferentes e NUNCA entram no mesmo total.
    ['ZEN NA BOLSA', temAlgum(contas, (a) => a.stats?.zenBolsa) ? compacto(soma(contas, (a) => a.stats?.zenBolsa)) : '—'],
    ['ZEN GANHO', temAlgum(contas, (a) => a.stats?.zenGanho) ? compacto(soma(contas, (a) => a.stats?.zenGanho)) : '—'],
    ['ZEN / HORA', zenHora === null ? '—' : compacto(zenHora)],
    ['ZEN PROJETADO 24H', zenHora === null ? '—' : compacto(zenHora * 24)],
    ['XP / MIN', temAlgum(contas, (a) => a.stats?.xpPerMin) ? compacto(soma(contas, (a) => a.stats?.xpPerMin)) : '—'],
    ['LEVELS HOJE', niveis.length ? '+' + soma(niveis, (a) => a.stats.level - a.levelBase) : '—'],
    ['JOIAS', temJoia ? joias : '—'],
  ];
  troca($('#farmKpis'), 'innerHTML', kpis.map(([k, v]) =>
    `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join(''));

  troca($('#farmContas'), 'innerHTML', contas.map((a) => {
    const s = a.stats || {};
    const modo = a.suspended ? 'suspenso' : a.effective;
    const n = window.fleet.ganhoDoDia({ levelDia: hojeISO(), levelBase: a.levelBase }, s.level, hojeISO());
    const ganho = n ? `<em>+${n} hoje</em>` : '';
    const joiasHtml = JOIAS.filter(([k]) => s[k]).map(([k, nome]) =>
      `<span class="joia">${nome} ${s[k]}</span>`).join('');
    return `<div class="cta ${modo}">
      <div class="topo"><span class="nm">${esc(a.label)}</span>
        <span class="est">${a.suspended ? 'SUSPENSA' : a.effective === 'ver' ? 'VOCÊ JOGA' : 'PAINEL GERENCIA'}</span></div>
      <div class="nivel">${typeof s.level === 'number' ? 'LV ' + s.level : 'LV —'}${ganho}</div>
      <div class="grade3">
        <div class="cx"><span>ZEN BOLSA</span><b>${compacto(s.zenBolsa)}</b></div>
        <div class="cx"><span>ZEN GANHO</span><b>${compacto(s.zenGanho)}</b></div>
        <div class="cx"><span>XP / MIN</span><b>${compacto(s.xpPerMin)}</b></div>
        <div class="cx"><span>ZEN / HORA</span><b>${compacto(s.zenPerHour)}</b></div>
      </div>
      ${joiasHtml ? `<div class="joias">${joiasHtml}</div>` : ''}
      <div class="quando">${a.statsAt ? 'lida ' + idade(a.statsAt) + ' atrás' : 'sem leitura ainda'}${a.stale ? ' · desatualizada' : ''}</div>
    </div>`;
  }).join(''));

  const lidas = contas.filter((a) => a.statsAt).length;
  troca($('#farmLinha1'), 'textContent',
    `${lidas} de ${contas.length} contas com leitura · atualiza sozinho a cada 45 s no modo gerenciar, ` +
    'e a cada segundo nas janelas abertas. Campo sem dado aparece como travessão, nunca estimado.');
}

$('#abrirFarm').onclick = () => { farmEl.hidden = !farmEl.hidden; renderFarm(); };
$('#farmFechar').onclick = () => { farmEl.hidden = true; };
$('#farmAtualizar').onclick = () => refresh();
$('#farmCopiar').onclick = async () => {
  const linhas = state.accounts.map((a) => {
    const s = a.stats || {};
    return `${a.label} | ${a.suspended ? 'suspensa' : a.effective} | LV ${s.level ?? '-'}` +
      ` | bolsa ${s.zenBolsa ?? '-'} | ganho ${s.zenGanho ?? '-'}` +
      ` | xp/min ${s.xpPerMin ?? '-'} | zen/h ${s.zenPerHour ?? '-'} | lida ${a.statsAt ? new Date(a.statsAt).toLocaleTimeString('pt-BR') : '-'}`;
  });
  const txt = [`MIDLE — ${new Date().toLocaleString('pt-BR')}`, ...linhas].join('\n');
  try { await navigator.clipboard.writeText(txt); $('#farmLinha1').textContent = 'Diagnóstico copiado.'; }
  catch { mostrarErro(null, 'não consegui copiar'); }
};

// ---------- proxy por conta ----------
const prox = $('#prox');

async function abrirProxy() {
  const st = await window.fleet.proxyStatus();
  // A lista NUNCA volta preenchida: ela carrega senha. O que a tela mostra é o
  // mapa de quem está usando o quê — mesma regra da chave do provedor de IA.
  $('#proxLista').value = '';
  $('#proxLista').placeholder = st.total
    ? `${st.total} proxy(s) guardado(s) — cole a lista de novo para trocar`
    : '1.2.3.4:8080:usuario:senha\n5.6.7.8:3128';
  $('#proxAtivo').checked = st.ativo;
  $('#proxRemover').hidden = !st.total;
  pintarMapa(st);
  dicaProx(st.cofre ? '' : 'Este sistema não oferece cofre de credenciais: a senha do proxy ficará legível no disco.', !st.cofre);
  prox.showModal();
}

const dicaProx = (t, ruim) => { const el = $('#proxHint'); el.textContent = t; el.style.color = ruim ? 'var(--bad)' : 'var(--faint)'; };

function pintarMapa(st) {
  $('#proxMapa').innerHTML = (st.contas || []).map((c) => `
    <div class="par" data-conta="${esc(c.id)}">
      <span>${esc(c.label)}</span>
      <span class="end">${c.proxy ? esc(c.proxy.rotulo) : 'rede normal'}</span>
      <button type="button" data-testar="${esc(c.id)}" ${c.proxy ? '' : 'disabled'}>Testar</button>
    </div>`).join('') || '<p class="hint">Nenhuma conta ainda.</p>';
}

$('#abrirProxy').onclick = abrirProxy;
$('#proxCancelar').onclick = () => prox.close();

$('#proxSalvar').onclick = async (e) => {
  e.preventDefault();
  const texto = $('#proxLista').value.trim();
  const ativo = $('#proxAtivo').checked;
  if (!texto) {   // só ligou/desligou o que já estava guardado
    const st = await window.fleet.proxyStatus();
    if (!st.total) return dicaProx('Cole a lista de proxies primeiro.', true);
  }
  const r = await window.fleet.proxySave({ texto, ativo });
  if (r.erros?.length) {
    dicaProx(`Não entendi ${r.erros.length} linha(s): ${r.erros.map((x) => 'linha ' + x.linha).join(', ')}.`, true);
  } else if (r.avisos?.length) {
    dicaProx(r.avisos[0], true);
  } else {
    dicaProx(`${r.total} proxy(s) ${r.ativo ? 'em uso' : 'guardados, desligados'}.`);
  }
  $('#proxLista').value = '';
  pintarMapa(r);
  refresh();
};

$('#proxRemover').onclick = async (e) => {
  e.preventDefault();
  if (!confirm('Remover a lista de proxies? As senhas são apagadas do disco.')) return;
  pintarMapa(await window.fleet.proxyClear());
  dicaProx('Lista removida. As contas voltaram para a rede normal.');
};

prox.addEventListener('click', async (e) => {
  const id = e.target.dataset?.testar;
  if (!id) return;
  e.preventDefault();
  const cel = e.target.closest('.par');
  e.target.disabled = true;
  const antes = e.target.textContent;
  e.target.textContent = 'testando…';
  const r = await window.fleet.proxyTest(id);
  e.target.textContent = antes;
  e.target.disabled = false;
  cel.querySelector('.ip')?.remove();
  const span = document.createElement('span');
  span.className = 'ip' + (r.ok ? '' : ' ruim');
  span.textContent = r.ok ? `saiu por ${r.ip}` : r.erro;
  cel.appendChild(span);
});

// ---------- consumo, ações em lote e foco ----------
// Modo Eco CPU: o jogo continua VISÍVEL e só desenha menos. É outra coisa do que o
// Repouso, que esconde a janela inteira — os dois convivem e servem a momentos
// diferentes: este para olhar a frota, aquele para deixar a frota de lado.
const FPS_ECO = 10;
let ecoCpu = false;
try { ecoCpu = localStorage.getItem('ecoCpu') === '1'; } catch { /* modo privado */ }

// O limitador precisa rodar no MUNDO PRINCIPAL da pagina: o preload vive num
// mundo isolado e o `window` de la nao e o que o jogo usa. Medido em 16/09/2026,
// depois de uma versao que parecia ligada e nao limitava nada.
const SCRIPT_FPS = (teto) => `(() => {
  if (!window.__fleetFps) {
    const nativo = window.requestAnimationFrame.bind(window);
    window.__fleetFps = { teto: 0, ultimo: 0 };
    window.requestAnimationFrame = function (cb) {
      const s = window.__fleetFps;
      if (!s.teto) return nativo(cb);
      return nativo((t) => {
        if (t - s.ultimo < 1000 / s.teto) { window.requestAnimationFrame(cb); return; }
        s.ultimo = t;
        cb(t);
      });
    };
  }
  window.__fleetFps.teto = ${Number(teto) || 0};
  return window.__fleetFps.teto;
})()`;

function aplicarFps(wv) {
  // Sem try mudo: falha aqui vira aviso, porque a versao anterior falhou calada.
  wv.executeJavaScript(SCRIPT_FPS(ecoCpu ? FPS_ECO : 0))
    .catch((err) => console.warn('limitador de quadros:', err.message));
}

function aplicarFpsEmTodas() {
  for (const wv of janelasAbertas()) aplicarFps(wv);
}

$('#modoGpu').onclick = () => {
  ecoCpu = !ecoCpu;
  try { localStorage.setItem('ecoCpu', ecoCpu ? '1' : '0'); } catch { /* modo privado */ }
  aplicarFpsEmTodas();
  pintarModoGpu();
  mostrarAviso(ecoCpu ? `Desenhando ${FPS_ECO} quadros por segundo` : 'Desenho sem limite de quadros');
};

function pintarModoGpu() {
  const b = $('#modoGpu');
  troca(b, 'textContent', ecoCpu ? `Quadros ${FPS_ECO}/s` : 'Quadros cheios');
  b.classList.toggle('on', ecoCpu);
}

// Nao pule a medicao quando `document.hidden` -- no Windows a janela apenas
// COBERTA por outra ja conta como escondida, e o usuario continua olhando para o
// painel. O guard economizava um getAppMetrics a cada 3 s (enumerar ~11 processos)
// e em troca congelava o numero na tela: medido em 16/09/2026, o medidor mostrava
// 470 MB enquanto a frota ja segurava 2,1 GB. Numero velho e pior do que numero
// nenhum, porque e ele que decide quantas janelas a pessoa abre.
async function medir() {
  try {
    const m = await window.fleet.metrics();
    const gpu = ecoCpu ? 'Eco' : (m.gpu === 'ativa' ? 'Ativa' : m.gpu === 'software' ? 'Software' : '—');
    troca($('#medidor'), 'innerHTML',
      `<i class="vivo"></i>CPU <b>${m.cpu}%</b><span class="gpu${ecoCpu ? ' eco' : ''}">GPU <b>${gpu}</b></span>RAM <b>${m.ram}</b> MB`);
  } catch { /* painel fechando */ }
}
setInterval(medir, 3000);
medir();

// O Chromium estrangula temporizador de pagina escondida -- depois de ~5 min
// oculta, um setInterval de 3s passa a rodar uma vez por minuto. Envelhecer ali
// e DESEJAVEL: nao vale gastar CPU medindo uma tela que ninguem esta vendo, e
// desligar `backgroundThrottling` para resolver isto faria a janela inteira
// continuar desenhando, os <webview> do jogo junto -- o oposto do Modo Eco.
//
// O que nao pode e o numero velho continuar na tela DEPOIS que ela volta. Entao
// mede no instante em que volta, em vez de medir o tempo todo.
document.addEventListener('visibilitychange', () => { if (!document.hidden) medir(); });
window.addEventListener('focus', medir);

const janelasAbertas = () => [...document.querySelectorAll('.cel webview, #stage webview')];

$('#recarregarTodas').onclick = () => {
  const n = janelasAbertas().length;
  for (const wv of janelasAbertas()) { try { wv.reload(); } catch { /* ainda nascendo */ } }
  if (n) mostrarAviso(`Recarregando ${n} janela${n === 1 ? '' : 's'}`);
};

$('#mudoTodas').onclick = () => {
  const todas = janelasAbertas();
  if (!todas.length) return;
  // Se qualquer uma tem som, o botão cala todas. Só devolve o som quando estão todas mudas.
  const calar = todas.some((wv) => { try { return !wv.isAudioMuted(); } catch { return false; } });
  for (const wv of todas) { try { wv.setAudioMuted(calar); } catch { /* ainda nascendo */ } }
  $('#mudoTodas').classList.toggle('on', calar);
  mostrarAviso(calar ? 'Som desligado nas janelas' : 'Som devolvido');
};

// ---------- repetir a sequencia nas outras ----------
// O jogo atualiza direto, e depois de atualizar as doze janelas caem na mesma
// tela. Mas "voltar ao jogo" nao e um clique: e escolher o servidor, escolher o
// personagem e entrar -- tres telas, uma depois da outra. Repetir so o ultimo
// clique deixaria as outras onze paradas na primeira.
//
// Entao o painel grava a TRILHA: tudo que voce clicou desde o ultimo Repetir.
// Voce entra no jogo numa janela, aperta uma vez, e as outras refazem o mesmo
// caminho. A trilha se apaga quando e repetida, para a proxima nao arrastar a
// anterior junto.
//
// Nenhum seletor fica escrito aqui: qualquer botao que eu chumbasse hoje some na
// proxima atualizacao do jogo. Quem ensina o caminho e voce, toda vez.
//
// Grava no MUNDO PRINCIPAL da pagina, pelo mesmo motivo do limitador de quadros:
// o preload vive num mundo isolado cujo `window` o jogo nao usa. E grava no
// sessionStorage, nao so em variavel: medido no lorvath.com em 18/09/2026,
// clicar no servidor NAVEGA, e a navegacao levava junto o clique que a pessoa
// acabou de dar -- em variavel, a memoria nao sobrevivia ao proprio efeito.
const PASSOS_MAX = 12;
// Nome gravado e nome procurado passam pelo MESMO corte. Antes gravava 60
// caracteres e comparava com o texto inteiro: alvo de nome longo nunca casava e
// caia sempre na posicao, justo o que o nome existe para evitar.
const NOME_MAX = 60;
const NOME_JS = `((e) => (e.textContent || '').trim().slice(0, ${NOME_MAX}))`;

const SCRIPT_GRAVAR = `(() => {
  const CHAVE = '__midleTrilha';
  const lido = () => { try { return JSON.parse(sessionStorage.getItem(CHAVE) || '[]'); } catch { return []; } };
  if (window.__midleTrilha !== undefined) { if (!window.__midleTrilha.length) window.__midleTrilha = lido(); return true; }
  window.__midleTrilha = lido();
  const caminho = (el) => {
    const p = [];
    for (; el && el.nodeType === 1 && el !== document.body; el = el.parentElement) {
      if (el.id) { p.unshift('#' + CSS.escape(el.id)); break; }
      let s = el.tagName.toLowerCase();
      const irmaos = [...(el.parentElement ? el.parentElement.children : [])].filter((x) => x.tagName === el.tagName);
      if (irmaos.length > 1) s += ':nth-of-type(' + (irmaos.indexOf(el) + 1) + ')';
      p.unshift(s);
    }
    return p.join('>');
  };
  addEventListener('pointerdown', (e) => {
    // isTrusted separa o que VOCE clicou do que o painel repetiu: sem isso a
    // repeticao se regrava e a proxima repete a copia.
    if (!e.isTrusted || !e.target || e.target.nodeType !== 1) return;
    window.__midleTrilha.push({
      sel: caminho(e.target),
      tag: e.target.tagName.toLowerCase(),
      txt: ${NOME_JS}(e.target),
      em: Date.now(),
    });
    // Trilha longa demais e trilha velha misturada com nova: corta pelo fim.
    if (window.__midleTrilha.length > ${PASSOS_MAX}) window.__midleTrilha = window.__midleTrilha.slice(-${PASSOS_MAX});
    try { sessionStorage.setItem(CHAVE, JSON.stringify(window.__midleTrilha)); } catch { /* modo privado */ }
  }, true);
  return true;
})()`;

/** Espera o alvo aparecer e clica. O espera e o que faz a sequencia funcionar:
 *  o botao do passo 2 so existe depois de o passo 1 trocar a tela, e quanto
 *  demora e do servidor, nao nosso. Se nunca aparecer, para -- seguir clicando
 *  numa tela que nao e a esperada e como o painel acertaria o botao errado. */
const SCRIPT_PASSO = (c, prazo) => `(async () => {
  // O TEXTO vem antes da posicao. Posicao nao e identidade: basta a lista vir com
  // uma linha a mais numa janela -- um aviso, um servidor novo, uma ordem por
  // populacao -- para o 5o botao ser outro servidor. O erro seria silencioso: a
  // conta entra, o jogo carrega, e so muito depois se descobre que foi no lugar
  // errado. O nome nao tem esse problema.
  //
  // So aceita texto que aparece UMA vez, com a mesma etiqueta: dois botoes com o
  // mesmo nome nao dizem qual e, e ai a posicao volta a ser a melhor pista. E e
  // a posicao que resolve o passo do personagem, onde o nome muda por conta.
  const acha = () => {
    ${c.txt ? `const iguais = [...document.querySelectorAll(${JSON.stringify(c.tag)})]
      .filter((e) => ${NOME_JS}(e) === ${JSON.stringify(c.txt)});
    if (iguais.length === 1) return iguais[0];` : ''}
    return document.querySelector(${JSON.stringify(c.sel)});
  };
  const fim = Date.now() + ${Number(prazo) || 8000};
  let alvo = acha();
  while (!alvo && Date.now() < fim) { await new Promise((r) => setTimeout(r, 120)); alvo = acha(); }
  if (!alvo) return false;
  alvo.scrollIntoView({ block: 'center' });
  // O jogo escuta pointer e mouse em botoes diferentes; .click() sozinho perde
  // os que so ouvem pointerdown.
  alvo.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  for (const t of ['mousedown', 'mouseup', 'click']) {
    alvo.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
  alvo.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  return true;
})()`;

/** `executeJavaScript` LANCA de forma sincrona quando a webview ainda nao emitiu
 *  dom-ready -- o `.catch` nem chega a ser instalado. Sozinho isso derrubava o
 *  vigia inteiro a cada janela nascendo. Tudo que fala com o guest passa por
 *  aqui, e devolve `padrao` em vez de explodir. */
function naJanela(wv, js, padrao = null) {
  try { return Promise.resolve(wv.executeJavaScript(js)).catch(() => padrao); }
  catch { return Promise.resolve(padrao); }
}

const gravarCliques = (wv) =>
  naJanela(wv, SCRIPT_GRAVAR).then((r) => { if (r === null) console.warn('gravador de clique: janela ainda nascendo'); });

// So a ULTIMA tentativa: a trilha acumula desde o ultimo Repetir, e quem errou o
// caminho e refez nao quer os passos errados junto. A regra e pura e mora em
// `trilha.js`, com assercao no selfcheck -- aqui so se consome a decisao.
const lerTrilha = (wv) =>
  naJanela(wv, 'JSON.stringify(window.__midleTrilha || [])', '[]')
    .then((t) => window.fleet.ultimaTentativa(JSON.parse(t || '[]')));

const limparTrilha = (wv) =>
  naJanela(wv, `(() => { window.__midleTrilha = []; try { sessionStorage.removeItem('__midleTrilha'); } catch {} return true; })()`, false);

$('#repetirClique').onclick = async () => {
  const botao = $('#repetirClique');
  if (botao.disabled) return;
  // Desabilita ANTES do primeiro await, nao depois de ler as trilhas: a leitura
  // leva alguns quadros, e nessa janela dava para apertar de novo e disparar uma
  // segunda repeticao por cima da primeira. E tambem o unico sinal de "acabou"
  // que existe de fora, entao ele precisa ser sincrono com o clique.
  botao.disabled = true;
  botao.classList.add('on');
  try {
    // Uma passada do vigia em curso para na proxima janela ao ver o botao
    // desabilitado; espera ela sair antes de clicar, senao os dois clicam na
    // mesma janela ao mesmo tempo.
    await vigiaEmVoo;
    const todas = janelasAbertas();
    if (todas.length < 2) return mostrarAviso('Abra mais de uma janela para repetir');

    const lidas = await Promise.all(todas.map(async (wv) => ({ wv, t: await lerTrilha(wv) })));
    const comTrilha = lidas.filter((x) => x.t.length);
    if (!comTrilha.length) return mostrarAviso('Clique primeiro numa janela — é esse caminho que se repete');
    // A mais recente vence: serve tanto clicando na celula da grade quanto na
    // janela em foco, e resolve o caso de duas janelas terem trilha velha.
    const origem = comTrilha.sort((a, b) => b.t[b.t.length - 1].em - a.t[a.t.length - 1].em)[0];

    const alvos = todas.filter((wv) => wv !== origem.wv);
    mostrarAviso(`Repetindo ${origem.t.length} passo${origem.t.length === 1 ? '' : 's'} em ${alvos.length} janela${alvos.length === 1 ? '' : 's'}…`);
    // Janelas em paralelo, passos em ordem dentro de cada uma: doze janelas
    // esperando o servidor uma depois da outra seria um minuto de espera.
    const feitos = await Promise.all(alvos.map(async (wv) => {
      let n = 0;
      for (const passo of origem.t) {
        if (!(await naJanela(wv, SCRIPT_PASSO(passo, 8000), false))) break;
        n++;
        await new Promise((r) => setTimeout(r, 350));   // deixa a tela reagir antes do proximo
      }
      return n;
    }));
    await Promise.all(todas.map(limparTrilha));   // repetida e consumida: a proxima comeca limpa
    // O caminho que voce acabou de repetir fica guardado: e ele que o "Voltar
    // sozinho" refaz quando uma janela cai na tela inicial. Salvar aqui e nao
    // num botao separado porque e aqui que voce ja disse "este e o caminho".
    caminhoSalvo = origem.t;
    guarda(CAMINHO_CHAVE, caminhoSalvo);
    vigiadas.clear();
    pintarVoltarSozinho();
    const inteiras = feitos.filter((n) => n === origem.t.length).length;
    mostrarAviso(inteiras === alvos.length
      ? `${origem.t.length} passo${origem.t.length === 1 ? '' : 's'} repetido${origem.t.length === 1 ? '' : 's'} em ${inteiras} janela${inteiras === 1 ? '' : 's'}`
      : `${inteiras} de ${alvos.length} janelas completaram — nas outras parei no ${Math.min(...feitos) + 1}º passo, o botão não apareceu`);
  } finally {
    botao.disabled = false;
    botao.classList.remove('on');
  }
};

// ---------- voltar sozinho ----------
// O jogo reinicia, a aba cai na escolha de servidor, e quem esta fora de casa so
// descobre horas depois que a frota parou de farmar. Se o caminho de volta ja e
// conhecido -- e e, porque voce acabou de ensina-lo ao Repetir --, o painel pode
// refaze-lo sem voce.
//
// Tres freios, porque isto clica sozinho numa conta de verdade:
//   1. so age se VOCE ligou, e so com um caminho que VOCE salvou;
//   2. so age na janela que esta mostrando o PRIMEIRO passo do caminho. Isso e o
//      que distingue "caiu na tela de escolha de servidor" de "esta jogando" --
//      sem essa condicao ele clicaria no meio do jogo;
//   3. depois de tres tentativas seguidas sem completar, para naquela janela e
//      avisa. Clicar para sempre numa tela que nao responde e pior do que parar.
const CAMINHO_CHAVE = 'midle.caminho';
const AUTO_CHAVE = 'midle.voltarSozinho';
const VIGIA_MS = 10000;          // de quanto em quanto tempo olha
// Repouso e maximo de falhas sao decisao pura, em `trilha.js`, com assercao.
const { podeTentar, marcaDepois, VIGIA_REPOUSO_MS, VIGIA_TENTATIVAS_MAX } = window.fleet;

const leGuardado = (chave, padrao) => {
  try { return JSON.parse(localStorage.getItem(chave)) ?? padrao; } catch { return padrao; }
};
const guarda = (chave, valor) => {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado */ }
};

let caminhoSalvo = leGuardado(CAMINHO_CHAVE, []);
let voltarSozinho = leGuardado(AUTO_CHAVE, false);
const vigiadas = new Map();   // webview -> { ultima, falhas }

function resumoCaminho(c) {
  return c.map((p) => (p.txt || p.tag).replace(/\s+/g, ' ').slice(0, 14)).join(' → ');
}

function pintarVoltarSozinho() {
  const b = $('#voltarSozinho');
  b.classList.toggle('on', voltarSozinho && caminhoSalvo.length > 0);
  b.title = caminhoSalvo.length
    ? `${voltarSozinho ? 'Ligado' : 'Desligado'} — caminho salvo: ${resumoCaminho(caminhoSalvo)}. ` +
      'Refaz este caminho sozinho na janela que cair na primeira tela dele. O caminho vem do último Repetir.'
    : 'Sem caminho salvo. Faça o caminho numa janela e aperte Repetir: é ele que fica guardado.';
}

$('#voltarSozinho').onclick = () => {
  if (!caminhoSalvo.length) return mostrarAviso('Nenhum caminho salvo — faça o caminho numa janela e aperte Repetir');
  voltarSozinho = !voltarSozinho;
  guarda(AUTO_CHAVE, voltarSozinho);
  vigiadas.clear();   // ligar de novo perdoa as falhas de antes
  pintarVoltarSozinho();
  mostrarAviso(voltarSozinho
    ? `Voltando sozinho: ${resumoCaminho(caminhoSalvo)}`
    : 'Voltar sozinho desligado');
};

/** A janela esta parada na primeira tela do caminho? E a unica pergunta que
 *  separa "caiu" de "esta jogando", e ela se responde com o proprio caminho
 *  salvo -- nada de reconhecer tela do Lorvath por dentro, que muda a cada
 *  atualizacao. */
const SCRIPT_NA_PRIMEIRA_TELA = (c) => `(() => {
  ${c.txt ? `const iguais = [...document.querySelectorAll(${JSON.stringify(c.tag)})]
    .filter((e) => ${NOME_JS}(e) === ${JSON.stringify(c.txt)});
  if (iguais.length === 1) return true;` : ''}
  return !!document.querySelector(${JSON.stringify(c.sel)});
})()`;

async function refazerCaminho(wv) {
  let n = 0;
  for (const passo of caminhoSalvo) {
    if (!(await naJanela(wv, SCRIPT_PASSO(passo, 8000), false))) break;
    n++;
    await new Promise((r) => setTimeout(r, 350));
  }
  return n;
}

// Uma passada por vez. Refazer um caminho de tres passos leva ate ~25 s, mais
// que o intervalo do vigia: sem isto, duas passadas corriam juntas.
let vigiaEmVoo = null;
function vigiar() {
  if (!vigiaEmVoo) vigiaEmVoo = passadaDoVigia().finally(() => { vigiaEmVoo = null; });
  return vigiaEmVoo;
}

async function passadaDoVigia() {
  if (!voltarSozinho || !caminhoSalvo.length) return;

  for (const wv of janelasAbertas()) {
    // A cada janela, e nao so no comeco: um Repetir apertado no meio da passada
    // espera por ela (`vigiaEmVoo`), e ela cede na primeira oportunidade.
    if ($('#repetirClique').disabled) return;
    // Na grade a conta vem da celula; fora dela a janela unica e a montada no
    // palco, que nao tem `data-id` acima. Sem este segundo caso o Voltar sozinho
    // simplesmente nao existiria para quem joga com uma janela de cada vez.
    const cel = wv.closest('[data-id]');
    const a = byId(cel ? cel.dataset.id : montado.id);
    if (!a) continue;
    // Janela comum entra tambem, de proposito. A guarda que importa nao e "e do
    // jogo?", e sim "esta mostrando a primeira tela do caminho?" -- e essa vem
    // logo abaixo. Excluir janela comum daqui tinha um custo escondido: ela e a
    // unica que o roteiro pode usar, entao a exclusao deixava justamente este
    // recurso, o unico que clica sozinho, sem teste nenhum.

    const marca = vigiadas.get(wv);
    if (!podeTentar(marca, Date.now())) continue;

    const caiu = await naJanela(wv, SCRIPT_NA_PRIMEIRA_TELA(caminhoSalvo[0]), false);
    if (!caiu) { vigiadas.set(wv, marcaDepois(marca, 'fora', Date.now())); continue; }

    mostrarAviso(`${a.label} caiu na tela inicial — refazendo o caminho`);
    const feitos = await refazerCaminho(wv);
    const completou = feitos === caminhoSalvo.length;
    const nova = marcaDepois(marca, completou ? 'completou' : 'falhou', Date.now());
    vigiadas.set(wv, nova);
    if (completou) mostrarAviso(`${a.label} voltou sozinha`);
    else mostrarAviso(!podeTentar(nova, Infinity)
      ? `${a.label}: desisti depois de ${VIGIA_TENTATIVAS_MAX} tentativas — o caminho não serve mais, refaça e aperte Repetir`
      : `${a.label}: parei no ${feitos + 1}º passo, tento de novo em ${VIGIA_REPOUSO_MS / 1000}s`);
  }
}
setInterval(vigiar, VIGIA_MS);
pintarVoltarSozinho();

$('#limparCache').onclick = async () => {
  const r = await window.fleet.clearCache();
  mostrarAviso(`Cache limpo em ${r.limpas} conta${r.limpas === 1 ? '' : 's'} — o login continua`);
};

$('#modoFoco').onclick = () => {
  const on = document.body.classList.toggle('foco');
  $('#modoFoco').classList.toggle('on', on);
};

/** Aviso curto sem conta associada — o mostrarErro serve para falha, este para recado. */
function mostrarAviso(texto) {
  const box = document.getElementById('avisos');
  const el = document.createElement('div');
  el.className = 'aviso';
  el.innerHTML = `<b>${esc(texto)}</b>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('saindo'); setTimeout(() => el.remove(), 400); }, 2600);
}

// O menu da linha nao alcanca a webview: ela existe so aqui. Recarregar volta
// por este canal em vez de o main mandar na janela do jogo por fora.
window.fleet.onRecarregar((id) => {
  const wv = document.querySelector(`[data-id="${id}"] webview`);
  try { wv?.reload(); } catch { /* ainda nascendo */ }
});

// ---------- atalhos ----------
// Ctrl+1..9 escolhe a conta, Ctrl+G alterna a grade, Ctrl+E o repouso da frota,
// Ctrl+D repete nas outras janelas o ultimo clique que voce deu numa delas.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const alvo = e.target;
  if (alvo && /^(INPUT|TEXTAREA)$/.test(alvo.tagName)) return;
  if (alvo && alvo.isContentEditable) return;

  if (e.key >= '1' && e.key <= '9') {
    const a = state.accounts[Number(e.key) - 1];
    if (!a) return;
    e.preventDefault();
    selected = a.id;
    try { localStorage.setItem('sel', a.id); } catch { /* modo privado */ }
    render();
    return;
  }
  const atalhos = { g: '#verGrade', e: '#modoEco', f: '#modoFoco', r: '#recarregarTodas', b: '#puxador', d: '#repetirClique' };
  const botao = atalhos[e.key.toLowerCase()];
  if (botao) { e.preventDefault(); $(botao).click(); }
});

// ---------- ciclo ----------

function render() {
  renderList();
  renderPane();
  renderFarm();
  const emVer = state.accounts.filter((a) => a.effective === 'ver').length;
  const gerenciadas = state.accounts.filter((a) => a.effective === 'gerenciar' && !a.suspended).length;
  // Frota parada e estado do painel inteiro, nao um controle marcado num canto.
  const parado = !!state.settings.killSwitch;
  $('#killSwitch').setAttribute('aria-pressed', String(parado));
  document.body.classList.toggle('parada', parado);
  // Sem gerenciamento nao existe regra automatica rodando, entao dizer "regras
  // ativas" seria mentira -- e o Panico seria uma parada de emergencia para algo
  // que nao anda. Os dois somem juntos e o rodape diz o que o painel de fato e.
  $('#killSwitch').hidden = !GERENCIAMENTO;
  troca($('#rodapeAlerta'), 'textContent', !GERENCIAMENTO
    ? 'Só janelas — gerenciamento desligado'
    : parado ? 'Pânico armado — o painel não age sozinho' : 'Regras automáticas ativas');
  $('#rodapeAlerta').classList.toggle('quieto', !GERENCIAMENTO);

  const suspensas = state.accounts.filter((a) => a.suspended).length;
  troca($('#contaVer'), 'textContent', String(emVer));
  troca($('#rotVer'), 'textContent', GERENCIAMENTO ? (emVer === 1 ? 'sua' : 'suas') : (emVer === 1 ? 'aberta' : 'abertas'));
  troca($('#rotGer'), 'textContent', GERENCIAMENTO ? 'do painel' : (gerenciadas === 1 ? 'fechada' : 'fechadas'));
  troca($('#contaGer'), 'textContent', String(gerenciadas));
  troca($('#contaSus'), 'textContent', String(suspensas));
  $('#parSus').hidden = suspensas === 0;
  $('#parSus').title = `${suspensas} suspensa${suspensas === 1 ? '' : 's'} por presença tomada por fora`;

  pintarModoGpu();
  troca($('#rodapeModo'), 'textContent',
    document.body.classList.contains('foco') ? 'Modo Foco' : ecoCpu ? `${FPS_ECO} quadros/s` : '');
  troca($('#rodapeContagem'), 'textContent', `${emVer}/${state.settings.maxWindows ?? 6} janelas`);

  const mw = $('#maxWindows');
  if (document.activeElement !== mw) troca(mw, 'value', String(state.settings.maxWindows ?? 6));
  // O preco da escolha fica visível, não escondido em tooltip. A conta nao e so a
  // pagina: medido em 16/09/2026, o painel sozinho custa ~430 MB e cada janela
  // cobra ~85 MB de navegador alem do que a pagina segura. Anunciar so o conteudo
  // subestimava o total em ~40% -- 6 janelas "de 2400 MB" mediram 3341 MB.
  const teto = Number(state.settings.maxWindows ?? 6);
  const custo = Math.round((430 + teto * (400 + 85)) / 100) / 10;
  troca($('#custoJanelas'), 'textContent', `~${custo} GB se abrir todas`);
  $('#verGrade').classList.toggle('on', grade);
  const abertas = state.accounts.filter((a) => a.effective === 'ver' && !a.suspended).length;
  $('#modoEco').classList.toggle('on', abertas > 0 && state.accounts
    .filter((a) => a.effective === 'ver' && !a.suspended).every((a) => dormindo.has(a.id)));
  $('#modoEco').disabled = !abertas;
}

async function refresh() {
  state = await window.fleet.get();
  render();
  if (!booted) { booted = true; console.log(`ui pronta: ${state.accounts.length} contas`); }
}

// Aviso temporario: some sozinho, nunca exige acao (FR-010).
window.fleet.onNotice(({ texto, contas }) => {
  const box = document.getElementById('avisos');
  const el = document.createElement('div');
  el.className = 'aviso';
  el.innerHTML = `<b>${esc(texto)}</b>` +
    (contas?.length ? `<span class="quem">${esc(contas.join(', '))}</span>` : '');
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('saindo');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);   // se a animacao estiver desligada
  }, 3200);
});

window.fleet.onState((s) => { state = s; render(); });
// Arrastando uma janela solta por cima da barra: ela acende, e soltar ali devolve.
window.fleet.onAlvoSolta((v) => document.body.classList.toggle('alvo-solta', v));
refresh();
