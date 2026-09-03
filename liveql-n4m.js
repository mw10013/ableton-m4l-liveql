const http = require("http");
const path = require("path");
const Max = require("max-api");
const { createYoga, createSchema } = require("graphql-yoga");

// This will be printed directly to the Max console
Max.post(`liveql: loaded the ${path.basename(__filename)} script`);

async function get(
  idOrPath,
  propertyKeysSingle = null,
  propertyKeysMultiple = null,
  childKeysSingle = null,
  childKeysMultiple = null
) {
  return exec({
    action: "get",
    idOrPath,
    propertyKeysSingle,
    propertyKeysMultiple,
    childKeysSingle,
    childKeysMultiple,
  });
}

async function set(id, property, value) {
  return exec({
    action: "set",
    idOrPath: id,
    property,
    value,
  });
}

async function call(id, ...args) {
  return exec({
    action: "call",
    idOrPath: id,
    args,
  });
}

let actionId = 0;
let actionResultHandlers = new Map();

/**
 * Failures from the v8 bridge arrive as a bare message with no record of which
 * LOM operation produced it. The message is wrapped here, where the action, the
 * property or function, and the target id are all still in hand, so a GraphQL
 * error reads `liveql: set loop_end on 42: ...` instead of just Live's text.
 */
function describeAction({ action, idOrPath, property, args }) {
  const subject = property ?? args?.[0];
  return `${action}${subject === undefined ? "" : ` ${subject}`} on ${idOrPath}`;
}

async function exec(params) {
  actionId += 1;

  const p = new Promise((resolve, reject) => {
    actionResultHandlers.set(actionId, { resolve, reject });
  });
  const action = { actionId, ...params };
  await Max.outlet(action.action, JSON.stringify(action));
  return p.catch((err) => {
    throw new Error(`liveql: ${describeAction(params)}: ${err.message}`);
  });
}

Max.addHandler("result", async (json) => {
  const result = JSON.parse(json);
  const handler = actionResultHandlers.get(result.actionId);
  actionResultHandlers.delete(result.actionId);
  if (!handler) return;
  if (result.status !== "succeeded") {
    await Max.post("liveql: failed result: " + json);
    handler.reject(new Error(result.message));
    return;
  }
  handler.resolve(result.data);
});

/**
 * GraphQL is the schema boundary for Live API type normalization.
 *
 * The Live Object Model documents many fields as `bool`, but Max's `LiveAPI`
 * commonly returns those values as numeric `0` / `1`. We keep the Max bridge in
 * `liveql-m4l.js` generic and expose those fields here as GraphQL `Boolean`
 * where appropriate.
 *
 * In practice, Yoga/GraphQL coerces `0` -> `false` and `1` -> `true` for output
 * fields typed as `Boolean`, so output boolean fields usually need no custom
 * resolver logic.
 *
 * For boolean mutations, GraphQL inputs arrive as normal JavaScript booleans.
 * Live property setters still expect the Max/Live representation, so mutation
 * resolvers convert `true` / `false` to `1` / `0` before calling `LiveAPI.set`.
 *
 * Field, argument and mutation names mirror the LOM verbatim. Nullable fields
 * are the members the LOM documents as absent on some objects of the type
 * (Track.arm on return/master tracks, ClipSlot.color outside Group Track slots,
 * note functions on audio clips). The bridge records a property only when
 * `LiveAPI.get` yields exactly one value, so an absent member that reads as an
 * empty list resolves to null; one that throws fails the whole object read
 * with Live's message. Which of the two Live does is unverified.
 */
const typeDefs = /* GraphQL */ `
  type Application {
    id: Int!
    path: String!
    type: String!
    get_major_version: Int!
    get_minor_version: Int!
    get_bugfix_version: Int!
    get_version_string: String!
  }

  type Song {
    id: Int!
    path: String!
    type: String!
    """Empty string for a Set that has never been saved."""
    name: String!
    """Empty string for a Set that has never been saved."""
    file_path: String!
    is_playing: Boolean!
    tempo: Float!
    signature_numerator: Int!
    signature_denominator: Int!
    current_song_time: Float!
    start_time: Float!
    last_event_time: Float!
    song_length: Float!
    loop: Boolean!
    loop_start: Float!
    loop_length: Float!
    metronome: Boolean!
    swing_amount: Float!
    midi_recording_quantization: Int!
    clip_trigger_quantization: Int!
    root_note: Int!
    scale_name: String!
    scale_intervals: [Int!]!
    scale_mode: Boolean!
    can_undo: Boolean!
    can_redo: Boolean!
    record_mode: Boolean!
    session_record: Boolean!
    overdub: Boolean!
    arrangement_overdub: Boolean!
    is_counting_in: Boolean!
    can_capture_midi: Boolean!
    view: SongView!
    track(index: Int!): Track
    tracks: [Track!]!
    return_tracks: [Track!]!
    visible_tracks: [Track!]!
    master_track: Track!
    scene(index: Int!): Scene
    scenes: [Scene!]!
  }

  input SongPropertiesInput {
    tempo: Float
    signature_numerator: Int
    signature_denominator: Int
    current_song_time: Float
    start_time: Float
    loop: Boolean
    loop_start: Float
    loop_length: Float
    metronome: Boolean
    swing_amount: Float
    midi_recording_quantization: Int
    clip_trigger_quantization: Int
    root_note: Int
    scale_name: String
    scale_mode: Boolean
    record_mode: Boolean
    session_record: Boolean
    overdub: Boolean
    arrangement_overdub: Boolean
  }

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

  input SongViewPropertiesInput {
    draw_mode: Boolean
    follow_song: Boolean
  }

  type Track {
    id: Int!
    path: String!
    type: String!
    name: String!
    has_midi_input: Boolean!
    has_audio_input: Boolean!
    has_audio_output: Boolean!
    has_midi_output: Boolean!
    can_be_armed: Boolean!
    """Null on tracks the LOM does not give it to, such as return and master tracks."""
    arm: Boolean
    """Null on tracks the LOM does not give it to, such as the master track."""
    mute: Boolean
    """Null on tracks the LOM does not give it to, such as the master track."""
    solo: Boolean
    muted_via_solo: Boolean!
    color: Int!
    color_index: Int!
    is_foldable: Boolean!
    is_grouped: Boolean!
    is_visible: Boolean!
    is_frozen: Boolean!
    """Null unless is_foldable: only Group Tracks have a fold state."""
    fold_state: Int
    """Null on tracks with no clip slots, such as return and master tracks."""
    playing_slot_index: Int
    """Null on tracks with no clip slots, such as return and master tracks."""
    fired_slot_index: Int
    """Null when the track is not inside a Group Track."""
    group_track: Track
    clip_slot(index: Int!): ClipSlot
    clip_slots: [ClipSlot!]!
    arrangement_clip(index: Int!): Clip
    arrangement_clips: [Clip!]!
  }

  input TrackPropertiesInput {
    name: String
    arm: Boolean
    mute: Boolean
    solo: Boolean
    color: Int
    color_index: Int
    fold_state: Int
  }

  type ClipSlot {
    id: Int!
    path: String!
    type: String!
    clip: Clip
    has_clip: Boolean!
    has_stop_button: Boolean!
    is_playing: Boolean!
    is_recording: Boolean!
    is_triggered: Boolean!
    playing_status: Int!
    is_group_slot: Boolean!
    will_record_on_start: Boolean!
    """Null outside Group Track slots, which are the only slots the LOM colors."""
    color: Int
  }

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

  input ScenePropertiesInput {
    name: String
    color: Int
    color_index: Int
    tempo_enabled: Boolean
    tempo: Float
    time_signature_enabled: Boolean
    time_signature_numerator: Int
    time_signature_denominator: Int
  }

  type Clip {
    id: Int!
    path: String!
    type: String!
    name: String!
    color: Int!
    color_index: Int!
    is_arrangement_clip: Boolean!
    is_session_clip: Boolean!
    is_take_lane_clip: Boolean!
    is_audio_clip: Boolean!
    is_midi_clip: Boolean!
    length: Float!
    looping: Boolean!
    loop_start: Float!
    loop_end: Float!
    start_marker: Float!
    end_marker: Float!
    position: Float!
    start_time: Float!
    end_time: Float!
    signature_numerator: Int!
    signature_denominator: Int!
    muted: Boolean!
    is_playing: Boolean!
    is_recording: Boolean!
    is_triggered: Boolean!
    is_overdubbing: Boolean!
    playing_position: Float!
    launch_mode: Int!
    launch_quantization: Int!
    legato: Boolean!
    velocity_amount: Float!
    has_envelopes: Boolean!
    has_groove: Boolean!
    will_record_on_start: Boolean!
    view: ClipView!
    """
    Every note in the clip, sorted by start_time then pitch. Null on an audio
    clip, as are the other three note fields.
    """
    get_all_notes_extended: NotesDictionary
    """
    The notes with these ids. Ids that are not in the clip are simply absent
    from the result rather than an error, so a shorter list than you asked for
    means some ids are stale.
    """
    get_notes_by_id(note_ids: [Int!]!): NotesDictionary
    get_notes_extended(
      from_pitch: Int!
      pitch_span: Int!
      from_time: Float!
      time_span: Float!
    ): NotesDictionary
    get_selected_notes_extended: NotesDictionary
  }

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

  type ClipView {
    id: Int!
    path: String!
    type: String!
    """
    The editor's grid, as Off plus Live's nine Fixed Grid entries, coarse to
    fine: 0 = Off (Snap to Grid unchecked), 1 = 8 Bars, 2 = 4 Bars, 3 = 2 Bars,
    4 = 1 Bar, 5 = 1/2, 6 = 1/4, 7 = 1/8, 8 = 1/16, 9 = 1/32. Anything outside
    0-9 is ignored and leaves the current value, with no error. The menu's
    Adaptive Grid entries are not reachable here. This is NOT the enum
    clip_quantize takes: a 1/16 grid is 8 here and 5 there.
    """
    grid_quantization: Int!
    """Live's Triplet Grid toggle, which the grid_quantization enum has no values for."""
    grid_is_triplet: Boolean!
  }

  input ClipViewPropertiesInput {
    grid_quantization: Int
    grid_is_triplet: Boolean
  }

  type Note {
    note_id: Int!
    pitch: Int!
    start_time: Float!
    duration: Float!
    velocity: Float!
    mute: Boolean!
    probability: Float!
    velocity_deviation: Float!
    release_velocity: Float!
  }

  type NotesDictionary {
    notes: [Note!]!
  }

  input NoteInput {
    note_id: Int
    pitch: Int
    start_time: Float
    duration: Float
    velocity: Float
    mute: Boolean
    probability: Float
    velocity_deviation: Float
    release_velocity: Float
  }

  type ClipNotesPayload {
    clip: Clip!
    note_ids: [Int!]!
  }

  type Query {
    live_set: Song!
    live_app: Application!
    """
    The clip with this LOM id, or null if no object has it or the object is not
    a Clip. The by-id queries never raise for a bad id.
    """
    clip(id: Int!): Clip
    clip_slot(id: Int!): ClipSlot
    track(id: Int!): Track
    scene(id: Int!): Scene
  }

  type Mutation {
    song_start_playing(id: Int!): Song
    song_continue_playing(id: Int!): Song
    song_stop_playing(id: Int!): Song
    song_set_properties(id: Int!, properties: SongPropertiesInput!): Song
    song_undo(id: Int!): Song
    song_redo(id: Int!): Song
    song_stop_all_clips(id: Int!, quantized: Boolean = true): Song
    song_jump_by(id: Int!, beats: Float!): Song
    song_capture_midi(id: Int!, destination: Int = 0): Song
    song_create_midi_track(id: Int!, index: Int = -1): Song
    song_create_scene(id: Int!, index: Int = -1): Song
    song_tap_tempo(id: Int!): Song

    song_view_set_properties(
      id: Int!
      properties: SongViewPropertiesInput!
    ): SongView
    song_view_set_detail_clip(id: Int!, detail_clip: Int!): SongView
    song_view_set_selected_track(id: Int!, selected_track: Int!): SongView
    song_view_set_highlighted_clip_slot(
      id: Int!
      highlighted_clip_slot: Int!
    ): SongView
    song_view_set_selected_scene(id: Int!, selected_scene: Int!): SongView

    track_set_properties(id: Int!, properties: TrackPropertiesInput!): Track
    track_stop_all_clips(id: Int!): Track
    track_create_midi_clip(id: Int!, start_time: Float!, length: Float!): Track
    track_delete_clip(id: Int!, clip: Int!): Track
    track_duplicate_clip_slot(id: Int!, index: Int!): Track
    track_duplicate_clip_to_arrangement(
      id: Int!
      clip: Int!
      destination_time: Float!
    ): Track
    track_jump_in_running_session_clip(id: Int!, beats: Float!): Track

    """
    The LOM takes these optional arguments positionally, so launch_quantization
    without record_length is rejected with an error naming the missing one.
    """
    clip_slot_fire(
      id: Int!
      record_length: Float
      launch_quantization: Int
    ): ClipSlot
    clip_slot_stop(id: Int!): ClipSlot
    clip_slot_create_clip(id: Int!, length: Float!): ClipSlot
    clip_slot_delete_clip(id: Int!): ClipSlot
    clip_slot_duplicate_clip_to(id: Int!, target_clip_slot: Int!): ClipSlot
    clip_slot_set_has_stop_button(id: Int!, has_stop_button: Boolean!): ClipSlot

    """
    The LOM takes these optional arguments positionally, so
    can_select_scene_on_launch without force_legato is rejected with an error
    naming the missing one.
    """
    scene_fire(
      id: Int!
      force_legato: Boolean
      can_select_scene_on_launch: Boolean
    ): Scene
    scene_set_properties(id: Int!, properties: ScenePropertiesInput!): Scene

    """
    Writes several Clip properties in one call as a plain sequence of set, in
    a fixed key order: scalars, then loop_start, loop_end, start_marker,
    end_marker, position. Nothing is read first and nothing is reordered. Live
    drops a start set past the current end, and an end set before the current
    start, without raising; write markers one per mutation in the order that
    keeps start <= end, and compare the returned clip with what you asked for.
    Sending both markers in one batch gets whatever the fixed order gives.
    """
    clip_set_properties(id: Int!, properties: ClipPropertiesInput!): Clip
    """
    Adds notes and returns the ids Live assigned, in the order the notes were
    given.
    """
    clip_add_new_notes(id: Int!, notes: [NoteInput!]!): ClipNotesPayload
    """
    Live silently ignores the entire list when any note_id in it is not in the
    clip: no error, nothing changes, and the returned clip is unchanged. Check the
    ids first with clip(id) { get_notes_by_id(note_ids: [...]) } if that matters,
    and compare the returned notes with what you asked for.
    """
    clip_apply_note_modifications(id: Int!, notes: [NoteInput!]!): Clip
    clip_fire(id: Int!): Clip
    clip_stop(id: Int!): Clip
    clip_select_all_notes(id: Int!): Clip
    clip_select_notes_by_id(id: Int!, note_ids: [Int!]!): Clip
    clip_deselect_all_notes(id: Int!): Clip
    clip_remove_notes_by_id(id: Int!, note_ids: [Int!]!): Clip
    clip_remove_notes_extended(
      id: Int!
      from_pitch: Int!
      pitch_span: Int!
      from_time: Float!
      time_span: Float!
    ): Clip
    """
    Omit destination_time to place the copies the way the GUI's Duplicate does:
    every copy is shifted by the span of the selection, its last note end minus
    its first note start. The shift is not snapped to the editor grid, and
    copies landing past loop_end do not extend the clip's region.
    """
    clip_duplicate_notes_by_id(
      id: Int!
      note_ids: [Int!]!
      destination_time: Float
      transposition_amount: Int
    ): Clip
    clip_duplicate_region(
      id: Int!
      region_start: Float!
      region_length: Float!
      destination_time: Float!
      pitch: Int = -1
      transposition_amount: Int = 0
    ): Clip
    clip_duplicate_loop(id: Int!): Clip
    clip_crop(id: Int!): Clip
    """
    Live's Quantize dialog in menu order: 0 = no quantization, 1 = 1/4,
    2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T, 7 = 1/16 + 1/16T,
    8 = 1/32. Anything from 9 up is silently ignored, so an out-of-range grid
    gives no error and an unquantized clip. Not the ClipView.grid_quantization
    enum. Quantizing takes Song.swing_amount into account.
    """
    clip_quantize(id: Int!, quantization_grid: Int!, amount: Float!): Clip
    """
    Live's Quantize dialog in menu order: 0 = no quantization, 1 = 1/4,
    2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T, 7 = 1/16 + 1/16T,
    8 = 1/32. Anything from 9 up is silently ignored, so an out-of-range grid
    gives no error and an unquantized clip. Not the ClipView.grid_quantization
    enum. Quantizing takes Song.swing_amount into account.
    """
    clip_quantize_pitch(
      id: Int!
      pitch: Int!
      quantization_grid: Int!
      amount: Float!
    ): Clip
    clip_scrub(id: Int!, beat_time: Float!): Clip
    clip_stop_scrub(id: Int!): Clip
    clip_move_playing_pos(id: Int!, beats: Float!): Clip
    clip_set_fire_button_state(id: Int!, state: Boolean!): Clip

    clip_view_set_properties(
      id: Int!
      properties: ClipViewPropertiesInput!
    ): ClipView
    clip_view_show_loop(id: Int!): ClipView
  }
`;

/**
 * Symbol properties the LOM documents as possibly empty (Song.name and
 * Song.file_path on an unsaved Set, unnamed clips). The bridge only records a
 * property when `LiveAPI.get` yields exactly one value, and an empty symbol may
 * come back as an empty list, which would drop a `String!` field and fail the
 * whole query. Defaulting here keeps the field non-null.
 */
function withStringDefaults(o, keys) {
  return keys.reduce((acc, k) => ({ ...acc, [k]: acc[k] ?? "" }), o);
}

function getSong() {
  return get(
    "live_set",
    [
      "name",
      "file_path",
      "is_playing",
      "tempo",
      "signature_numerator",
      "signature_denominator",
      "current_song_time",
      "start_time",
      "last_event_time",
      "song_length",
      "loop",
      "loop_start",
      "loop_length",
      "metronome",
      "swing_amount",
      "midi_recording_quantization",
      "clip_trigger_quantization",
      "root_note",
      "scale_name",
      "scale_mode",
      "can_undo",
      "can_redo",
      "record_mode",
      "session_record",
      "overdub",
      "arrangement_overdub",
      "is_counting_in",
      "can_capture_midi",
    ],
    ["scale_intervals"],
    ["view", "master_track"],
    ["tracks", "return_tracks", "visible_tracks", "scenes"]
  ).then((o) => withStringDefaults(o, ["name", "file_path", "scale_name"]));
}

function getSongView(id) {
  return get(
    id,
    ["draw_mode", "follow_song"],
    null,
    ["detail_clip", "selected_track", "highlighted_clip_slot", "selected_scene"]
  );
}

function getTrack(id) {
  return get(
    id,
    [
      "name",
      "has_midi_input",
      "has_audio_input",
      "has_audio_output",
      "has_midi_output",
      "can_be_armed",
      "arm",
      "mute",
      "solo",
      "muted_via_solo",
      "color",
      "color_index",
      "is_foldable",
      "is_grouped",
      "is_visible",
      "is_frozen",
      "fold_state",
      "playing_slot_index",
      "fired_slot_index",
    ],
    null,
    ["group_track"],
    ["clip_slots", "arrangement_clips"]
  ).then((o) => withoutAbsentTrackMembers(withStringDefaults(o, ["name"])));
}

/**
 * Nulls the members the LOM does not give this kind of track. Live does not
 * report an absent member as missing or as an error: `LiveAPI.get` answers 1,
 * which arrives as `arm: true` on a track that cannot be armed and
 * `fold_state: 1` on one that does not fold. The capability flags read
 * correctly, so nullability is derived from them and from the track's path
 * rather than from the value itself. The master track is the one with no
 * mute or solo; neither it nor a return track has clip slots, so their slot
 * indexes are meaningless too.
 */
function withoutAbsentTrackMembers(o) {
  const isMaster = o.path?.endsWith("master_track") ?? false;
  const hasSlots = o.clip_slots?.length > 0;
  return {
    ...o,
    arm: o.can_be_armed ? o.arm : null,
    mute: isMaster ? null : o.mute,
    solo: isMaster ? null : o.solo,
    fold_state: o.is_foldable ? o.fold_state : null,
    playing_slot_index: hasSlots ? o.playing_slot_index : null,
    fired_slot_index: hasSlots ? o.fired_slot_index : null,
  };
}

function getClipSlot(id) {
  return get(
    id,
    [
      "has_clip",
      "has_stop_button",
      "is_playing",
      "is_recording",
      "is_triggered",
      "playing_status",
      "is_group_slot",
      "will_record_on_start",
      "color",
    ],
    null,
    ["clip"]
  );
}

function getScene(id) {
  return get(
    id,
    [
      "name",
      "color",
      "color_index",
      "is_empty",
      "is_triggered",
      "tempo",
      "tempo_enabled",
      "time_signature_numerator",
      "time_signature_denominator",
      "time_signature_enabled",
    ],
    null,
    null,
    ["clip_slots"]
  ).then((o) => withStringDefaults(o, ["name"]));
}

function getClip(id) {
  return get(
    id,
    [
      "name",
      "color",
      "color_index",
      "is_arrangement_clip",
      "is_session_clip",
      "is_take_lane_clip",
      "is_audio_clip",
      "is_midi_clip",
      "length",
      "looping",
      "loop_start",
      "loop_end",
      "start_marker",
      "end_marker",
      "position",
      "start_time",
      "end_time",
      "signature_numerator",
      "signature_denominator",
      "muted",
      "is_playing",
      "is_recording",
      "is_triggered",
      "is_overdubbing",
      "playing_position",
      "launch_mode",
      "launch_quantization",
      "legato",
      "velocity_amount",
      "has_envelopes",
      "has_groove",
      "will_record_on_start",
    ],
    null,
    ["view"]
  ).then((o) => withStringDefaults(o, ["name"]));
}

function getClipView(id) {
  return get(id, ["grid_quantization", "grid_is_triplet"]);
}

async function getApplication() {
  const [o, major, minor, bugfix, version] = await Promise.all([
    get("live_app"),
    call("live_app", "get_major_version"),
    call("live_app", "get_minor_version"),
    call("live_app", "get_bugfix_version"),
    call("live_app", "get_version_string"),
  ]);
  return {
    ...o,
    get_major_version: firstInt(major),
    get_minor_version: firstInt(minor),
    get_bugfix_version: firstInt(bugfix),
    get_version_string: firstString(version),
  };
}

function toLiveBool(value) {
  return value ? 1 : 0;
}

function toLiveValue(value) {
  return typeof value === "boolean" ? toLiveBool(value) : value;
}

/**
 * LOM functions and child setters that take an object take it as the atoms
 * `id N`, the form `live.object` and `live.path` exchange. The v8 `LiveAPI`
 * accepts a single string for that pair when constructing (`new LiveAPI("id 12")`,
 * which `liveql-m4l.js` already relies on), so the same string form is used for
 * arguments. Confirmed in Live for `set` (`song_view_set_detail_clip`); if a
 * child setter is ever rejected, the alternative to try is the two-atom form
 * `["id", id]`, and this is the only place to change.
 */
function idArg(id) {
  return `id ${id}`;
}

function parseMaybeJson(data) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch (_err) {
    return data;
  }
}

/**
 * Normalizes whatever the v8 bridge forwards from `LiveAPI.call` for functions
 * documented as returning a list of note IDs (`add_new_notes`). The exact shape
 * under v8 is not pinned down: it may be a flat int array, a Max list with a
 * leading symbol, a JSON string like the note dictionaries, or a single int.
 * Every shape reduces to the integers it contains, in order. Confirmed in Live
 * that what comes out is one id per input note, in input order.
 */
function toIntList(data) {
  const v = parseMaybeJson(data);
  if (Array.isArray(v)) return v.flatMap(toIntList);
  if (Number.isInteger(v)) return [v];
  if (typeof v === "string" && /^-?\d+$/.test(v)) return [Number(v)];
  if (v && typeof v === "object") return toIntList(v.note_ids ?? Object.values(v));
  return [];
}

function firstInt(data) {
  return toIntList(data)[0] ?? 0;
}

function firstString(data) {
  const v = parseMaybeJson(data);
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

function isInvalidId(err) {
  return err.message.includes("Invalid live id or path");
}

async function setProperties(id, properties, keys) {
  for (const k of keys.filter((k) => properties[k] !== undefined)) {
    await set(id, k, toLiveValue(properties[k]));
  }
}

const CLIP_SCALAR_KEYS = [
  "name",
  "signature_numerator",
  "signature_denominator",
  "looping",
  "muted",
  "color",
  "color_index",
  "launch_mode",
  "launch_quantization",
  "legato",
  "velocity_amount",
];

const CLIP_PROPERTY_KEYS = [
  ...CLIP_SCALAR_KEYS,
  "loop_start",
  "loop_end",
  "start_marker",
  "end_marker",
  "position",
];


function normalizeNoteInput(note) {
  if (note.mute === undefined) {
    return note;
  }
  return { ...note, mute: toLiveBool(note.mute) };
}

function normalizeNotesDictionaryInput(notesDictionary) {
  return {
    ...notesDictionary,
    notes: notesDictionary.notes.map(normalizeNoteInput),
  };
}

function compareNotes(a, b) {
  // start_time ascending, pitch ascending
  if (a.start_time < b.start_time) return -1;
  if (a.start_time > b.start_time) return 1;
  return a.pitch - b.pitch;
}

/**
 * Live answers a notes function with a dictionary that has no `notes` key at
 * all, rather than `{"notes": []}`, when nothing matches — confirmed in Live for
 * `get_notes_by_id` with an id that is not in the clip. Reading the absent key
 * as an empty list keeps that an ordinary empty result, which is what the
 * `Clip.get_notes_by_id` query field returns for a stale id; spreading it
 * unguarded died with a TypeError instead.
 */
function sortJsonNotesDictionary(json) {
  const data = JSON.parse(json);
  return { notes: [...(data?.notes ?? [])].sort(compareNotes) };
}

async function getNotesExtended(parent, args) {
  // resolver interface with parent arg unused
  var json = await call(
    args.id,
    "get_notes_extended",
    args.from_pitch,
    args.pitch_span,
    args.from_time,
    args.time_span
  );
  return sortJsonNotesDictionary(json);
}

async function getNotesById(id, noteIds) {
  return noteIds.length === 0
    ? []
    : sortJsonNotesDictionary(await call(id, "get_notes_by_id", ...noteIds))
        .notes;
}

async function addNewNotes(id, notes) {
  return toIntList(
    await call(id, "add_new_notes", normalizeNotesDictionaryInput({ notes }))
  );
}

function midiOnly(fn) {
  return (parent, args) => (parent.is_midi_clip ? fn(parent, args) : null);
}

function byId(expectedType, fetch) {
  return async (parent, args) => {
    const o = await get(args.id).catch((err) => {
      if (isInvalidId(err)) return null;
      throw err;
    });
    return o?.type === expectedType ? fetch(args.id) : null;
  };
}

/**
 * The LOM takes optional function arguments positionally (`ClipSlot.fire
 * record_length launch_quantization`), so a later optional argument cannot be
 * given without every earlier one. Rejects that shape with a message naming the
 * missing argument instead of letting Live read the wrong value.
 */
function optionalPositional(name, values, argNames) {
  const given = values.slice(0, values.findLastIndex((v) => v != null) + 1);
  const gap = given.findIndex((v) => v == null);
  if (gap >= 0) {
    throw new Error(
      `liveql: ${name}: ${argNames[gap]} is required when a later optional argument is given`
    );
  }
  return given.map(toLiveValue);
}

const resolvers = {
  Query: {
    live_set: getSong,
    live_app: getApplication,
    clip: byId("Clip", getClip),
    clip_slot: byId("ClipSlot", getClipSlot),
    track: byId("Track", getTrack),
    scene: byId("Scene", getScene),
  },
  Mutation: {
    song_start_playing: async (parent, args) => {
      await call(args.id, "start_playing");
      return getSong();
    },
    song_continue_playing: async (parent, args) => {
      await call(args.id, "continue_playing");
      return getSong();
    },
    song_stop_playing: async (parent, args) => {
      await call(args.id, "stop_playing");
      return getSong();
    },
    song_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, [
        "tempo",
        "signature_numerator",
        "signature_denominator",
        "current_song_time",
        "start_time",
        "loop",
        "loop_length",
        "loop_start",
        "metronome",
        "swing_amount",
        "midi_recording_quantization",
        "clip_trigger_quantization",
        "root_note",
        "scale_name",
        "scale_mode",
        "record_mode",
        "session_record",
        "overdub",
        "arrangement_overdub",
      ]);
      return getSong();
    },
    song_undo: async (parent, args) => {
      await call(args.id, "undo");
      return getSong();
    },
    song_redo: async (parent, args) => {
      await call(args.id, "redo");
      return getSong();
    },
    song_stop_all_clips: async (parent, args) => {
      await call(args.id, "stop_all_clips", toLiveBool(args.quantized));
      return getSong();
    },
    song_jump_by: async (parent, args) => {
      await call(args.id, "jump_by", args.beats);
      return getSong();
    },
    song_capture_midi: async (parent, args) => {
      await call(args.id, "capture_midi", args.destination);
      return getSong();
    },
    song_create_midi_track: async (parent, args) => {
      await call(args.id, "create_midi_track", args.index);
      return getSong();
    },
    song_create_scene: async (parent, args) => {
      await call(args.id, "create_scene", args.index);
      return getSong();
    },
    song_tap_tempo: async (parent, args) => {
      await call(args.id, "tap_tempo");
      return getSong();
    },

    song_view_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, ["draw_mode", "follow_song"]);
      return getSongView(args.id);
    },
    song_view_set_detail_clip: async (parent, args) => {
      await set(args.id, "detail_clip", idArg(args.detail_clip));
      return getSongView(args.id);
    },
    song_view_set_selected_track: async (parent, args) => {
      await set(args.id, "selected_track", idArg(args.selected_track));
      return getSongView(args.id);
    },
    song_view_set_highlighted_clip_slot: async (parent, args) => {
      await set(
        args.id,
        "highlighted_clip_slot",
        idArg(args.highlighted_clip_slot)
      );
      return getSongView(args.id);
    },
    song_view_set_selected_scene: async (parent, args) => {
      await set(args.id, "selected_scene", idArg(args.selected_scene));
      return getSongView(args.id);
    },

    track_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, [
        "name",
        "arm",
        "mute",
        "solo",
        "color",
        "color_index",
        "fold_state",
      ]);
      return getTrack(args.id);
    },
    track_stop_all_clips: async (parent, args) => {
      await call(args.id, "stop_all_clips");
      return getTrack(args.id);
    },
    track_create_midi_clip: async (parent, args) => {
      await call(args.id, "create_midi_clip", args.start_time, args.length);
      return getTrack(args.id);
    },
    track_delete_clip: async (parent, args) => {
      await call(args.id, "delete_clip", idArg(args.clip));
      return getTrack(args.id);
    },
    track_duplicate_clip_slot: async (parent, args) => {
      await call(args.id, "duplicate_clip_slot", args.index);
      return getTrack(args.id);
    },
    track_duplicate_clip_to_arrangement: async (parent, args) => {
      await call(
        args.id,
        "duplicate_clip_to_arrangement",
        idArg(args.clip),
        args.destination_time
      );
      return getTrack(args.id);
    },
    track_jump_in_running_session_clip: async (parent, args) => {
      await call(args.id, "jump_in_running_session_clip", args.beats);
      return getTrack(args.id);
    },

    clip_slot_fire: async (parent, args) => {
      await call(
        args.id,
        "fire",
        ...optionalPositional(
          "clip_slot_fire",
          [args.record_length, args.launch_quantization],
          ["record_length", "launch_quantization"]
        )
      );
      return getClipSlot(args.id);
    },
    clip_slot_stop: async (parent, args) => {
      await call(args.id, "stop");
      return getClipSlot(args.id);
    },
    clip_slot_create_clip: async (parent, args) => {
      await call(args.id, "create_clip", args.length);
      return getClipSlot(args.id);
    },
    clip_slot_delete_clip: async (parent, args) => {
      await call(args.id, "delete_clip");
      return getClipSlot(args.id);
    },
    clip_slot_duplicate_clip_to: async (parent, args) => {
      await call(args.id, "duplicate_clip_to", idArg(args.target_clip_slot));
      return getClipSlot(args.id);
    },
    clip_slot_set_has_stop_button: async (parent, args) => {
      await set(args.id, "has_stop_button", toLiveBool(args.has_stop_button));
      return getClipSlot(args.id);
    },

    scene_fire: async (parent, args) => {
      await call(
        args.id,
        "fire",
        ...optionalPositional(
          "scene_fire",
          [args.force_legato, args.can_select_scene_on_launch],
          ["force_legato", "can_select_scene_on_launch"]
        )
      );
      return getScene(args.id);
    },
    scene_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, [
        "name",
        "color",
        "color_index",
        "tempo_enabled",
        "tempo",
        "time_signature_enabled",
        "time_signature_numerator",
        "time_signature_denominator",
      ]);
      return getScene(args.id);
    },

    clip_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, CLIP_PROPERTY_KEYS);
      return getClip(args.id);
    },
    clip_add_new_notes: async (parent, args) => {
      const note_ids = await addNewNotes(args.id, args.notes);
      return { clip: await getClip(args.id), note_ids };
    },
    clip_apply_note_modifications: async (parent, args) => {
      await call(args.id, "apply_note_modifications", normalizeNotesDictionaryInput({ notes: args.notes }));
      return getClip(args.id);
    },
    clip_fire: async (parent, args) => {
      await call(args.id, "fire");
      return getClip(args.id);
    },
    clip_stop: async (parent, args) => {
      await call(args.id, "stop");
      return getClip(args.id);
    },
    clip_select_all_notes: async (parent, args) => {
      await call(args.id, "select_all_notes");
      return getClip(args.id);
    },
    clip_select_notes_by_id: async (parent, args) => {
      await call(args.id, "select_notes_by_id", ...args.note_ids);
      return getClip(args.id);
    },
    clip_deselect_all_notes: async (parent, args) => {
      await call(args.id, "deselect_all_notes");
      return getClip(args.id);
    },
    clip_remove_notes_by_id: async (parent, args) => {
      await call(args.id, "remove_notes_by_id", ...args.note_ids);
      return getClip(args.id);
    },
    clip_remove_notes_extended: async (parent, args) => {
      await call(
        args.id,
        "remove_notes_extended",
        args.from_pitch,
        args.pitch_span,
        args.from_time,
        args.time_span
      );
      return getClip(args.id);
    },
    /**
     * Dictionary form so `destination_time` and `transposition_amount` can be
     * omitted independently; when `destination_time` is absent Live inserts
     * "after the last selected note", the same placement as Duplicate in the
     * GUI. Only supplied keys go in the dictionary so an absent key keeps that
     * default.
     */
    /**
     * Omitting `destination_time` is what the LOM calls placing the copies
     * "after the last selected note". Confirmed in Live, that means a uniform
     * shift by the span of the selection — its last note end minus its first
     * note start — so a lone sixteenth moves by 0.25, a chord by its longest
     * note, and two notes two beats apart by 2.25. The shift is not snapped to
     * the editor grid (an off-grid source keeps its offset), and copies landing
     * past `loop_end` do not extend the clip's region.
     */
    clip_duplicate_notes_by_id: async (parent, args) => {
      const { id, note_ids, destination_time, transposition_amount } = args;
      await call(id, "duplicate_notes_by_id", {
        note_ids,
        ...(destination_time == null ? {} : { destination_time }),
        ...(transposition_amount == null ? {} : { transposition_amount }),
      });
      return getClip(id);
    },
    clip_duplicate_region: async (parent, args) => {
      await call(
        args.id,
        "duplicate_region",
        args.region_start,
        args.region_length,
        args.destination_time,
        args.pitch,
        args.transposition_amount
      );
      return getClip(args.id);
    },
    clip_duplicate_loop: async (parent, args) => {
      await call(args.id, "duplicate_loop");
      return getClip(args.id);
    },
    clip_crop: async (parent, args) => {
      await call(args.id, "crop");
      return getClip(args.id);
    },
    /**
     * The LOM documents no int mapping for `quantization_grid`. Measured in
     * Live by quantizing notes off every grid and reading where they land, it
     * is Live's Quantize dialog in menu order: 0 no quantization, 1 = 1/4,
     * 2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T,
     * 7 = 1/16 + 1/16T, 8 = 1/32. Anything from 9 up is silently ignored, so a
     * caller gets no error for an out-of-range grid, just an unquantized clip.
     * This is NOT the Clip.View.grid_quantization enum, which takes 0-9.
     */
    clip_quantize: async (parent, args) => {
      await call(args.id, "quantize", args.quantization_grid, args.amount);
      return getClip(args.id);
    },
    clip_quantize_pitch: async (parent, args) => {
      await call(
        args.id,
        "quantize_pitch",
        args.pitch,
        args.quantization_grid,
        args.amount
      );
      return getClip(args.id);
    },
    clip_scrub: async (parent, args) => {
      await call(args.id, "scrub", args.beat_time);
      return getClip(args.id);
    },
    clip_stop_scrub: async (parent, args) => {
      await call(args.id, "stop_scrub");
      return getClip(args.id);
    },
    clip_move_playing_pos: async (parent, args) => {
      await call(args.id, "move_playing_pos", args.beats);
      return getClip(args.id);
    },
    clip_set_fire_button_state: async (parent, args) => {
      await call(args.id, "set_fire_button_state", toLiveBool(args.state));
      return getClip(args.id);
    },

    /**
     * The LOM says only "Get/set the grid quantization" for
     * Clip.View.grid_quantization. It is Off plus the nine Fixed Grid entries,
     * coarse to fine: 0 = Off (the
     * editor's Snap to Grid unchecked), 1 = 8 Bars, 2 = 4 Bars, 3 = 2 Bars,
     * 4 = 1 Bar, 5 = 1/2, 6 = 1/4, 7 = 1/8, 8 = 1/16, 9 = 1/32. Anything
     * outside 0-9 is ignored and leaves the current value. 0, 5 and 9 were read
     * directly off the grid label in Live's note editor; the rest follow from
     * the count and the order of the menu. The menu's Adaptive
     * Grid entries are not reachable through this property, and Triplet Grid is
     * the separate grid_is_triplet bool. This enum is not the one
     * `clip_quantize` takes.
     */
    clip_view_set_properties: async (parent, args) => {
      await setProperties(args.id, args.properties, [
        "grid_quantization",
        "grid_is_triplet",
      ]);
      return getClipView(args.id);
    },
    clip_view_show_loop: async (parent, args) => {
      await call(args.id, "show_loop");
      return getClipView(args.id);
    },
  },
  Song: {
    view: (parent) => getSongView(parent.view),
    track: (parent, args) => {
      const id = parent.tracks[args.index];
      return id === undefined ? null : getTrack(id);
    },
    tracks: (parent) => parent.tracks.map((id) => getTrack(id)),
    return_tracks: (parent) => parent.return_tracks.map((id) => getTrack(id)),
    visible_tracks: (parent) => parent.visible_tracks.map((id) => getTrack(id)),
    master_track: (parent) => getTrack(parent.master_track),
    scene: (parent, args) => {
      const id = parent.scenes[args.index];
      return id === undefined ? null : getScene(id);
    },
    scenes: (parent) => parent.scenes.map((id) => getScene(id)),
  },
  SongView: {
    detail_clip: (parent) =>
      parent.detail_clip ? getClip(parent.detail_clip) : null,
    selected_track: (parent) =>
      parent.selected_track ? getTrack(parent.selected_track) : null,
    highlighted_clip_slot: (parent) =>
      parent.highlighted_clip_slot
        ? getClipSlot(parent.highlighted_clip_slot)
        : null,
    selected_scene: (parent) =>
      parent.selected_scene ? getScene(parent.selected_scene) : null,
  },
  Track: {
    group_track: (parent) =>
      parent.group_track ? getTrack(parent.group_track) : null,
    clip_slot: (parent, args) => {
      const id = parent.clip_slots[args.index];
      return id === undefined ? null : getClipSlot(id);
    },
    clip_slots: (parent) => parent.clip_slots.map((id) => getClipSlot(id)),
    arrangement_clip: (parent, args) => {
      const id = parent.arrangement_clips[args.index];
      return id === undefined ? null : getClip(id);
    },
    arrangement_clips: (parent) =>
      parent.arrangement_clips.map((id) => getClip(id)),
  },
  ClipSlot: {
    clip: (parent) => (parent.clip ? getClip(parent.clip) : null),
  },
  Scene: {
    clip_slots: (parent) => parent.clip_slots.map((id) => getClipSlot(id)),
  },
  Clip: {
    view: (parent) => getClipView(parent.view),
    get_all_notes_extended: midiOnly(async (parent) =>
      sortJsonNotesDictionary(await call(parent.id, "get_all_notes_extended"))
    ),
    get_notes_by_id: midiOnly(async (parent, args) => ({
      notes: await getNotesById(parent.id, args.note_ids),
    })),
    get_notes_extended: midiOnly((parent, args) =>
      getNotesExtended(parent, { ...args, id: parent.id })
    ),
    get_selected_notes_extended: midiOnly(async (parent) =>
      sortJsonNotesDictionary(await call(parent.id, "get_selected_notes_extended"))
    ),
  },
};

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  maskedErrors: false,
});

const port = parseInt(process.argv[2]) || 4000;

const server = http.createServer(yoga);
server.listen(port, () => {
  Max.post(`liveql: server ready at http://localhost:${port}${yoga.graphqlEndpoint}`);
});
