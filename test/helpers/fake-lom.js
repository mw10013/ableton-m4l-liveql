/**
 * A fake Live Object Model that implements the wire contract of
 * `liveql-m4l.js`, not Live's semantics. The four `get` loops, skipping a
 * member the object's `info` does not list (an object's members are its
 * `props` keys), the `id 0` and `"id"` token handling and the
 * empty-list-for-an-empty-member behaviour are mirrored here exactly; anything else (marker constraints, note id
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
    cue_points: ["id", 90],
    tuning_system: ["id", 95],
  };
}

/**
 * Live does not always answer with a list: a track with no clip slots gives the
 * empty symbol for `clip_slots`, so anything that is not a list is read as one.
 */
const asList = (v) =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

/**
 * The `id` tokens separating child ids, `id 0` for no child, and the empty
 * symbol Live pads an empty child list with are none of them ids to resolve.
 */
const isChildId = (v) =>
  v !== "id" && v !== 0 && v !== "" && v !== undefined && v !== null;

/** A track's props, less the `absent` members, which its `info` leaves out. */
function trackProps(overrides, absent = []) {
  const props = {
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
    color: [16_711_680],
    color_index: [1],
    is_foldable: [0],
    is_grouped: [0],
    is_visible: [1],
    is_frozen: [0],
    playing_slot_index: [-1],
    fired_slot_index: [-1],
    group_track: ["id", 0],
    clip_slots: [],
    arrangement_clips: [],
    devices: [],
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(props).filter(([k]) => !absent.includes(k)),
  );
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
    color: [16_711_680],
    clip: ["id", 0],
    ...overrides,
  };
}

function clipProps(overrides) {
  return {
    name: [],
    color: [16_711_680],
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
 * A device's props. Every device's `info` lists the LOM's `type` property, the
 * DeviceType int (1 = instrument, 2 = audio_effect), which shares its name with
 * the fixture's `type`, the object's `LiveAPI.type`.
 */
function deviceProps(overrides) {
  return {
    can_have_chains: [0],
    can_have_drum_pads: [0],
    class_display_name: ["Device"],
    class_name: ["Device"],
    is_active: [1],
    name: ["Device"],
    type: [1],
    latency_in_samples: [0],
    latency_in_ms: [0],
    can_compare_ab: [1],
    is_using_compare_preset_b: [0],
    ...overrides,
  };
}

/** A non-quantized parameter's props; its `info` leaves out value_items. */
function parameterProps(overrides) {
  return {
    name: ["Parameter"],
    original_name: ["Parameter"],
    is_enabled: [1],
    is_quantized: [0],
    min: [0],
    max: [1],
    default_value: [0],
    value: [0],
    display_value: [0],
    automation_state: [0],
    state: [0],
    ...overrides,
  };
}

/**
 * One MIDI track (10) holding a Simpler (60) with two parameters (70, 71) and a plain Device (61), with a clip slot holding MIDI clip 40 whose groove is 91, one audio track
 * (11) holding arrangement clip 50 and an Audio Effect Rack (62) whose chain (80) holds a plain Device (63), a return track (13) holding a Shifter (66) and a master track (12) holding a plug-in (67) and a Max Audio Effect (68) whose audio buses are 72 and 73
 * missing the members Live's `info` leaves out there; the master track's `info`
 * lists `output_routing_type`, which Live answers with a dictionary missing
 * its key. None of them is a Group
 * Track, so none has a fold_state. Song.View's
 * `highlighted_clip_slot` is `id 0` so the bridge's null child is covered.
 * The Song has one cue point (90) and a tuning system (95). Every device view's `LiveAPI.type` is a
 * bare `View`, so only its members tell the Simpler's view (64) from the
 * plain Device's (65).
 */
function defaultObjects() {
  return {
    live_set: { id: 1, path: "live_set", type: "Song", props: songProps() },
    live_app: { id: 3, path: "live_app", type: "Application", props: {} },
    2: {
      id: 2,
      path: "live_set view",
      type: "Song.View",
      props: {
        draw_mode: [0],
        follow_song: [1],
        detail_clip: ["id", 40],
        selected_track: ["id", 10],
        highlighted_clip_slot: ["id", 0],
        selected_scene: ["id", 30],
      },
    },
    10: {
      id: 10,
      path: "live_set tracks 0",
      type: "Track",
      props: trackProps({
        name: ["MIDI"],
        clip_slots: ["id", 20, "id", 21],
        devices: ["id", 60, "id", 61],
        input_routing_type: [
          '{"input_routing_type": {"display_name": "All Ins", "identifier": 17}}',
        ],
        available_input_routing_types: [
          '{"available_input_routing_types": [{"display_name": "All Ins", "identifier": 17}, {"display_name": "No Input", "identifier": 23}]}',
        ],
      }),
    },
    60: {
      id: 60,
      path: "live_set tracks 0 devices 0",
      type: "SimplerDevice",
      props: deviceProps({
        class_display_name: ["Simpler"],
        class_name: ["OriginalSimpler"],
        name: ["Simpler"],
        playback_mode: [0],
        retrigger: [0],
        voices: [1],
        parameters: ["id", 70, "id", 71],
        view: ["id", 64],
      }),
    },
    64: {
      id: 64,
      path: "live_set tracks 0 devices 0 view",
      type: "View",
      props: { is_collapsed: [0], selected_slice: [-1] },
    },
    65: {
      id: 65,
      path: "live_set tracks 0 devices 1 view",
      type: "View",
      props: { is_collapsed: [0] },
    },
    70: {
      id: 70,
      path: "live_set tracks 0 devices 0 parameters 0",
      type: "DeviceParameter",
      props: parameterProps({ name: ["Volume"], value: [0.5] }),
    },
    /** Live's `info` lists value_items only on a quantized parameter. */
    71: {
      id: 71,
      path: "live_set tracks 0 devices 0 parameters 1",
      type: "DeviceParameter",
      props: parameterProps({
        name: ["Snap"],
        is_quantized: [1],
        value: [1],
        value_items: ["Off", "On"],
      }),
    },
    61: {
      id: 61,
      path: "live_set tracks 0 devices 1",
      type: "Device",
      props: deviceProps({
        class_display_name: ["Operator"],
        class_name: ["Operator"],
        name: ["Operator"],
        view: ["id", 65],
      }),
    },
    11: {
      id: 11,
      path: "live_set tracks 1",
      type: "Track",
      props: trackProps({
        name: ["Audio"],
        has_midi_input: [0],
        has_audio_input: [1],
        arrangement_clips: ["id", 50],
        devices: ["id", 62],
      }),
    },
    62: {
      id: 62,
      path: "live_set tracks 1 devices 0",
      type: "RackDevice",
      props: deviceProps({
        can_have_chains: [1],
        class_display_name: ["Audio Effect Rack"],
        type: [2],
        class_name: ["AudioEffectGroupDevice"],
        name: ["Audio Effect Rack"],
        chains: ["id", 80],
        return_chains: [],
      }),
    },
    80: {
      id: 80,
      path: "live_set tracks 1 devices 0 chains 0",
      type: "Chain",
      props: { name: ["Chain"], mute: [0], solo: [0], devices: ["id", 63] },
    },
    63: {
      id: 63,
      path: "live_set tracks 1 devices 0 chains 0 devices 0",
      type: "Device",
      props: deviceProps({
        class_display_name: ["Saturator"],
        type: [2],
        class_name: ["Saturator"],
        name: ["Saturator"],
      }),
    },
    /**
     * Live's `info` for the master track and a return track leaves out the
     * members they lack, as measured in the fixture Set; `LiveAPI.get` would
     * answer 1 for each, which is why the bridge never asks.
     */
    12: {
      id: 12,
      path: "live_set master_track",
      type: "Track",
      props: trackProps(
        {
          name: ["Master"],
          can_be_armed: [0],
          clip_slots: "",
          devices: ["id", 67, "id", 68],
          output_routing_type: ["{}"],
        },
        [
          "arm",
          "mute",
          "solo",
          "muted_via_solo",
          "playing_slot_index",
          "fired_slot_index",
          "arrangement_clips",
        ],
      ),
    },
    13: {
      id: 13,
      path: "live_set return_tracks 0",
      type: "Track",
      props: trackProps(
        {
          name: ["A Return"],
          can_be_armed: [0],
          clip_slots: "",
          devices: ["id", 66],
        },
        ["arm", "playing_slot_index", "fired_slot_index", "arrangement_clips"],
      ),
    },
    66: {
      id: 66,
      path: "live_set return_tracks 0 devices 0",
      type: "ShifterDevice",
      props: deviceProps({
        class_display_name: ["Shifter"],
        type: [2],
        class_name: ["Shifter"],
        name: ["Shifter"],
        pitch_bend_range: [2],
        pitch_mode_index: [0],
      }),
    },
    67: {
      id: 67,
      path: "live_set master_track devices 0",
      type: "PluginDevice",
      props: deviceProps({
        class_display_name: ["AUDelay"],
        type: [2],
        class_name: ["AuPluginDevice"],
        name: ["AUDelay"],
        is_editor_open: [0],
        presets: ["Untitled", "Slapback"],
        selected_preset_index: [0],
      }),
    },
    68: {
      id: 68,
      path: "live_set master_track devices 1",
      type: "MaxDevice",
      props: deviceProps({
        class_display_name: ["Max Audio Effect"],
        type: [2],
        class_name: ["MxDeviceAudioEffect"],
        name: ["Max Audio Effect"],
        audio_inputs: ["id", 72],
        audio_outputs: ["id", 73],
        midi_inputs: [],
        midi_outputs: [],
      }),
    },
    72: {
      id: 72,
      path: "live_set master_track devices 1 audio_inputs 0",
      type: "DeviceIO",
      props: {
        available_routing_channels: [
          '{"available_routing_channels": [{"display_name": "", "identifier": 50}]}',
        ],
        available_routing_types: [
          '{"available_routing_types": [{"display_name": "Ext. In", "identifier": 34}, {"display_name": "No Input", "identifier": 46}]}',
        ],
        default_external_routing_channel_is_none: [0],
        routing_channel: [
          '{"routing_channel": {"display_name": "", "identifier": 50}}',
        ],
        routing_type: [
          '{"routing_type": {"display_name": "No Input", "identifier": 46}}',
        ],
      },
    },
    73: {
      id: 73,
      path: "live_set master_track devices 1 audio_outputs 0",
      type: "DeviceIO",
      props: {
        routing_type: [
          '{"routing_type": {"display_name": "No Output", "identifier": 29}}',
        ],
      },
    },
    /**
     * Live answers the tuning system's `path` with null, which the bridge
     * passes on.
     */
    95: {
      id: 95,
      path: null,
      type: "TuningSystem",
      props: {
        name: ["7-EDO"],
        pseudo_octave_in_cents: [1200],
        lowest_note: ['{"index_in_octave": 6, "octave": -7}'],
        highest_note: ['{"index_in_octave": 0, "octave": 12}'],
        reference_pitch: [
          '{"index_in_octave": 5, "octave": 3, "frequency": 440.0}',
        ],
        note_tunings: ['{"note_tunings": [0.0, 171.42857360839844]}'],
      },
    },
    20: {
      id: 20,
      path: "live_set tracks 0 clip_slots 0",
      type: "ClipSlot",
      props: clipSlotProps({
        has_clip: [1],
        clip: ["id", 40],
      }),
    },
    21: {
      id: 21,
      path: "live_set tracks 0 clip_slots 1",
      type: "ClipSlot",
      props: clipSlotProps({ color: [] }),
    },
    30: {
      id: 30,
      path: "live_set scenes 0",
      type: "Scene",
      props: {
        name: [],
        color: [16_711_680],
        color_index: [1],
        is_empty: [0],
        is_triggered: [0],
        tempo: [120],
        tempo_enabled: [0],
        time_signature_numerator: [4],
        time_signature_denominator: [4],
        time_signature_enabled: [0],
        clip_slots: ["id", 20, "id", 21],
      },
    },
    40: {
      id: 40,
      path: "live_set tracks 0 clip_slots 0 clip",
      type: "Clip",
      props: clipProps({ has_groove: [1], groove: ["id", 91] }),
    },
    90: {
      id: 90,
      path: "live_set cue_points 0",
      type: "CuePoint",
      props: { name: ["Verse"], time: [16] },
    },
    91: {
      id: 91,
      path: "live_set groove_pool grooves 0",
      type: "Groove",
      props: {
        base: [3],
        name: ["Swing 16ths 66"],
        quantization_amount: [0],
        random_amount: [0],
        timing_amount: [100],
        velocity_amount: [0],
      },
    },
    41: {
      id: 41,
      path: "live_set tracks 0 clip_slots 0 clip view",
      type: "Clip.View",
      props: {
        grid_quantization: [4],
        grid_is_triplet: [0],
      },
    },
    50: {
      id: 50,
      path: "live_set tracks 1 arrangement_clips 0",
      type: "Clip",
      props: clipProps({
        is_arrangement_clip: [1],
        is_session_clip: [0],
        is_audio_clip: [1],
        is_midi_clip: [0],
        view: ["id", 51],
      }),
    },
    51: {
      id: 51,
      path: "live_set tracks 1 arrangement_clips 0 view",
      type: "Clip.View",
      props: {
        grid_quantization: [4],
        grid_is_triplet: [0],
      },
    },
  };
}

/**
 * Live rejects a marker that would cross its partner with these messages
 * (`refs/m4l-docs/apiref/lom/clip/index.md`: start_marker "Cannot be set behind
 * the end marker", end_marker "Cannot be set before the start marker"). The
 * same is assumed for loop_start / loop_end, which is the assumption a caller
 * ordering markers one per mutation is written against and clip.test.js
 * "surfaces a marker Live rejects" exercises. Live may instead clamp silently;
 * test/live answers that.
 */
function guardMarkers(props, property, value) {
  const at = (k) => props[k]?.[0];
  if (property === "start_marker" && value > at("end_marker"))
    // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- mirrors the string `liveql-m4l.js` throws
    throw "Cannot be set behind the end marker";
  if (property === "end_marker" && value < at("start_marker"))
    // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- mirrors the string `liveql-m4l.js` throws
    throw "Cannot be set before the start marker";
  if (property === "loop_start" && value > at("loop_end"))
    // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- mirrors the string `liveql-m4l.js` throws
    throw "Cannot be set behind the loop end";
  if (property === "loop_end" && value < at("loop_start"))
    // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- mirrors the string `liveql-m4l.js` throws
    throw "Cannot be set before the loop start";
}

function createLom() {
  const objects = defaultObjects();
  // Live resolves the Song and the Application by numeric id as well as by path
  objects[objects.live_set.id] = objects.live_set;
  objects[objects.live_app.id] = objects.live_app;
  const log = [];
  const gets = [];
  const notes = { 40: [{ note_id: 1, ...DEFAULT_NOTE }] };
  const calls = {};
  let nextNoteId = 100;

  const resolve = (idOrPath) => {
    const o = objects[idOrPath];
    if (!o)
      // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- mirrors the string `liveql-m4l.js` throws
      throw `Invalid live id or path: ${idOrPath}`;
    return o;
  };
  const read = (o, k) => o.props[k] ?? [];
  const notesOf = (id) => (notes[id] ??= []);

  const readObject = (params) => {
    const o = resolve(params.idOrPath);
    gets.push(params);
    const out = { id: o.id, path: o.path, liveApiType: o.type };
    const listed = (keys) => (keys ?? []).filter((k) => k in o.props);
    for (const k of listed(params.propertyKeysSingle)) {
      const arr = asList(read(o, k));
      if (arr.length === 1) out[k] = arr[0];
    }
    for (const k of listed(params.propertyKeysMultiple)) {
      const list = asList(read(o, k));
      out[k] = list.length === 1 && list[0] === "" ? [] : list;
    }
    for (const k of listed(params.childKeysSingle)) {
      const id = asList(read(o, k))[1];
      out[k] = isChildId(id) ? id : null;
    }
    for (const k of listed(params.childKeysMultiple))
      out[k] = asList(read(o, k)).filter(isChildId);
    return out;
  };
  const get = ({ reads }) =>
    reads.map((params) => {
      try {
        return { data: readObject(params) };
      } catch (err) {
        return { message: String(err) };
      }
    });

  const info = (params) => {
    const o = resolve(params.idOrPath);
    log.push(["info", o.id]);
    return [
      `id ${o.id}`,
      `type ${o.type}`,
      ...Object.keys(o.props).map((k) => `property ${k}`),
      "done",
    ].join("\n");
  };

  const set = ({ idOrPath, properties }) => {
    let applied = 0;
    try {
      const o = resolve(idOrPath);
      for (const [property, value] of properties) {
        log.push(["set", o.id, property, value]);
        guardMarkers(o.props, property, value);
        o.props[property] = [value];
        applied += 1;
      }
      return { applied };
    } catch (err) {
      return { applied, message: String(err) };
    }
  };

  const call = (params) => {
    const o = resolve(params.idOrPath);
    const [fn, ...args] = params.args;
    log.push(["call", o.id, fn, ...args]);
    if (calls[fn]) return calls[fn](args, o);
    const dict = (list) => JSON.stringify({ notes: list });
    switch (fn) {
      case "get_major_version": {
        return [12];
      }
      case "get_minor_version": {
        return [3];
      }
      case "get_bugfix_version": {
        return [5];
      }
      case "get_version_string": {
        return ["12.3.5"];
      }
      case "get_all_notes_extended":
      case "get_selected_notes_extended": {
        return dict(notesOf(o.id));
      }
      case "get_notes_extended": {
        const [fromPitch, pitchSpan, fromTime, timeSpan] = args;
        return dict(
          notesOf(o.id).filter(
            (n) =>
              n.pitch >= fromPitch &&
              n.pitch < fromPitch + pitchSpan &&
              n.start_time >= fromTime &&
              n.start_time < fromTime + timeSpan,
          ),
        );
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
      case "add_new_notes": {
        return [
          "id",
          ...args[0].notes.map((n) => {
            const note_id = nextNoteId++;
            notesOf(o.id).push({ ...DEFAULT_NOTE, ...n, note_id });
            return note_id;
          }),
        ];
      }
      /**
       * Live ignores the whole list when any note_id is not in the clip; the
       * guard in `applyNoteModifications` exists for that, and notes.test.js
       * "stale note_id" depends on this fake doing the same.
       */
      case "apply_note_modifications": {
        const list = notesOf(o.id);
        const mods = args[0].notes;
        if (mods.some((m) => !list.some((n) => n.note_id === m.note_id)))
          return null;
        for (const m of mods)
          Object.assign(
            list.find((n) => n.note_id === m.note_id),
            m,
          );
        return null;
      }
      case "remove_notes_by_id": {
        notes[o.id] = notesOf(o.id).filter((n) => !args.includes(n.note_id));
        return null;
      }
      /**
       * Selects the same half-open pitch/onset window `get_notes_extended`
       * does, and removes what it selects: a client rewriting a whole clip
       * derives its deletion window from a snapshot on the assumption those
       * two agree.
       */
      case "remove_notes_extended": {
        const [fromPitch, pitchSpan, fromTime, timeSpan] = args;
        notes[o.id] = notesOf(o.id).filter(
          (n) =>
            !(
              n.pitch >= fromPitch &&
              n.pitch < fromPitch + pitchSpan &&
              n.start_time >= fromTime &&
              n.start_time < fromTime + timeSpan
            ),
        );
        return null;
      }
      default: {
        return null;
      }
    }
  };

  return {
    objects,
    log,
    gets,
    notes,
    calls,
    setsOf: (property) =>
      log.filter((entry) => entry[0] === "set" && entry[2] === property),
    setOrder: () =>
      log.filter(([action]) => action === "set").map((entry) => entry[2]),
    exec: (params) => ({ get, info, set, call })[params.action](params),
  };
}

module.exports = { createLom, DEFAULT_NOTE };
