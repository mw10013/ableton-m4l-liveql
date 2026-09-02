# Testing Research: Should LiveQL Have An Automated Suite?

Date: 2026-09-01

Research question: LiveQL has no tests (`pnpm test` exits 1). The schema pass of 2026-09-01 was
verified with a throwaway harness that mocked `max-api` and drove the server through `yoga.fetch`.
Should that become a real suite, and if so with what runner? Vitest was suggested.

Recommendation up front: **yes, keep a suite, but on Node's built-in `node:test`, not Vitest**, run
under both the PATH Node and the Node binary Ableton bundles. Vitest buys watch mode and nicer output
at the cost of a transform pipeline that cannot run under the bundled binary, and the bundled binary
is the runtime that matters.

## What Can Be Tested Where

The device is three layers with two hard boundaries:

```
GraphQL client ──HTTP──▶ liveql-n4m.js (Node for Max) ──max-api──▶ liveql-m4l.js (v8) ──LiveAPI──▶ Live
```

| Layer | Runs under | Testable without Live? |
| --- | --- | --- |
| Schema + resolvers (`liveql-n4m.js`) | Node for Max's bundled Node, v22.18.0 on this machine | Yes. `max-api` is the only Max dependency and is one object with `post`, `outlet`, `addHandler` |
| Bridge (`liveql-m4l.js`) | Max's `v8` object | No. `LiveAPI` and `outlet` exist only inside Max. It is ~120 lines and stateless; the cost of leaving it untested is low |
| The wire protocol between them | both | Yes, indirectly: a fake `max-api` that answers `get`/`set`/`call` JSON exactly as the bridge does exercises every message the Node layer sends |
| Live's actual behaviour (marker clamping, `add_new_notes` return shape, grid int mapping) | Live | No. Only a running device answers these |

So there are two distinct suites worth having, and one that is not worth it:

1. **Resolver suite, no Live.** Fake `max-api`, fake LOM object table, real graphql-yoga, real schema.
   Covers everything the 2026-09-01 harness covered: schema validity, marker ordering, by-id null
   semantics, payload shapes, composite step errors, positional-argument guards, nullable fields on
   master tracks, empty-symbol defaults. Fast, deterministic, CI-able.
2. **Live end-to-end suite, opt-in.** Plain HTTP against `http://localhost:4000/graphql` with the device
   running on a disposable Set. This is the ten-item verification matrix from
   `docs/liveql-note-editing-enhancement-research.md` written as assertions. Gated behind an env var so
   `pnpm test` never needs Live.
3. **Bridge unit tests: skip.** Would need a `LiveAPI` shim whose fidelity is the very thing in question.

## Runner Choice

### Why the bundled binary matters

`liveql-n4m.js` does not run under the Node on `PATH` (v26.7.0 here); it runs under
`.../packages/Node for Max/source/bin/osx/node/node`, measured at **v22.18.0** on this machine. The
graphql dependency upgrade research already had to run its checks under that binary because the two
Nodes differ in what they accept. A resolver suite that can only run under `PATH` Node proves less than
one that also runs under the binary the device uses. Verified today:

```
$ "$N4M/source/bin/osx/node/node" --version
v22.18.0
$ "$N4M/source/bin/osx/node/node" -e "require('node:test'); console.log('ok')"
ok
```

### node:test

- Ships with Node since 18; stable in 20 and 22. Zero dependencies. Runs CommonJS test files as-is,
  which matches the repo rule of plain JavaScript with no build step.
- `node --test test/` discovers `*.test.js`. Assertions via `node:assert/strict`. Has `describe`/`it`,
  `before`/`after`, `mock` for function spies, `--test-only`, `--watch` (Node 22), and a TAP/spec
  reporter.
- Runs identically under `PATH` Node and the bundled binary, so one suite, two `package.json` scripts.
- Weaknesses: no snapshot testing until Node 22.3 (`t.assert.snapshot`, experimental), plainer output
  than Vitest, no browser-style `expect` matchers.

### Vitest

- Excellent DX: watch mode with smart re-runs, `expect` matchers, inline snapshots, coverage via v8 in
  one flag.
- Runs test files through Vite's transform pipeline (`vite-node`). It handles CommonJS sources, but it
  runs on the `PATH` Node, and its own engine floor is Node 18+/20+ depending on version. It cannot be
  pointed at the bundled binary without also installing its dependency tree in a form that binary can
  load, which defeats the purpose.
- Adds `vitest` plus Vite to `devDependencies`. Harmless for the device (`pnpm build:dist` installs
  `--prod`), but it is a second module system and toolchain in a repo whose only other tooling is
  `scripts/refs.ts`.
- Vitest is the right tool if the suite grows into something people iterate on daily. For a suite whose
  main job is catching schema regressions and runtime incompatibilities, it is more tool than the job
  needs.

### Decision

`node:test`. Revisit if the suite grows past a few hundred assertions or someone misses watch mode
badly; the tests themselves would port to Vitest with mechanical `assert` to `expect` edits.

## Proposed Layout

```
test/
  fake-max.js          # stub of max-api: post, addHandler, outlet -> routes to fake-lom
  fake-lom.js          # object table keyed by id/path; implements get/set/call the way liveql-m4l.js does
  server.js            # loads liveql-n4m.js with fake-max injected, captures yoga, exposes gql(query, vars)
  schema.test.js       # schema builds; every type has id/path/type; no field name outside the LOM allowlist
  clip.test.js         # marker ordering, set_properties, by-id, notes fields null on audio clips
  notes.test.js        # add returns note_ids, modify rejects stale ids, write_notes step errors
  song.test.js         # song/view/track/scene reads, nullable master-track fields, empty symbols
  live/                # opt-in end-to-end, LIVEQL_E2E=1, hits localhost:4000
    verification-matrix.test.js
```

`package.json`:

```json
"test": "node --test test/",
"test:n4m": "\"/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/Contents/Resources/C74/packages/Node for Max/source/bin/osx/node/node\" --test test/",
"test:live": "LIVEQL_E2E=1 node --test test/live/"
```

`test:n4m` hard-codes the Suite path; the Beta and Standard paths differ. A tiny resolver script can
locate the binary if that becomes annoying.

### How the fake LOM stays honest

The fake must implement the bridge's wire contract, not Live's semantics. Concretely it mirrors the
four loops in `liveql-m4l.js`'s `get` (single properties recorded only when exactly one value comes
back, `["id", N]` for children, `id 0` as null, `"id"` tokens stripped from lists) and the
`{ status, actionId, data | message }` result envelope. Anything beyond that (marker clamping, note id
assignment) is a convenience for a specific test, not a claim about Live. Keep those behaviours minimal
and named after the test that needs them so nobody mistakes the fake for documentation of Live.

The bridge itself should get a one-line contract comment pointing at `test/fake-lom.js` when the suite
lands, so a bridge change that alters the wire shape prompts a fake update.

### Schema allowlist test

The naming rule (every field/argument is a LOM name) is enforceable: introspect the built schema and
check each field and argument name against a set built from the headings in
`refs/m4l-docs/apiref/lom/*/index.md`, with a short explicit allowlist for the invented names (`id`,
`path`, `properties`, `clip`, `note_ids`, `index`, the `*_set_properties` mutations, `clip_write_notes`
and its input). This is the single most valuable test for keeping the schema aligned with the LOM as
it grows. `refs/` is gitignored, so this test skips itself when the refs are not fetched.

## The Live Suite

Written against the real device and a disposable Set with one MIDI track and one looped 4-beat clip.
Each case is one of the verification-matrix items and asserts what the research doc says to record:

| Case | Asserts | Records into a JSDoc |
| --- | --- | --- |
| `add_new_notes` return | `note_ids.length === notes.length`, ids resolve through `get_notes_by_id`, order matches pitches | return shape under v8 |
| Marker batch grow / shrink | returned markers equal requested | whether Live clamps silently |
| `start_marker > end_marker` | GraphQL error or unchanged marker, never a silent wrong value | which |
| Unlooped `loop_end` vs `end_marker` | equality or not | aliasing answer |
| `end_time` looped vs unlooped | equals `loop_end` / `end_marker` | |
| `grid_quantization` sweep | read after changing grid in Live's editor (manual step, prompt in test output) | int mapping |
| Unsaved Set | `live_set { name file_path }` returns `""` | empty-symbol behaviour |
| `song_view_set_detail_clip` | `detail_clip.id` equals the id set | `"id N"` string form works |
| `clip(id)` with a track id | `null`, no error | |
| `clip_write_notes` stale modify | error names step and lists added ids | |

The suite mutates a Set, so it must never run by default and should print the Set name it expects.

## Costs

- `node:test` suite: no new dependencies. Roughly the 200 lines of the throwaway harness split into the
  files above plus assertions. Half a day.
- Live suite: the same HTTP client, a fixture Set checked into `test/live/` as `.als`, and a checklist
  for the manual grid step. Half a day plus one Live session to run it and fill the JSDocs.
- Allowlist test: an hour, depends on `refs/m4l-docs` being fetched.

## What Landed, And Where This Doc Was Wrong

Implemented 2026-09-01 as `test/`, 42 assertions, green under both the PATH Node (v26.7.0) and the
bundled binary (v22.18.0 — the Live 12 Suite one; the v20.6.1 that `package.json` and the Node for Max
README recorded is gone, and `engines` is now a single `>=22.18.0`). Two things in the plan above do not
survive contact with Node 22:

- **`node --test test/` does not work.** A bare directory argument is treated as a file to run:
  `Error: Cannot find module '.../test'`. The scripts pass shell-expanded globs instead
  (`node --test test/*.test.js`), which also works on Node 20 where the runner has no glob support.
- **Everything under a directory named `test` is a test file.** Under bare `node --test`, `fake-max.js`,
  `fake-lom.js` and `server.js` are each loaded and reported as a passing test. The helpers moved to
  `test/helpers/` and the globs never match them.

Also changed: no `.als` fixture is checked in. `test/live/` discovers the first MIDI track with a clip in
whatever Set is open, saves that clip's markers and notes, and restores them afterwards. Cases whose
answer is the point (does Live clamp? does `loop_end` alias `end_marker`?) print a `RECORD:` line and
assert only the invariant, so the suite does not bake in a guess about Live.

## Appendix: The 2026-09-01 Harness

The throwaway harness that verified the schema pass, kept here so the suite can start from it rather
than from scratch. It lived in a scratch directory and is not in the repo. It fakes `max-api` by
patching `Module._load`, captures the yoga instance by patching `http.createServer`, and answers
`get`/`set`/`call` from an object table shaped like the bridge's output.

```js
const Module = require("module");
const http = require("http");

const log = [];
const objects = {
  live_set: { id: 1, type: "Song", props: { name: [], file_path: [], is_playing: [0], tempo: [120],
    /* ...every Song property the resolver reads, as LiveAPI.get would return it... */
    view: ["id", 2], master_track: ["id", 12], tracks: ["id", 10, "id", 11], scenes: ["id", 30] } },
  live_app: { id: 3, type: "Application", props: {} },
  2: { id: 2, type: "Song.View", props: { draw_mode: [0], follow_song: [1], detail_clip: ["id", 40],
    selected_track: ["id", 10], highlighted_clip_slot: ["id", 20], selected_scene: ["id", 30] } },
  12: { id: 12, type: "Track", props: { name: ["Master"], can_be_armed: [0], /* no arm/mute/solo */ } },
  20: { id: 20, type: "ClipSlot", props: { has_clip: [1], clip: ["id", 40], /* ... */ } },
  40: { id: 40, type: "Clip", props: { name: [], is_midi_clip: [1], looping: [1], loop_start: [0],
    loop_end: [4], start_marker: [0], end_marker: [4], view: ["id", 41], /* ... */ } },
  41: { id: 41, type: "Clip.View", props: { grid_quantization: [4], grid_is_triplet: [0] } },
};
let notes = [{ note_id: 1, pitch: 60, start_time: 0, duration: 1, velocity: 100, mute: 0,
  probability: 1, velocity_deviation: 0, release_velocity: 64 }];
let nextNoteId = 100;
let resultHandler = null;

function lom(params) {
  const o = objects[params.idOrPath];
  if (!o) throw `Invalid live id or path: ${params.idOrPath}`;
  const base = { id: o.id, path: `path ${o.id}`, type: o.type };
  if (params.action === "get") {
    for (const k of params.propertyKeysSingle || []) { const v = o.props[k] ?? []; if (v.length === 1) base[k] = v[0]; }
    for (const k of params.propertyKeysMultiple || []) base[k] = o.props[k] ?? [];
    for (const k of params.childKeysSingle || []) { const id = (o.props[k] ?? [])[1]; base[k] = id === 0 || id === undefined ? null : id; }
    for (const k of params.childKeysMultiple || []) base[k] = (o.props[k] ?? []).filter((v) => v !== "id");
    return base;
  }
  if (params.action === "set") {
    log.push(["set", params.idOrPath, params.property, params.value]);
    if (params.property === "start_marker" && params.value > o.props.end_marker[0]) throw "start marker behind end marker";
    o.props[params.property] = [params.value];
    return null;
  }
  const [fn, ...args] = params.args;
  log.push(["call", params.idOrPath, fn, ...args]);
  switch (fn) {
    case "get_major_version": return [12];
    case "get_version_string": return ["12.3.5"];
    case "get_all_notes_extended": case "get_selected_notes_extended": return JSON.stringify({ notes });
    case "get_notes_extended": return JSON.stringify({ notes: notes.filter((n) => n.start_time >= args[2]) });
    case "get_notes_by_id": return JSON.stringify({ notes: notes.filter((n) => args.includes(n.note_id)) });
    case "add_new_notes": { const ids = args[0].notes.map((n) => { const id = nextNoteId++; notes.push({ ...n, note_id: id }); return id; }); return ["id", ...ids]; }
    case "apply_note_modifications": { for (const m of args[0].notes) Object.assign(notes.find((x) => x.note_id === m.note_id), m); return null; }
    case "remove_notes_by_id": notes = notes.filter((n) => !args.includes(n.note_id)); return null;
    default: return null;
  }
}

const fakeMax = {
  post: async () => {},
  addHandler: (name, fn) => { if (name === "result") resultHandler = fn; },
  outlet: async (action, json) => {
    const params = JSON.parse(json);
    let result;
    try { result = { status: "succeeded", actionId: params.actionId, data: lom(params) }; }
    catch (err) { result = { status: "failed", actionId: params.actionId, message: String(err) }; }
    setImmediate(() => resultHandler(JSON.stringify(result)));
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === "max-api" ? fakeMax : origLoad.call(this, request, ...rest); };
let yoga;
http.createServer = (y) => { yoga = y; return { listen: () => {} }; };
require(process.argv[2]);

async function gql(query, variables) {
  const res = await yoga.fetch("http://localhost/graphql", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return res.json();
}
```

Queries it ran, which become the first test cases:

- `{ live_set { name file_path master_track { arm fold_state } view { detail_clip { id } } scenes { clip_slots { id } } } }`
  expecting `""`, `null`, `null`.
- `{ a: clip(id: 40) { type } b: clip(id: 10) { id } c: track(id: 999) { id } }` expecting `"Clip"`, `null`, `null`.
- `mutation { clip_set_properties(id: 40, properties: { looping: false, end_marker: 8, loop_end: 8, start_marker: 1, loop_start: 1, position: 2 }) { ... } }`
  expecting the `set` log order `name > looping > end_marker > loop_end > start_marker > loop_start > position`.
- `mutation { clip_add_new_notes(id: 40, notes: [...]) { note_ids } }` expecting `[100, 101]`.
- `mutation { clip_apply_note_modifications(id: 40, notes: [{ note_id: 999, pitch: 1 }]) { id } }` expecting an error naming `999`.
- `mutation { clip_write_notes(id: 40, input: { add_new_notes: [...], apply_note_modifications: [{ note_id: 999 }] }) { note_ids } }`
  expecting `clip_write_notes step apply_note_modifications failed after add_new_notes (ids 103)`.
- `mutation { clip_slot_fire(id: 20, launch_quantization: 3) { id } }` expecting the positional-argument error.
- `mutation { song_view_set_detail_clip(id: 2, detail_clip: 40) { id } }` expecting the `set` log entry `["set", 2, "detail_clip", "id 40"]`.
