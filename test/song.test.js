const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

describe("song", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("defaults the symbols an unsaved Set leaves empty", async () => {
    const { data } = await gql(
      "{ live_set { name file_path scale_name tempo } }",
    );
    assert.deepEqual(data.live_set, {
      name: "",
      file_path: "",
      scale_name: "",
      tempo: 120,
    });
  });

  it("reads a multi-value property as a list", async () => {
    const { data } = await gql("{ live_set { scale_intervals } }");
    assert.deepEqual(data.live_set.scale_intervals, [0, 2, 4, 5, 7, 9, 11]);
  });

  /**
   * Live answers 1 for a member a track does not have rather than reporting it
   * missing, so every one of these would read as a confident lie - arm true on
   * a track that cannot be armed - if the bridge read a member the track's
   * info does not list.
   */
  it("resolves the members Live omits on the master track as null", async () => {
    const { data } = await gql(
      "{ live_set { master_track { name can_be_armed arm mute solo fold_state playing_slot_index fired_slot_index clip_slots { id } arrangement_clips { id } } } }",
    );
    assert.deepEqual(data.live_set.master_track, {
      name: "Master",
      can_be_armed: false,
      arm: null,
      mute: null,
      solo: null,
      fold_state: null,
      playing_slot_index: null,
      fired_slot_index: null,
      clip_slots: [],
      arrangement_clips: null,
    });
  });

  it("keeps mute and solo on a return track, which has them", async () => {
    const { data } = await gql(
      "{ live_set { return_tracks { name arm mute solo fold_state playing_slot_index clip_slots { id } } } }",
    );
    assert.deepEqual(data.live_set.return_tracks, [
      {
        name: "A Return",
        arm: null,
        mute: false,
        solo: false,
        fold_state: null,
        playing_slot_index: null,
        clip_slots: [],
      },
    ]);
  });

  it("keeps every one of those members on a regular track", async () => {
    const { data } = await gql(
      "{ live_set { tracks { name arm mute solo playing_slot_index fired_slot_index } } }",
    );
    assert.deepEqual(data.live_set.tracks[0], {
      name: "MIDI",
      arm: false,
      mute: false,
      solo: false,
      playing_slot_index: -1,
      fired_slot_index: -1,
    });
  });

  it("resolves a child of id 0 as null", async () => {
    const { data } = await gql(
      "{ live_set { view { highlighted_clip_slot { id } detail_clip { id } } } }",
    );
    assert.equal(data.live_set.view.highlighted_clip_slot, null);
    assert.equal(data.live_set.view.detail_clip.id, 40);
  });

  it("walks tracks, scenes and clip slots", async () => {
    const { data } = await gql(
      "{ live_set { tracks { id name } return_tracks { id } visible_tracks { id } scenes { clip_slots { id has_clip } } } }",
    );
    assert.deepEqual(data.live_set.tracks, [
      { id: 10, name: "MIDI" },
      { id: 11, name: "Audio" },
    ]);
    assert.deepEqual(data.live_set.return_tracks, [{ id: 13 }]);
    assert.deepEqual(data.live_set.visible_tracks, [{ id: 10 }, { id: 11 }]);
    assert.deepEqual(data.live_set.scenes[0].clip_slots, [
      { id: 20, has_clip: true },
      { id: 21, has_clip: false },
    ]);
  });

  it("returns null for an index past the end of a child list", async () => {
    const { data } = await gql(
      "{ live_set { a: track(index: 0) { id } b: track(index: 9) { id } c: scene(index: 0) { id } d: scene(index: 9) { id } } }",
    );
    assert.deepEqual(data.live_set, {
      a: { id: 10 },
      b: null,
      c: { id: 30 },
      d: null,
    });
  });

  it("reads the application version through call", async () => {
    const { data } = await gql(
      "{ live_app { type get_major_version get_minor_version get_bugfix_version get_version_string } }",
    );
    assert.deepEqual(data.live_app, {
      type: "Application",
      get_major_version: 12,
      get_minor_version: 3,
      get_bugfix_version: 5,
      get_version_string: "12.3.5",
    });
  });

  it("resolves a by-id query only when the id is of the expected type", async () => {
    const { data, errors } = await gql(
      "{ a: clip(id: 40) { type } b: clip(id: 10) { id } c: track(id: 999) { id } d: clip_slot(id: 20) { has_clip } e: scene(id: 30) { is_empty } }",
    );
    assert.equal(errors, undefined);
    assert.deepEqual(data, {
      a: { type: "Clip" },
      b: null,
      c: null,
      d: { has_clip: true },
      e: { is_empty: false },
    });
  });

  it("sets a child with the id N atom pair, and clears it with id 0", async () => {
    const { data } = await gql(
      "mutation { song_view_set(id: 2, properties: [{ detail_clip: 40 }, { selected_scene: 0 }, { follow_song: true }]) { id } }",
    );
    assert.equal(data.song_view_set.id, 2);
    assert.deepEqual(
      lom.log.filter(([action]) => action === "set"),
      [
        ["set", 2, "detail_clip", "id 40"],
        ["set", 2, "selected_scene", "id 0"],
        ["set", 2, "follow_song", 1],
      ],
    );
  });

  it("writes song properties in list order, booleans as 0 and 1", async () => {
    const { data } = await gql(
      "mutation { song_set(id: 1, properties: [{ loop_start: 4 }, { loop_length: 8 }, { loop: true }, { metronome: false }, { tempo: 90 }]) { tempo } }",
    );
    assert.equal(data.song_set.tempo, 90);
    assert.deepEqual(lom.setOrder(), [
      "loop_start",
      "loop_length",
      "loop",
      "metronome",
      "tempo",
    ]);
    assert.deepEqual(lom.setsOf("loop"), [["set", 1, "loop", 1]]);
    assert.deepEqual(lom.setsOf("metronome"), [["set", 1, "metronome", 0]]);
  });

  it("calls a function the docs type with its arguments in LOM order", async () => {
    const { data } = await gql(
      'mutation { track_create_audio_clip(id: 11, position: 4, file_path: "/a.wav") { id } song_scrub_by(id: 1, beats: -2) { id } }',
    );
    assert.deepEqual(data, {
      track_create_audio_clip: { id: 11 },
      song_scrub_by: { id: 1 },
    });
    assert.deepEqual(
      lom.log.filter(([action]) => action === "call"),
      [
        ["call", 11, "create_audio_clip", "/a.wav", 4],
        ["call", 1, "scrub_by", -2],
      ],
    );
  });

  it("names the action, the property and the target in a failure", async () => {
    const response = await gql(
      "mutation { song_set(id: 999, properties: [{ tempo: 90 }]) { id } }",
    );
    assert.equal(response.data.song_set, null);
    assert.equal(
      errorMessage(response),
      "liveql: set tempo on 999: Invalid live id or path: 999; song_set stopped at properties[0], applied: none",
    );
  });

  it("reads a cue point and calls its jump", async () => {
    const { data } = await gql("{ live_set { cue_points { id name time } } }");
    assert.deepEqual(data.live_set.cue_points, [
      { id: 90, name: "Verse", time: 16 },
    ]);
    const jumped = await gql("mutation { cue_point_jump(id: 90) { name } }");
    assert.deepEqual(jumped.data, { cue_point_jump: { name: "Verse" } });
    assert.deepEqual(
      lom.log.filter(([action]) => action === "call"),
      [["call", 90, "jump"]],
    );
  });

  it("reads the tuning system, whose path Live leaves null, with its dictionaries as typed objects", async () => {
    const { data } = await gql(
      "{ live_set { tuning_system { __typename id path name pseudo_octave_in_cents lowest_note { index_in_octave octave } reference_pitch { octave frequency } note_tunings } } }",
    );
    assert.deepEqual(data.live_set.tuning_system, {
      __typename: "TuningSystem",
      id: 95,
      path: null,
      name: "7-EDO",
      pseudo_octave_in_cents: 1200,
      lowest_note: { index_in_octave: 6, octave: -7 },
      reference_pitch: { octave: 3, frequency: 440 },
      note_tunings: [0, 171.42857360839844],
    });
  });

  it("sets a tuning system dictionary from a typed input with one set each", async () => {
    await gql(
      "mutation { tuning_system_set(id: 95, properties: [{ lowest_note: { index_in_octave: 1, octave: -6 } }, { note_tunings: [0, 170] }]) { id } }",
    );
    assert.deepEqual(
      lom.log.filter(([action]) => action === "set"),
      [
        ["set", 95, "lowest_note", '{"index_in_octave":1,"octave":-6}'],
        ["set", 95, "note_tunings", '{"note_tunings":[0,170]}'],
      ],
    );
  });

  it("reads a track's routing as typed objects, null where Live answers without the key", async () => {
    const { data } = await gql(
      "{ live_set { tracks { input_routing_type { display_name identifier } available_input_routing_types { display_name } } master_track { output_routing_type { identifier } } } }",
    );
    assert.deepEqual(data.live_set.tracks[0], {
      input_routing_type: { display_name: "All Ins", identifier: 17 },
      available_input_routing_types: [
        { display_name: "All Ins" },
        { display_name: "No Input" },
      ],
    });
    assert.deepEqual(data.live_set.tracks[1], {
      input_routing_type: null,
      available_input_routing_types: null,
    });
    assert.deepEqual(data.live_set.master_track, { output_routing_type: null });
  });
});
