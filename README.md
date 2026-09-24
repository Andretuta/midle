<div align="center">

<img src="build/icon.png" width="112" alt="MIDLE icon: three MU jewels on glass">

# MIDLE

**Multi + idle.** Many accounts of a browser idle game, each in its own isolated session,
all playable at once in a single grid.

Built for [Lorvath](https://lorvath.com), an idle MU Online, and open to any other web address.

`Windows` · `portable, no install` · `6 to 12 accounts` · `v0.2.0`

**English** · [Português](README.pt-BR.md)

</div>

<p align="center"><img src="assets/grade.png" alt="Two Lorvath accounts side by side in the MIDLE grid" width="900"></p>

---

## Download

Grab `MIDLE-0.2.0-portable.exe` from **[Releases](https://github.com/Andretuta/midle/releases)** and
run it — nothing gets installed. The executable is not signed, so Windows warns you the first time
(**More info → Run anyway**).

Or run it from source:

```bash
npm install
npm start
```

> The app's interface is in Portuguese. Below, each control is named as it appears on screen, with
> its meaning next to it.

## What's new in 0.2.0

| | |
|---|---|
| **New look** | Frosted glass over the glow of the three MU jewels — gold for open accounts, blue for closed ones, violet for the panel itself. New fonts (Manrope, Unbounded, JetBrains Mono), bundled with the app. |
| **Icon** | Three jewels on glass — on the executable, the taskbar and the panel's top bar. |
| **Pop-out windows** | Take an account out of the panel and size it and place it wherever you like, on any monitor; drag it onto the top bar to bring it back. |
| **Safer auto-return** | Replay and auto-return no longer click the same window at the same time, and the rules for when it retries are now covered by the automated check. |
| **Disk** | Deleting an account no longer leaves ~2 MB of session data behind: the panel cleans up on start. The first cleanup removed 200 folders, ~310 MB. |
| **Fewer freezes** | The game page's tracking pixels (Facebook, Google Analytics) are blocked before they leave — with many accounts they flooded the terminal and could freeze the app. |

---

## How to use

**+ Conta** (add account) creates a window. Pick Lorvath or any other address; each one starts with a
clean session, and you log in inside it just like in a browser.

**Fechar tudo** (close all) closes the whole fleet at once and cannot be refused: it doesn't wait for
an in-flight macro or a stuck mode switch, and it also takes login popups with it — windows that
belong to no account and so had no other way to be closed from the panel. The account doesn't
disappear; it becomes an empty slot.

**Grade** (grid) shows the whole fleet side by side — a live window where there is one, and a slot
with a button where the account is closed. **Telas** (screens) sets how many can be open at once.

**Repouso** (rest) swaps the window's rendering for a card with a clock. The character keeps farming
on the server, which is what an idle game does. Measured: **36.2 frames per second drop to zero and
CPU drops 89%** — but memory does **not** change (490 MB → 489 MB), because the page stays loaded.
To save memory, close the window.

**Quadros** (frames) caps rendering without hiding the window: the game stays visible, drawing 10
frames per second instead of 75. Measured: 75.0 → 9.4.

**Proxy** gives each account a fixed outbound address, so the server doesn't see the whole fleet
coming from the same IP. It accepts `host:port:user:password` or `scheme://user:password@host:port`.
One warning: Chromium **does not authenticate SOCKS proxies with a password** — only HTTP.

**Repetir** (replay) handles getting back into the game after it updates, when the whole fleet lands
on the same screen. Getting back isn't one click: it's picking the server, picking the character and
entering. So the panel records the **trail** — everything you clicked since the last replay — and
redoes the whole path in the other windows, waiting for each screen to appear before the next step.
The trail is cleared once replayed, so the next one doesn't drag the previous one along.

No selectors hard-coded: whatever the game draws today changes with its next update, so you are the
one who teaches the path. It only replays what **you** actually clicked — the replay itself never
becomes the next recording.

Three decisions that took measurements in the real game, on 2026-09-18:

- The trail lives in the page's own `sessionStorage`. **Clicking a server navigates**, and the
  navigation used to take the just-made click with it — exactly the one you want to replay.
- Only the **last attempt** counts. The trail accumulates since the last replay, so if you took a
  wrong path, reloaded and redid it, the wrong steps came along: a 3-step path became 12 — four
  attempts stitched together — and the panel would have entered the game four times. A pause longer
  than 3 minutes starts a new trail.
- Each step looks for the **name** before the position. Position is not identity: one extra row in
  one of the windows and the 5th button is a different server, and the mistake would be silent. When
  the name changes per account, as with the character, then position is used.

Verified on both accounts: server, character and enter in one window, one replay, and the other one
entered the game by itself. **The server, however, is the game's decision**: a character lives on a
server, and picking another one in the lobby doesn't move it — measured by clicking by hand, it's not
the panel.

**Voltar sozinho** (auto-return) is replay without you. The path you replayed last is saved, and with
the switch on, the panel redoes that path in any window that shows **its first screen** — that's how
it tells "the game restarted and dropped to server selection" from "it's playing". It starts off.

Three safeguards, because this clicks on its own in a real account: it only acts with the switch on
and a path you saved; it only acts on a window that is showing the first step; and it gives up after
three attempts in a row without finishing, and tells you — clicking forever on a screen that doesn't
respond is worse than stopping.

It checks every 10 seconds, but **the timer is throttled while the window is in the background**:
measured, it fired after 38 s. For what it does — getting back into the game after a restart — that's
enough, and the price of turning throttling off would be the whole fleet rendering.

**Soltar** (pop out — ⧉ on the cell, or right-click on the account row) takes the account out of the
panel and turns it into a window of its own: you choose the size and the position, even on another
monitor, and the panel remembers both next time. To bring it back, drag the window onto the **panel's
top bar** — it lights up when you're on target — or close it with the X. The target is the bar, not
the whole panel, because with the panel maximized every drag would land on it. Leaving and coming
back reloads the page (it's a different window, same session): the login stays and the game
reconnects. Replay, auto-return and frame cap only apply to windows inside the panel.

**Excluir** (delete) also lives in the account row's right-click menu, next to open, close and
reload. It used to exist only in the right-hand panel, which forced you to select the account —
that is, open its window — just to delete it.

Shortcuts: `Ctrl+1..9` selects an account, `Ctrl+B` collapses the column, `Ctrl+G` toggles the grid,
`Ctrl+E` rest, `Ctrl+F` focus, `Ctrl+R` reloads all, `Ctrl+D` replays the trail in the others.

---

## Look

Color always means something: **gold** is an open account, with you playing; **blue** is a closed
account; **violet** is the panel itself — the brand and the keyboard focus. The background is the
castle at night with the glow of the three jewels, and the top bar, the column and the footer are
frosted glass over it.

Blur is applied **only to the chrome**, which has the still glow behind it. Game windows get no blur:
with twelve of them, that would be GPU spent across the whole fleet. If you turn on *reduced
transparency* in Windows, you get the same design, solid.

---

## Memory

Each window is its own Chromium. The cost has two parts, and for a while the panel only reported one
of them: **what the page holds, plus ~85 MB of browser**, on top of a ~430 MB base for the panel.
The estimate it uses today is `430 + n × (content + 85)` MB, and it matches what was measured on
2026-09-16:

| windows | content per window | measured |
|---|---|---|
| 6 | 400 MB | 3,341 MB |
| 12 | 400 MB | 6,071 MB |
| 6 | 1,500 MB | 9,520 MB committed — 3 GB already paged to disk |

The panel shows this cost in the top bar and **refuses to open a window when free memory can't hold
it**, before the limit you chose: the limit is a preference, memory is physical. The estimate uses
what the windows are costing right now, not an average — that's what makes the refusal right in boss
areas, where a single window goes past 1 GB. Measured: with 1 GB windows the guard stops at the
fourth; with a fixed 400 MB average it would let you reach the ninth.

This number exists because the version without it **froze the machine**: twelve 1.5 GB windows ask
for 18 GB of commit on a 16 GB computer, and Windows locks up before any protection in the panel gets
to run.

### Disk

Every deleted account used to leave its session folder behind — Chromium holds the files while the
panel is running, so deleting them right away isn't possible. Now the deletion is noted and the panel
removes the folder **on the next start**. Measured on 2026-09-23: 202 folders for 2 accounts, ~310 MB
of leftovers.

It only removes what **it** deleted, never "every session I don't recognize": the executable and
`npm start` keep their accounts in different places but share the same session folder — and each one
would wipe the other's logins.

---

## Panel-driven management — turned off

The panel can talk to the game through its own channel (MCP, with OAuth per account): read telemetry
with no window open, restart farming on its own when XP per minute drops, step aside when someone
logs into the account from elsewhere. **That is turned off.**

Nothing was deleted — the code, the rules and the checks are all still in the repository. The switch
is the `GERENCIAMENTO` constant, in `main.js` and in `renderer/app.js`; both must agree. With it set
to `false`, the panel never talks to the game server, and each account has only two states: open or
closed.

<details>
<summary><b>Game limits, if you turn it back on</b></summary>

These aren't style preferences. They are limits of the Lorvath server, measured, and breaking them
damages real accounts:

- **Never call `game_release`.** It locks reconnection with "Player took control", and only unlocks
  manually in the game's interface. Releasing control is done by letting the `controlEpoch` expire,
  which takes ~2 minutes.
- **`game_connect` and `game_charSelect` take control of the character** and can trigger a server
  transfer. They must never run for an account someone is playing.
- **Every dispatch generates a new `requestId`.** Deduplication persists across sessions: a fixed id
  is burned on first use and never dispatches again.
- Actions accept only `{data, requestId, controlEpoch}` — the schemas are
  `additionalProperties: false` and reject any extra field.
- `game_account` reads characters, servers and scopes **without taking control**. It's the cheap
  read.
- Lobby servers are `webmu-1..8`. A character moved to `webmu-9+` is out of reach.
- **A successful call is not proof of control.** When someone logs into the account from elsewhere,
  the server keeps accepting the old `controlEpoch` and returns no error: what changes is the answer
  to the state read. Waiting for an error would be waiting forever.
- **The server accepts both channels at the same time.** Measured on 2026-09-15: with the character
  hunting in the window, an entire macro went through MCP without a single error. Exclusivity between
  playing and managing is the panel's choice — coexisting costs farming: the window registered ~1
  minute of absence and the next connection took 4× longer.

</details>

---

## Tests

> Tests live on the developer's machine, outside the repository — like the specs. The commands below
> apply to whoever has the `test/` folder.

Two of them, covering different things.

**The pure decisions**, without opening the app:

```bash
npm test
```

Credential isolation between accounts, the automatic rule, HUD parsing, mode resolution, telemetry
rates, the signal of presence taken from elsewhere, grid decisions and the memory cap, the trail and
the auto-return safeguards, the pop-out drop target and size, and which sessions may leave the disk.
No framework: plain assertions.

**The interface**, against the running panel:

```bash
npm run start:debug     # in one terminal, leave the panel open
npm run roteiro         # in another
```

67 named steps, each with the failure reason and a screenshot when it breaks: the top bar at eight
widths from 1600 to 900px, the column collapsing without reloading the game, the grid showing the
whole fleet, the dialog rejecting an invalid address, a window's lifecycle, the limit, the meter, the
forced close that cannot be refused, and the path replayed on a fake server list — with real clicks,
because the recorder rejects events that didn't come from your hand, and with the list **shifted** in
the second window, which is what catches replay-by-position — and auto-return, where what matters most
is what it does **not** do: switched off it doesn't click, and on a screen that isn't the path's it
doesn't click.

Animation steps are **skipped with the reason written down** when the window isn't rendering: covered
by another window and unfocused, Chromium throttles to ~1 frame per 500 ms even while reporting
`visible`, the transition doesn't advance, and failing there would point at the wrong code. Exits with
code 1 if any step fails.

Three safety rules live in the script's code, not in the head of whoever runs it: no step talks to the
game server, no step creates a Lorvath account (only a plain window pointed at a local load page), and
the final group fails if the script changed a setting or deleted an account that already existed.

---

## Files

| file | role |
|---|---|
| `main.js` | main process: windows, IPC, proxy, OAuth loopback, polling, macro queue |
| `lorvath-account.js` | one account = one MCP client + macros; `ehLorvath` tells the game apart from a plain window |
| `oauth-store.js` | per-account credentials — this is what makes multi-account possible |
| `modes.js` | effective mode, what each account accepts right now, presence-loss counting |
| `grade.js` | grid columns, whether one more window fits, memory cap, pop-out windows and sessions to delete |
| `trilha.js` | where the last attempt of the recorded path starts, and when auto-return retries |
| `rules.js` | the automatic rule's decision |
| `telemetry.js` | per-minute rates from two readings |
| `hud-parse.js` | parsing the HUD text |
| `proxy.js` | reads the pasted list, decides which account uses which, and the rule handed to the browser |
| `ai-store.js` / `ai-chat.js` | provider key and the conversation that turns into actions |
| `game-probe.js` | webview preload: reads the HUD → live stats |
| `renderer/` | the whole interface: `index.html` (structure and style) and `app.js` |
| `build/` | the icon: `icon.svg` is the source, `icon.ico` and `icon.png` are generated from it |
| `test/` | `selfcheck.js`, `roteiro.mjs` and the fake pages it uses — local only, outside the repository |
| `data/` | accounts, tokens, proxies and the action log — none of it goes into the repository |

`modes.js`, `grade.js`, `trilha.js`, `rules.js`, `telemetry.js`, `hud-parse.js` and `proxy.js` are
pure modules: no DOM, no Electron, no I/O, deterministic output. That's where the decisions live, and
that's what `selfcheck` covers.

---

## Known limitations

- **Everything was verified with a single game account.** The figures for 12 managed accounts are
  still an extrapolation; those for 12 **windows** were measured with synthetic load.
- **The probe does not read the game's websocket — it never did.** The preload runs in an isolated
  world, and Electron 33 no longer lets you turn that off through a webview attribute, so wrapping
  `window.WebSocket` there patches a `window` the page doesn't use. All window telemetry comes from
  **reading the HUD text**, which is why jewels never show up in the farm panel.
- **Twelve heavy windows don't fit in a 16 GB computer.** In boss areas, with the whole server in one
  spot, a single window reaches ~1.5 GB: under those conditions the budget is 4 or 5 windows.
- **`selfcheck` has never run on POSIX.** The only platform-dependent assertion is the token file's
  permission, and it's isolated per platform — but isolated isn't verified.
- **The executable is not signed.** Windows will warn you on first run.
- **The executable and `npm start` can't be open together.** Both use the same Windows folder
  (`%APPDATA%\midle`), and the panel only allows one instance per folder: the second one to open just
  brings the first to the front. Each one's accounts stay separate.
- **The meter goes stale while the window is hidden.** Chromium throttles timers on hidden pages; the
  panel measures again the moment the screen comes back. Turning that off would keep the whole window
  rendering, the game `<webview>`s included — the opposite of rest mode.

---

## License

Personal use. Not affiliated with Lorvath.
