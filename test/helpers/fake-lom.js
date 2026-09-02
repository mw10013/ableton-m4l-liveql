/**
 * A fake Live Object Model that implements the wire contract of
 * `liveql-m4l.js`, not Live's semantics. The four `get` loops, the `id 0` and
 * `"id"` token handling and the empty-list-for-an-absent-member behaviour are
 * mirrored here exactly; anything else (marker constraints, note id
 * assignment) is a convenience for a named test and is not a claim about what
 * Live does. A change to the bridge's shape means a change here.
 */

const DEFAULT_NOTE = {
  pitch: 60,
  start_time: 0,
  duration: 1,
  velocity: 100,
  mute: 0,
  probability: 1,
  velocity_deviation: 0,
  release_velocity: 64,
};

function songProps() {
  return {
    // empty symbols: an unsaved Set, exercised by song.test.js
    name: [],
    file_path: [],
    scale_name: [],
    is_playing: [0],
    tempo: [120],
    signature_numerator: [4],
    signature_denominator: [4],
    current_song_time: [0],
    start_time: [0],
    last_event_time: [16],
    song_length: [16],
    loop: [0],
    loop_start: [0],
    loop_length: [16],
    metronome: [0],
    swing_amount: [0],
    midi_recording_quantization: [0],
    clip_trigger_quantization: [0],
    root_note: [0],
    scale_mode: [0],
    scale_intervals: [0, 2, 4, 5, 7, 9, 11],
    can_undo: [1],
    can_redo: [0],
    record_mode: [0],
    session_record: [0],
    overdub: [0],
    arrangement_overdub: [0],
    is_counting_in: [0],
    can_capture_midi: [1],
    view: ["id", 2],
    master_track: ["id", 12],
    tracks: ["id", 10, "id", 11],
    return_tracks: ["id", 13],
    visible_tracks: ["id", 10, "id", 11],
    scenes: ["id", 30],
  };
}

/**
 * Live does not always answer with a list: a track with no clip slots gives the
 * empty symbol for `clip_slots`, so anything that is not a list is read as one.
 */
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * The `id` tokens separating child ids, `id 0` for no child, and the empty
 * symbol Live pads an empty child list with are none of them ids to resolve.
 */
const isChildId = (v) => v !== "id" && v !== 0 && v !== "" && v !== undefined && v !== null;

function trackProps(overrides) {
  return {
    name: ["Track"],
    has_midi_input: [1],
    has_audio_input: [0],
    has_audio_output: [1],
    has_midi_output: [0],
    can_be_armed: [1],
    arm: [0],
    mute: [0],
    solo: [0],
    muted_via_solo: [0],
    color: [16711680],
    color_index: [1],
    is_foldable: [0],
    is_grouped: [0],
    is_visible: [1],
    is_frozen: [0],
    fold_state: [0],
    playing_slot_index: [-1],
    fired_slot_index: [-1],
    group_track: ["id", 0],
    clip_slots: [],
    arrangement_clips: [],
    ...overrides,
  };
}

function clipSlotProps(overrides) {
  return {
    has_clip: [0],
    has_stop_button: [1],
    is_playing: [0],
    is_recording: [0],
    is_triggered: [0],
    playing_status: [0],
    is_group_slot: [0],
    will_record_on_start: [0],
    color: [16711680],
    clip: ["id", 0],
    ...overrides,
  };
}

function clipProps(overrides) {
  return {
    name: [],
    color: [16711680],
    color_index: [1],
    is_arrangement_clip: [0],
    is_session_clip: [1],
    is_take_lane_clip: [0],
    is_audio_clip: [0],
    is_midi_clip: [1],
    length: [4],
    looping: [1],
    loop_start: [0],
    loop_end: [4],
    start_marker: [0],
    end_marker: [4],
    position: [0],
    start_time: [0],
    end_time: [4],
    signature_numerator: [4],
    signature_denominator: [4],
    muted: [0],
    is_playing: [0],
    is_recording: [0],
    is_triggered: [0],
    is_overdubbing: [0],
    playing_position: [0],
    launch_mode: [0],
    launch_quantization: [0],
    legato: [0],
    velocity_amount: [0],
    has_envelopes: [0],
    has_groove: [0],
    will_record_on_start: [0],
    view: ["id", 41],
    ...overrides,
  };
}

/**
 * One MIDI track (10) with a clip slot holding MIDI clip 40, one audio track
 * (11) holding arrangement clip 50, a return track (13) and a master track (12)
 * missing the members the LOM documents as absent there. Song.View's
 * `highlighted_clip_slot` is `id 0` so the bridge's null child is covered.
 */
function defaultObjects() {
  return {
    live_set: { id: 1, path: "live_set", type: "Song", props: songProps() },
    live_app: { id: 3, path: "live_app", type: "Application", props: {} },
    2: { id: 2, path: "live_set view", type: "Song.View", props: {
      draw_mode: [0],
      follow_song: [1],
      detail_clip: ["id", 40],
      selected_track: ["id", 10],
      highlighted_clip_slot: ["id", 0],
      selected_scene: ["id", 30],
    } },
    10: { id: 10, path: "live_set tracks 0", type: "Track", props: trackProps({
      name: ["MIDI"],
      clip_slots: ["id", 20, "id", 21],
    }) },
    11: { id: 11, path: "live_set tracks 1", type: "Track", props: trackProps({
      name: ["Audio"],
      has_midi_input: [0],
      has_audio_input: [1],
      arrangement_clips: ["id", 50],
    }) },
    /**
     * Live does not report a member the master track lacks as missing: it
     * answers 1, which is why these read as the junk they do in the Set. The
     * resolvers null them from can_be_armed and the path instead.
     */
    12: { id: 12, path: "live_set master_track", type: "Track", props: trackProps({
      name: ["Master"],
      can_be_armed: [0],
      arm: [1],
      mute: [1],
      solo: [1],
      fold_state: [1],
      playing_slot_index: [1],
      fired_slot_index: [1],
      clip_slots: "",
    }) },
    13: { id: 13, path: "live_set return_tracks 0", type: "Track", props: trackProps({
      name: ["A Return"],
      can_be_armed: [0],
      arm: [1],
      fold_state: [1],
      playing_slot_index: [1],
      fired_slot_index: [1],
      clip_slots: "",
    }) },
    20: { id: 20, path: "live_set tracks 0 clip_slots 0", type: "ClipSlot", props: clipSlotProps({
      has_clip: [1],
      clip: ["id", 40],
    }) },
    21: { id: 21, path: "live_set tracks 0 clip_slots 1", type: "ClipSlot", props: clipSlotProps({ color: [] }) },
    30: { id: 30, path: "live_set scenes 0", type: "Scene", props: {
      name: [],
      color: [16711680],
      color_index: [1],
      is_empty: [0],
      is_triggered: [0],
      tempo: [120],
      tempo_enabled: [0],
      time_signature_numerator: [4],
      time_signature_denominator: [4],
      time_signature_enabled: [0],
      clip_slots: ["id", 20, "id", 21],
    } },
    40: { id: 40, path: "live_set tracks 0 clip_slots 0 clip", type: "Clip", props: clipProps() },
    41: { id: 41, path: "live_set tracks 0 clip_slots 0 clip view", type: "Clip.View", props: {
      grid_quantization: [4],
      grid_is_triplet: [0],
    } },
    50: { id: 50, path: "live_set tracks 1 arrangement_clips 0", type: "Clip", props: clipProps({
      is_arrangement_clip: [1],
      is_session_clip: [0],
      is_audio_clip: [1],
      is_midi_clip: [0],
      view: ["id", 51],
    }) },
    51: { id: 51, path: "live_set tracks 1 arrangement_clips 0 view", type: "Clip.View", props: {
      grid_quantization: [4],
      grid_is_triplet: [0],
    } },
  };
}

/**
 * Live rejects a marker that would cross its partner with these messages
 * (`refs/m4l-docs/apiref/lom/clip/index.md`: start_marker "Cannot be set behind
 * the end marker", end_marker "Cannot be set before the start marker"). The
 * same is assumed for loop_start / loop_end, which is exactly the assumption
 * `clipPropertyOrder` is written against and clip.test.js "batch that shrinks
 * the loop" exercises. Live may instead clamp silently; test/live answers that.
 */
function guardMarkers(props, property, value) {
  const at = (k) => props[k]?.[0];
  if (property === "start_marker" && value > at("end_marker")) throw "Cannot be set behind the end marker";
  if (property === "end_marker" && value < at("start_marker")) throw "Cannot be set before the start marker";
  if (property === "loop_start" && value > at("loop_end")) throw "Cannot be set behind the loop end";
  if (property === "loop_end" && value < at("loop_start")) throw "Cannot be set before the loop start";
}

function createLom() {
  const objects = defaultObjects();
  // Live resolves the Song and the Application by numeric id as well as by path
  objects[objects.live_set.id] = objects.live_set;
  objects[objects.live_app.id] = objects.live_app;
  const log = [];
  const notes = { 40: [{ note_id: 1, ...DEFAULT_NOTE }] };
  const calls = {};
  let nextNoteId = 100;

  const resolve = (idOrPath) => {
    const o = objects[idOrPath];
    if (!o) throw `Invalid live id or path: ${idOrPath}`;
    return o;
  };
  const read = (o, k) => o.props[k] ?? [];
  const notesOf = (id) => (notes[id] ??= []);

  const get = (params) => {
    const o = resolve(params.idOrPath);
    const out = { id: o.id, path: o.path, type: o.type };
    for (const k of params.propertyKeysSingle || []) {
      const arr = asList(read(o, k));
      if (arr.length === 1) out[k] = arr[0];
    }
    for (const k of params.propertyKeysMultiple || []) out[k] = asList(read(o, k));
    for (const k of params.childKeysSingle || []) {
      const id = asList(read(o, k))[1];
      out[k] = isChildId(id) ? id : null;
    }
    for (const k of params.childKeysMultiple || []) out[k] = asList(read(o, k)).filter(isChildId);
    return out;
  };

  const set = (params) => {
    const o = resolve(params.idOrPath);
    log.push(["set", o.id, params.property, params.value]);
    guardMarkers(o.props, params.property, params.value);
    o.props[params.property] = [params.value];
    return null;
  };

  const call = (params) => {
    const o = resolve(params.idOrPath);
    const [fn, ...args] = params.args;
    log.push(["call", o.id, fn, ...args]);
    if (calls[fn]) return calls[fn](args, o);
    const dict = (list) => JSON.stringify({ notes: list });
    switch (fn) {
      case "get_major_version": return [12];
      case "get_minor_version": return [3];
      case "get_bugfix_version": return [5];
      case "get_version_string": return ["12.3.5"];
      case "get_all_notes_extended":
      case "get_selected_notes_extended":
        return dict(notesOf(o.id));
      case "get_notes_extended": {
        const [fromPitch, pitchSpan, fromTime, timeSpan] = args;
        return dict(notesOf(o.id).filter((n) =>
          n.pitch >= fromPitch && n.pitch < fromPitch + pitchSpan &&
          n.start_time >= fromTime && n.start_time < fromTime + timeSpan));
      }
      /**
       * Live returns a dictionary with no `notes` key when none of the ids are
       * in the clip, so the fake does too — the shape that used to crash the
       * stale-id pre-check.
       */
      case "get_notes_by_id": {
        const found = notesOf(o.id).filter((n) => args.includes(n.note_id));
        return found.length === 0 ? JSON.stringify({}) : dict(found);
      }
      case "add_new_notes":
        return ["id", ...args[0].notes.map((n) => {
          const note_id = nextNoteId++;
          notesOf(o.id).push({ ...DEFAULT_NOTE, ...n, note_id });
          return note_id;
        })];
      /**
       * Live ignores the whole list when any note_id is not in the clip; the
       * guard in `applyNoteModifications` exists for that, and notes.test.js
       * "stale note_id" depends on this fake doing the same.
       */
      case "apply_note_modifications": {
        const list = notesOf(o.id);
        const mods = args[0].notes;
        if (mods.some((m) => !list.some((n) => n.note_id === m.note_id))) return null;
        for (const m of mods) Object.assign(list.find((n) => n.note_id === m.note_id), m);
        return null;
      }
      case "remove_notes_by_id":
        notes[o.id] = notesOf(o.id).filter((n) => !args.includes(n.note_id));
        return null;
      default: return null;
    }
  };

  return {
    objects,
    log,
    notes,
    calls,
    setsOf: (property) => log.filter(([action, , p]) => action === "set" && p === property),
    setOrder: () => log.filter(([action]) => action === "set").map(([, , property]) => property),
    exec: (params) => (params.action === "get" ? get : params.action === "set" ? set : call)(params),
  };
}

module.exports = { createLom, DEFAULT_NOTE };
