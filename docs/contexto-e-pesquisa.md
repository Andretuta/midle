# Contexto: por que este projeto existe

## O objetivo

Ter para o [Lorvath](https://lorvath.com) o equivalente aos gerenciadores multi-conta de MU Online
clássico (aquele painel com 5 janelas do jogo lado a lado, cada uma numa conta, com status de farm e
botões de controle): **6 a 12 contas rodando ao mesmo tempo**, cada uma com login próprio, visíveis
numa tela só, com o painel **agindo sozinho** quando um personagem para de farmar.

Decisões tomadas no início, que explicam o formato do app:

| pergunta | escolha |
|---|---|
| como ver as contas | **todas as janelas do jogo vivas**, igual ao painel de referência — não só cards de dados |
| login | Kick, Twitch, Discord e QR code (um provedor diferente por conta) |
| escala | 6 a 12 contas simultâneas |
| automação | **regras automáticas**, não só monitoramento |

## Por que não deu para usar o que já existia

O Lorvath já expõe um MCP oficial para assistentes (`https://lorvath.com/mcp/player`) e o Hermes já
falava com ele. O problema: **o Hermes guarda credencial por servidor MCP, não por conta**. Uma
instalação = uma identidade. Não havia como ter N contas.

Pesquisa feita em 14/09/2026, procurando algo para forkar:

| o que existe | veredito |
|---|---|
| [Ferdium](https://github.com/ferdium/ferdium-app), [Rambox](https://github.com/ramboxapp), [multi-session-browser](https://github.com/pavloniym/multi-session-browser) | o truque útil é `partition: persist:<id>` para isolar sessões — são 3 linhas. O resto (recipes, store, i18n) é peso morto |
| [multizen-browser](https://github.com/multizenteam/multizen-browser), Persona Studio | anti-detect e fingerprint: problema que não temos, o jogo publica MCP para assistentes |
| [mcp-web-client](https://github.com/hemanth/mcp-web-client), [CanvasMCPClient](https://github.com/n00bvn/CanvasMCPClient) | todos assumem **uma identidade por servidor MCP** — o mesmo gargalo do Hermes |
| [obot mcp-oauth-proxy](https://github.com/obot-platform/mcp-oauth-proxy) | proxy OAuth multi-tenant: camada a mais para algo que o SDK resolve local |
| **`@modelcontextprotocol/sdk`** | **usado**: descoberta OAuth, registro dinâmico, PKCE e refresh prontos. A credencial é por instância → multi-conta sai de graça |

Nada específico do Lorvath existe — o jogo é novo demais. Escrever do zero (~600 linhas, 2
dependências) saiu mais barato que adaptar qualquer um dos acima.

## O que descobrimos sondando o servidor

- O MCP devolve 401 com `WWW-Authenticate: Bearer` → OAuth 2.1 padrão, com registro dinâmico de
  cliente (`/register`) e PKCE S256.
- **O token de 900s vem com `refresh_token`.** Isso contraria a nota antiga de que seria preciso
  reautorizar no navegador a cada 15 minutos: o navegador só aparece na **primeira** autorização de
  cada conta.
- 92 tools disponíveis; `game_account` lê personagens, servidores e scopes **sem tomar controle** do
  personagem — é a leitura barata que o painel usa no poll.
- Os schemas das ações são `additionalProperties: false`: aceitam apenas
  `{data, requestId, controlEpoch}`. Mandar o campo solto (ex. `slot`) é rejeitado.
- O personagem vem em `characters[]` com a classe no campo `cls`, e casa por `slot`.
- `lorvath.com` manda `X-Frame-Options: DENY` e `frame-ancestors 'none'` — **não dá para usar iframe**
  numa página web comum. Dentro do Electron, a `<webview>` é contexto de topo e carrega normalmente
  (verificado: a página abre e o título vem certo).

## Regras de convivência com o jogo

Estas não são preferências de estilo — são limites do servidor, e o app foi desenhado em volta delas:

- **`game_connect` + `game_charSelect` tomam controle do personagem** e podem disparar transferência
  de servidor. Por isso só rodam em ação explícita ou regra automática, **nunca no poll**.
- **Nunca chamar `game_release`.** Ele bloqueia a reconexão com "Player took control"; só dá para
  destravar manualmente na UI do jogo. A macro solta o controle deixando o epoch morrer em ~2 min.
- O `controlEpoch` expira com ~2 minutos sem requisições.
- `requestId` é deduplicado de forma **persistente** entre sessões: id fixo queima no primeiro uso e
  nunca mais despacha. Cada chamada gera um id novo.
- Servidores lobby são `webmu-1..8`; se o personagem for movido para `webmu-9+`, o MCP não alcança e
  a conta fica marcada como bloqueada esperando ação humana.
- Sem telemetria fresca da janela (menos de 2 minutos), **nenhuma regra dispara** — decisão
  conservadora de propósito, para o app nunca agir às cegas. Por isso a janela reenvia os dados a
  cada 15s enquanto o websocket do jogo está aberto (senão estado parado parecia velho), e o modo
  leve, que fecha as janelas, deixa as regras em pausa com aviso no card.

## O que falta

- [ ] Rodar o `.exe` de verdade no Windows (o build v0.1.0 foi compilado no Linux e nunca executado).
- [ ] Mapear o protocolo do websocket do jogo com uma sessão logada (`DEBUG_WS=1` grava amostras em
      `data/ws-sample.log`) para fixar de onde vêm XP/min, kills/min e `manualMode`.
- [ ] Ícone próprio e metadados no executável (hoje exige multiarch i386 para o `rcedit`).
- [ ] Assinatura digital, para sumir o aviso de "editor desconhecido".
- [ ] Conferir se o servidor impõe limite de contas por pessoa — é regra do Lorvath, não do app.
