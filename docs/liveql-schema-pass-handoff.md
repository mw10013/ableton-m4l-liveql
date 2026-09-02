# LiveQL Schema Pass: Handoff For Prelive

Date: 2026-09-01

Records what changed in LiveQL's GraphQL schema when `docs/liveql-note-editing-enhancement-research.md`
was implemented, with the naming corrections applied on top. Written for the agent working in the
Prelive repository (`../ableton-extension-prelive`, which mirrors this repo read-only at `refs/liveql/`)
so it can update Prelive's queries, domain types and schema ref without reading LiveQL's source.

There are no compatibility shims. Renamed and removed members are gone, not deprecated.

## Naming Rule

Every name in the schema is a Live Object Model (LOM) name, taken from `refs/m4l-docs/apiref/lom/`:

- Object types are LOM classes: `Song`, `SongView`, `Track`, `ClipSlot`, `Scene`, `Clip`, `ClipView`,
  `Application`.
- Fields are LOM properties and children under their exact snake_case names. Read-only LOM functions
  are fields too, under the full function name including `get_` (`Clip.get_all_notes_extended`,
  `Application.get_major_version`).
- Mutations are `<object>_<function>` for LOM functions (`clip_duplicate_loop`, `scene_fire`) and
  `<object>_set_<property>` for single property writes (`clip_slot_set_has_stop_button`,
  `song_view_set_detail_clip`).
- Mutation arguments are the LOM parameter names (`destination_time`, `force_legato`,
  `target_clip_slot`) or, for functions that take a dictionary, the dictionary keys (`notes`,
  `note_ids`, `transposition_amount`).
- Two things have no LOM name and are the only invented ones: the `*_set_properties` batch mutations
  (the LOM operation is `set`; the batch groups several) and `clip_write_notes` (a composite of four LOM
  operations, whose input keys are the names of the functions it runs).

## Breaking Changes

| Before | After | Notes |
| --- | --- | --- |
| `Clip.notes: [Note!]` | `Clip.get_all_notes_extended: NotesDictionary` | Select `{ notes { ... } }`. In the LOM `notes` is an observer bang, not a list, so the old name collided |
| `clip_add_new_notes(id, notes_dictionary: { notes: [...] })` returns `Clip` | `clip_add_new_notes(id, notes: [NoteInput!]!)` returns `ClipNotesPayload { clip, note_ids }` | `note_ids` are the ids Live assigned, in input order (confirmed in Live) |
| `clip_apply_note_modifications(id, notes_dictionary: { notes })` | `clip_apply_note_modifications(id, notes: [NoteInput!]!)` | Now fails with an error naming missing `note_id`s instead of silently doing nothing |
| `clip_remove_notes_by_id(id, ids)` | `clip_remove_notes_by_id(id, note_ids)` | |
| `clip_get_all_notes_extended`, `clip_get_notes_extended`, `clip_get_selected_notes_extended` mutations | `Clip.get_all_notes_extended`, `Clip.get_notes_extended(...)`, `Clip.get_selected_notes_extended` fields | Removed as mutations |
| `clip_set_looping(id, looping)` | `clip_set_properties(id, properties: { looping })` | Removed |
| `track_set_name(id, name)` | `track_set_properties(id, properties: { name })` | Removed |
| `NotesDictionaryInput` | gone | Note lists are passed directly |

Everything else is additive.

## Prelive Follow-Ups

1. Regenerate `refs/liveql-schema.graphql` with `pnpm liveql:schema` against the running device.
2. `Domain.Clip` / `Domain.ClipWithNotes`: read notes from `get_all_notes_extended { notes }`. Add the
   marker fields `loop_start`, `loop_end`, `start_marker`, `end_marker`, `position`, plus
   `is_session_clip`, `muted`, `color`, `view { grid_quantization grid_is_triplet }`.
3. `AddNotesData` / `writeNotes`: decode `{ clip, note_ids }` from `clip_add_new_notes`, or replace the
   three-mutation write with one `clip_write_notes` call (below).
4. Post-write refetch: `query { clip(id: $id) { ... } }` instead of walking `detail_clip` or a slot index.
5. Effective playback range: `looping ? [loop_start, loop_end] : [start_marker, end_marker]`.
6. Any `clip_set_looping` or `track_set_name` call moves to the `_set_properties` batch.

## New Surface

### Query

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

By-id queries return `null` for an unknown id and for an id whose LOM `type` is not the requested
class. They never raise.

```graphql
type Application {
  id: Int!
  path: String!
  type: String!
  get_major_version: Int!
  get_minor_version: Int!
  get_bugfix_version: Int!
  get_version_string: String!
}
```

### Every object type

All object types now carry `type: String!`, the LOM class name (`"Clip"`, `"Song.View"`), read from
`LiveAPI.type`.

### Clip

Fields, all LOM properties unless noted:

`name color color_index is_arrangement_clip is_session_clip is_take_lane_clip is_audio_clip
is_midi_clip length looping loop_start loop_end start_marker end_marker position start_time end_time
signature_numerator signature_denominator muted is_playing is_recording is_triggered is_overdubbing
playing_position launch_mode launch_quantization legato velocity_amount has_envelopes has_groove
will_record_on_start`

Children and function-backed fields:

```graphql
view: ClipView!
get_all_notes_extended: NotesDictionary
get_notes_by_id(note_ids: [Int!]!): NotesDictionary
get_notes_extended(from_pitch: Int!, pitch_span: Int!, from_time: Float!, time_span: Float!): NotesDictionary
get_selected_notes_extended: NotesDictionary
```

The four note fields are `null` on audio clips. Notes are sorted by `start_time` then `pitch`.

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

`clip_set_properties` applies the batch sequentially in an order that never violates Live's marker
constraints: non-marker scalars, then ends that grow (`end_marker`, `loop_end`), then starts
(`start_marker`, `loop_start`), then ends that shrink, then `position`. Live may clamp a value without
raising, so compare the returned clip with what was requested.

Clip mutations, all returning `Clip` unless noted:

```graphql
clip_set_properties(id: Int!, properties: ClipPropertiesInput!): Clip
clip_add_new_notes(id: Int!, notes: [NoteInput!]!): ClipNotesPayload
clip_apply_note_modifications(id: Int!, notes: [NoteInput!]!): Clip
clip_write_notes(id: Int!, input: ClipWriteNotesInput!): ClipNotesPayload
clip_fire(id: Int!): Clip
clip_stop(id: Int!): Clip
clip_select_all_notes(id: Int!): Clip
clip_select_notes_by_id(id: Int!, note_ids: [Int!]!): Clip
clip_deselect_all_notes(id: Int!): Clip
clip_remove_notes_by_id(id: Int!, note_ids: [Int!]!): Clip
clip_remove_notes_extended(id: Int!, from_pitch: Int!, pitch_span: Int!, from_time: Float!, time_span: Float!): Clip
clip_duplicate_notes_by_id(id: Int!, note_ids: [Int!]!, destination_time: Float, transposition_amount: Int): Clip
clip_duplicate_region(id: Int!, region_start: Float!, region_length: Float!, destination_time: Float!, pitch: Int = -1, transposition_amount: Int = 0): Clip
clip_duplicate_loop(id: Int!): Clip
clip_crop(id: Int!): Clip
clip_quantize(id: Int!, quantization_grid: Int!, amount: Float!): Clip
clip_quantize_pitch(id: Int!, pitch: Int!, quantization_grid: Int!, amount: Float!): Clip
clip_scrub(id: Int!, beat_time: Float!): Clip
clip_stop_scrub(id: Int!): Clip
clip_move_playing_pos(id: Int!, beats: Float!): Clip
clip_set_fire_button_state(id: Int!, state: Boolean!): Clip
```

`clip_duplicate_notes_by_id` omits `destination_time` from the dictionary when not given, so Live
places the copies "after the last selected note" exactly as Duplicate does in the GUI.

### Composite write

```graphql
input ClipWriteNotesInput {
  properties: ClipPropertiesInput
  add_new_notes: [NoteInput!]
  apply_note_modifications: [NoteInput!]
  remove_notes_by_id: [Int!]
}

type ClipNotesPayload {
  clip: Clip!
  note_ids: [Int!]!
}
```

Runs in key order: `properties` (marker-ordered batch), `add_new_notes`, `apply_note_modifications`,
`remove_notes_by_id`. Not atomic. On failure the error is
`liveql: clip_write_notes step <key> failed[ after add_new_notes (ids ...)]: <message>`; refetch with
`clip(id)` rather than retrying the same payload. `note_ids` on success are the ids added.
`apply_note_modifications` pre-checks its ids with `get_notes_by_id` and fails naming the missing ones,
since Live otherwise ignores the whole list silently.

### Clip.View

```graphql
type ClipView { id: Int! path: String! type: String! grid_quantization: Int! grid_is_triplet: Boolean! }
input ClipViewPropertiesInput { grid_quantization: Int grid_is_triplet: Boolean }
clip_view_set_properties(id: Int!, properties: ClipViewPropertiesInput!): ClipView
clip_view_show_loop(id: Int!): ClipView
```

### Song

Properties added: `name file_path tempo signature_numerator signature_denominator current_song_time
start_time last_event_time song_length loop loop_start loop_length metronome swing_amount
midi_recording_quantization clip_trigger_quantization root_note scale_name scale_intervals scale_mode
can_undo can_redo record_mode session_record overdub arrangement_overdub is_counting_in
can_capture_midi`. `name` and `file_path` are `""` for an unsaved Set.

Children added: `return_tracks`, `visible_tracks`, `master_track`, `scenes`, `scene(index)`.

```graphql
song_set_properties(id: Int!, properties: SongPropertiesInput!): Song
song_undo(id: Int!): Song
song_redo(id: Int!): Song
song_stop_all_clips(id: Int!, quantized: Boolean = true): Song
song_jump_by(id: Int!, beats: Float!): Song
song_capture_midi(id: Int!, destination: Int = 0): Song
song_create_midi_track(id: Int!, index: Int = -1): Song
song_create_scene(id: Int!, index: Int = -1): Song
song_tap_tempo(id: Int!): Song
```

`SongPropertiesInput` has every settable property above except the read-only ones (`name`,
`file_path`, `last_event_time`, `song_length`, `scale_intervals`, `can_undo`, `can_redo`,
`is_counting_in`, `can_capture_midi`).

### Song.View

```graphql
type SongView {
  id: Int! path: String! type: String!
  selected_track: Track
  detail_clip: Clip
  highlighted_clip_slot: ClipSlot
  selected_scene: Scene
  draw_mode: Boolean!
  follow_song: Boolean!
}
song_view_set_properties(id: Int!, properties: SongViewPropertiesInput!): SongView
song_view_set_detail_clip(id: Int!, detail_clip: Int!): SongView
song_view_set_selected_track(id: Int!, selected_track: Int!): SongView
song_view_set_highlighted_clip_slot(id: Int!, highlighted_clip_slot: Int!): SongView
song_view_set_selected_scene(id: Int!, selected_scene: Int!): SongView
```

The child setters take the target object's id under the property's name.

### Track

Fields added: `has_audio_input has_audio_output has_midi_output can_be_armed arm mute solo
muted_via_solo color color_index is_foldable is_grouped is_visible is_frozen fold_state
playing_slot_index fired_slot_index group_track arrangement_clips arrangement_clip(index)`.

Nullable: `arm`, `mute`, `solo`, `playing_slot_index`, `fired_slot_index` (the LOM marks them not in
return/master tracks), `fold_state` (only if `is_foldable`), `group_track` (id 0 when ungrouped).

```graphql
track_set_properties(id: Int!, properties: TrackPropertiesInput!): Track   # name arm mute solo color color_index fold_state
track_stop_all_clips(id: Int!): Track
track_create_midi_clip(id: Int!, start_time: Float!, length: Float!): Track
track_delete_clip(id: Int!, clip: Int!): Track
track_duplicate_clip_slot(id: Int!, index: Int!): Track
track_duplicate_clip_to_arrangement(id: Int!, clip: Int!, destination_time: Float!): Track
track_jump_in_running_session_clip(id: Int!, beats: Float!): Track
```

### ClipSlot

Fields added: `has_stop_button is_playing is_recording is_triggered playing_status is_group_slot
will_record_on_start color` (`color` nullable, Group Track slots only).

```graphql
clip_slot_fire(id: Int!, record_length: Float, launch_quantization: Int): ClipSlot
clip_slot_stop(id: Int!): ClipSlot
clip_slot_create_clip(id: Int!, length: Float!): ClipSlot
clip_slot_delete_clip(id: Int!): ClipSlot
clip_slot_duplicate_clip_to(id: Int!, target_clip_slot: Int!): ClipSlot
clip_slot_set_has_stop_button(id: Int!, has_stop_button: Boolean!): ClipSlot
```

The LOM takes optional arguments positionally, so `launch_quantization` without `record_length` is
rejected with an error naming the missing argument. Same for `scene_fire`.

### Scene

```graphql
type Scene {
  id: Int! path: String! type: String!
  name: String! color: Int! color_index: Int!
  is_empty: Boolean! is_triggered: Boolean!
  tempo: Float! tempo_enabled: Boolean!
  time_signature_numerator: Int! time_signature_denominator: Int! time_signature_enabled: Boolean!
  clip_slots: [ClipSlot!]!
}
scene_fire(id: Int!, force_legato: Boolean, can_select_scene_on_launch: Boolean): Scene
scene_set_properties(id: Int!, properties: ScenePropertiesInput!): Scene
```

## Errors

Every failure is a GraphQL error whose message names the LOM operation:
`liveql: <get|set|call> <property-or-function> on <id>: <Live's message>`. Composite steps prefix
that with the step name. Prelive can match on the `liveql:` prefix and the step name; do not match on
Live's text.

## Verified In Live

`pnpm test:live` (`test/live/verification-matrix.test.js`) passes against a running Set — 15 cases,
all assertions, no manual steps except the one noted below. Prelive can depend on all of this:

1. `clip_add_new_notes` returns exactly one id per input note, in input order.
2. Child setters accept the target's id (`song_view_set_detail_clip`) — the `id N` atom form works
   for `set`, not only for construction.
3. Marker batches that grow and that shrink the region both read back exactly as requested, so the
   ordering rule holds.
4. A `start_marker` set behind the end marker is **silently dropped** — no error, the old value
   stays. So always compare the returned clip with what you asked for.
5. On an unlooped clip `loop_start`/`loop_end` **do** alias `start_marker`/`end_marker`, and
   `end_time` follows `end_marker` unlooped, `loop_end` looped. The effective-range rule
   (`looping ? [loop_start, loop_end] : [start_marker, end_marker]`) is therefore safe either way.
6. `Song.name` and `file_path` on an unsaved Set come back as `""`, not a dropped field.
7. `clip(id)` with a track id, and `track(id)` with an unknown id, return `null` with no `errors`.
8. `Clip.get_notes_by_id` with an id that is not in the clip returns `notes: []`.
9. The composite failure message is literally `liveql: clip_write_notes step <step> failed after
   add_new_notes (ids <n>): liveql: apply_note_modifications on <id>: ignored because these note_ids
   are not in the clip: <ids>`, so matching on the step name is safe.

### `clip_duplicate_notes_by_id` default placement

Omitting `destination_time` shifts every copy by **the span of the selection** — its last note end
minus its first note start. Measured in Live:

| Selection | Shift |
| --- | --- |
| one sixteenth at 0 | 0.25 |
| one note at 0.3, duration 0.25 | 0.25 (float, *not* snapped to the grid) |
| chord at 0, durations 0.5 / 1 / 2 | 2 (the longest note) |
| notes at 0 and 2, duration 0.25 | 2.25 |
| note at 7.5, duration 2 (ends past `loop_end` 8) | 2 |

Copies keep their durations and their relative offsets, nothing snaps to `view.grid_quantization`,
and copies landing beyond `loop_end` **do not** extend the clip's region — Prelive extends it itself
if it wants the copies inside the loop.

### `clip_quantize` grid mapping

`quantization_grid` is Live's Quantize dialog in menu order, measured by quantizing notes off every
grid and reading where they land. One beat is a quarter note.

| `quantization_grid` | Grid | Step in beats |
| --- | --- | --- |
| 0 | no quantization (no-op) | — |
| 1 | 1/4 | 1 |
| 2 | 1/8 | 0.5 |
| 3 | 1/8T | 1/3 |
| 4 | 1/8 + 1/8T | 0.5 and 1/3 |
| 5 | 1/16 | 0.25 |
| 6 | 1/16T | 1/6 |
| 7 | 1/16 + 1/16T | 0.25 and 1/6 |
| 8 | 1/32 | 0.125 |
| 9 and up | silently ignored — no error, nothing moves | — |

Quantizing takes `Song.swing_amount` into account, so zero it first for an exact grid.

**This is not the `ClipView.grid_quantization` enum.** That one is Off plus Live's nine Fixed Grid
entries, coarse to fine, and takes a different int for the same musical grid — a 1/16 grid is `5`
for `clip_quantize` and `8` for the view. Prelive must not reuse one value for the other.

### `ClipView.grid_quantization` mapping

`0`, `5` and `9` were read directly off the grid label in the top right of Live's note editor; the
rest follow from the count (ten values, nine Fixed Grid entries plus Off) and the menu's order.

| `grid_quantization` | Grid |
| --- | --- |
| 0 | Off — the editor's Snap to Grid is unchecked |
| 1 | 8 Bars |
| 2 | 4 Bars |
| 3 | 2 Bars |
| 4 | 1 Bar |
| 5 | 1/2 |
| 6 | 1/4 |
| 7 | 1/8 |
| 8 | 1/16 |
| 9 | 1/32 |

Anything outside `0`-`9` is ignored and leaves the current value — no error. The menu's Adaptive
Grid entries (Widest … Narrowest) are **not** reachable through this property, and Triplet Grid is
the separate `grid_is_triplet` bool.

## Absent Members Read As `1`, Not As Missing

The last open question has a worse answer than either option it offered. A LOM member an object does
not have neither throws nor reads back empty: **`LiveAPI.get` answers `1`**. Unguarded, that surfaces
as a confident lie — `arm: true` on a track whose `can_be_armed` is `false`, `mute: true` and
`solo: true` on the master track, `fold_state: 1` on every track that does not fold, and
`playing_slot_index: 1` on return and master tracks where a regular track correctly says `-1`.

The capability flags themselves read correctly, so nullability is now derived from them rather than
from the value:

| Field | Null when |
| --- | --- |
| `arm` | `can_be_armed` is false |
| `mute`, `solo` | the track is the master track (by `path`) |
| `fold_state` | `is_foldable` is false |
| `playing_slot_index`, `fired_slot_index` | the track has no clip slots |

Return tracks keep real `mute` and `solo` — they have both in Live — so the guard is not simply
"return or master". `pnpm test` covers each case against a fake that now returns Live's `1`, and
`pnpm test:live` asserts both the nulls and that a regular track keeps every one of these values.

**For Prelive:** treat `null` as "this kind of track does not have it", and do not infer a track's
kind from a member being present.

## Fixed While Verifying

1. `get_notes_by_id` crashed with `data.notes is not iterable` for **any** id not in the clip: Live
   answers with a dictionary that has no `notes` key at all, not `{"notes": []}`, and the resolver
   spread it unguarded. This took out `clip_apply_note_modifications`' stale-id pre-check, so a
   composite write with a stale id raised a raw TypeError instead of naming the ids.
2. Reading **any** return or master track failed with
   `TypeError: live.get(...).filter is not a function`. A track with no clip slots answers
   `clip_slots` with the empty symbol instead of an empty list, which threw inside `liveql-m4l.js`
   and took the whole object read with it — even `{ id name }` failed. All four read loops in the
   bridge now coerce, and the empty symbol and `id 0` are filtered out as non-ids.
3. The junk described above: `arm`, `mute`, `solo`, `fold_state` and the slot indexes were returning
   `1` on tracks that do not have them.

`test/helpers/fake-lom.js` mirrors all three shapes now, so `pnpm test` covers them without Live.

## Findings Are In The Schema

The behaviour Prelive has to know is carried as GraphQL descriptions on the fields and arguments
themselves, not only in this document. `printSchema` emits them, so `pnpm liveql:schema` pulls them
into `refs/liveql-schema.graphql`, and they show in the GraphiQL docs panel. Described: both grid
enums (each stating it is not the other), the `destination_time` placement rule, the marker ordering
and silent clamping on `clip_set_properties`, the `clip_write_notes` step order and non-atomicity,
the positional-argument rule on `clip_slot_fire` and `scene_fire`, why each nullable field is null,
and that `Query.clip` returns `null` rather than raising.
