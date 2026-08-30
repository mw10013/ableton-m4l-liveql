# Node for Max: Runtime, Module Resolution, and Distribution

Date: 2026-08-30

Answers four questions that kept tangling together:

1. What Node runs our GraphQL server, and where does that Node come from?
2. Why does `graphql-yoga` come from *our* `node_modules` when `max-api` does not — why are there two separate library paths?
3. `liveql-n4m.js` is referenced by the `.amxd`. So how can Node possibly be reaching into our project's `node_modules`?
4. How do we distribute this without shipping `node_modules`?

Everything below was verified against the Max for Live install on this machine. Commands are in
[Appendix: how this was verified](#appendix-how-this-was-verified) so any claim can be re-checked.

Shorthand used throughout:

```
$N4M = /Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/
       Contents/Resources/C74/packages/Node for Max
```

---

## 1. Short answers

| Question | Answer |
| --- | --- |
| Which Node? | `$N4M/source/bin/osx/node/node`, a **Node binary bundled inside Ableton Live**. v20.6.1 in Live 12 Suite, v22.18.0 in the Live 12 Beta. Nothing to do with the Node on your `PATH` (v26.7.0 here). |
| Is `liveql-n4m.js` embedded in the `.amxd`? | **No.** The device stores `"embed" : 0`. It is an external file on disk, found by name. |
| Where is it found? | Next to the `.amxd`. Both live in the repo root, and Max searches the patcher's own folder. |
| Why does it see our `node_modules`? | Because `node.script` sets the child process `cwd` to *the script file's directory* — the repo root. Node's ordinary `node_modules` walk starts there. |
| Why isn't `graphql-yoga` in Node for Max? | Node for Max is a **process launcher and message bridge**, not a runtime library bundle. It injects exactly one module, `max-api`. Everything else is your normal npm project. |
| Whose GraphQL server is it? | **Ours.** `liveql-n4m.js:416-417` — `http.createServer(yoga)` / `server.listen(4000)`, our code, in this repo. Ableton ships no server; it ships the Node that runs ours. |
| Does pnpm break any of this? | No. Verified working. Two caveats in [§7](#7-pnpm-specific-notes). |
| Distribution? | Freeze the device from inside a **Max Project** with an **Embedded** search path entry. Node for Max explicitly supports bundling `node_modules` into a frozen `.amxd`. See [§8](#8-distribution). |

---

## 2. The processes, and where the memory boundaries actually are

The single most useful correction to the mental model: **there are three separate OS processes**, not one
program with plugins. Each has its own address space, its own heap, its own module cache. They only touch
through IPC.

Each process is named below for **what launches it** — that is the one label that stays stable. Ownership
of the *code inside* a process is marked separately, because it is never uniform: every process here runs a
mix of Ableton's code and ours. Confusing "whose process is this" with "whose code is running in it" is the
single easiest way to get lost in this architecture.

```
  OWNERSHIP KEY
  [C74] shipped by Ableton / Cycling '74 — we cannot change it, it moves when Live moves
  [US]  written by us, lives in this repo

┌──────────────────────────────────────────────────────────────────────────────────┐
│ PROCESS 1  —  ABLETON LIVE                                                        │
│ binary: /Applications/Ableton Live 12 Suite.app                                   │
│                                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ [C74] Max for Live engine (Max.app, loaded in-process, C++ heap)            │  │
│  │                                                                             │  │
│  │   [US] liveql.amxd  ── our device patcher                                   │  │
│  │     ├── [US] liveql-m4l.js, running in [C74] the v8 object                  │  │
│  │     │         Our code, executed by Max's own embedded JS engine.           │  │
│  │     │         This is what actually touches the LOM, via LiveAPI.           │  │
│  │     │         No npm, no require() of node_modules, ever.                   │  │
│  │     │                                                                       │  │
│  │     └── [C74] the node.script object                                        │  │
│  │              │  Holds NO JavaScript. It is a remote control for a           │  │
│  │              │  process that lives outside Live entirely.                   │  │
│  └──────────────┼─────────────────────────────────────────────────────────────┘  │
└─────────────────┼────────────────────────────────────────────────────────────────┘
                  │  Unix domain socket + IPC
                  │  (stdio socket, stderr socket, control socket in $TMPDIR)
                  ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PROCESS 2  —  NODE FOR MAX PROCESS MANAGER   (process title: "N4M PM")            │
│ 100% [C74]. None of our code runs here. We never touch this process.              │
│                                                                                   │
│ execPath : $N4M/source/bin/osx/node/node        ← Ableton's Node v20.6.1          │
│ entry    : $N4M/source/index.js                                                   │
│                                                                                   │
│   A supervisor: starts/stops/restarts scripts, pipes stdio, runs the file         │
│   watcher. Owns chokidar / commander / debug / colors / lodash.set in ITS OWN     │
│   node_modules ($N4M/source/node_modules) — invisible to us (MODULE_NOT_FOUND).   │
│                                                                                   │
│   child_process.fork(RUNNER_PATH, { cwd, env, execPath })   [nsProcess.js:657]    │
└─────────────────┬────────────────────────────────────────────────────────────────┘
                  │  fork + IPC channel
                  ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PROCESS 3  —  node.script CHILD PROCESS                                           │
│ THE MIXED ONE. Ableton's runtime, Ableton's bootstrap, our application on top.    │
│                                                                                   │
│   [C74] Node binary  $N4M/source/bin/osx/node/node   ← v20.6.1, ships with Live   │
│     │                                                                             │
│     ▼                                                                             │
│   [C74] bootstrap    $N4M/source/lib/nsRunner.js                                  │
│          cwd       = <repo>                    ← derived from OUR script's path   │
│          NODE_PATH = $N4M/…/lib/exposed        ← the one module N4M injects       │
│          execArgv  = --import $N4M/…/loader/register.mjs                          │
│     │                                                                             │
│     │    require(process.env.SCRIPT_PATH)                    [nsRunner.js:382]    │
│     ▼                                                                             │
│   [US]  liveql-n4m.js   ←── THE GRAPHQL SERVER IS THIS. IT IS OURS.               │
│          http.createServer(yoga)                                                  │
│          server.listen(4000)                            [liveql-n4m.js:416-417]   │
│          our typeDefs, our resolvers, our graphql-yoga from <repo>/node_modules   │
│                                                                                   │
│   From that require() on, this is an ordinary Node program that happens to be     │
│   running on Ableton's Node, in our repo directory.                               │
│                                                                                   │
│   Heap: the V8 heap of THIS process. Live cannot see into it, and vice versa.     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Read the ownership column top to bottom and the split is clean: **Ableton supplies every runtime and every
transport; we supply both endpoints.** `liveql-m4l.js` at one end, `liveql-n4m.js` at the other, and
Cycling '74's plumbing in between. Neither endpoint is Ableton's, and none of the plumbing is ours.

The GraphQL server on `localhost:4000` lives entirely in **Process 3** and is entirely our code — Ableton
ships no server here, only the Node that runs ours. When a resolver needs the LOM it cannot call Live
directly (different address space); it sends a message back up the chain to `liveql-m4l.js` in Process 1,
which does the LiveAPI work and sends the answer back. That round trip is what `exec()` /
`actionResultHandlers` in `liveql-n4m.js` implements.

---

## 3. "But the script is in the device" — no, it isn't

This was the crux of the confusion, and the device file settles it. Decoding the JSON out of `liveql.amxd`:

```json
{
  "filename" : "liveql-n4m.js",
  "embed" : 0,
  ...
}
{
  "filename" : "liveql-m4l.js",
  "embed" : 0,
  "varname" : "v8_AA"
}
```

`"embed" : 0` on **both** scripts. The `.amxd` contains only the *name* of each file, not its bytes. Same
for the object box text, which is stored literally as:

```
node.script liveql-n4m.js @autostart 0 @watch 1
```

That is a filename, resolved at load time. If you delete `liveql-n4m.js` from disk, the device still opens
and still shows that object box — it just fails to start with a "file not found" error.

The `.amxd` also carries a `dependency_cache`, which is a *hint about where Max last saw each file*, not a
binding link:

```json
[
  { "name": "liveql-m4l.js",  "bootpath": "~/Documents/src/ableton-live-liveql", "type": "TEXT" },
  { "name": "liveql-n4m.js",  "bootpath": "~/Documents/src/ableton-live-liveql", "type": "TEXT" },
  { "name": "n4m.monitor.maxpat", "bootpath": "C74:/packages/Node for Max/patchers/debug-monitor", ... }
]
```

Note the bootpath says `ableton-live-liveql`. The repo is now `ableton-m4l-liveql`, and an even older path
(`~/Documents/src/liveql`) is still sitting in Max's recent-files list. **The device has been moved twice and
still works**, which is the proof that the cached bootpath is not how the file gets found.

### How Max actually finds it

Two mechanisms, and only the first one applies here:

1. **The patcher's own folder is searched first.** `liveql.amxd`, `liveql-m4l.js`, and `liveql-n4m.js` all sit
   in the repo root, side by side. This is why it resolves.
2. Max's global search path. Checked `maxpreferences.maxpref` — **the project directory is not in it.**

So the binding is *positional*: the device finds its script because they are neighbours in the same folder.

---

## 4. From "script file" to "our node_modules"

This is the mechanical answer to *why is it grabbing our stuff*. Two lines of Cycling '74 code do it.

`$N4M/source/lib/nsProcess.js:94` — the working directory is derived from the resolved script path:

```js
this._cwd = path.dirname(options.path);
```

`options.path` is the absolute path Max resolved in §3, i.e. `<repo>/liveql-n4m.js`. So `cwd` becomes the
repo root. Then at `nsProcess.js:657` the child is forked with that `cwd`, and at `nsRunner.js:382` our file
is loaded by absolute path.

Node's resolution algorithm for a bare specifier like `require("graphql-yoga")` walks up from the
**directory of the requiring file**:

```
require("graphql-yoga")  from  /Users/mw/Documents/src/ableton-m4l-liveql/liveql-n4m.js
   │
   ├─ look in  /Users/mw/Documents/src/ableton-m4l-liveql/node_modules/   ✓ FOUND
   ├─ else     /Users/mw/Documents/src/node_modules/
   ├─ else     /Users/mw/Documents/node_modules/
   ├─ else     /Users/mw/node_modules/
   ├─ else     /Users/node_modules/
   ├─ else     /node_modules/
   └─ else     $NODE_PATH  (the global fallback)
```

There is nothing exotic here. The script is a file in our repo, so Node finds our repo's `node_modules`.
The `.amxd` is not involved in this step at all — by the time Node runs, Max's job is already finished.

---

## 5. Why two library paths: `max-api` vs `graphql-yoga`

They come from opposite ends of that resolution list, which is exactly why they feel like "two separate
code paths" — because they *are*.

```
   MODULE RESOLUTION IN PROCESS 3 (the node.script child), AS SEEN BY liveql-n4m.js
             ═════════════════════════════════════════

  require("max-api")                          require("graphql-yoga")
        │                                             │
        │ not in <repo>/node_modules                  │ found immediately in
        │ …walks all the way up, finds nothing…       │ <repo>/node_modules
        │                                             │
        ▼ falls through to NODE_PATH                  ▼
  ┌───────────────────────────────────┐        ┌────────────────────────────────────┐
  │ NODE_PATH =                       │        │ <repo>/node_modules/graphql-yoga    │
  │   $N4M/source/lib/exposed         │        │   → symlink →                       │
  │                                   │        │ <repo>/node_modules/.pnpm/          │
  │   max-api.js  ← THE ONLY MODULE   │        │   graphql-yoga@5.18.1_graphql@…/    │
  │                 N4M EXPOSES       │        │                                     │
  │                                   │        │ 414 files load at runtime           │
  │ (an ESM loader hook at            │        │ (graphql, @graphql-tools/*,         │
  │  lib/loader/nsLoader.mjs also     │        │  @whatwg-node/*, @envelop/*, …)     │
  │  intercepts the specifier)        │        │                                     │
  └───────────────────────────────────┘        └────────────────────────────────────┘
        OWNED BY ABLETON / CYCLING '74               OWNED BY US
        ships & versions with Live                   pinned in our package.json
        we cannot change it                          we control it entirely

  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ $N4M/source/node_modules/  —  chokidar, commander, debug, colors, lodash.set │
  │                                                                              │
  │   WALLED OFF. These belong to Process 2 (the N4M manager), not Process 3.    │
  │   NODE_PATH points at lib/exposed only, NOT at this folder.                  │
  │   Verified: require("chokidar") from our script ⇒ MODULE_NOT_FOUND.          │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### So why doesn't Node for Max just ship graphql-yoga?

Because that would be a category error about what the product is. Node for Max's own README describes it as:

> "Node for Max makes it possible to launch, manage and communicate with Node processes from Max."

It is a **process manager plus a message bridge**. Its entire public surface is the `max-api` module:
`post`, `outlet`, `addHandler`, `getDict`, and friends — the things that only make sense *because* you are
inside Max. It deliberately has no opinion about what your script does.

The alternative — a curated library bundle — would mean Cycling '74 choosing and versioning every npm
package anyone might want, and you being stuck with whatever GraphQL version shipped with your Live
release. Instead they hand you a stock Node runtime and get out of the way, which is why they also bundle
`npm` (v9.8.1) and document `script npm install <pkg>` as a first-class workflow.

The one-line version: **`max-api` is the bridge to Max and only Node for Max can provide it; `graphql-yoga`
is application code and only we can provide it.**

---

## 6. Node versions, and what to do about `engines`

### The facts

| Where | Node | Source |
| --- | --- | --- |
| Live 12 Suite (what we run against) | **v20.6.1** | `$N4M/source/bin/osx/node/node --version`, and `$N4M/README.md` states "Node v20.6.1 / NPM v9.8.1" |
| Live 12 Beta | **v22.18.0** | same binary path inside the Beta app bundle |
| This dev machine's `PATH` | v26.7.0 | `node --version` |

The bundled binary is a universal Mach-O (x86_64 + arm64, 191 MB). The version is Ableton's choice and moves
only when Live moves.

### The problem we had

`package.json` declared `"engines": { "node": ">=24.16.0" }`. Nothing in the runtime is anywhere near that,
and nothing in the dependency tree asks for it either — `graphql-yoga` wants `>=18`, `graphql` wants `>=17`,
`@effect/platform-node` wants `>=18`, `typescript` wants `>=16.20`. The number described the Node that
happened to be on this laptop, and it described it in the one field whose job is to describe **the runtime
the shipped code needs**. Read literally it claimed the device requires Node 24 — which would mean the
device cannot run in Live at all.

### What was actually true

Two different runtimes, two different floors, and the mistake was collapsing them into one number:

- **The device** runs on N4M's Node. Floor: **20.6.0**.
- **`scripts/refs.ts`** is executed directly by Node (`node scripts/refs.ts`) and therefore needs native
  TypeScript type stripping. Measured, not guessed:
  - Node 20.6.1 → `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`
  - Node 22.18.0 → runs correctly
  So the real floor is **22.18.0**, not 24.16.0.

### What was changed

Root `package.json` — now describes the runtime, with the reasoning inline:

```json
"//engines": "liveql-n4m.js runs under Node for Max's bundled Node (v20.6.1 in Live 12 Suite,
              v22.18.0 in the Live 12 Beta), not the Node on your PATH. This floor describes
              that runtime. The refs tooling needs a newer Node -- see scripts/package.json.",
"engines": { "node": ">=20.6.0" },
```

`scripts/package.json` — the dev-tooling floor, recorded where the tooling lives. `scripts/` already had its
own `package.json` (it marks the directory ESM), so this is the natural home:

```json
"//engines": "refs.ts is run directly by Node, so it needs native TypeScript type stripping.
              Verified: Node 22.18.0 runs it, Node 20.6.1 fails with ERR_UNKNOWN_FILE_EXTENSION.
              This is a dev-tooling floor only -- it does not apply to the device runtime,
              see the root package.json.",
"engines": { "node": ">=22.18.0" },
```

Why split rather than just raise the root to 22.18: `engines` on the root package is what a package manager
checks against *your* Node at install time (and what pnpm hard-fails on if `engine-strict` is ever enabled).
Putting 22.18 there would assert the device needs 22.18, which is false for Live 12 Suite and would be an
actively misleading thing to hand to anyone packaging this later. `scripts/` is not a workspace member, so
its `engines` is documentary — but it is documentary *in the right place*, next to the code it constrains.

---

## 7. pnpm-specific notes

Using pnpm is fine. Confirmed by running the bundled Node 20.6.1 against the real tree:

```
yoga ok: function
graphql 16.13.1
max-api ok: function
node v20.6.1
```

pnpm's symlink farm works because Node resolves realpaths by default: `node_modules/graphql-yoga` is a
symlink into `node_modules/.pnpm/graphql-yoga@5.18.1_graphql@16.13.1/`, and once resolved there, its peers
resolve alongside it. This would only break under `--preserve-symlinks`, and N4M does not pass it (`execArgv`
is just `--import <loader>`).

Two things to watch:

### 7a. Never use Max's `script npm install`

`node.script` accepts an `npm install` message and the Max console *offers it* when a require fails
(`lib/nsNPMCommand.js`). It would run the bundled npm 9.8.1 in the repo root and lay a flat `node_modules`
over pnpm's symlink tree — a hybrid that is very hard to reason about afterwards. Always install from the
terminal with `pnpm`.

### 7b. `@watch 1` polls every required file

The device is currently `node.script liveql-n4m.js @autostart 0 @watch 1`. The watch feature is not just
watching our one file. `nsRunner.js` monkey-patches `Module._load` and reports **every module our script
requires** back to the manager, which adds each one to the watcher (`nsProcess.js:291`,
`_addFileToWatcher`). And that watcher is created with:

```js
chokidar.watch(this._script, { usePolling: true, cwd: this._cwd, ignoreInitial: true })
```

`usePolling: true`. Measured module count for our script: **424 modules loaded, 414 of them under
`.pnpm`**. So `@watch 1` means ~414 files being stat-polled continuously, inside a real-time audio host.

This is not a pnpm problem — npm would produce the same count in a different layout — but it is worth
knowing. `@watch 1` is a development convenience (edit the script, process restarts). For a device you are
about to hand to someone, ship it as `@watch 0`.

---

## 8. Distribution

No, we do not ship `node_modules` as a loose folder next to the device — and we do not have to. Node for Max
supports bundling dependencies **into** the frozen device. From `$N4M/docs/vignettes/03_n4m_projects_devices.maxvig.xml`:

> "Node for Max supports bundling dependencies (aka the node_modules folder) within Collectives, Standalone
> Applications and Max For Live Devices."

The catch is that it only works through a **Max Project** — freezing a loose `.amxd` will not find, let
alone bundle, a Node dependency tree. Max's freeze analysis understands Max file types via the search path;
it does not traverse a CommonJS require graph.

### The required structure

```
LiveQL/                          ← a Max Project
├── patchers/
│   └── liveql.amxd
└── node_content/                ← added to the PROJECT's search path,
    │                              with the "Embedded" option ENABLED
    ├── liveql-n4m.js
    ├── package.json
    └── node_modules/            ← gets bundled into the frozen .amxd
```

Steps, per the vignette:

1. Create a Max Project. In the Project Inspector, **disable "Keep Project Folder Organized"** — otherwise
   Max relocates `.js` files into a `code/` folder and JSON into `data/`, which breaks Node's layout
   assumptions.
2. Create `node_content/` alongside `patchers/`.
3. Project Window → gear icon → Search Paths → add `node_content` → **enable "Embedded"**. This flag is the
   whole trick; without it nothing gets bundled.
4. Freeze the device (Freeze button, then File → Save).

The vignette also warns against generic script names like `index.js`, because Max's search path is flat and
a collision anywhere in the path produces a console warning. `liveql-n4m.js` is already specific enough.

### Which install to bundle

Two adjustments to what is currently in the repo.

**Production only.** Current tree is 116 MB / 8,039 files, but that includes `typescript`, `effect`,
`@types/node` and the rest of the refs tooling. Production closure:

```
pnpm install --prod   →   10 MB, 1,887 files, 13 top-level entries
```

**Flat, not symlinked.** For a bundle, prefer a real directory tree over pnpm's symlink farm — symlinks
into `.pnpm` are a poor bet for surviving being embedded into an `.amxd` and unpacked on someone else's
machine. pnpm can produce a flat tree directly, no need to switch to npm:

```bash
pnpm install --prod --config.node-linker=hoisted
```

Verified output: **0 symlinks**, 10 MB, same 1,887 files. That is what goes in `node_content/`.

### Version caveat for whoever we ship to

The bundled dependencies run on *their* Live's Node, not ours: 20.6.1 on Live 12 Suite, 22.18.0 on the
Beta, and whatever a future Live ships. Our production deps are comfortable there (`graphql-yoga` >=18,
`graphql` >=17), but anything added later needs checking against **20.6.1**, not against the Node on the
dev machine. That is exactly what the root `engines` field now records.

---

## Appendix: how this was verified

```bash
N4M="/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/Contents/Resources/C74/packages/Node for Max"

# Bundled Node version (and the Beta's)
"$N4M/source/bin/osx/node/node" --version                       # v20.6.1
tail -3 "$N4M/README.md"                                        # Node v20.6.1 / NPM v9.8.1

# Our deps resolve under the bundled Node, from the repo root
NODE_PATH="$N4M/source/lib/exposed" "$N4M/source/bin/osx/node/node" \
  -e 'require("graphql-yoga"); require("max-api"); console.log(process.version)'

# N4M's own deps are NOT reachable from our script
NODE_PATH="$N4M/source/lib/exposed" "$N4M/source/bin/osx/node/node" \
  -e 'try{require("chokidar")}catch(e){console.log(e.code)}'    # MODULE_NOT_FOUND

# How many files @watch 1 ends up polling
NODE_PATH="$N4M/source/lib/exposed" "$N4M/source/bin/osx/node/node" \
  -e 'require("graphql-yoga");require("max-api");console.log(Object.keys(require.cache).length)'   # 424

# The engines floor, measured rather than assumed
"$N4M/source/bin/osx/node/node" scripts/refs.ts list            # ERR_UNKNOWN_FILE_EXTENSION
"<Live 12 Beta>/…/node" scripts/refs.ts list                    # works (v22.18.0)

# Device internals: embed flags and dependency cache
python3 -c "…"  # decode the ptch JSON chunk out of liveql.amxd
```

Source lines referenced:

| Claim | Location |
| --- | --- |
| `cwd` = script's directory | `$N4M/source/lib/nsProcess.js:94` |
| fork with bundled `execPath` | `$N4M/source/lib/nsProcess.js:657-676` |
| `NODE_PATH` = `lib/exposed` | `$N4M/source/lib/nsProcess.js:648` |
| our script loaded by absolute path | `$N4M/source/lib/nsRunner.js:360, 382` |
| every `require` added to the watcher | `$N4M/source/lib/nsRunner.js:55-68`, `nsProcess.js:291, 400` |
| watcher uses `usePolling: true` | `$N4M/source/lib/nsProcess.js:248-255` |
| `max-api` specifier interception | `$N4M/source/lib/loader/nsLoader.mjs:9` |
| bundling into frozen devices | `$N4M/docs/vignettes/03_n4m_projects_devices.maxvig.xml` |
