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
| `clip_add_new_notes(id, notes_dictionary: { notes: [...] })` returns `Clip` | `clip_add_new_notes(id, notes: [NoteInput!]!)` returns `ClipNotesPayload { clip, note_ids }` | `note_ids` are the ids Live assigned, in input order (order unverified in Live, see below) |
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

## Not Yet Verified In Live

Behaviour that the LOM documents but the implementer could not confirm without a Live session. Each is
marked in a resolver JSDoc in `liveql-n4m.js`. Prelive should not depend on these until checked:

1. The shape `LiveAPI.call("add_new_notes", ...)` returns under `v8`, and that `note_ids` come back in
   input order. The resolver normalizes any list-like shape to its integers.
2. Whether `LiveAPI.set("detail_clip", "id 12")` accepts the string form. If not, the fix is one helper
   (`idArg`) in `liveql-n4m.js`.
3. Whether `loop_start`/`loop_end` alias `start_marker`/`end_marker` on unlooped clips.
4. The int mapping of `quantization_grid` for `clip_quantize` and `ClipView.grid_quantization`.
5. Whether empty symbols (`Song.name` on an unsaved Set) come back as an empty list; the resolvers
   default such fields to `""` either way.

The full ten-item verification matrix is in `docs/liveql-note-editing-enhancement-research.md`.
