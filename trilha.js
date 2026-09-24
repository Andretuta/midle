'use strict';
// A trilha e a sequencia de cliques que o painel refaz nas outras janelas.
// Aqui mora so a decisao de ONDE ela comeca -- sem DOM, sem Electron, sem I/O.

/** Distancia a partir da qual dois cliques deixam de ser a mesma tentativa.
 *  Dentro de um caminho os cliques ficam a segundos um do outro; o que separa e
 *  uma pausa, e pausa quer dizer que a pessoa parou, olhou e recomecou. Tres
 *  minutos porque tela de jogo carregando leva segundos, nunca isso. */
const CORTE_TENTATIVA_MS = 3 * 60 * 1000;

/**
 * So a ULTIMA tentativa. Sem isto a trilha acumula tudo desde o ultimo Repetir:
 * quem errou o caminho, recarregou e refez levava junto os passos da tentativa
 * errada. Medido no jogo em 18/09/2026 -- um caminho de 3 passos virou 12, as
 * quatro tentativas emendadas, e o painel teria entrado no jogo quatro vezes.
 *
 * O corte vai no ULTIMO buraco grande, nao no primeiro: o que vale e de onde a
 * pessoa recomecou pela ultima vez.
 *
 * @param {{em:number}[]} trilha cliques em ordem, com carimbo de tempo
 * @param {number} [corteMs] distancia que separa uma tentativa da outra
 */
function ultimaTentativa(trilha, corteMs = CORTE_TENTATIVA_MS) {
  if (!Array.isArray(trilha)) return [];
  let inicio = 0;
  for (let i = 1; i < trilha.length; i++) {
    if (trilha[i].em - trilha[i - 1].em > corteMs) inicio = i;
  }
  return trilha.slice(inicio);
}

// ---------- voltar sozinho: tentar ou nao numa janela ----------
// Isto clica sozinho numa conta de verdade, entao os freios moram aqui, com
// assercao, e nao espalhados pela interface.

/** Depois de uma tentativa, nao insiste em cima dela: a tela ainda pode estar
 *  reagindo ao ultimo clique. */
const VIGIA_REPOUSO_MS = 30 * 1000;
/** Tentativas seguidas sem completar antes de desistir da janela. Clicar para
 *  sempre numa tela que nao responde e pior do que parar. */
const VIGIA_TENTATIVAS_MAX = 3;

/**
 * O vigia pode tentar nesta janela agora? A outra condicao -- a janela estar
 * mostrando o primeiro passo -- so se responde olhando a pagina, e vem depois.
 * @param {{ultima:number, falhas:number}|undefined} marca
 * @param {number} agora
 */
function podeTentar(marca, agora) {
  if (!marca) return true;
  return marca.falhas < VIGIA_TENTATIVAS_MAX && agora - marca.ultima >= VIGIA_REPOUSO_MS;
}

/**
 * A marca da janela depois de o vigia olhar para ela.
 *  - 'fora': nao estava na primeira tela. Esta jogando -- zera as falhas, sem
 *    contar como tentativa.
 *  - 'completou': refez o caminho inteiro. Zera as falhas.
 *  - 'falhou': parou no meio. Conta uma falha.
 * @param {{ultima:number, falhas:number}|undefined} marca
 * @param {'fora'|'completou'|'falhou'} resultado
 * @param {number} agora
 */
function marcaDepois(marca, resultado, agora) {
  const m = marca || { ultima: 0, falhas: 0 };
  if (resultado === 'fora') return { ultima: m.ultima, falhas: 0 };
  if (resultado === 'completou') return { ultima: agora, falhas: 0 };
  return { ultima: agora, falhas: m.falhas + 1 };
}

module.exports = {
  ultimaTentativa, CORTE_TENTATIVA_MS,
  podeTentar, marcaDepois, VIGIA_REPOUSO_MS, VIGIA_TENTATIVAS_MAX,
};
