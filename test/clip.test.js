const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

const CLIP_SET = `mutation ($p: [ClipSetInput!]!) {
  clip_set(id: 40, properties: $p) {
    name looping loop_start loop_end start_marker end_marker
  }
}`;

function recordActions(lom) {
  const actions = [];
  const { exec } = lom;
  lom.exec = (params) => {
    actions.push(`${params.action} ${params.property ?? ""}`.trim());
    return exec(params);
  };
  return actions;
}

describe("clip", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("sets each item in list order, then reads the clip back once", async () => {
    const actions = recordActions(lom);
    const { data, errors } = await gql(CLIP_SET, {
      p: [
        { end_marker: 8 },
        { start_marker: 6 },
        { name: "x" },
        { looping: false },
      ],
    });
    assert.equal(errors, undefined);
    assert.deepEqual(actions, [
      "set end_marker",
      "set start_marker",
      "set name",
      "set looping",
      "get",
    ]);
    assert.deepEqual(lom.setsOf("looping"), [["set", 40, "looping", 0]]);
    assert.deepEqual(data.clip_set, {
      name: "x",
      looping: false,
      loop_start: 0,
      loop_end: 4,
      start_marker: 6,
      end_marker: 8,
    });
  });

  it("sets the same property twice when the list names it twice", async () => {
    const { errors } = await gql(CLIP_SET, {
      p: [{ name: "a" }, { name: "b" }],
    });
    assert.equal(errors, undefined);
    assert.deepEqual(lom.setsOf("name"), [
      ["set", 40, "name", "a"],
      ["set", 40, "name", "b"],
    ]);
  });

  it("stops at the first failed set, naming it and what was applied, with no readback", async () => {
    const actions = recordActions(lom);
    const response = await gql(CLIP_SET, {
      p: [
        { name: "x" },
        { looping: false },
        { start_marker: 6 },
        { end_marker: 8 },
      ],
    });
    assert.equal(response.data.clip_set, null);
    assert.equal(
      errorMessage(response),
      "liveql: set start_marker on 40: Cannot be set behind the end marker; clip_set stopped at properties[2], applied: properties[0] name, properties[1] looping",
    );
    assert.deepEqual(actions, ["set name", "set looping", "set start_marker"]);
  });

  it("says nothing was applied when the first set fails", async () => {
    const response = await gql(CLIP_SET, { p: [{ start_marker: 6 }] });
    assert.equal(
      errorMessage(response),
      "liveql: set start_marker on 40: Cannot be set behind the end marker; clip_set stopped at properties[0], applied: none",
    );
  });

  for (const { name, p } of [
    { name: "an unknown property", p: [{ name: "x" }, { length: 8 }] },
    { name: "a wrong type", p: [{ name: "x" }, { looping: "yes" }] },
    {
      name: "two keys in one item",
      p: [{ name: "x" }, { name: "y", looping: true }],
    },
    { name: "no key in an item", p: [{ name: "x" }, {}] },
    { name: "a null value", p: [{ name: "x" }, { name: null }] },
    { name: "a null item", p: [{ name: "x" }, null] },
  ])
    it(`rejects ${name} before any LOM call`, async () => {
      const response = await gql(CLIP_SET, { p });
      assert.equal(response.data, undefined);
      assert.ok(response.errors?.length > 0);
      assert.deepEqual(lom.log, []);
    });

  it("rejects two keys in an inline item before any LOM call", async () => {
    const response = await gql(
      'mutation { clip_set(id: 40, properties: [{ name: "x", looping: true }]) { id } }',
    );
    assert.match(
      errorMessage(response),
      /exactly one field must be specified/u,
    );
    assert.deepEqual(lom.log, []);
  });

  it("reads the clip view and writes its properties", async () => {
    const { data } = await gql(
      "mutation { clip_view_set(id: 41, properties: [{ grid_quantization: 5 }, { grid_is_triplet: true }]) { grid_quantization grid_is_triplet } }",
    );
    assert.deepEqual(data.clip_view_set, {
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
    assert.equal(data.a.color, 16_711_680);
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

  it("reads a clip's groove and sets it through groove_set", async () => {
    const { data } = await gql(
      "{ clip(id: 40) { has_groove groove { id name base } } }",
    );
    assert.deepEqual(data.clip, {
      has_groove: true,
      groove: { id: 91, name: "Swing 16ths 66", base: 3 },
    });
    const set = await gql(
      "mutation { groove_set(id: 91, properties: [{ timing_amount: 50 }]) { timing_amount } }",
    );
    assert.deepEqual(set.data, { groove_set: { timing_amount: 50 } });
    assert.deepEqual(lom.setsOf("timing_amount"), [
      ["set", 91, "timing_amount", 50],
    ]);
  });
});
