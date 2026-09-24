'use strict';
// Guarda a chave do provedor de IA. Arquivo proprio, separado de accounts.json:
// configuracao o usuario abre, copia e manda print; credencial nao.
// Mesmo tratamento restrito que oauth-store.js da aos tokens de conta.
const fs = require('fs');
const path = require('path');
const { restringir } = require('./oauth-store');

// URLs sao nossas, nao do usuario: pedir para ele digitar endpoint e um jeito de
// errar sozinho. So a chave e dele.
const PROVEDORES = {
  openai: {
    nome: 'OpenAI',
    base: 'https://api.openai.com/v1',
    modelos: null,                       // sem catalogo publico: modelo digitado
    padrao: 'gpt-4o-mini',
  },
  openrouter: {
    nome: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    modelos: 'https://openrouter.ai/api/v1/models',   // publico, sem auth
    padrao: 'openai/gpt-4o-mini',
  },
  gemini: {
    nome: 'Gemini',
    // Endpoint compativel com OpenAI: um caminho de codigo serve os tres.
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelos: null,
    padrao: 'gemini-2.0-flash',
  },
};

class AiStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'ai-key.json');
  }

  /** @returns {{provider:string, model:string, key:string}|null} */
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  save({ provider, model, key }) {
    if (!PROVEDORES[provider]) throw new Error(`provedor desconhecido: ${provider}`);
    // Trocar so o modelo nao pode exigir redigitar a chave: ela nunca volta para a
    // interface, entao o campo chega vazio de proposito. Mesmo provedor, mesma chave.
    const atual = this.read();
    const chave = key || (atual && atual.provider === provider ? atual.key : null);
    if (!chave) throw new Error('chave vazia');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ provider, model: model || PROVEDORES[provider].padrao, key: chave }, null, 2), { mode: 0o600 });
    restringir(this.file);   // o mode so pega arquivo novo; ver oauth-store.js
  }

  /** Remover o provedor apaga a chave do disco, nao so esquece a referencia. */
  clear() {
    try { fs.rmSync(this.file, { force: true }); } catch { /* ja nao existia */ }
  }

  /** O que pode sair para a interface: tudo menos a chave (FR-033). */
  status() {
    const c = this.read();
    if (!c) return { configured: false, provider: null, model: null, provedores: catalogo() };
    return { configured: true, provider: c.provider, model: c.model, provedores: catalogo() };
  }
}

const catalogo = () => Object.entries(PROVEDORES).map(([id, p]) =>
  ({ id, nome: p.nome, padrao: p.padrao, temCatalogo: !!p.modelos }));

module.exports = { AiStore, PROVEDORES };
