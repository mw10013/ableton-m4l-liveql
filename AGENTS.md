# AGENTS.md

- Prefer JSDoc for comments for complex and subtle behavior the code cannot show. A JSDoc must carry its reasoning inline and must never reference files under `docs/` — research docs go stale and get deleted. External URLs and `refs/` paths are acceptable.
- Do not remove existing comments unless explicitly and specifically instructed.
- Do not git commit unless you are explicitly instructed.
- Your answers and explanations should be concise and scannable so the user can scan quickly and easily understand. Sacrifice grammar for the sake of concision.
- Ground your answers and explanations with excerpts from documentation and code.

## Project

- `LiveQL` is a GraphQL API for Ableton Live: a Max for Live device exposing a subset of the Live Object Model (LOM) over `http://localhost:4000/graphql`.
- `liveql.amxd` — the Max for Live device. Hosts the `v8` object running the Max JS script and the `node.script` object running the Node for Max server.
- `liveql-m4l.js` — Max JS (`v8` object). Talks to the LOM through `LiveAPI`, receives actions on its inlet, returns results on its outlet.
- `liveql-n4m.js` — Node for Max script. Serves the GraphQL schema and resolvers with graphql-yoga; resolvers dispatch actions to the Max layer over `max-api` and await the matching result by `actionId`.
- `scripts/refs.ts` — reference-source fetcher. The only TypeScript here, and the only place Effect is used.
- `docs/` — research notes. Reference material for humans, not load-bearing: do not cite from code.
- `dist/` — throwaway build output from `pnpm build:dist`. Never edit; rebuild it.

## Runtime

- `liveql-n4m.js` runs under **Node for Max's bundled Node**, not the Node on your PATH (v20.6.1 in Live 12 Suite, v22.18.0 in the Live 12 Beta). It is CommonJS: `require`, no ESM, no bundler, no TypeScript.
- `liveql-m4l.js` runs under Max's **`v8` object**, not Node. No `require`, no Node globals. Top-level `inlets`/`outlets` must be bare globals — `let`/`const` breaks Max's attribute binding. Mark helpers `fn.local = 1` so Max does not expose them as message handlers.
- `node scripts/refs.ts` runs under the Node on your PATH and needs **>=22.18** for native TypeScript type stripping.

## Refs

Downloaded reference sources are in `refs/`, pinned to the versions this workspace depends on. Fetched by `scripts/refs.ts`; see the JSDoc there before changing an entry.

- **Live Object Model / Max docs**: `refs/m4l-docs/apiref/lom/` (crawled markdown; also `reference/`, `userguide/`)
- **graphql-js**: `refs/graphql/src/` (the implementation the server executes against — resolver signatures, error shapes)
- **graphql-yoga**: `refs/graphql-yoga/` (server used by `liveql-n4m.js`)
- **GraphQL spec (October2021)**: `refs/graphql-spec/spec/` (the edition graphql-js 16 implements)
- **GraphQL docs**: `refs/graphql-docs/learn/` (conceptual docs, crawled)
- **graphql-js docs**: `refs/graphql-js-docs/docs/`, API reference in `api-v16/`
- **Effect v4**: `refs/effect/ai-docs/`, source in `packages/` (only relevant to `scripts/refs.ts`)
- **bang**: `refs/bang/` — a Shopify app, unrelated to Live. Here for its Effect and tooling patterns.
- **prelive**: `refs/prelive/` — abandoned attempt at doing this as an Ableton Live extension. Kept for how it reached the object model.

## Commands

```bash
pnpm refs:check         # report refs that drifted from their pins (exit 1 if any)
pnpm refs fetch <name>  # re-fetch one ref; `pnpm refs:all` for every non-opt-in ref
pnpm typecheck:scripts  # typecheck scripts/ (the only TypeScript in the repo)
pnpm build:dist         # build the self-contained dist/ device (see README)
```

- There is no test suite and no lint step. `pnpm test` is a placeholder that exits 1.
- Run `pnpm typecheck:scripts` after editing `scripts/refs.ts`. Not necessary if just research.
- The device itself is exercised by hand in Live: drop `liveql.amxd` on a track, click start, query `http://localhost:4000/graphql`. `curl` examples are in the README.

## JavaScript Guidelines

- Plain JavaScript, no build step. Match the surrounding file: CommonJS in `liveql-n4m.js`, bare-global `v8` style in `liveql-m4l.js`.
- Prefer immutable data (`const`), optional chaining (`?.`) and nullish coalescing (`??`).
- Employ a concise and dense coding style. Prefer inlining expressions, function composition and direct returns over intermediate variables, unless a variable is essential for clarity or avoids redundant computation.
- Destructure directly in the function signature if the destructuring is short and shallow; otherwise in the body.
- **Do not add comments to generated code** beyond the JSDoc rule above. Rely on clear naming and concise logic.

## TypeScript Guidelines (`scripts/` only)

- Follow functional programming principles and Effect v4 patterns and idioms.
- Import modules as namespace objects and access members through them (`Effect.gen`, `Schema.String`) — never cherry-pick individual functions (`import { gen } from "effect/Effect"`). For `effect`, use named module imports from the barrel (`import { Effect, Schema, Layer } from "effect"`) — the documented v4 style; those named exports are module namespaces. Use `import * as X` for local modules and libraries without namespace re-exports.
- Strict mode is on; prefix intentionally unused bindings with `_`; use `import type` for type-only imports.
- Inline types when practical instead of introducing extra interfaces or type aliases.

## GraphQL Guidelines

- The schema is an SDL template literal in `liveql-n4m.js`. Field and type names mirror LOM names verbatim (`live_set`, `is_playing`, `has_midi_input`, `clip_slot`) — snake_case, not camelCase.
- Mutations are named `<object>_<action>` after the LOM operation they perform (`clip_set_looping`, `song_continue_playing`).
- Ground new fields in `refs/m4l-docs/apiref/lom/` — the LOM is the source of truth for what a property is called and whether it is readable, writable or a child.

## Do Not Edit

- `refs/` — external reference code, gitignored.
- `dist/` — build output of `pnpm build:dist`.
- `pnpm-lock.yaml` — regenerate through pnpm.
