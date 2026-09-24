'use strict';
// Conversa com o provedor de IA e traduz o que ele pede em acoes do painel.
//
// Fronteira que nao se negocia: a resposta do provedor e DADO, nunca instrucao.
// Ele so escolhe dentro do catalogo que oferecemos, e toda escolha passa pelo
// mesmo despacho do botao equivalente -- mesma checagem de modo, mesmo cooldown,
// mesmo botao de panico. O chat nao amplia o que o painel ja podia fazer.
//
// fetch nativo, sem SDK: os tres provedores falam o mesmo formato de chat.
const { PROVEDORES } = require('./ai-store');

const TIMEOUT_MS = 60_000;
const MAX_VOLTAS = 5;   // ponytail: limite duro de idas e vindas; sem isto um provedor teimoso roda para sempre
// Historico sem teto vira conta cara: cada pedido reenvia a conversa inteira.
// O sistema fica sempre; o resto e janela deslizante.
const MAX_HISTORICO = 40;

/** Catalogo exposto ao provedor. Espelha os botoes, nao acrescenta nada. */
function ferramentas() {
  const conta = { type: 'string', description: 'Rótulo ou id da conta. Use "todas" para a frota inteira.' };
  return [
    { type: 'function', function: { name: 'listar_contas', description: 'Lista as contas, o modo de cada uma, o estado e a telemetria atual.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'religar_farm', description: 'Reconecta e coloca o personagem para farmar no ponto atual.', parameters: { type: 'object', properties: { conta }, required: ['conta'] } } },
    { type: 'function', function: { name: 'vender_lixo', description: 'Vende os itens marcados como lixo.', parameters: { type: 'object', properties: { conta }, required: ['conta'] } } },
    { type: 'function', function: { name: 'ler_conta', description: 'Releitura do estado da conta pelo canal de gerenciamento.', parameters: { type: 'object', properties: { conta }, required: ['conta'] } } },
    { type: 'function', function: { name: 'trocar_modo', description: 'Troca entre ver (você joga) e gerenciar (o painel joga).', parameters: { type: 'object', properties: { conta, modo: { type: 'string', enum: ['ver', 'gerenciar'] } }, required: ['conta', 'modo'] } } },
  ];
}

const SISTEMA = [
  'Você opera o MIDLE, um painel que cuida de várias contas de um jogo idle.',
  'Você só pode usar as ferramentas oferecidas. Não invente ações nem prometa o que não executou.',
  'Antes de agir sobre "todas as contas", chame listar_contas para saber quais existem e em que modo estão.',
  'Contas em modo ver são jogadas pela pessoa: não aja nelas, avise que estão em ver.',
  'Se uma ação for recusada, diga o motivo exatamente como veio; não tente contornar.',
  'Responda em português, curto, dizendo o que fez em cada conta.',
].join(' ');

/**
 * @param {object} deps
 * @param {() => {provider:string, model:string, key:string}|null} deps.config
 * @param {() => Array} deps.frota  estado resumido das contas
 * @param {(nome:string, args:object) => Promise<object>} deps.executar  despacho do painel
 * @param {(msg:string) => void} [deps.log]
 */
function criarChat({ config, frota, executar, log = () => {} }) {
  const historico = [{ role: 'system', content: SISTEMA }];

  async function chamarProvedor(mensagens) {
    const c = config();
    if (!c) throw new Error('Nenhum provedor de IA configurado.');
    const p = PROVEDORES[c.provider];
    if (!p) throw new Error(`Provedor desconhecido: ${c.provider}`);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, messages: mensagens, tools: ferramentas(), tool_choice: 'auto' }),
        signal: ctrl.signal,
      });
    } catch (err) {
      // A mensagem nunca pode carregar a chave nem o cabecalho que a leva (FR-033).
      throw new Error(err.name === 'AbortError'
        ? `${p.nome} não respondeu em ${TIMEOUT_MS / 1000}s.`
        : `Não consegui falar com ${p.nome}: ${err.message}`);
    } finally { clearTimeout(t); }

    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      const dica = res.status === 401 || res.status === 403 ? ' Confira a chave nas configurações.' : '';
      throw new Error(`${p.nome} recusou (${res.status}).${dica} ${corpo.slice(0, 200)}`.trim());
    }
    const json = await res.json();
    const msg = json?.choices?.[0]?.message;
    if (!msg) throw new Error(`${p.nome} devolveu uma resposta que não entendi.`);
    return msg;
  }

  /** Executa uma escolha do provedor. Ferramenta fora do catalogo e recusada. */
  async function rodarFerramenta(nome, args) {
    if (nome === 'listar_contas') return { contas: frota() };
    const permitidas = new Set(ferramentas().map((f) => f.function.name));
    if (!permitidas.has(nome)) return { ok: false, erro: `ferramenta ${nome} não existe` };
    return executar(nome, args || {});
  }

  return {
    async enviar(texto) {
      // Corta antes de enviar. A janela tem que comecar num `user`: deixar uma
      // mensagem `tool` orfa no topo faz o provedor recusar a conversa inteira.
      while (historico.length > MAX_HISTORICO) historico.splice(1, 1);
      while (historico.length > 1 && historico[1].role !== 'user') historico.splice(1, 1);
      historico.push({ role: 'user', content: String(texto || '').slice(0, 4000) });
      const acoes = [];

      for (let volta = 0; volta < MAX_VOLTAS; volta++) {
        const msg = await chamarProvedor(historico);
        historico.push(msg);

        const chamadas = msg.tool_calls || [];
        if (!chamadas.length) return { ok: true, reply: msg.content || '(sem resposta)', actions: acoes };

        for (const ch of chamadas) {
          const nome = ch.function?.name;
          let args = {};
          try { args = JSON.parse(ch.function?.arguments || '{}'); } catch { /* provedor mandou lixo */ }
          const r = await rodarFerramenta(nome, args);
          if (nome !== 'listar_contas') acoes.push({ nome, args, resultado: r });
          log(`chat: ${nome} ${JSON.stringify(args)} -> ${JSON.stringify(r).slice(0, 160)}`);
          historico.push({ role: 'tool', tool_call_id: ch.id, content: JSON.stringify(r).slice(0, 4000) });
        }
      }
      return { ok: true, reply: 'Parei: o provedor ficou pedindo ações sem concluir.', actions: acoes };
    },

    limpar() { historico.length = 1; },
  };
}

/** Catalogo de modelos. So o OpenRouter publica um; os outros o usuario digita. */
async function buscarModelos(provider) {
  const p = PROVEDORES[provider];
  if (!p?.modelos) return { ok: false, erro: `${p?.nome || provider} não publica catálogo de modelos. Digite o nome do modelo.` };
  const res = await fetch(p.modelos, { headers: { accept: 'application/json' } });
  if (!res.ok) return { ok: false, erro: `${p.nome} respondeu ${res.status} ao listar modelos.` };
  const json = await res.json();
  const modelos = (json?.data || [])
    .map((m) => ({ id: m.id, nome: m.name || m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, modelos };
}

module.exports = { criarChat, buscarModelos, ferramentas };
