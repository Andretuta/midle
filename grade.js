'use strict';
// Decisoes da grade de janelas: quantas colunas, se cabe mais uma, e quanto a
// conta subiu hoje.
//
// Sao tres perguntas pequenas, e e exatamente por isso que estavam soltas dentro
// da interface -- onde quebram em silencio na primeira mudanca de layout. Aqui
// elas tem nome, contrato e assercao.
//
// Modulo puro, como modes.js, rules.js, hud-parse.js e telemetry.js: sem DOM, sem
// Electron, sem I/O. `hoje` e injetado; a funcao nao olha o relogio.

/** Sem limite escolhido, seis janelas. Cabe num 3x2 e e a escala alvo do painel. */
const LIMITE_PADRAO = 6;

/** Teto duro: doze janelas a ~400 MB cada ja e mais memoria do que a maioria tem. */
const LIMITE_MAXIMO = 12;

/** Custo por janela, em MB, com o jogo em mapa comum. E um PISO, nao uma previsao:
 *  em area de boss uma janela chega a ~1,5 GB. Quem chama deve passar o custo
 *  observado quando tiver um -- ver `tetoPorMemoria`. */
const CUSTO_JANELA_MB = 400;

/** O painel sozinho, sem janela nenhuma. Medido em 16/09/2026: 430 MB, 5 processos. */
const BASE_PAINEL_MB = 430;

/** Fracao da memoria livre que o painel se permite usar. O resto e do sistema:
 *  ocupar tudo nao trava so o painel, trava a maquina inteira -- medido do jeito
 *  ruim em 16/09/2026, com 12 janelas de 1500 MB numa maquina de 16 GB. */
const FOLGA = 0.8;

/**
 * Quantas janelas a memoria livre da maquina comporta agora.
 * @param {number} livreMB memoria livre, em MB
 * @param {number} [custoMB] custo OBSERVADO por janela agora; so e usado quando maior
 *        que o piso. Existe porque 400 MB e a janela em mapa comum, e em area de boss
 *        -- servidor inteiro num ponto so -- a mesma janela chega a ~1,5 GB.
 * @returns {number|null} nulo quando nao da para saber -- e ai o limite e so o do usuario
 */
function tetoPorMemoria(livreMB, custoMB = CUSTO_JANELA_MB) {
  const livre = Number(livreMB);
  // Nunca abaixo do piso: um custo observado menor que 400 MB significa janelas
  // leves agora, e nao que a proxima sera leve. Errar para o lado conservador.
  const obs = Number(custoMB);
  const custo = Number.isFinite(obs) && obs > CUSTO_JANELA_MB ? obs : CUSTO_JANELA_MB;
  if (!Number.isFinite(livre) || livre <= 0) return null;
  // Sempre ao menos uma: recusar a primeira janela deixaria o painel inutil numa
  // maquina apertada, e uma janela sozinha a gente sabe que cabe.
  return Math.max(1, Math.floor((livre * FOLGA) / custo));
}

/**
 * Quantas colunas para exibir `n` janelas sem deixar celula orfa.
 * @param {number} n janelas abertas
 * @returns {number} colunas, sempre >= 1
 */
function colunas(n) {
  const q = Number(n);
  if (!Number.isFinite(q) || q <= 1) return 1;   // inclui lixo de entrada: 1 coluna e sempre seguro
  const base = q <= 2 ? 2 : q <= 4 ? 2 : q <= 9 ? 3 : 4;
  // Uma celula sozinha na ultima linha e o arranjo feio que este modulo existe
  // para evitar -- e a tabela acima, sozinha, produzia exatamente isso em 3 (2+1)
  // e em 7 (3+3+1). Os dois passaram anos despercebidos porque so o caso do 4
  // tinha assercao. Em vez de remendar os dois, a regra agora esta escrita: se
  // sobra uma orfa, mais uma coluna. O selfcheck confere de 2 a 12.
  return q > base && q % base === 1 ? base + 1 : base;
}

/**
 * Cabe abrir mais uma janela?
 * Responde sim ou nao. NAO escolhe quem fechar: fechar a janela de outra conta e
 * decisao do usuario, nao do painel (FR-005).
 * @param {number} abertas janelas ja abertas
 * @param {number} limite  limite escolhido pelo usuario
 * @returns {{ok:boolean, reason:string}} recusa sempre traz motivo
 */
function cabeJanela(abertas, limite, livreMB, custoMB) {
  const teto = normalizaLimite(limite);
  const ja = Number(abertas);
  const quantas = Number.isFinite(ja) && ja > 0 ? Math.floor(ja) : 0;

  // A memoria vem antes do limite escolhido: o limite e preferencia, a memoria e
  // fisica. Passar dela nao deixa o painel lento, congela o computador.
  const porRam = tetoPorMemoria(livreMB, custoMB);
  if (porRam !== null && quantas >= porRam) {
    return {
      ok: false,
      reason: `a memória livre agora (${Math.round(Number(livreMB) / 1024 * 10) / 10} GB) só comporta ${porRam} janela${porRam === 1 ? '' : 's'}; feche algo antes`,
    };
  }

  if (quantas < teto) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: `limite de ${teto} janela${teto === 1 ? '' : 's'} atingido; feche uma antes`,
  };
}

/** Limite fora da faixa nao pode virar zero janelas nem memoria infinita. */
function normalizaLimite(limite) {
  const n = Number(limite);
  if (!Number.isFinite(n) || n < 1) return LIMITE_PADRAO;
  return Math.min(Math.floor(n), LIMITE_MAXIMO);
}

/**
 * Quantos niveis a conta ganhou hoje.
 * @param {{levelDia?:string, levelBase?:number}|null} marco nivel com que a conta comecou o dia
 * @param {number} nivelAtual nivel lido agora
 * @param {string} hoje data corrente AAAA-MM-DD, injetada
 * @returns {number|null} nulo quando nao da para saber -- nunca zero, que seria uma afirmacao
 */
function ganhoDoDia(marco, nivelAtual, hoje) {
  const m = marco || {};
  if (!hoje || m.levelDia !== hoje) return null;
  if (typeof m.levelBase !== 'number' || typeof nivelAtual !== 'number') return null;
  const ganho = nivelAtual - m.levelBase;
  // Nivel menor que a base significa marco invalido (personagem trocado, reset),
  // nao ganho negativo.
  return ganho >= 0 ? ganho : null;
}

/**
 * Pastas de sessao de contas que ESTE painel excluiu. Excluir conta limpa cookies
 * e login, mas o Chromium deixa o esqueleto da particao (~2 MB de cache cada) --
 * medido em 23/09/2026: 202 pastas para 2 contas.
 *
 * So sai o que esta na lista de excluidas, nunca "tudo que eu nao conheco": o
 * executavel e o `npm start` guardam contas em lugares diferentes mas dividem a
 * MESMA pasta de sessoes (%APPDATA%\midle e \MIDLE sao uma so no Windows). A
 * primeira versao apagava toda sessao sem conta conhecida -- e cada um dos dois
 * apagaria o login das contas do outro.
 * @param {string[]} pastas nomes dentro de Partitions/
 * @param {string[]} excluidas ids que este painel excluiu
 * @param {string[]} vivas ids cadastrados agora (uma conta recriada com o mesmo id fica)
 */
function particoesExcluidas(pastas, excluidas, vivas) {
  if (!Array.isArray(pastas) || !Array.isArray(excluidas)) return [];
  const agora = new Set((Array.isArray(vivas) ? vivas : []).map((id) => String(id).toLowerCase()));
  const alvo = new Set(excluidas.map((id) => String(id).toLowerCase()).filter((id) => !agora.has(id)).map((id) => `acc-${id}`));
  return pastas.filter((p) => alvo.has(String(p).toLowerCase()));
}

/**
 * A janela solta foi largada no alvo de volta? O alvo e a BARRA de cima do
 * painel, nao o painel inteiro: com o painel maximizado toda a tela e painel, e
 * qualquer arrasto devolveria a janela sem voce querer.
 * @param {{x:number,y:number}} cursor onde o mouse soltou, em coordenadas de tela
 * @param {{x:number,y:number,width:number}} painel area de conteudo do painel
 * @param {number} barra altura da barra, em px
 */
function soltaNaBarra(cursor, painel, barra) {
  if (!cursor || !painel) return false;
  return cursor.x >= painel.x && cursor.x < painel.x + painel.width &&
    cursor.y >= painel.y && cursor.y < painel.y + barra;
}

/**
 * Onde a janela solta nasce. O tamanho guardado vale; a posicao guardada so
 * vale se ainda cair em alguma tela -- monitor desligado deixaria a janela
 * aberta num lugar que ninguem ve.
 * @param {{x?:number,y?:number,width?:number,height?:number}|null} guardado
 * @param {{x:number,y:number,width:number,height:number}[]} telas areas uteis dos monitores
 */
function limitesSolta(guardado, telas) {
  const g = guardado || {};
  const tam = (v, min, padrao) => (Number.isFinite(v) && v >= min ? Math.round(v) : padrao);
  const out = { width: tam(g.width, 320, 1280), height: tam(g.height, 240, 760) };
  const naTela = Number.isFinite(g.x) && Number.isFinite(g.y) && (telas || []).some((t) =>
    g.x + 40 > t.x && g.x < t.x + t.width - 40 && g.y >= t.y && g.y < t.y + t.height - 40);
  if (naTela) { out.x = Math.round(g.x); out.y = Math.round(g.y); }
  return out;
}

module.exports = { soltaNaBarra, limitesSolta, particoesExcluidas, colunas, cabeJanela, tetoPorMemoria, ganhoDoDia, LIMITE_PADRAO, LIMITE_MAXIMO, CUSTO_JANELA_MB, BASE_PAINEL_MB };
