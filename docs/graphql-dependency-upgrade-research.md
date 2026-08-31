# GraphQL Dependency Upgrade: graphql and graphql-yoga

Date: 2026-08-31

Answers one question — can we move `graphql` and `graphql-yoga` to their latest pins, and what
breaks — and records why the answer for `graphql` is **16.14.2, not 17.0.2**, even though 17 was
measured working.

Everything below was verified on this machine against **the Node binary Ableton actually ships**,
not the Node on `PATH`. Commands are in [Appendix: how this was verified](#appendix-how-this-was-verified)
so any claim can be re-checked.

Shorthand used throughout:

```
$N20 = /Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/
       Contents/Resources/C74/packages/Node for Max/source/bin/osx/node/node   # v20.6.1
```

---

## 1. Short answers

| Question | Answer |
| --- | --- |
| What moved? | `graphql` 16.13.1 → **16.14.2**, `graphql-yoga` 5.18.1 → **5.22.0**. |
| Is `graphql-yoga` 5.22.0 safe? | **Yes, and it is the load-bearing half.** 5.18.1 → 5.22.0 is entirely additive, and 5.21.3 patches a prototype-pollution vulnerability. |
| Why not `graphql` 17.0.2? | Its `engines` excludes Node 20.6.1 — the Node that ships in Live 12 Suite. See [§3](#3-why-not-graphql-17). |
| But does 17 actually work on 20.6.1? | **Yes, measured.** Byte-identical responses. It works by accident of one guarded call site, not by support. [§3.2](#32-why-17-survives-node-206-anyway) |
| Do any v16 → v17 breaking changes hit this project? | **None.** All twelve miss. [§4](#4-the-v16--v17-breaking-changes-mapped-to-this-project) |
| Did any behavior change at all? | **No.** Three stacks, identical output across query, mutation, error and GraphiQL paths. [§5](#5-verification) |
| Did `scripts/refs.ts` need editing? | **No.** Both refs read their pin out of `package.json`, so re-fetching was the whole job. 17 *would* have needed two hand edits. [§6](#6-refs-impact) |
| When do we revisit 17? | When Node for Max ships 22 in the **stable** Live release. The beta is already on 22.18.0. [§3.4](#34-the-trigger-to-revisit) |

---

## 2. graphql-yoga 5.18.1 → 5.22.0

Additive across the board. Nothing in the range is a breaking change, and nothing in it touches an
API this project calls. From `packages/graphql-yoga/CHANGELOG.md` at tag `graphql-yoga@5.22.0`:

| Version | Change | Relevance here |
| --- | --- | --- |
| 5.19.0 | "Update TypeScript to v6, and remove `ReadableStream`'s `AsyncIterable` typings" | None — typings only, and this repo has no TypeScript outside `scripts/`. |
| 5.20.0 | "Support changing `graphqlEndpoint` after initialization" | None — we read `yoga.graphqlEndpoint`, never assign it. |
| 5.21.0 | "Short-circuit response in `onRequestParse` hook" | None — no plugins. |
| 5.21.1 | `@whatwg-node/server` `^0.10.14` → `^0.11.0` | Transitive. |
| 5.21.2 | "Fix provenance attestations when publishing with pnpm" | Publish-side only. |
| **5.21.3** | **"Patch prototype pollution vulnerability in multipart parser"** | **Security fix.** The parser is reachable on any Yoga instance that accepts `multipart/form-data`. |
| 5.22.0 | "Update to support graphql-js 17 — Bump package versions, fix expected typing, and update compatability with subscribe." | Widens the peer range; see below. |

5.21.3 alone justifies the bump. This device binds `http://localhost:4000`, so the exposure is
local rather than public, but there is no reason to sit on a known parser vulnerability when the
upgrade is behaviorally inert.

### 2.1 The peer range widened, it did not move

```
graphql-yoga@5.18.1  peerDependencies.graphql = "^15.2.0 || ^16.0.0"
graphql-yoga@5.22.0  peerDependencies.graphql = "^15.2.0 || ^16.0.0 || ^17.0.0"
```

5.22.0 *adds* 17 without dropping 16. That is what makes "yoga now, graphql later" a coherent
position rather than a half-migration: 5.22.0 is a supported pairing with 16.14.2 today and the
only prerequisite for 17 whenever we want it.

The one thing to check was 5.22.0's new major transitive dep, since "support graphql-js 17" could
plausibly have meant "require graphql-js 17":

```
@graphql-tools/executor@2.0.0  peerDependencies.graphql = "^14.0.0 || ^15.0.0 || ^16.0.0 || ^17.0.0"
```

It did not. 16 is still in range.

---

## 3. Why not graphql 17

`graphql` 17.0.0 shipped 2026-06-15; 17.0.2 on 2026-07-03. It is stable, not a prerelease. The
objection is not stability.

### 3.1 The engines conflict

```
graphql@17.0.2  engines.node = "^22.0.0 || ^24.0.0 || ^25.0.0 || >=26.0.0"
graphql@16.14.2 engines.node = "^12.22.0 || ^14.16.0 || ^16.0.0 || >=17.0.0"
```

Confirmed by the upgrade guide's own first line, under **Platform Requirements**: "Node.js version:
v17 requires `^22.0.0 || ^24.0.0 || ^25.0.0 || >=26.0.0`."

Node for Max in **Live 12 Suite is v20.6.1** — outside that range. The Live 12 Beta is on 22.18.0,
which is inside it. So 17 is supported on the beta runtime and unsupported on the shipping one.

This is invisible at install time and will stay invisible. `pnpm install` runs under the Node on
`PATH` (v26.7.0 here), which satisfies `>=26.0.0`, so the constraint is checked against a runtime
that is not the one executing the code. Verified: installing `graphql@17.0.2` is clean even with
`--config.engine-strict=true`. Nothing in the toolchain will ever warn us about this.

### 3.2 Why 17 survives Node 20.6 anyway

Worth writing down, because "it works" and "it is supported" are different claims and the gap
between them is the whole argument.

Scanning `graphql@17.0.2`'s CommonJS dist for Node 22-era APIs turns up exactly two, and both are
guarded. `graphql/execution/withConcurrentAbruptClose.js:5`:

```js
const asyncDispose = Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose');
```

And the real one, `graphql/diagnostics.js` — `process.getBuiltinModule` landed in Node **22.3.0**:

```js
function resolveDiagnosticsChannel() {
    let dc;
    try {
        const processRef = globalThis.process;
        if (typeof processRef?.getBuiltinModule === 'function') {
            dc = processRef.getBuiltinModule('node:diagnostics_channel');
        }
    }
    catch {
    }
    return dc;
}
const dc = resolveDiagnosticsChannel();
exports.parseChannel = dc?.tracingChannel('graphql:parse');
exports.validateChannel = dc?.tracingChannel('graphql:validate');
exports.executeChannel = dc?.tracingChannel('graphql:execute');
```

A `typeof` guard, a `try`/`catch`, and `?.` on every consumer. On 20.6.1 (`typeof
process.getBuiltinModule === 'undefined'`) every channel is `undefined` and `shouldTrace` returns
`false`. The only casualty is graphql 17's new diagnostics-channel tracing, which this project does
not use.

So 17 degrades gracefully on 20.6.1 rather than failing. That is a real result — but it is a
property of graphql's current source, not a promise.

### 3.3 The actual argument

Four facts, taken together:

1. **17 buys nothing measurable.** 16.14.2 + yoga 5.22.0 and 17.0.2 + yoga 5.22.0 produce
   byte-identical responses on every path this device exposes ([§5](#5-verification)). There is no
   feature, no fix and no behavior on the far side of the upgrade.
2. **Nothing pins the guard.** §3.2 holds because of how `diagnostics.js` is written today. A 17.x
   patch adding an unguarded Node 22 API is entirely within semver, and `engines` says we would
   have no standing to complain.
3. **There is no net.** No test suite, no lint step; the device is exercised by hand in Live. A
   regression surfaces as `node.script` failing to boot, in someone's Live session, with the Max
   console as the only diagnostic.
4. **The 16 line is not a dead end.** 16.14.2 shipped 2026-06-09, and graphql-js released
   **15.10.3 on 2026-08-28** — three days before this was written. They are still patching the
   *previous* previous major.

The asymmetry decides it. Deferring 17 costs a pin bump later. Shipping a device that will not
start under stable Live costs a hand-tested debugging session in someone else's DAW.

### 3.4 The trigger to revisit

When Node for Max ships **22** in the stable Live release — the beta already has 22.18.0. At that
point 17 is in-support, and the move is a one-line pin change plus the two `refs.ts` edits in
[§6.2](#62-what-17-would-have-required), both of which `refs.ts` already anticipates in its own
comments.

### 3.5 What 16.14.2 brings over 16.13.1

Docs, two additive features, one bug fix. Nothing this project can observe:

| Release | Contents |
| --- | --- |
| 16.13.2 | Docs; `Object.create(null)` over `{}` to avoid prototype issues. |
| 16.14.0 | Configurable `ofType` introspection depth; experimental directives-on-directive-definitions; `valueFromAST` variable own-property fix. |
| 16.14.1 | Docs only. |
| 16.14.2 | Docs only. |

---

## 4. The v16 → v17 breaking changes, mapped to this project

Recorded even though we are not taking 17 — this is the table that makes the eventual upgrade a
five-minute decision instead of a re-run of this research. Every row is from the official
[v16 to v17 upgrade guide](https://www.graphql-js.org/upgrade-guides/v16-v17).

| Breaking change | Hits us? | Why not |
| --- | --- | --- |
| Node `^22.0.0 \|\| ^24 \|\| ^25 \|\| >=26` | **Yes** | The only one. See [§3](#3-why-not-graphql-17). |
| `graphql/subscription` subpath removed | No | No subscriptions; the schema has `Query` and `Mutation` only. |
| Dev mode off by default, no longer reads `NODE_ENV` | No | Never enabled it. Costs extra invariant checks we were not getting under `node.script` anyway. |
| Removed/renamed exports (`KindEnum`, `getVisitFn`, `assertValidName`, `getOperationRootType`, `printError`, `formatError`, positional `GraphQLError` ctor …) | No | `liveql-n4m.js` never imports `graphql`. Its only GraphQL import is `require("graphql-yoga")` for `createYoga` / `createSchema`. |
| Invalid arg/input-field defaults now fail schema validation; `defaultValue` → `default: { value }` | No | Schema is SDL-only, and the SDL declares no default values at all. |
| `undefined` in `variableValues` treated as omitted | No | Resolvers read `args`, never `variableValues`. |
| Scalar coercion renames (`serialize` → `coerceOutputValue`, etc.) | No | No custom scalars. Old names are deprecated, not removed. |
| `getVariableValues()` shape; `info.variableValues.coerced` | No | No resolver in this file takes the `info` argument. |
| `execute()` drops incremental delivery | No | No `@defer` / `@stream`, and execution is Yoga's concern. |
| `subscribe()` returns `PromiseOrValue` | No | No subscriptions. |
| `originalError` → `Error.cause` on `GraphQLError` | No | We never construct a `GraphQLError`. Errors reach Yoga as thrown values from `exec()`'s rejected promise. |
| Schema validation tightening (directive arg defaults, non-null `@deprecated` reason, `includeDeprecated: Boolean! = false`, OneOf input cycles) | No | No directives, nothing deprecated, no OneOf, no cyclic inputs — `NotesDictionaryInput` → `[NoteInput!]!` terminates. |

### 4.1 The one behavior worth checking by hand

`liveql-n4m.js:77-88` makes a load-bearing claim about scalar coercion:

> In practice, Yoga/GraphQL coerces `0` -> `false` and `1` -> `true` for output fields typed as
> `Boolean`, so output boolean fields usually need no custom resolver logic.

That is the entire reason `is_playing`, `has_midi_input`, `has_clip`, `looping` and friends work
without resolvers, given the LOM returns numeric `0`/`1`. A silent tightening here would break the
schema everywhere at once. Since v17 renames `serialize` → `coerceOutputValue`, it was worth
confirming the semantics did not move with the name. They did not — 16.13.1 and 17.0.2 agree
exactly:

```
Boolean.serialize(0)    = false        Int.serialize(1.5)  = THROW: Int cannot represent non-integer value
Boolean.serialize(1)    = true         Int.serialize("3")  = 3
Boolean.serialize(2)    = true         Float.serialize("3") = 3
Boolean.serialize("0")  = THROW        String.serialize(1) = "1"
Boolean.serialize(null) = THROW        String.serialize(true) = "true"
```

The JSDoc still holds on both majors.

---

## 5. Verification

Changelogs say what maintainers intended. The device is hand-tested, so the useful evidence is
observed output — and the only runtime that counts is the one Ableton ships.

The harness runs **the real `liveql-n4m.js`**, unmodified, under `$N20` (v20.6.1), with `max-api`
replaced by a stub that answers `get` / `set` / `call` from a fixture Live set and can fail one id
on demand. It then drives the paths the README documents:

- a deeply nested query — `live_set` → `view.selected_track`, `tracks` → `clip_slots` → `clip` →
  `notes`, exercising the `0`/`1` → `Boolean` coercion and the `get_all_notes_extended` JSON path
- a mutation — `clip_set_looping`, exercising `toLiveBool`
- a validation error — `{ nope }`
- an internal error with `maskedErrors: false` (`liveql-n4m.js:411`), to confirm the real Live API
  message still reaches the client unmasked
- `GET` with `accept: text/html`, for the GraphiQL shell

Four stacks, all on Node 20.6.1:

| # | Stack | Result |
| --- | --- | --- |
| 1 | `graphql@16.13.1` + `graphql-yoga@5.18.1` | baseline |
| 2 | `graphql@16.14.2` + `graphql-yoga@5.22.0` | **identical to 1** |
| 3 | `graphql@17.0.2` + `graphql-yoga@5.22.0` | **identical to 1** |
| 4 | the repo's real `node_modules` after the bump | **identical to 1** |

Diffed byte-for-byte with only the port number normalized:

```
=== DIFF old(16.13.1/5.18.1) vs new(17.0.2/5.22.0) ===
*** IDENTICAL ***
=== 16.14.2+5.22.0  vs  baseline 16.13.1+5.18.1 ===
*** IDENTICAL ***
=== 16.14.2+5.22.0  vs  17.0.2+5.22.0 ===
*** IDENTICAL ***
```

Stack 4 matters more than 2: it is the actual installed tree, resolved through pnpm's `.pnpm` store
with every real transitive dep, rather than a clean-room npm install of the same two pins.

The unmasked-error path, from stack 4, confirming `maskedErrors: false` is still honored:

```
[max.post] liveql: failed result: {"actionId":14,"status":"failed","message":"live api boom"}
MASKED? 200 {"errors":[{"message":"live api boom","locations":[...],"path":["track_set_name"]}],
             "data":{"track_set_name":null}}
```

`pnpm build:dist` was also re-run: the self-contained device resolves `16.14.2` / `5.22.0`.

---

## 6. Refs impact

### 6.1 What actually happened: nothing but a re-fetch

`scripts/refs.ts` names the `package.json` that owns each pin, so both refs followed the bump on
their own — the file's opening comment is exactly right that "a dependency bump is the only edit
needed":

```
graphql: v16.14.2  (. graphql)
  -> refs/graphql
graphql-yoga: graphql-yoga@5.22.0  (. graphql-yoga)
  -> refs/graphql-yoga
```

`pnpm refs:check` then reports the whole set aligned, with `graphql-spec` still on `October2021`
and `graphql-js-docs` still on `16` — correct for a 16.x pin, not stale.

### 6.2 What 17 would have required

Two hand edits, both already called out in `refs.ts`'s own comments — worth recording so the future
upgrade does not have to rediscover them.

**`scripts/refs.ts:242-250` — the spec edition.** The comment states the rule and the target:

> The edition graphql-js 16 implements … Deliberately not the working draft: the draft is where the
> 17 line is heading, so on anything the two disagree about — incremental delivery, the newer error
> semantics — it would describe a runtime this project does not have. Bump alongside the `graphql`
> dependency, whose major picks the edition: **17 lands on September2025.**

`tag: "October2021"` → `"September2025"`. The tag exists upstream — confirmed against
`graphql/graphql-spec`, which publishes `September2025`, `October2021`, `June2018`, `October2016`,
`April2016`, `October2015`, `July2015`.

**`scripts/refs.ts:329-340` — the API reference edition.** Two lines, and they must move together:

```js
include: String.raw`^https://www\.graphql-js\.org/(docs|api-v16)(/|$)`,
version: "16",
```

→ `api-v17` and `"17"`. A crawl's `version` is a literal the script never reads from a
`package.json`, so it is a hand-kept mirror of the pin; leaving it at `"16"` after moving the
include would make `refs:check` report aligned while the ref held v17 pages. Confirmed the site
serves both editions side by side — `/api-v16/graphql/` and `/api-v17/graphql/` are both 200, and
the repo's `website/pages/_meta.ts` lists v17 and v16 as parallel API menus.

One asymmetry to know about when that day comes: `website/pages/api-v17/` has **no
`subscription.mdx`**, matching v17's removal of the `graphql/subscription` subpath. Nothing here
uses it.

### 6.3 Docs that did not need changing

`AGENTS.md`'s Refs section describes `refs/graphql-spec/spec/` as "the edition graphql-js 16
implements". Still accurate on a 16.x pin. It becomes wrong the moment `graphql` moves to 17, and
should be updated in the same commit as [§6.2](#62-what-17-would-have-required).

---

## Appendix: how this was verified

Registry metadata:

```bash
npm view graphql dist-tags --json                 # latest 17.0.2, latest-16 16.14.2
npm view graphql-yoga dist-tags --json            # latest 5.22.0
npm view graphql@17.0.2 engines --json
npm view graphql@16.14.2 engines --json
npm view graphql-yoga@5.22.0 peerDependencies dependencies --json
npm view graphql-yoga@5.18.1 peerDependencies dependencies --json
```

Changelogs and release notes (`dotansimha/graphql-yoga` now redirects to `graphql-hive/graphql-yoga`;
`gh` follows it, so the `repo` string in `refs.ts` still resolves):

```bash
gh api "repos/graphql-hive/graphql-yoga/contents/packages/graphql-yoga/CHANGELOG.md?ref=graphql-yoga@5.22.0" \
  -q '.content' | base64 -d
gh api repos/graphql/graphql-js/releases -q '.[] | "\(.tag_name)\t\(.published_at)"'
gh api repos/graphql/graphql-spec/tags --paginate -q '.[].name'
gh api "repos/graphql/graphql-js/git/trees/v17.0.2?recursive=1" -q '.tree[].path' | grep website/pages
```

The Node that actually runs the server:

```bash
"$N20" -v                                          # v20.6.1
"$N20" -e "console.log(typeof process.getBuiltinModule)"   # undefined
node   -e "console.log(typeof process.getBuiltinModule)"   # function  (v26.7.0 on PATH)
```

Node 22-era API scan of the installed dist:

```bash
grep -rn --include="*.js" "getBuiltinModule\|Symbol.asyncDispose\|Promise.withResolvers\|\
Array.fromAsync\|Object.groupBy\|structuredClone" node_modules/graphql
```

Install behavior under the strictest setting:

```bash
pnpm install --prod --config.engine-strict=true --ignore-scripts   # clean with graphql@17.0.2
```

The behavioral harness — real `liveql-n4m.js`, stubbed `max-api`, run under `$N20`, output diffed
across stacks with the port normalized:

```bash
diff <(sed 's/localhost:[0-9]*/localhost:PORT/' out-old.txt) \
     <(sed 's/localhost:[0-9]*/localhost:PORT/' out-new.txt)
```

Stack 4 was built by symlinking the repo's own resolved packages into the harness, so pnpm's real
`.pnpm` layout is what gets exercised:

```bash
ln -s "$(cd $REPO/node_modules/graphql      && pwd -P)" node_modules/graphql
ln -s "$(cd $REPO/node_modules/graphql-yoga && pwd -P)" node_modules/graphql-yoga
```

Post-bump repo checks:

```bash
pnpm install
pnpm refs fetch graphql graphql-yoga
pnpm refs:check
pnpm build:dist
```
