# LiveQL Note Editing Enhancement Research

Date: 2026-09-01

Research question: what should change in LiveQL so Prelive can do reliable note editing with
automatic playback-boundary extension, Live-parity Duplicate, and the later operation roadmap, without
another LiveQL round of changes for each feature?

This document is written to be handed to an implementer working in the LiveQL repository
(`../ableton-m4l-liveql`, mirrored read-only at `refs/liveql/`). All LOM citations below use paths
relative to that repository's `refs/m4l-docs/apiref/lom/`. Prelive follow-up work is listed at the end.

## Recommendation

Do one full LiveQL pass now rather than adding fields feature by feature. Four changes are load
bearing for Prelive's next milestones; the rest of the pass is cheap once the patterns exist.

1. Expose every Clip marker property and make `clip_set_properties` accept them, applied in an order
   that cannot violate Live's marker constraints.
2. Return the note IDs Live assigns from `clip_add_new_notes`, so a client can reconcile temporary IDs
   without a heuristic diff.
3. Add direct by-id queries (`clip(id)`, `track(id)`, `clip_slot(id)`) so a client can refetch exactly
   the object it just wrote.
4. Add a composite `clip_write_notes` mutation that applies markers, additions, modifications, and
   removals in one request with a documented order, returning the refreshed Clip in the same round
   trip.

Then widen coverage across Song, Song.View, Track, ClipSlot, Scene, Clip, and Clip.View to the full
set of members that matter for note editing, transport, and navigation. Devices, routing, meters,
audio-only clip properties, and control surfaces stay out of scope.

## Current LiveQL State

Read from `liveql-n4m.js` and `liveql-m4l.js`.

- Schema is an SDL template literal in `liveql-n4m.js`. Names mirror the LOM verbatim in snake_case;
  mutations are `<object>_<action>`.
- The Node layer sends three action kinds to the Max `v8` layer: `get`, `set`, `call`. Each is one
  round trip over `max-api` keyed by `actionId`.
- `get` takes four key lists: single-value properties, multi-value properties, single child ids, and
  child id lists. The bridge returns `{ id, path, type, ...values }`; GraphQL exposes only `id` and
  `path`.
- `call` passes `[fn, ...args]` straight to `LiveAPI.call`. Dictionary arguments already work this
  way for `add_new_notes`. Dictionary results come back as a JSON string that the Node layer parses
  (`sortJsonNotesDictionary`).
- Every note mutation discards the LOM call's return value and re-reads the Clip via `getClip(id)`,
  which fetches nine scalar properties. `Clip.notes` is a synthetic field backed by
  `get_all_notes_extended`.
- Booleans: LOM returns `0`/`1`; output fields typed `Boolean` coerce automatically; input booleans
  are converted with `toLiveBool` before `set` and inside note dictionaries.
- Failures: the `v8` layer catches exceptions and returns `{ status: "failed", message }`; the Node
  layer rethrows the string, which Yoga surfaces as a GraphQL error. Messages do not say which object
  or function failed.
- `clip_set_properties` issues its `set` calls through `Promise.all`. Ordering is only sequential by
  accident of the single-threaded Max message queue.

Current Clip fields: `end_time`, `is_arrangement_clip`, `is_midi_clip`, `length`, `looping`, `name`,
`signature_denominator`, `signature_numerator`, `start_time`, `notes`. No marker, loop, color, mute,
or playing-state fields. No `Clip.view`.

## Why Prelive Needs This

Prelive's note list editor keeps a local draft and writes it back as three sequential mutations.
Prelive's reliability research (`docs/note-list-editor-reliability-and-duplicate-research.md`)
identified three needs that LiveQL cannot satisfy today:

| Need                                                | Blocking LiveQL gap                                             |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Extend playback so out-of-range duplicates are heard | No `loop_end`, `end_marker`, `loop_start`, `start_marker` access |
| Map temporary note IDs to Live IDs after a write     | `clip_add_new_notes` drops the returned ID list                  |
| Refetch exactly the written clip to verify           | Clips are reachable only via the detail view or a slot index     |

The LOM confirms the shape of the fix. `Clip.length` is read-only and derived: "For looped clips: loop
length in beats. Otherwise it's the distance in beats from start to end marker" (`clip/index.md`).
The writable properties are `loop_start`, `loop_end`, `start_marker`, `end_marker`, and `position`.
`add_new_notes` "Returns a list of note IDs of the added notes" (`clip/index.md`).

Prelive's operation roadmap (`docs/note-list-editor-development-research.md`, Phases 1 through 3)
also lists quantize, Duplicate placement parity with Live, selection sync, transpose, time-range
operations, fit to scale, and audition. Several map directly onto LOM functions and properties that
should be exposed in the same pass: `quantize`, `duplicate_notes_by_id`, `duplicate_region`,
`select_notes_by_id`, `get_selected_notes_extended`, `Clip.View.grid_quantization`,
`Song.scale_intervals`, `Song.swing_amount`, `Clip.scrub`.

## Design Rules For The Pass

These follow the LiveQL `AGENTS.md` conventions and the existing resolver patterns.

- **Mirror LOM names verbatim.** Field names, argument names, and mutation suffixes come from
  `refs/m4l-docs/apiref/lom/`. Do not invent synthetic "playback_end" style fields; clients derive
  those from `looping`, `loop_end`, and `end_marker`.
- **Every mutation returns the refreshed parent object.** Keep this. Where the LOM function also
  returns data (note IDs), return a payload type that carries both.
- **Read-only LOM functions become fields, not mutations.** `get_notes_by_id`,
  `get_notes_extended`, and `get_selected_notes_extended` are queries. Add them as `Clip` fields and
  mark the existing `clip_get_*` mutations `@deprecated` rather than deleting them.
- **Property batches are sequential and ordered.** Replace `Promise.all` in `clip_set_properties`
  with a for-await loop in a documented order. Marker ordering is described below.
- **Expose `type` on every object.** The bridge already returns it. It lets by-id queries reject an id
  that points at the wrong object kind, and lets clients disambiguate without path parsing.
- **Errors name the operation.** Wrap the bridge message as
  `liveql: <action> <property-or-function> on <idOrPath>: <message>`. Throw `Error` objects, not
  strings.
- **Nullability follows the LOM.** Properties documented as MIDI-only or audio-only are nullable and
  resolvers return `null` when `is_midi_clip` or `is_audio_clip` says they do not apply.
- **Do not add per-note expression, MPE, or envelope APIs.** The note dictionary API has no MPE
  fields (`clip/index.md`, `get_all_notes_extended`), and envelopes are out of scope.

## Change 1: Clip Markers And Extended Clip Properties

### New Clip fields

All from `clip/index.md`. Access column from the LOM entry where it states one; "get set" where the
LOM lists no access line, which is the LOM's default for properties.

| Field                 | Type     | LOM access  | Notes                                                                                   |
| --------------------- | -------- | ----------- | --------------------------------------------------------------------------------------- |
| `type`                | String!  | bridge      | Always `"Clip"`; comes from `live.type`                                                  |
| `loop_start`          | Float!   | get set     | Looped: loop start. Unlooped: clip start. Beats for MIDI clips                           |
| `loop_end`            | Float!   | get set     | Looped: loop end. Unlooped: clip end                                                     |
| `start_marker`        | Float!   | get set     | Independent of loop state. "Cannot be set behind the end marker"                        |
| `end_marker`          | Float!   | get set     | Independent of loop state. "Cannot be set before the start marker"                      |
| `position`            | Float!   | get set     | Equals `loop_start`; setting preserves loop length                                       |
| `is_session_clip`     | Boolean! | get         |                                                                                         |
| `is_audio_clip`       | Boolean! | get         |                                                                                         |
| `is_take_lane_clip`   | Boolean! | get         |                                                                                         |
| `muted`               | Boolean! | get set     | Clip Activator off                                                                      |
| `color`               | Int!     | get set     | `0x00rrggbb`; set snaps to nearest palette color                                        |
| `color_index`         | Int!     | get set     |                                                                                         |
| `is_playing`          | Boolean! | get set     | Set is documented; expose set through a mutation, not the property batch                |
| `is_recording`        | Boolean! | get         |                                                                                         |
| `is_triggered`        | Boolean! | get         |                                                                                         |
| `is_overdubbing`      | Boolean! | get         |                                                                                         |
| `playing_position`    | Float!   | get         | Beats of absolute clip time for MIDI; 0 when stopped                                    |
| `launch_mode`         | Int!     | get set     | 0 Trigger, 1 Gate, 2 Toggle, 3 Repeat                                                   |
| `launch_quantization` | Int!     | get set     | 0 Global … 14 1/32; table in LOM                                                        |
| `legato`              | Boolean! | get set     |                                                                                         |
| `velocity_amount`     | Float!   | get set     | 0 to 1                                                                                  |
| `has_envelopes`       | Boolean! | get         |                                                                                         |
| `has_groove`          | Boolean! | get         |                                                                                         |
| `will_record_on_start`| Boolean! | get         |                                                                                         |
| `view`                | ClipView!| child       | See Change 6                                                                            |

Keep `end_time` and `start_time`. `end_time` is useful precisely because for Session clips it already
resolves the loop state: "if Loop is on, this is the Loop End, otherwise it's the End Marker"
(`clip/index.md`). Verify this in Live before Prelive relies on it as the effective playback end; the
raw markers are the ground truth either way.

Audio-only properties (`gain`, `warp_mode`, `warping`, `pitch_coarse`, `pitch_fine`, `file_path`,
`sample_length`, `sample_rate`, `ram_mode`, `warp_markers`, `available_warp_modes`) are out of scope.
If added later they must be nullable and return `null` for MIDI clips.

### Extend `ClipPropertiesInput`

```graphql
input ClipPropertiesInput {
  name: String
  signature_numerator: Int
  signature_denominator: Int
  looping: Boolean
  loop_start: Float
  loop_end: Float
  start_marker: Float
  end_marker: Float
  position: Float
  muted: Boolean
  color: Int
  color_index: Int
  launch_mode: Int
  launch_quantization: Int
  legato: Boolean
  velocity_amount: Float
}
```

`clip_set_looping` stays for compatibility and can be marked `@deprecated` in favor of the batch.

### Marker ordering rule

Live rejects a start marker set past the end marker and an end marker set before the start marker
(`clip/index.md`, `start_marker`, `end_marker`). The same constraint should be assumed for
`loop_start` and `loop_end`. Apply the batch in this order so no intermediate state violates it:

1. Read the current clip once (`getClip`) so the resolver knows the current values.
2. Non-marker scalars in any order: `name`, signatures, `looping`, `muted`, `color`, `color_index`,
   `launch_mode`, `launch_quantization`, `legato`, `velocity_amount`.
3. Ends that grow: set `end_marker` if the new value is greater than current, then `loop_end` if
   greater than current.
4. Starts, in any direction: `start_marker`, then `loop_start`. Ends are already at their final or
   larger value.
5. Ends that shrink: `end_marker`, then `loop_end`, if not already applied in step 3.
6. `position` last. It moves the loop while preserving its length.

Whether `looping` is toggled before or after markers does not matter for correctness; the LOM
states `start_marker` and `end_marker` are independent of loop state. Toggle it in step 2.

After the batch, re-read the clip and return it. Live can clamp or ignore an invalid marker set
without raising a JavaScript exception in the `v8` layer, so callers must compare the returned values
with what they asked for. Document this on the mutation with a JSDoc in the resolver.

### Open question: unlooped `loop_start` and `loop_end`

The LOM says that for unlooped clips `loop_start` and `loop_end` are "clip start" and "clip end". It
does not say whether they alias `start_marker` and `end_marker` in that state or hold the last loop
values. Test in Live: unloop a clip, set `end_marker`, read `loop_end`. Record the answer in the
resolver JSDoc. Prelive will use `looping ? loop_end : end_marker` regardless.

## Change 2: Return Note IDs From Additions

`add_new_notes` returns the new IDs. `clip_add_new_notes` currently returns only `Clip`. Change it to
a payload:

```graphql
type ClipNotesPayload {
  clip: Clip!
  note_ids: [Int!]!
}

clip_add_new_notes(id: Int!, notes_dictionary: NotesDictionaryInput!): ClipNotesPayload!
```

The order of `note_ids` corresponds to the order of the input notes. That is the assumption a client
needs for temporary-id mapping; verify it with a three-note add of distinct pitches and confirm the
ids map back through `notes_by_id`.

**Verify in Max first:** the shape `LiveAPI.call("add_new_notes", dict)` returns in the `v8` runtime.
The bridge forwards whatever `live.call` returns as `data`. It may be a flat array of ints, an array
prefixed with a symbol, or a JSON string like the note dictionaries. Print it once from
`liveql-m4l.js` with `post()` and normalize in the Node resolver.

This is a breaking change for Prelive's `AddNotesData` schema, which decodes `{ id }`. Prelive's
follow-up list covers that.

## Change 3: Direct By-Id Queries

```graphql
type Query {
  live_set: Song!
  live_app: Application!
  clip(id: Int!): Clip
  clip_slot(id: Int!): ClipSlot
  track(id: Int!): Track
  scene(id: Int!): Scene
}
```

Resolver pattern: call the existing `getClip(id)`, catch the bridge's "Invalid live id or path"
failure and return `null`, and also return `null` when the returned `type` is not the expected LOM
type. The `type` check is why Change 1 exposes `type`.

`live_app` gives clients the Live version through `Application` functions `get_major_version`,
`get_minor_version`, `get_bugfix_version` (`application/index.md`). Several note APIs are gated by
version (`duplicate_notes_by_id` since 11.1.2, `select_notes_by_id` since 11.0.6), so exposing it now
avoids guesswork later.

```graphql
type Application {
  id: Int!
  path: String!
  type: String!
  major_version: Int!
  minor_version: Int!
  bugfix_version: Int!
}
```

## Change 4: Composite Note Write

Prelive's write is three sequential mutations, soon four with a marker change. A composite mutation
does the same work server-side in one HTTP request, with a fixed order, and returns the verified
clip in the same round trip. It is not atomic; nothing over the LOM is. Its value is one round trip,
one documented order, and an error that names the failed step.

```graphql
input ClipWriteNotesInput {
  properties: ClipPropertiesInput
  add: [NoteInput!]
  modify: [NoteInput!]
  remove_ids: [Int!]
}

type ClipWriteNotesPayload {
  clip: Clip!
  added_note_ids: [Int!]!
}

clip_write_notes(id: Int!, input: ClipWriteNotesInput!): ClipWriteNotesPayload!
```

Order of operations, chosen so a failure leaves the most recoverable state:

1. `properties` via the marker-ordered batch above. A boundary that grows before notes are added
   means a later note failure leaves a clip that is longer than needed but hides nothing.
2. `add` via `add_new_notes`, capturing ids.
3. `modify` via `apply_note_modifications`. The LOM ignores the whole list if any id is missing
   (`clip/index.md`, `apply_note_modifications`), so this step should fail loudly when the returned
   clip does not reflect the change. At minimum, surface the LOM error if one is raised.
4. `remove_ids` via `remove_notes_by_id`.

On failure at step N, throw an error whose message names the step and includes the ids added in step
2 if that step completed, for example
`liveql: clip_write_notes step modify failed after add (ids 412,413,414): <message>`. The client then
refetches; it does not retry the same payload.

Keep the individual mutations. The composite is additive.

## Change 5: Note Query Fields And Remaining Clip Functions

### Clip fields backed by read-only note functions

```graphql
type Clip {
  # ...
  notes: [Note!]
  notes_by_id(note_ids: [Int!]!): [Note!]
  notes_in_region(from_pitch: Int!, pitch_span: Int!, from_time: Float!, time_span: Float!): [Note!]
  selected_notes: [Note!]
}
```

All are `null` for audio clips, sorted with the existing `compareNotes`. `notes_by_id` maps to
`get_notes_by_id`, which accepts either a list or a dictionary with `note_ids` (`clip/index.md`).
Use the dictionary form so it matches `duplicate_notes_by_id`.

Mark `clip_get_notes_extended`, `clip_get_selected_notes_extended`, and
`clip_get_all_notes_extended` `@deprecated(reason: "Use Clip fields")`.

### New Clip mutations

| Mutation                        | LOM function            | Arguments                                                                       | Returns            |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------- | ------------------ |
| `clip_duplicate_notes_by_id`    | `duplicate_notes_by_id` | `note_ids: [Int!]!`, `destination_time: Float`, `transposition_amount: Int`     | `ClipNotesPayload!` if the call returns ids, else `Clip!` (verify) |
| `clip_duplicate_region`         | `duplicate_region`      | `region_start: Float!`, `region_length: Float!`, `destination_time: Float!`, `pitch: Int = -1`, `transposition_amount: Int = 0` | `Clip!` |
| `clip_quantize`                 | `quantize`              | `quantization_grid: Int!`, `amount: Float!`                                     | `Clip!`            |
| `clip_quantize_pitch`           | `quantize_pitch`        | `pitch: Int!`, `quantization_grid: Int!`, `amount: Float!`                      | `Clip!`            |
| `clip_select_notes_by_id`       | `select_notes_by_id`    | `note_ids: [Int!]!`                                                             | `Clip!`            |
| `clip_deselect_all_notes`       | `deselect_all_notes`    |                                                                                 | `Clip!`            |
| `clip_duplicate_loop`           | `duplicate_loop`        |                                                                                 | `Clip!`            |
| `clip_crop`                     | `crop`                  |                                                                                 | `Clip!`            |
| `clip_stop`                     | `stop`                  |                                                                                 | `Clip!`            |
| `clip_scrub`                    | `scrub`                 | `beat_time: Float!`                                                             | `Clip!`            |
| `clip_stop_scrub`               | `stop_scrub`            |                                                                                 | `Clip!`            |
| `clip_move_playing_pos`         | `move_playing_pos`      | `beats: Float!`                                                                 | `Clip!`            |
| `clip_set_fire_button_state`    | `set_fire_button_state` | `state: Boolean!`                                                               | `Clip!`            |

Notes:

- `duplicate_notes_by_id` "will be inserted after the last selected note" when `destination_time` is
  omitted, and "This behavior can be observed when duplicating notes in the Live GUI"
  (`clip/index.md`). Prelive's Duplicate research needs this as the behavioral oracle for placement.
  The dictionary form takes `note_ids`, `destination_time`, `transposition_amount`; build the
  dictionary with only the keys that were supplied.
- `quantize` uses the song's `swing_amount` (`song/index.md`). The `quantization_grid` int mapping is
  not documented in the LOM page. Expected to follow Live's `GridQuantization` enum order
  (no grid, 1/32, 1/16, 1/8, 1/4, 1/2, bar, 2 bars, 4 bars, 8 bars) but this must be confirmed
  empirically and recorded in a resolver JSDoc.
- `quantize_pitch` is documented as "Same as quantize, but only for notes in the given pitch". The
  argument order beyond `pitch` is not stated; assume `pitch, quantization_grid, amount` and verify.
- `scrub` respects global quantization and continues until `stop_scrub`. Together with
  `playing_position` this is the closest thing to an audition API the LOM offers for a clip.
- `selected_notes` plus `clip_select_notes_by_id` let a client mirror Live's note selection in both
  directions. `select_notes_by_id` "will not print a warning or error if the list contains
  nonexistent IDs" (`clip/index.md`), so a client cannot rely on it for id validation.

## Change 6: Clip.View

```graphql
type ClipView {
  id: Int!
  path: String!
  type: String!
  grid_quantization: Int!
  grid_is_triplet: Boolean!
}

clip_view_set_properties(id: Int!, properties: ClipViewPropertiesInput!): ClipView!
clip_view_show_loop(id: Int!): ClipView!

input ClipViewPropertiesInput {
  grid_quantization: Int
  grid_is_triplet: Boolean
}
```

Source: `clip_view/index.md`. The clip's current grid is what Live's Duplicate and quantize commands
use in the GUI, so a client that wants Live-parity placement needs to read it. The int mapping for
`grid_quantization` is undocumented; determine it empirically alongside `quantize` above and document
both in one place.

Resolver: `Clip.view` is a single child, fetched with `childKeysSingle: ["view"]` like `Song.view`.

## Change 7: Song, Song.View, Track, ClipSlot, Scene Coverage

### Song

Properties to add (`song/index.md`), all readable, set where noted:

| Field                          | Type      | Set | Why                                                                |
| ------------------------------ | --------- | --- | ------------------------------------------------------------------ |
| `type`                         | String!   |     |                                                                    |
| `name`                         | String!   |     | Empty if unsaved                                                   |
| `file_path`                    | String!   |     |                                                                    |
| `tempo`                        | Float!    | yes | 20 to 999                                                          |
| `signature_numerator`          | Int!      | yes |                                                                    |
| `signature_denominator`        | Int!      | yes |                                                                    |
| `current_song_time`            | Float!    | yes | Beats                                                              |
| `start_time`                   | Float!    | yes | Playback start position                                            |
| `last_event_time`              | Float!    |     |                                                                    |
| `song_length`                  | Float!    |     |                                                                    |
| `loop`                         | Boolean!  | yes | Arrangement loop                                                   |
| `loop_start`                   | Float!    | yes |                                                                    |
| `loop_length`                  | Float!    | yes |                                                                    |
| `metronome`                    | Boolean!  | yes |                                                                    |
| `swing_amount`                 | Float!    | yes | Affects `Clip.quantize`                                            |
| `midi_recording_quantization`  | Int!      | yes |                                                                    |
| `clip_trigger_quantization`    | Int!      | yes | Global launch quantization                                         |
| `root_note`                    | Int!      | yes | 0 = C                                                              |
| `scale_name`                   | String!   | yes |                                                                    |
| `scale_intervals`              | [Int!]!   |     | Multi-value property; use `propertyKeysMultiple`                   |
| `scale_mode`                   | Boolean!  | yes |                                                                    |
| `can_undo`                     | Boolean!  |     |                                                                    |
| `can_redo`                     | Boolean!  |     |                                                                    |
| `record_mode`                  | Boolean!  | yes |                                                                    |
| `session_record`               | Boolean!  | yes |                                                                    |
| `overdub`                      | Boolean!  | yes |                                                                    |
| `arrangement_overdub`          | Boolean!  | yes |                                                                    |
| `is_counting_in`               | Boolean!  |     |                                                                    |
| `can_capture_midi`             | Boolean!  |     |                                                                    |

Children to add: `scenes: [Scene!]!`, `scene(index: Int!): Scene`, `return_tracks: [Track!]!`,
`visible_tracks: [Track!]!`, `master_track: Track!`, `cue_points` can wait.

Mutations:

| Mutation                    | LOM                     | Arguments                                   |
| --------------------------- | ----------------------- | ------------------------------------------- |
| `song_set_properties`       | property sets           | `SongPropertiesInput` with every "Set: yes" row |
| `song_undo`                 | `undo`                  |                                             |
| `song_redo`                 | `redo`                  |                                             |
| `song_stop_all_clips`       | `stop_all_clips`        | `quantized: Boolean = true`                 |
| `song_jump_by`              | `jump_by`               | `beats: Float!`                             |
| `song_capture_midi`         | `capture_midi`          | `destination: Int = 0`                      |
| `song_create_midi_track`    | `create_midi_track`     | `index: Int = -1`                           |
| `song_create_scene`         | `create_scene`          | `index: Int = -1`                           |
| `song_tap_tempo`            | `tap_tempo`             |                                             |

`song_undo` and `song_redo` affect the whole Live Set, including user actions taken outside the API.
Expose them; the client decides whether to use them. Prelive's reliability research already rules
them out as a substitute for local draft history.

### Song.View

From `song_view/index.md`:

```graphql
type SongView {
  id: Int!
  path: String!
  type: String!
  selected_track: Track
  detail_clip: Clip
  highlighted_clip_slot: ClipSlot
  selected_scene: Scene
  draw_mode: Boolean!
  follow_song: Boolean!
}

song_view_set_detail_clip(id: Int!, clip_id: Int!): SongView!
song_view_set_selected_track(id: Int!, track_id: Int!): SongView!
song_view_set_highlighted_clip_slot(id: Int!, clip_slot_id: Int!): SongView!
song_view_set_selected_scene(id: Int!, scene_id: Int!): SongView!
song_view_set_properties(id: Int!, properties: SongViewPropertiesInput!): SongView!
```

`detail_clip`, `highlighted_clip_slot`, `selected_scene`, and `selected_track` are settable children.
Setting a child through `LiveAPI.set` takes the value `"id N"`; verify the exact form the `v8` bridge
needs (the string `id 12` versus the array `["id", 12]`). Being able to push a clip into Live's
Detail View is what lets a navigator in a client open the clip the user picked.

### Track

From `track/index.md`. Add:

| Field                  | Type        | Set |
| ---------------------- | ----------- | --- |
| `type`                 | String!     |     |
| `arrangement_clips`    | [Clip!]!    |     |
| `arrangement_clip(index: Int!)` | Clip |     |
| `arm`                  | Boolean!    | yes |
| `can_be_armed`         | Boolean!    |     |
| `mute`                 | Boolean!    | yes |
| `solo`                 | Boolean!    | yes |
| `muted_via_solo`       | Boolean!    |     |
| `color`                | Int!        | yes |
| `color_index`          | Int!        | yes |
| `has_audio_input`      | Boolean!    |     |
| `has_audio_output`     | Boolean!    |     |
| `has_midi_output`      | Boolean!    |     |
| `is_foldable`          | Boolean!    |     |
| `is_grouped`           | Boolean!    |     |
| `is_visible`           | Boolean!    |     |
| `is_frozen`            | Boolean!    |     |
| `fold_state`           | Int         | yes | (null unless `is_foldable`) |
| `group_track`          | Track       |     |
| `playing_slot_index`   | Int!        |     |
| `fired_slot_index`     | Int!        |     |

`arm`, `mute`, `solo`, `playing_slot_index`, `fired_slot_index` are documented as not available on
return or master tracks. Make them nullable and return `null` when the property read fails, since
`Song.return_tracks` and `Song.master_track` resolve to the same `Track` type.

Mutations:

| Mutation                              | LOM                            | Arguments                                   |
| ------------------------------------- | ------------------------------ | ------------------------------------------- |
| `track_set_properties`                | property sets                  | `name, arm, mute, solo, color, color_index, fold_state` |
| `track_stop_all_clips`                | `stop_all_clips`               |                                             |
| `track_create_midi_clip`              | `create_midi_clip`             | `start_time: Float!, length: Float!`        |
| `track_delete_clip`                   | `delete_clip`                  | `clip_id: Int!`                             |
| `track_duplicate_clip_slot`           | `duplicate_clip_slot`          | `index: Int!`                               |
| `track_duplicate_clip_to_arrangement` | `duplicate_clip_to_arrangement`| `clip_id: Int!, destination_time: Float!`   |
| `track_jump_in_running_session_clip`  | `jump_in_running_session_clip` | `beats: Float!`                             |

`track_set_name` stays, `@deprecated` in favor of the batch.

### ClipSlot

From `clipslot/index.md`:

| Field                   | Type     |
| ----------------------- | -------- |
| `type`                  | String!  |
| `is_playing`            | Boolean! |
| `is_recording`          | Boolean! |
| `is_triggered`          | Boolean! |
| `playing_status`        | Int!     |
| `has_stop_button`       | Boolean! (settable) |
| `is_group_slot`         | Boolean! |
| `will_record_on_start`  | Boolean! |
| `color`                 | Int      |

Mutations:

| Mutation                      | LOM                  | Arguments                                              |
| ----------------------------- | -------------------- | ------------------------------------------------------ |
| `clip_slot_fire`              | `fire`               | `record_length: Float`, `launch_quantization: Int`     |
| `clip_slot_stop`              | `stop`               |                                                        |
| `clip_slot_create_clip`       | `create_clip`        | `length: Float!`                                       |
| `clip_slot_delete_clip`       | `delete_clip`        |                                                        |
| `clip_slot_duplicate_clip_to` | `duplicate_clip_to`  | `target_clip_slot_id: Int!`                            |
| `clip_slot_set_has_stop_button` | property set       | `has_stop_button: Boolean!`                            |

`clip_slot_create_clip` is how a client creates an empty MIDI clip from nothing, which the current
schema cannot do at all.

### Scene

From `scene/index.md`, new type:

```graphql
type Scene {
  id: Int!
  path: String!
  type: String!
  name: String!
  color: Int!
  color_index: Int!
  is_empty: Boolean!
  is_triggered: Boolean!
  tempo: Float!
  tempo_enabled: Boolean!
  time_signature_numerator: Int!
  time_signature_denominator: Int!
  time_signature_enabled: Boolean!
  clip_slots: [ClipSlot!]!
}

scene_fire(id: Int!, force_legato: Boolean): Scene!
scene_set_properties(id: Int!, properties: ScenePropertiesInput!): Scene!
```

## Bridge Changes In `liveql-m4l.js`

Most of the pass is Node-side schema and resolver work. The `v8` layer needs three small changes.

1. **Preserve non-scalar `call` results.** Confirm what `live.call` returns for `add_new_notes`
   and `duplicate_notes_by_id`. If it is an array, `JSON.stringify` already carries it. If it comes
   back as a Max list with a leading symbol, strip it in the bridge and document why in a JSDoc.
2. **Empty symbols.** `get` only records a property when `live.get(k).length === 1`. An empty
   `name` may come back as an empty array, which would drop a non-null `String!` field and fail the
   whole query. Record empty-string for symbol properties, or read them with `getstring`. Test with an
   unsaved Set (`Song.name` is documented as empty) and an unnamed clip.
3. **Child sets.** For `song_view_set_detail_clip` and the other child setters, determine whether
   `live.set("detail_clip", "id 12")` or `live.set("detail_clip", ["id", 12])` is accepted and encode
   that once in a helper.

Optional but recommended: include `live.type` and the action in `outletFailedResult` messages so
Node can build the operation-naming error described above.

## Breaking Changes

| Change                                     | Effect on Prelive                                                     |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `clip_add_new_notes` returns a payload     | `AddNotesData` schema and `writeNotes` must decode `{ clip, note_ids }` |
| `clip_get_*` mutations deprecated          | None immediately; migrate reads to `Clip` fields when convenient      |
| `clip_set_looping`, `track_set_name` deprecated | None immediately                                                  |

Everything else is additive. Regenerate `refs/liveql-schema.graphql` in Prelive with
`pnpm liveql:schema` against the running device once the LiveQL change lands.

## Verification Matrix

No automated tests exist in LiveQL; the device is exercised by hand through GraphiQL at
`http://localhost:4000/graphql`. Run these against a disposable Live Set and record results in
resolver JSDocs where they resolve an open question.

1. `add_new_notes` return shape, and that `note_ids` order matches input order.
2. `duplicate_notes_by_id` return value, and its default placement for: one grid-aligned sixteenth, one
   off-grid note, a chord with mixed durations, two notes with a gap, overlapping notes, and notes
   ending beyond `loop_end`. This doubles as the placement characterization Prelive's Duplicate
   research asks for.
3. Marker batch: grow `end_marker` then `loop_end` on a looped clip; shrink both; set `start_marker`
   past `end_marker` and confirm Live's rejection is surfaced or at least visible in the returned
   clip.
4. Unlooped clip: set `end_marker`, read `loop_end`; set `loop_end`, read `end_marker`.
5. `end_time` on a Session clip with looping on and off, compared with `loop_end` and `end_marker`.
6. `grid_quantization` and `quantize` int mappings, by changing the grid in Live's editor and reading
   the value, then quantizing with each value and inspecting note starts.
7. `Song.name` on an unsaved Set and an unnamed clip do not fail the query.
8. `song_view_set_detail_clip` opens the target clip in Live's Detail View.
9. `Query.clip(id)` with a track id returns `null`, not an error.
10. `clip_write_notes` with a deliberately stale id in `modify` after a successful `add`: the error
    names the step and lists the added ids.

## Prelive Follow-Ups After The LiveQL Change

- Run `pnpm liveql:schema` to refresh `refs/liveql-schema.graphql`.
- Extend `Domain.Clip` and `Domain.ClipWithNotes` with the marker fields, `is_session_clip`,
  `muted`, `color`, and `view { grid_quantization grid_is_triplet }`.
- Replace `LiveSet.writeNotes` with one `clip_write_notes` call that selects the full clip and notes
  on the payload, so the write and the verification read are one request.
- Read clips by id (`Query.clip`) for post-write refetch instead of the detail view or slot address.
- Use `added_note_ids` to drop the negative temporary ids without a remount if that becomes desirable;
  the remount path still works.
- Derive effective playback range as `looping ? [loop_start, loop_end] : [start_marker, end_marker]`
  and extend it in the draft when duplicated notes run past it, rounding to the next bar from the
  clip's time signature per the Duplicate research.
- Read `view.grid_quantization` for Live-parity Duplicate spacing and use `song.swing_amount` and
  `song.scale_intervals` for the Phase 2 and 3 operations.

## Sources

- LiveQL source: `../ableton-m4l-liveql/liveql-n4m.js`, `../ableton-m4l-liveql/liveql-m4l.js`
- LiveQL conventions: `../ableton-m4l-liveql/AGENTS.md`
- LiveQL prior research: `../ableton-m4l-liveql/docs/lom-schema-research.md`
- LOM Clip: `refs/m4l-docs/apiref/lom/clip/index.md` (in the LiveQL repo; also at
  `../ableton-extension-prelive/refs/m4l-docs/apiref/lom/clip/index.md`)
- LOM Clip.View: `refs/m4l-docs/apiref/lom/clip_view/index.md`
- LOM Song: `refs/m4l-docs/apiref/lom/song/index.md`
- LOM Song.View: `refs/m4l-docs/apiref/lom/song_view/index.md`
- LOM Track: `refs/m4l-docs/apiref/lom/track/index.md`
- LOM ClipSlot: `refs/m4l-docs/apiref/lom/clipslot/index.md`
- LOM Scene: `refs/m4l-docs/apiref/lom/scene/index.md`
- LOM Application: `refs/m4l-docs/apiref/lom/application/index.md`
- Max LiveAPI JS reference: `refs/m4l-docs/apiref/js/liveapi/index.md`
- Prelive editor research: `docs/note-list-editor-reliability-and-duplicate-research.md`,
  `docs/note-list-editor-development-research.md`
