# Handoff: Strip LiveQL Back to a Bare Live Object Model Mirror

Date: 2026-09-03. Written for the agent making the change in this repo. Read `AGENTS.md`
first; its rules (JSDoc citations, no commits unless told, run `pnpm test` and `pnpm test:n4m`)
apply.

## Goal

Every GraphQL mutation should be exactly one Live Object Model (LOM) operation, `set` or
`call`, followed by the readback the selection set needs. No mutation reads before it writes,
reorders writes, validates against Live state, or chains several LOM calls. Orchestration
belongs to the client. Prelive (`../ableton-m4l-prelive`) has already moved its whole-clip
rewrite to the client using only one-call mutations sent as aliased fields of one mutation
document, so nothing in the schema below is still needed by it. See
`refs/prelive/docs/liveql-composite-mutations-research.md` or the live repo for that design.

The Max layer (`liveql-m4l.js`) is already pure `get`/`set`/`call`. Only `liveql-n4m.js`, the
tests, README and docs change.

## Remove

### 1. `clip_write_notes` (schema `liveql-n4m.js:559`, resolver `:1304`)

Composite of `set`×n, `add_new_notes`, `apply_note_modifications`, `remove_notes_by_id`.
Unused by prelive since its commit `9d9ca71`. Delete:

- Mutation field and its docstring.
- `input ClipWriteNotesInput` (`:434`).
- The resolver and its `step` helper.
- `test/notes.test.js` cases at lines ~112-166 (write, step failure, empty input).
- `test/schema.test.js:117-118`, the arg-naming exemption loop for `clip_write_notes`
  (`INVENTED_ARGS` may become empty or go away; check what else uses it).
- `test/live/verification-matrix.test.js` ~lines 300-320, "clip_write_notes step failure".
- README line 96, the sentence starting "`clip_write_notes`, the one mutation without a LOM
  counterpart".

### 2. `clip_replace_notes` (schema `:567`, resolver `:1350`)

Composite of preflight `get`, `get_all_notes_extended`, `remove_notes_extended`,
`add_new_notes`, readback. Prelive now does this sequence itself. Delete:

- Mutation field and docstring.
- `input ReplacementNoteInput` (`:446`). `NoteInput` stays; it is what `add_new_notes` takes.
- The resolver.
- `test/notes.test.js` ~lines 168-270 (`REPLACE` constant and its describe block).
- `test/live/verification-matrix.test.js` `describe("clip_replace_notes")` ~lines 325-410,
  including the audio-clip preflight case.
- Any README mention.

`ClipNotesPayload` (`:429`) stays: `clip_add_new_notes` returns it because `add_new_notes` is
the one LOM call whose return value (the new ids) matters.

### 3. Marker ordering inside `clip_set_properties` (`setClipProperties` `:963`, `clipPropertyOrder` `:945`, `CLIP_SCALAR_KEYS` `:919`)

Today the clip batch reads the clip first and orders the writes so start never crosses end.
That is client logic. Make `clip_set_properties` the same shape as `track_set_properties`: a
plain loop of `set` in a fixed key list, no read first.

```js
const CLIP_PROPERTY_KEYS = [
  ...CLIP_SCALAR_KEYS,          // name, signature_*, looping, muted, color*, launch_*, legato, velocity_amount
  "loop_start", "loop_end", "start_marker", "end_marker", "position",
];
clip_set_properties: async (parent, args) => {
  await setProperties(args.id, args.properties, CLIP_PROPERTY_KEYS);
  return getClip(args.id);
},
```

Delete `clipPropertyOrder`, `setClipProperties` and the ordering JSDoc. Keep the fact that Live
silently ignores a crossing marker, but move it to the schema docstring on
`clip_set_properties` as a warning to callers: "Live drops a start set past the current end, and
an end set before the current start, without raising; write markers one per mutation in the
order that keeps start <= end, and compare the returned clip with what you asked for." Keys are
applied in list order within one call, so a caller who sends both markers in one batch gets
whatever that fixed order gives; document that too.

Tests: `test/clip.test.js` (~lines 6-70) asserts on the batch; keep the cases that check a
single-key set and the null-on-invalid-id case, drop any that assert reorder behaviour.
`test/live/verification-matrix.test.js` lines ~77-160 ("grow batch", "shrink batch", the
start-behind-end probe, looped/unlooped state) exercise ordering: keep the Live-behaviour probes
that document what Live does (the start-behind-end silent drop is valuable), rewrite grow/shrink
to send one marker per mutation in the right order, since that is now the caller's contract.
README line 92: drop "The clip batch applies markers in an order that never violates Live's
start/end constraints."

### 4. Stale-id pre-check in `clip_apply_note_modifications` (`applyNoteModifications` `:1034`)

Does a `get_notes_by_id` before the `apply_note_modifications` call so a stale id becomes an
error instead of Live silently ignoring the list. That is a read-before-write; remove it for
consistency with the goal. The resolver becomes:

```js
clip_apply_note_modifications: async (parent, args) => {
  await call(args.id, "apply_note_modifications", normalizeNotesDictionaryInput({ notes: args.notes }));
  return getClip(args.id);
},
```

The behaviour must not be lost, only relocated. LiveQL already documents Live's quirks in
schema docstrings on the mutation itself (`clip_quantize` for the out-of-range grid,
`clip_slot_fire` for positional arguments, `clip_duplicate_notes_by_id` for default placement),
and that is the place for this one. Put a docstring on `clip_apply_note_modifications` in the
SDL, in the same style:

```graphql
"""
Live silently ignores the entire list when any note_id in it is not in the
clip: no error, nothing changes, and the returned clip is unchanged. Check the
ids first with clip(id) { get_notes_by_id(note_ids: [...]) } if that matters,
and compare the returned notes with what you asked for.
"""
clip_apply_note_modifications(id: Int!, notes: [NoteInput!]!): Clip
```

The resolver keeps no comment about it; per `AGENTS.md` the schema docstring is what a client
sees and the code should not repeat it. `getNotesById` stays because the
`Clip.get_notes_by_id` query field uses it (`:1580`). `sortJsonNotesDictionary`'s JSDoc
(`:990`) cites `applyNoteModifications`; reword to cite the query field instead.

Tests: `test/notes.test.js` ~lines 75-100 (two stale-id cases) go; line ~107 (mute
normalisation) stays. README line 96 "Modify (stale ids fail loudly instead of being ignored)"
changes to describe Live's actual behaviour.

## Keep (not composites)

- `setProperties` loop for every `*_set_properties`: the LOM has no multi-set, and a batch of
  independent `set` calls with no read and no reordering is the smallest GraphQL shape.
- Every mutation's trailing `getClip`/`getTrack`/... readback: that fills the selection set.
- `getApplication` parallel reads: query resolution.
- `clip_slot_fire` / `scene_fire` positional-argument validation: rejects an impossible
  argument combination before any LOM call, no extra Live reads.
- `unprefix` (`:75`) if anything else still uses it after the step helpers go; otherwise delete.

## Docs

- `docs/liveql-note-editing-enhancement-research.md` and `docs/liveql-schema-pass-handoff.md`
  describe the composites as the design. Move both to `docs/archive/` with a one-line note at
  the top pointing here, rather than editing them.
- README sections "Properties" and "MIDI notes" (lines 92, 96): update as noted above. Add one
  sentence to the intro stating the rule: one LOM operation per mutation, orchestration is the
  client's job, and that several mutations can be sent in one document as aliased fields and
  run serially in order.

## Verify

1. `pnpm test` and `pnpm test:n4m` green.
2. `pnpm test:live` with Live open: the marker probes and note tests still pass under the
   rewritten one-marker-per-mutation form.
3. Prelive still saves: in `../ableton-m4l-prelive`, run the app, open a MIDI clip, edit a note
   past the clip end, Write. Its save sends `clip_set_properties` (one key each),
   `clip_remove_notes_extended`, `clip_add_new_notes` as aliased fields, then reads the clip back.
   None of the removed fields or inputs appear in `src/lib/LiveSet.ts`; confirm with
   `grep -n "replace_notes\|write_notes\|ReplacementNoteInput" src/lib/LiveSet.ts` (expect nothing).
4. `grep -n "clip_write_notes\|clip_replace_notes\|clipPropertyOrder\|setClipProperties\|ReplacementNoteInput\|ClipWriteNotesInput" liveql-n4m.js test README.md` returns nothing.
