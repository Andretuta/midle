'use strict';
// Decisao de modo por conta: ver o jogo ou gerenciar pelo painel.
//
// O servidor aceita os dois canais ao mesmo tempo -- medido em 15/09/2026, com o
// personagem cacando na janela enquanto a macro de controle inteira passou pelo MCP
// sem um unico erro. A exclusividade e escolha do painel: coexistir custa farm (a
// janela registrou ~1 min de ausencia e o game_connect seguinte levou 4x mais).
//
// Modulo puro, como rules.js e hud-parse.js: sem DOM, sem Electron, sem I/O, `now`
// sempre injetado. E o seam que o selfcheck cobre.

const MODOS = new Set(['ver', 'gerenciar']);
const PADRAO = 'gerenciar';

/** Troca de modo desiste depois disto. Medido, nao chutado: a ausencia observada
 *  foi da ordem de um minuto, e casa com a expiracao do controlEpoch. */
const TROCA_MS = 2 * 60_000;

/** O controlEpoch morre sozinho com ~2 min sem requisicao. Expirar assim NAO e
 *  disputa -- e o que separa "alguem entrou na conta" de "ninguem usou". */
const OCIOSIDADE_MS = 2 * 60_000;

/** Quantas perdas nao solicitadas seguidas ate suspender. Uma so e ruido. */
const PERDAS_ATE_SUSPENDER = 2;

const normaliza = (m) => (MODOS.has(m) ? m : PADRAO);

/**
 * Modo efetivo de cada conta.
 * @param {Array<{id:string, mode?:string, pendingMode?:string, switchingSince?:number, status?:string}>} accounts
 *        `mode` e o modo assentado; `pendingMode` e o destino de uma troca em curso.
 * @param {number} now instante injetado
 * @returns {Map<string, {effective:string, switching:boolean, reason:string}>}
 */
function resolve(accounts, now) {
  const out = new Map();
  for (const acc of accounts || []) {
    if (!acc || acc.id == null) continue;
    const mode = normaliza(acc.mode);

    // Suspensa nao esta em ver: esta em gerenciar, so que sem gerenciamento ativo.
    if (acc.status === 'suspenso') {
      out.set(acc.id, { effective: PADRAO, switching: false, reason: 'presença tomada por fora; esperando você decidir' });
      continue;
    }

    const desde = acc.switchingSince || 0;
    if (desde) {
      // Durante a troca vale o modo anterior, nunca o de destino: o canal novo
      // ainda nao conectou e prometer o destino faria a interface mentir.
      if (now - desde <= TROCA_MS) {
        out.set(acc.id, { effective: mode, switching: true, reason: `trocando para ${normaliza(acc.pendingMode)}` });
      } else {
        out.set(acc.id, { effective: mode, switching: false, reason: 'a troca demorou demais; voltou ao modo anterior' });
      }
      continue;
    }

    out.set(acc.id, { effective: mode, switching: false, reason: '' });
  }
  return out;
}

/**
 * A conta aceita acao de gerenciamento agora?
 * Fonte unica para a interface (FR-013) e para o chat (FR-028), para os dois
 * nunca discordarem sobre o que esta disponivel.
 * @returns {{ok:boolean, reason:string}} ok falso sempre vem com motivo.
 */
function canManage(state) {
  const s = state || {};
  if (s.effective === 'ver') return { ok: false, reason: 'a conta está em modo ver' };
  if (s.switching) return { ok: false, reason: 'troca de modo em andamento' };
  if (s.status === 'suspenso') return { ok: false, reason: 'presença tomada por fora; esperando você decidir' };
  if (s.status === 'blocked') return { ok: false, reason: 'conta bloqueada no jogo; precisa de ação manual' };
  // Sem sessao de gerenciamento a acao ate sai, mas volta com erro interno. Melhor
  // dizer antes, em portugues, do que deixar o usuario levar um modal com jargao.
  if (s.status === 'needs_auth') return { ok: false, reason: 'autorize o gerenciamento nesta conta' };
  if (s.status === 'offline') return { ok: false, reason: 'conectando ao jogo, aguarde' };
  if (s.status === 'error') return { ok: false, reason: 'a última conexão falhou; tentando de novo em instantes' };
  if (s.status !== 'ready') return { ok: false, reason: `conta em estado ${s.status}` };
  return { ok: true, reason: '' };
}

/**
 * A verificacao periodica pode conectar esta conta ao jogo?
 *
 * Existe porque a constituicao v1.1.0 permite `game_connect` no poll para conta em
 * gerenciar, e SO para ela. Essa permissao vale exatamente enquanto as tres recusas
 * abaixo valerem -- entao elas moram aqui, num modulo puro com assercao, e nao
 * enterradas numa sequencia de ifs no meio do laco.
 *
 * @param {{mode?:string, status?:string, generica?:boolean}} account
 * @returns {{ok:boolean, reason:string}} recusa sempre traz motivo
 */
function podeConectarNoPoll(account) {
  const a = account || {};
  // Janela comum nao fala com o servidor do jogo em hipotese alguma.
  if (a.generica) return { ok: false, reason: 'janela comum nao fala com o jogo' };
  // Suspensa espera decisao do humano; reconectar seria entrar por cima de quem joga.
  if (a.status === 'suspenso') return { ok: false, reason: 'conta suspensa por presenca externa' };
  // Em ver a presenca e do usuario. Conectar aqui e exatamente o abuso que o
  // Principio II proibe, e o que a emenda NAO liberou.
  if (normaliza(a.mode) === 'ver') return { ok: false, reason: 'a conta esta em modo ver' };
  return { ok: true, reason: '' };
}

/**
 * Este reestabelecimento de controle conta como perda de presenca nao solicitada?
 * NAO recebe latencia de proposito (FR-018a): 1217ms tanto pode ser disputa quanto
 * servidor lento, e suspender por isso derrubaria a frota numa oscilacao de rede.
 *
 * @param {{unsolicitedLosses?:number, lastRequestAt?:number, epochLostAt?:number}} account
 * @param {'troca'|'usuario'|'regra'|'nenhuma'} origin o que o painel pediu, se pediu
 * @returns {{losses:number, suspend:boolean, reason:string}}
 */
function countLoss(account, origin) {
  const acc = account || {};
  const losses = acc.unsolicitedLosses || 0;

  // O painel sabe tudo que solicitou. Fora dessas origens, foi alguem de fora.
  if (origin && origin !== 'nenhuma') return { losses: 0, suspend: false, reason: '' };

  const ocioso = (acc.epochLostAt || 0) - (acc.lastRequestAt || 0) >= OCIOSIDADE_MS;
  if (ocioso) return { losses, suspend: false, reason: 'presença expirou por ociosidade' };

  const novas = losses + 1;
  if (novas >= PERDAS_ATE_SUSPENDER) {
    return { losses: novas, suspend: true, reason: 'presença tomada por fora do painel duas vezes seguidas' };
  }
  return { losses: novas, suspend: false, reason: 'perda de presença não solicitada' };
}

module.exports = { resolve, canManage, countLoss, podeConectarNoPoll, TROCA_MS, OCIOSIDADE_MS, PERDAS_ATE_SUSPENDER };
