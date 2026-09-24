<div align="center">

<img src="build/icon.png" width="112" alt="Ícone do MIDLE: três joias do MU sobre vidro">

# MIDLE

**Multi + idle.** Várias contas de um jogo idle de navegador, cada uma com sessão isolada,
jogáveis ao mesmo tempo numa grade só.

Feito para o [Lorvath](https://lorvath.com), um MU Online idle, e aberto a qualquer outro endereço.

`Windows` · `portátil, sem instalação` · `6 a 12 contas` · `v0.2.0`

[English](README.md) · **Português**

</div>

<p align="center"><img src="assets/grade.png" alt="Duas contas do Lorvath lado a lado na grade do MIDLE" width="900"></p>

---

## Baixar

Pegue o `MIDLE-0.2.0-portable.exe` em **[Releases](https://github.com/Andretuta/midle/releases)**
e abra — não instala nada. O executável não é assinado, então o Windows avisa na primeira vez
(**Mais informações → Executar assim mesmo**).

Ou rode do código:

```bash
npm install
npm start
```

## Novidades na 0.2.0

| | |
|---|---|
| **Visual novo** | Vidro fosco sobre o brilho das três joias do MU — ouro para as contas abertas, azul para as fechadas, violeta para o painel. Fontes novas (Manrope, Unbounded, JetBrains Mono), empacotadas no app. |
| **Ícone** | Três joias sobre vidro, no executável, na barra de tarefas e na barra do painel. |
| **Janela solta** | Tire uma conta do painel e deixe do tamanho e no monitor que quiser; arraste até a barra de cima para trazer de volta. |
| **Voltar sozinho mais seguro** | Repetir e Voltar sozinho não clicam mais na mesma janela ao mesmo tempo, e as regras de quando ele tenta foram para o teste automático. |
| **Disco** | Conta excluída não deixa mais ~2 MB de sessão para trás: o painel limpa ao abrir. Na primeira vez, 200 pastas e ~310 MB. |
| **Menos travamento** | Pixels de rastreio da página (Facebook, Google Analytics) são barrados antes de sair — com várias contas eles enchiam o terminal e podiam congelar o app. |

---

## Como usar

**+ Conta** cria uma janela. Escolha Lorvath ou outro endereço; cada uma nasce com sessão limpa, e
você faz login dentro dela como faria no navegador.

**Fechar tudo** fecha a frota inteira na hora, e não pode ser recusado: não espera macro em voo nem
troca de modo travada, e leva junto popup de login, que é janela sem conta nenhuma registrada e por
isso não tinha como ser fechada pelo painel. A conta não some — vira vaga.

**Grade** mostra a frota inteira lado a lado — janela viva onde há, e uma vaga com botão onde a conta
está fechada. **Telas** define quantas podem ficar abertas ao mesmo tempo.

**Repouso** troca o desenho da janela por um cartão com relógio. O personagem continua farmando no
servidor, que é o que um jogo idle faz. Medido: **36,2 quadros por segundo caem a zero e o
processador cai 89%** — mas a memória **não** muda (490 MB → 489 MB), porque a página segue
carregada. Para economizar memória, feche a janela.

**Quadros** limita o desenho sem esconder a janela: o jogo continua visível, desenhando 10 quadros
por segundo em vez de 75. Medido: 75,0 → 9,4.

**Proxy** dá um endereço de saída fixo por conta, para o servidor não ver a frota inteira vindo do
mesmo IP. Aceita `host:porta:usuário:senha` ou `esquema://usuário:senha@host:porta`. Um aviso: o
Chromium **não autentica proxy SOCKS com senha** — só HTTP.

**Repetir** resolve a volta ao jogo depois que ele atualiza, quando a frota inteira cai na mesma tela.
Voltar não é um clique: é escolher o servidor, escolher o personagem e entrar. Então o painel grava a
**trilha** — tudo que você clicou desde o último Repetir — e refaz o caminho inteiro nas outras
janelas, esperando cada tela aparecer antes do passo seguinte. A trilha se apaga ao ser repetida,
para a próxima não arrastar a anterior junto.

Nada de seletor chumbado no código: o que o jogo desenha hoje muda na próxima atualização, e por isso
quem ensina o caminho é você. Ele só repete o que **você** clicou de verdade — a própria repetição
não vira a próxima gravação.

Três decisões que custaram medição no jogo real, em 18/09/2026:

- A trilha mora no `sessionStorage` da própria página. **Clicar no servidor navega**, e a navegação
  levava junto o clique recém-dado — exatamente o que você quer repetir.
- Só a **última tentativa** conta. A trilha acumula desde o último Repetir, então quem errou o
  caminho, recarregou e refez levava os passos errados junto: um caminho de 3 passos virou 12 — as
  quatro tentativas emendadas — e o painel teria entrado no jogo quatro vezes. Uma pausa de mais de
  3 minutos começa uma trilha nova.
- O passo procura pelo **nome** antes da posição. Posição não é identidade: basta uma linha a mais
  numa das janelas para o 5º botão ser outro servidor, e o erro seria silencioso. Quando o nome muda
  por conta, como no personagem, aí sim vale a posição.

Verificado nas duas contas: servidor, personagem e entrar numa janela, um Repetir, e a outra entrou
no jogo sozinha. **O servidor, porém, quem decide é o jogo**: o personagem mora num servidor, e
escolher outro no lobby não o move — medido clicando na mão, não é o painel.

**Voltar sozinho** é o Repetir sem você. O caminho que você repetiu por último fica guardado, e com
o interruptor ligado o painel refaz esse caminho em qualquer janela que aparecer na **primeira tela
dele** — que é como ele distingue "o jogo reiniciou e caiu na escolha de servidor" de "está jogando".
Nasce desligado.

Três freios, porque isto clica sozinho numa conta de verdade: só age com o interruptor ligado e um
caminho que você salvou; só age na janela que está mostrando o primeiro passo; e desiste depois de
três tentativas seguidas sem completar, avisando — clicar para sempre numa tela que não responde é
pior do que parar.

Ele olha de 10 em 10 segundos, mas **o relógio é estrangulado quando a janela está em segundo
plano**: medido, disparou em 38 s. Para o que ele faz — voltar ao jogo depois de um reinício — isso
serve, e o preço de desligar o estrangulamento seria a frota inteira desenhando.

**Soltar** (⧉ na célula, ou botão direito na linha) tira a conta do painel e a transforma numa janela
própria do Windows: você escolhe o tamanho e o lugar, inclusive em outro monitor, e o painel lembra
dos dois na próxima vez. Para trazer de volta, arraste a janela até a **barra de cima do painel** —
ela acende quando você está no alvo — ou feche-a no X. O alvo é a barra, e não o painel inteiro,
porque com o painel maximizado qualquer arrasto cairia em cima dele. Sair e voltar recarrega a página
(é outra janela, com a mesma sessão): o login fica e o jogo reconecta. Repetir, Voltar sozinho e
Quadros valem só para as janelas dentro do painel.

**Excluir** também mora no botão direito da linha da conta, junto com abrir, fechar e recarregar.
Antes só existia no painel da direita, o que obrigava a selecionar a conta — ou seja, abrir a janela
dela — para poder apagá-la.

Atalhos: `Ctrl+1..9` seleciona conta, `Ctrl+B` recolhe a coluna, `Ctrl+G` alterna a grade, `Ctrl+E`
repouso, `Ctrl+F` foco, `Ctrl+R` recarrega todas, `Ctrl+D` repete a trilha nas outras.

---

## Aparência

A cor sempre diz alguma coisa: **ouro** é conta aberta, com você jogando; **azul** é conta fechada;
**violeta** é o próprio painel — a marca e o foco do teclado. O fundo é a noite do castelo com o
brilho das três joias, e a barra, a coluna e o rodapé são vidro fosco por cima dele.

O desfoque fica **só no cromo**, que tem o brilho parado atrás. As janelas do jogo não levam
desfoque: com doze delas, isso seria placa de vídeo gasta com a frota inteira. Quem liga *menos
transparência* no Windows recebe o mesmo desenho, sólido.

---

## Memória

Cada janela é um Chromium próprio. O custo tem duas partes, e por um tempo o painel anunciava só uma
delas: **o que a página segura, mais ~85 MB de navegador**, sobre uma base de ~430 MB do painel. A
conta que ele faz hoje é `430 + n × (conteúdo + 85)` MB, e ela reproduz o medido em 16/09/2026:

| janelas | conteúdo por janela | medido |
|---|---|---|
| 6 | 400 MB | 3.341 MB |
| 12 | 400 MB | 6.071 MB |
| 6 | 1.500 MB | 9.520 MB de commit — 3 GB já paginados para o disco |

O painel mostra esse custo na barra e **recusa abrir janela quando a memória livre não comporta**,
antes do limite que você escolheu: o limite é preferência, a memória é física. A conta usa o que as
janelas estão custando naquele momento, não uma média — é o que faz a recusa acertar em área de boss,
onde uma janela passa de 1 GB. Medido: com janelas de 1 GB a guarda para na quarta; com a média fixa
de 400 MB ela deixava chegar à nona.

Esse número existe porque a versão sem ele **congelou a máquina**: doze janelas de 1,5 GB pedem 18 GB
de commit num computador de 16 GB, e o Windows trava antes de qualquer proteção do painel conseguir
rodar.

### Disco

Cada conta excluída deixava a pasta da sessão para trás — o Chromium segura os arquivos enquanto o
painel roda, então apagar na hora não dá. Agora a exclusão fica anotada e o painel apaga a pasta
**no próximo boot**. Medido em 23/09/2026: 202 pastas para 2 contas, ~310 MB de sobra.

Ele apaga só o que **ele mesmo** excluiu, nunca "toda sessão que eu não conheço": o executável e o
`npm start` guardam as contas em lugares diferentes, mas dividem a mesma pasta de sessões — e cada
um apagaria o login das contas do outro.

---

## Gerenciamento pelo painel — desligado

O painel sabe conversar com o jogo por um canal próprio (MCP, com OAuth por conta): ler telemetria
sem janela aberta, religar o farm sozinho quando o XP por minuto cai, ceder a vez quando alguém entra
na conta por fora. **Isso está desligado.**

Nada foi apagado — o código, as regras e as asserções continuam no repositório. O interruptor é a
constante `GERENCIAMENTO`, em `main.js` e em `renderer/app.js`; as duas precisam concordar. Com ele
em `false`, o painel não fala com o servidor do jogo em momento nenhum, e cada conta tem só dois
estados: aberta ou fechada.

<details>
<summary><b>Limites do jogo, se você for ligar de volta</b></summary>

Não são preferências de estilo. São limites do servidor do Lorvath, medidos, e quebrá-los estraga
conta de verdade:

- **Nunca chamar `game_release`.** Ele trava a reconexão com "Player took control", e só destrava
  manualmente na interface do jogo. Soltar o controle se faz deixando o `controlEpoch` morrer, o que
  leva ~2 minutos.
- **`game_connect` e `game_charSelect` tomam controle do personagem** e podem disparar transferência
  de servidor. Nunca podem rodar para conta que alguém está jogando.
- **Todo despacho gera um `requestId` novo.** A deduplicação é persistente entre sessões: id fixo
  queima no primeiro uso e nunca mais despacha.
- Ações aceitam apenas `{data, requestId, controlEpoch}` — os schemas são
  `additionalProperties: false` e rejeitam campo solto.
- `game_account` lê personagens, servidores e escopos **sem tomar controle**. É a leitura barata.
- Servidores lobby são `webmu-1..8`. Personagem movido para `webmu-9+` fica fora do alcance.
- **Sucesso de chamada não é prova de controle.** Quando alguém entra na conta por fora, o servidor
  continua aceitando o `controlEpoch` antigo e não devolve erro: o que muda é a resposta da leitura
  de estado. Esperar erro seria esperar para sempre.
- **O servidor aceita os dois canais ao mesmo tempo.** Medido em 15/09/2026: com o personagem caçando
  na janela, uma macro inteira passou pelo MCP sem um único erro. A exclusividade entre jogar e
  gerenciar é escolha do painel — coexistir custa farm: a janela registrou ~1 minuto de ausência e a
  conexão seguinte levou 4× mais.

</details>

---

## Teste

> Os testes ficam na máquina de quem desenvolve, fora do repositório — como as specs. Os
> comandos abaixo valem para quem tem a pasta `test/`.

Dois, cobrindo coisas diferentes.

**A decisão pura**, sem abrir o app:

```bash
npm test
```

Isolamento de credenciais entre contas, regra automática, leitura do HUD, decisão de modo, taxas de
telemetria, sinal de presença tomada por fora, decisões da grade e teto por memória, a trilha e os
freios do Voltar sozinho, o alvo e o tamanho da janela solta, e quais sessões podem sair do disco.
Sem framework: são asserções.

**A interface**, contra o painel rodando:

```bash
npm run start:debug     # numa janela, deixa o painel aberto
npm run roteiro         # noutra
```

67 passos nomeados, cada um com o motivo da falha e uma captura quando quebra: a barra em oito
larguras de 1600 a 900px, a coluna recolhendo sem recarregar o jogo, a grade mostrando a frota
inteira, o diálogo recusando endereço inválido, o ciclo de vida de uma janela, o limite, o medidor, o
fechamento à força que não pode ser recusado, e a sequência repetida numa lista de
servidores falsa — com clique de verdade, porque o gravador recusa evento que não veio da sua mão, e
com a lista **deslocada** na segunda janela, que é o que pega repetição por posição — e o Voltar
sozinho, onde o que mais importa é o que ele **não** faz: desligado não clica, e numa tela que não é
a do caminho não clica.

Os passos de animação se **pulam com o motivo escrito** quando a janela não está desenhando: coberta
por outra e sem foco, o Chromium estrangula até ~1 quadro por 500 ms mesmo reportando `visible`, a
transição não avança, e falhar ali apontaria para o código errado.
Sai com código 1 se algum falhar.

Três regras de segurança estão no código do roteiro, não na cabeça de quem roda: nenhum passo fala
com o servidor do jogo, nenhum cria conta do Lorvath (só janela comum apontada para uma página de
carga local), e o grupo final falha se o roteiro tiver mexido em ajuste ou apagado conta que já
existia.

---

## Arquivos

| arquivo | papel |
|---|---|
| `main.js` | processo principal: janelas, IPC, proxy, loopback OAuth, poll, fila de macros |
| `lorvath-account.js` | uma conta = um cliente MCP + macros; `ehLorvath` separa jogo de janela comum |
| `oauth-store.js` | credencial por conta — é isso que torna o multi-conta possível |
| `modes.js` | modo efetivo, o que cada conta aceita agora, contagem de perdas de presença |
| `grade.js` | colunas da grade, se cabe mais uma janela, teto por memória livre, janela solta e sessões a apagar |
| `trilha.js` | onde começa a última tentativa do caminho gravado, e quando o Voltar sozinho tenta |
| `rules.js` | decisão da regra automática |
| `telemetry.js` | taxas por minuto a partir de duas leituras |
| `hud-parse.js` | leitura do HUD em texto |
| `proxy.js` | lê a lista colada, decide qual conta usa qual, e a regra que vai ao navegador |
| `ai-store.js` / `ai-chat.js` | chave do provedor e a conversa que vira ação |
| `game-probe.js` | preload da webview: lê o HUD → estatísticas ao vivo |
| `renderer/` | a interface inteira: `index.html` (estrutura e estilo) e `app.js` |
| `build/` | o ícone: `icon.svg` é a fonte, `icon.ico` e `icon.png` saem dele |
| `test/` | `selfcheck.js`, `roteiro.mjs` e as páginas falsas que ele usa — só na máquina, fora do repositório |
| `data/` | contas, tokens, proxies e o registro de ações — nada disso vai para o repositório |

`modes.js`, `grade.js`, `trilha.js`, `rules.js`, `telemetry.js`, `hud-parse.js` e `proxy.js` são módulos
puros: sem DOM, sem Electron, sem I/O, saída determinística. É onde as decisões moram, e é o que o
`selfcheck` cobre.

---

## Limitações conhecidas

- **Tudo foi verificado com uma conta de jogo.** Os números de 12 contas gerenciadas continuam
  extrapolação; os de 12 **janelas** foram medidos com carga sintética.
- **A sonda não lê o websocket do jogo — nunca leu.** O preload roda em mundo isolado e o Electron 33
  não deixa mais desligar isso por atributo da webview, então envolver `window.WebSocket` ali patcheia
  um `window` que a página não usa. Toda a telemetria da janela vem de **leitura do HUD em texto**, o
  que explica as joias nunca aparecerem no painel de farm.
- **Doze janelas pesadas não cabem num computador de 16 GB.** Em área de boss, com o servidor todo num
  ponto só, uma janela chega a ~1,5 GB: nessa condição a conta é de 4 ou 5 janelas.
- **O `selfcheck` nunca rodou em POSIX.** A única asserção dependente de plataforma é a permissão do
  arquivo de token, e ela está isolada por plataforma — mas isolada não é verificada.
- **O executável não é assinado.** O Windows vai avisar na primeira execução.
- **O executável e o `npm start` não abrem juntos.** Os dois usam a mesma pasta do Windows
  (`%APPDATA%\midle`), e o painel só aceita uma instância por pasta: o segundo a abrir só traz o
  primeiro para a frente. As contas de cada um continuam separadas.
- **O medidor envelhece com a janela escondida.** O Chromium estrangula temporizadores de página
  oculta; o painel mede de novo no instante em que a tela volta. Desligar isso faria a janela inteira
  continuar desenhando, os `<webview>` do jogo junto — o oposto do Repouso.

---

## Licença

Uso pessoal. Não afiliado ao Lorvath.
