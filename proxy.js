'use strict';
// Proxy por conta: cada conta sai por um endereco fixo, para o servidor do jogo
// nao ver a frota inteira vindo do mesmo IP.
//
// Aqui moram so as DECISOES: como ler a lista que a pessoa colou, qual proxy
// pertence a qual conta, e que regra vai para o navegador. Quem aplica e fala com
// a rede e o main.js -- este modulo nao tem I/O, como modes.js e grade.js.
//
// Limite do Chromium que precisa estar dito em algum lugar: **proxy SOCKS5 com
// usuario e senha nao autentica**. O Chromium so pede credencial para proxy HTTP.
// Lista de SOCKS com senha vai conectar e falhar calada; por isso `analisar`
// devolve um aviso em vez de deixar passar.

const ESQUEMAS = new Set(['http', 'https', 'socks5', 'socks4']);

/** Uma linha da lista vira um proxy, ou nulo se nao der para entender. */
function lerLinha(linha) {
  const t = String(linha || '').trim();
  if (!t || t.startsWith('#')) return null;

  // Forma 1: esquema://usuario:senha@host:porta  (ou sem credencial)
  const comEsquema = t.match(/^([a-z0-9]+):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/@\s]+):(\d{1,5})\/?$/i);
  if (comEsquema) {
    const [, esquema, user, pass, host, porta] = comEsquema;
    return montar(esquema.toLowerCase(), host, porta, user, pass);
  }

  // Forma 2: host:porta:usuario:senha  (o formato que os revendedores entregam)
  const cru = t.split(':');
  if (cru.length === 4) return montar('http', cru[0], cru[1], cru[2], cru[3]);
  if (cru.length === 2) return montar('http', cru[0], cru[1], '', '');

  return null;
}

function montar(esquema, host, porta, user, pass) {
  const p = Number(porta);
  if (!host || !ESQUEMAS.has(esquema)) return null;
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  return { esquema, host: String(host), porta: p, user: String(user || ''), pass: String(pass || '') };
}

/**
 * Le a lista inteira que a pessoa colou.
 * @returns {{proxies:Array, erros:Array<{linha:number, texto:string}>, avisos:Array<string>}}
 */
function analisar(texto) {
  const linhas = String(texto || '').split(/\r?\n/);
  const proxies = [];
  const erros = [];
  linhas.forEach((l, i) => {
    if (!l.trim() || l.trim().startsWith('#')) return;
    const p = lerLinha(l);
    if (p) proxies.push(p);
    else erros.push({ linha: i + 1, texto: l.trim().slice(0, 60) });
  });

  const avisos = [];
  if (proxies.some((p) => /^socks/.test(p.esquema) && p.user)) {
    avisos.push('Proxy SOCKS com usuário e senha não autentica no Chromium. Use proxy HTTP para as contas que precisam de senha.');
  }
  return { proxies, erros, avisos };
}

/**
 * Qual proxy cada conta usa. Atribuicao ESTAVEL: uma conta que ja tem proxy
 * mantem o mesmo, senao o IP da conta mudaria a cada abertura do painel -- que e
 * exatamente o que o recurso existe para evitar.
 * @param {string[]} contas ids das contas, em ordem
 * @param {number} quantos  quantos proxies existem na lista
 * @param {Object<string,number>} atual atribuicao ja gravada (id -> indice)
 * @returns {Object<string,number>} id -> indice do proxy, ou -1 quando a lista acabou
 */
function atribuir(contas, quantos, atual) {
  const total = Number(quantos) || 0;
  const antes = atual && typeof atual === 'object' ? atual : {};
  const saida = {};
  const usados = new Set();

  // Primeiro quem ja tinha: mantem o indice, se ele ainda existir na lista.
  for (const id of contas || []) {
    const i = antes[id];
    if (Number.isInteger(i) && i >= 0 && i < total && !usados.has(i)) {
      saida[id] = i;
      usados.add(i);
    }
  }
  // Depois os novos, no primeiro indice livre. Sem lista, fica -1: conta sai pela
  // rede normal, em vez de falhar. Melhor sem proxy do que sem jogo.
  let proximo = 0;
  for (const id of contas || []) {
    if (saida[id] !== undefined) continue;
    while (proximo < total && usados.has(proximo)) proximo++;
    if (proximo < total) { saida[id] = proximo; usados.add(proximo); proximo++; }
    else saida[id] = -1;
  }
  return saida;
}

/** A regra que o navegador entende. Sem credencial aqui: ela vai no evento de login. */
function regra(p) {
  if (!p || !p.host) return null;
  return { proxyRules: `${p.esquema}://${p.host}:${p.porta}`, proxyBypassRules: '<local>' };
}

/** O que pode aparecer na tela: tudo menos a senha. */
function resumir(p, indice) {
  if (!p) return null;
  return {
    indice,
    esquema: p.esquema,
    host: p.host,
    porta: p.porta,
    user: p.user || null,
    temSenha: !!p.pass,
    rotulo: `${p.esquema}://${p.host}:${p.porta}`,
  };
}

module.exports = { analisar, lerLinha, atribuir, regra, resumir };
