# AGENTS.md

- Prefer JSDoc for comments for complex and subtle behavior the code cannot show. A JSDoc must carry its reasoning inline and must cite neither `docs/` nor `refs/` — research docs go stale and get deleted, and refs are gitignored and refetched at another version. The code is the truth, the JSDoc next; a stable external URL is the only acceptable citation.
- Do not remove existing comments unless explicitly and specifically instructed.
- Do not git commit unless you are explicitly instructed.
- Your answers and explanations should be concise and scannable so the user can scan quickly and easily understand. Sacrifice grammar for the sake of concision.
- Ground your answers and explanations with excerpts from documentation and code.

## Project

- `LiveQL` is a GraphQL API for Ableton Live: a Max for Live device exposing a subset of the Live Object Model (LOM) over `http://localhost:5100/graphql`.
- LiveQL's whole job, for now, is to mirror the LOM as faithfully as possible: a bare, raw view of what Live exposes, with nothing built on top. Every mutation is exactly one LOM operation, a `set` or a `call`, followed by the readback the selection set needs. No mutation reads before it writes, reorders writes, validates against Live state, or chains several LOM calls. Orchestration belongs to the client, which can send several mutations as aliased fields of one document and rely on them running serially in order. Composite or convenience operations may come later; do not add one now.
- `liveql.amxd` — the Max for Live device. Hosts the `v8` object running the Max JS script and the `node.script` object running the Node for Max server.
- `liveql-m4l.js` — Max JS (`v8` object). Talks to the LOM through `LiveAPI`, receives actions on its inlet, returns results on its outlet.
- `liveql-n4m.js` — Node for Max script. Serves the GraphQL schema and resolvers with graphql-yoga; resolvers dispatch actions to the Max layer over `max-api` and await the matching result by `actionId`.
- `test/` — `node:test` suite. `test/helpers/` fakes the Max layer; `test/live/` is opt-in and needs Live.
- `docs/` — research notes. Reference material for humans, not load-bearing: do not cite from code.
- `dist/` — throwaway build output from `pnpm build:dist`. Never edit; rebuild it.

## Runtime

- `liveql-n4m.js` runs under **Node for Max's bundled Node**, not the Node on your PATH. That binary is **v22.18.0** — ask it, not the Node for Max README, which still claims v20.6.1 and is stale. It is CommonJS: `require`, no ESM, no bundler, no TypeScript.
- `liveql-m4l.js` runs under Max's **`v8` object**, not Node. No `require`, no Node globals. Top-level `inlets`/`outlets` must be bare globals — `let`/`const` breaks Max's attribute binding. Mark helpers `fn.local = 1` so Max does not expose them as message handlers.

## Refs

References are fetched by the shared refs CLI in `/Users/mw/projects/tools` (`vpx /Users/mw/projects/tools/refs.ts sync`); see its README for what it supports.

- **Live Object Model / Max docs**: `/Users/mw/projects/m4l-docs/apiref/lom/` — shared, beside this checkout (also `apiref/js/` for `v8`, `apiref/nodeformax/`, `userguide/m4l/`, `reference/`). Refresh with `vpx /Users/mw/projects/tools/refs.ts sync m4l-docs`.
- **graphql-js**: `refs/graphql/src/` (the implementation the server executes against — resolver signatures, error shapes). Its docs site is in `refs/graphql/website/pages/` (`docs/`, API reference in `api-v17/`). Pinned to `package.json`.
- **graphql-yoga**: `refs/graphql-yoga/` (server used by `liveql-n4m.js`). Pinned to `package.json`.
- **prelive**: `/Users/mw/projects/ableton-m4l-prelive` — abandoned attempt at doing this as an Ableton Live extension. Kept for how it reached the object model.

## Commands

```bash
vp check                  # format, lint and type-check every file; `vp check --fix` after edits
vp run test               # node:test suite for the schema and resolvers, no Live needed
vp run test:n4m           # the same suite under Node for Max's bundled Node
vp run test:live          # opt-in end-to-end suite; needs Live and mutates the open Set
vp run build:dist         # build the self-contained dist/ device (see README)
```

- Lint is Oxlint through Vite+, configured in `vite.config.ts`. `liveql-m4l.js` has its own override declaring Max's `v8` globals and message handlers.
- `vp run test` fakes `max-api` and drives the real schema through yoga, so it covers everything up to the `v8` boundary; run it, and `vp run test:n4m`, after touching `liveql-n4m.js`.
- `liveql-m4l.js` has no unit tests: a `LiveAPI` shim's fidelity is the very thing in question. `test/helpers/fake-lom.js` mirrors its wire contract instead, so a change to the bridge's output shape means a change there.
- The device itself is exercised by hand in Live: drop `liveql.amxd` on a track, click start, query `http://localhost:5100/graphql`. `curl` examples are in the README. `vp run test:live` is that session written as assertions.

## JavaScript Guidelines

- Plain JavaScript, no build step. Match the surrounding file: CommonJS in `liveql-n4m.js`, bare-global `v8` style in `liveql-m4l.js`.
- Prefer immutable data (`const`), optional chaining (`?.`) and nullish coalescing (`??`).
- Employ a concise and dense coding style. Prefer inlining expressions, function composition and direct returns over intermediate variables, unless a variable is essential for clarity or avoids redundant computation.
- Destructure directly in the function signature if the destructuring is short and shallow; otherwise in the body.
- **Do not add comments to generated code** beyond the JSDoc rule above. Rely on clear naming and concise logic.

## GraphQL Guidelines

- The schema is an SDL template literal in `liveql-n4m.js`. Field and type names mirror LOM names verbatim (`live_set`, `is_playing`, `has_midi_input`, `clip_slot`) — snake_case, not camelCase.
- Mutations are named `<object>_<action>` after the LOM operation they perform (`clip_set_looping`, `song_continue_playing`).
- Ground new fields in `/Users/mw/projects/m4l-docs/apiref/lom/` — the LOM is the source of truth for what a property is called and whether it is readable, writable or a child.
- One LOM operation per mutation. If a feature needs a read before a write, a specific write order, or a sequence of calls, that logic goes in the client, not here. Live's quirks (a silently dropped marker, a silently ignored note list) are documented in the field's schema docstring as a warning to callers, never worked around in a resolver.

## Do Not Edit

- `refs/` — external reference code, gitignored. Also the shared `/Users/mw/projects/m4l-docs`.
- `dist/` — build output of `pnpm build:dist`.
- `pnpm-lock.yaml` — regenerate through pnpm.
