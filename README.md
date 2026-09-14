# Lorvath Fleet

Painel multi-conta para o [Lorvath](https://lorvath.com) (MU Online idle): um grid com N contas,
cada uma com **sessão de navegador própria** (login separado por Kick / Twitch / Discord / QR) e
**cliente MCP próprio** (token OAuth por conta), com regra automática de religar o farm.

## Baixar pronto (Windows)

[Releases](https://github.com/Andretuta/lovarth-multi-contas-idle/releases) → `LovarthFleet-0.1.0-portable.exe`.
Executável portátil: baixa, dá dois cliques, não instala nada. O Windows vai mostrar aviso de
"editor desconhecido" (o .exe não é assinado) — *Mais informações* → *Executar assim mesmo*.
Os dados ficam em `%APPDATA%\Lovarth Fleet\data` (tokens de cada conta, `actions.log`).

## Rodar do código (Windows / Linux)

Precisa de [Node 20+](https://nodejs.org). Na pasta do projeto:

```bash
npm install
```

```bash
npm start
```

## Primeira vez, por conta

1. **+ Conta** → dá um nome (ex: "Conta 2 — email x").
2. **abrir jogo** → a webview carrega o lorvath.com numa sessão isolada; faça o login normal
   (Kick, Twitch, Discord ou QR). O cookie fica só naquela conta e sobrevive ao fechar o app.
3. **autorizar MCP** → abre a página de autorização **dentro da mesma sessão**, ou seja já logado
   na conta certa. Aprove os scopes. O token vai para `data/<id>/tokens.json` e daí em diante
   renova sozinho (refresh token) — sem navegador de novo.
4. **slot N →** ajusta qual personagem daquela conta as ações controlam.

## O que o painel faz sozinho

- Lê `game_account` de cada conta a cada 60s (leitura barata, **não** toma controle do personagem).
- Lê nível / XP-min / kills / zen / mapa direto da janela do jogo (espelho do websocket, custo zero).
- Regra automática por conta: se o personagem está em **modo manual** ou com **XP/min abaixo do
  mínimo** por X minutos seguidos, roda a macro `connect → charSelect → hunt.spot=here → mode farm`
  e solta o controle deixando o epoch expirar.
  - cooldown por conta, uma macro por vez no app inteiro, tudo registrado em `data/actions.log`.
  - o checkbox **parar regras automáticas** no topo é o botão de pânico.

## O que ele nunca faz

- **`game_release`** — trava a reconexão com "Player took control"; só você destrava na UI do jogo.
- Retentar em loop uma conta bloqueada: ela fica vermelha esperando ação sua.
- Agir sem telemetria fresca da janela (sem dados < 2 min, nenhuma regra dispara).

## Memória

Cada janela de jogo aberta é um Chromium renderizando o jogo: ~300–500 MB. Com 6–12 contas, use o
**modo leve** (fecha todas as janelas e mantém só os dados) — o Lorvath é idle, o personagem
continua farmando com a janela fechada.

## Teste

```bash
npm test
```

Checa o isolamento de credenciais entre contas e a lógica da regra automática.

## Arquivos

| arquivo | papel |
|---|---|
| `main.js` | processo principal: janela, IPC, loopback OAuth (127.0.0.1:51380), poll, fila de macros |
| `lorvath-account.js` | uma conta = um cliente MCP + macros (`restartFarm`, `sellTrash`) |
| `oauth-store.js` | `OAuthClientProvider` por conta (é isso que torna o multi-conta possível) |
| `rules.js` | decisão da regra automática, isolada e testável |
| `game-probe.js` | preload da webview: espelha o websocket do jogo → estatísticas ao vivo |
| `renderer/` | grid de cards |
| `data/` | `accounts.json`, tokens por conta (chmod 600), `actions.log` |

Debug do protocolo do jogo: `DEBUG_WS=1 npm start` grava amostras cruas em `data/ws-sample.log`.
