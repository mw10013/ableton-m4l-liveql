const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

describe("song", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("defaults the symbols an unsaved Set leaves empty", async () => {
    const { data } = await gql("{ live_set { name file_path scale_name tempo } }");
    assert.deepEqual(data.live_set, { name: "", file_path: "", scale_name: "", tempo: 120 });
  });

  it("reads a multi-value property as a list", async () => {
    const { data } = await gql("{ live_set { scale_intervals } }");
    assert.deepEqual(data.live_set.scale_intervals, [0, 2, 4, 5, 7, 9, 11]);
  });

  it("resolves the members Live omits on the master track as null", async () => {
    const { data } = await gql("{ live_set { master_track { name can_be_armed arm solo mute fold_state } } }");
    assert.deepEqual(data.live_set.master_track, {
      name: "Master",
      can_be_armed: false,
      arm: null,
      solo: null,
      mute: false,
      fold_state: null,
    });
  });

  it("resolves a child of id 0 as null", async () => {
    const { data } = await gql("{ live_set { view { highlighted_clip_slot { id } detail_clip { id } } } }");
    assert.equal(data.live_set.view.highlighted_clip_slot, null);
    assert.equal(data.live_set.view.detail_clip.id, 40);
  });

  it("walks tracks, scenes and clip slots", async () => {
    const { data } = await gql(
      "{ live_set { tracks { id name } return_tracks { id } visible_tracks { id } scenes { clip_slots { id has_clip } } } }"
    );
    assert.deepEqual(data.live_set.tracks, [{ id: 10, name: "MIDI" }, { id: 11, name: "Audio" }]);
    assert.deepEqual(data.live_set.return_tracks, [{ id: 13 }]);
    assert.deepEqual(data.live_set.visible_tracks, [{ id: 10 }, { id: 11 }]);
    assert.deepEqual(data.live_set.scenes[0].clip_slots, [
      { id: 20, has_clip: true },
      { id: 21, has_clip: false },
    ]);
  });

  it("returns null for an index past the end of a child list", async () => {
    const { data } = await gql(
      "{ live_set { a: track(index: 0) { id } b: track(index: 9) { id } c: scene(index: 0) { id } d: scene(index: 9) { id } } }"
    );
    assert.deepEqual(data.live_set, { a: { id: 10 }, b: null, c: { id: 30 }, d: null });
  });

  it("reads the application version through call", async () => {
    const { data } = await gql(
      "{ live_app { type get_major_version get_minor_version get_bugfix_version get_version_string } }"
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
      "{ a: clip(id: 40) { type } b: clip(id: 10) { id } c: track(id: 999) { id } d: clip_slot(id: 20) { has_clip } e: scene(id: 30) { is_empty } }"
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

  it("sets a child with the id N atom pair", async () => {
    const { data } = await gql("mutation { song_view_set_detail_clip(id: 2, detail_clip: 40) { id } }");
    assert.equal(data.song_view_set_detail_clip.id, 2);
    assert.deepEqual(lom.log, [["set", 2, "detail_clip", "id 40"]]);
  });

  it("writes song properties in the resolver's order, booleans as 0 and 1", async () => {
    const { data } = await gql(
      "mutation { song_set_properties(id: 1, properties: { loop_start: 4, loop_length: 8, loop: true, metronome: false, tempo: 90 }) { tempo } }"
    );
    assert.equal(data.song_set_properties.tempo, 90);
    assert.deepEqual(lom.setOrder(), ["tempo", "loop", "loop_length", "loop_start", "metronome"]);
    assert.deepEqual(lom.setsOf("loop"), [["set", 1, "loop", 1]]);
    assert.deepEqual(lom.setsOf("metronome"), [["set", 1, "metronome", 0]]);
  });

  it("names the action, the property and the target in a failure", async () => {
    const response = await gql("mutation { song_set_properties(id: 999, properties: { tempo: 90 }) { id } }");
    assert.equal(response.data.song_set_properties, null);
    assert.equal(errorMessage(response), "liveql: set tempo on 999: Invalid live id or path: 999");
  });
});
