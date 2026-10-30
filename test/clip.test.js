const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

const SET_PROPERTIES = `mutation ($p: ClipPropertiesInput!) {
  clip_set_properties(id: 40, properties: $p) {
    looping loop_start loop_end start_marker end_marker position
  }
}`;

describe("clip", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("sets every given key once, in the fixed key order, without reading first", async () => {
    const { data, errors } = await gql(SET_PROPERTIES, {
      p: {
        position: 2,
        end_marker: 8,
        start_marker: 1,
        loop_end: 8,
        loop_start: 1,
        looping: false,
        name: "x",
      },
    });
    assert.equal(errors, undefined);
    assert.deepEqual(
      lom.log.map(([action]) => action).filter((a) => a !== "set"),
      [],
    );
    assert.deepEqual(lom.setOrder(), [
      "name",
      "looping",
      "loop_start",
      "loop_end",
      "start_marker",
      "end_marker",
      "position",
    ]);
    assert.deepEqual(data.clip_set_properties, {
      looping: false,
      loop_start: 1,
      loop_end: 8,
      start_marker: 1,
      end_marker: 8,
      position: 2,
    });
  });

  it("surfaces a marker Live rejects with the property that was refused", async () => {
    const response = await gql(SET_PROPERTIES, { p: { start_marker: 6 } });
    assert.equal(response.data.clip_set_properties, null);
    assert.equal(
      errorMessage(response),
      "liveql: set start_marker on 40: Cannot be set behind the end marker",
    );
  });

  it("reads the clip view and writes its properties", async () => {
    const { data } = await gql(
      "mutation { clip_view_set_properties(id: 41, properties: { grid_quantization: 5, grid_is_triplet: true }) { grid_quantization grid_is_triplet } }",
    );
    assert.deepEqual(data.clip_view_set_properties, {
      grid_quantization: 5,
      grid_is_triplet: true,
    });
    assert.deepEqual(lom.setOrder(), ["grid_quantization", "grid_is_triplet"]);
    assert.deepEqual(lom.setsOf("grid_is_triplet"), [
      ["set", 41, "grid_is_triplet", 1],
    ]);
  });

  it("resolves the note functions as null on an audio clip", async () => {
    const { data, errors } = await gql(`{
      audio: clip(id: 50) { is_midi_clip get_all_notes_extended { notes { pitch } } get_notes_by_id(note_ids: [1]) { notes { pitch } } }
      midi: clip(id: 40) { is_midi_clip get_all_notes_extended { notes { pitch } } }
    }`);
    assert.equal(errors, undefined);
    assert.deepEqual(data.audio, {
      is_midi_clip: false,
      get_all_notes_extended: null,
      get_notes_by_id: null,
    });
    assert.deepEqual(data.midi.get_all_notes_extended.notes, [{ pitch: 60 }]);
    assert.deepEqual(
      lom.log.filter(([, id]) => id === 50),
      [],
    );
  });

  it("resolves a clip slot member Live omits as null", async () => {
    const { data } = await gql(
      "{ a: clip_slot(id: 20) { color } b: clip_slot(id: 21) { color clip { id } } }",
    );
    assert.equal(data.a.color, 16711680);
    assert.deepEqual(data.b, { color: null, clip: null });
  });

  it("rejects a later positional argument given without an earlier one", async () => {
    const response = await gql(
      "mutation { clip_slot_fire(id: 20, launch_quantization: 3) { id } }",
    );
    assert.equal(response.data.clip_slot_fire, null);
    assert.equal(
      errorMessage(response),
      "liveql: clip_slot_fire: record_length is required when a later optional argument is given",
    );
    assert.deepEqual(lom.log, []);
  });

  it("passes the positional arguments that were given, and only those", async () => {
    const { lom: bare, gql: fireBare } = createServer();
    await fireBare("mutation { clip_slot_fire(id: 20) { id } }");
    assert.deepEqual(bare.log, [["call", 20, "fire"]]);
    await gql(
      "mutation { clip_slot_fire(id: 20, record_length: 4, launch_quantization: 3) { id } }",
    );
    assert.deepEqual(lom.log, [["call", 20, "fire", 4, 3]]);
  });

  it("applies the same positional rule to scene_fire, converting booleans", async () => {
    const response = await gql(
      "mutation { scene_fire(id: 30, can_select_scene_on_launch: true) { id } }",
    );
    assert.equal(
      errorMessage(response),
      "liveql: scene_fire: force_legato is required when a later optional argument is given",
    );
    await gql(
      "mutation { scene_fire(id: 30, force_legato: true, can_select_scene_on_launch: false) { id } }",
    );
    assert.deepEqual(lom.log, [["call", 30, "fire", 1, 0]]);
  });

  it("passes an object argument as the id N atom pair", async () => {
    await gql("mutation { track_delete_clip(id: 10, clip: 40) { id } }");
    await gql(
      "mutation { clip_slot_duplicate_clip_to(id: 20, target_clip_slot: 21) { id } }",
    );
    assert.deepEqual(lom.log, [
      ["call", 10, "delete_clip", "id 40"],
      ["call", 20, "duplicate_clip_to", "id 21"],
    ]);
  });

  it("omits an absent optional key from a dictionary argument", async () => {
    await gql(
      "mutation { clip_duplicate_notes_by_id(id: 40, note_ids: [1], transposition_amount: 12) { id } }",
    );
    assert.deepEqual(lom.log[0], [
      "call",
      40,
      "duplicate_notes_by_id",
      { note_ids: [1], transposition_amount: 12 },
    ]);
  });
});
