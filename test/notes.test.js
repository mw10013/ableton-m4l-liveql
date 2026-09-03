const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

const ADD = `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: 40, notes: $n) { note_ids clip { id } } }`;
const TWO_NOTES = [
  { pitch: 64, start_time: 1, duration: 0.5, velocity: 90, mute: true },
  { pitch: 67, start_time: 2, duration: 0.5, velocity: 80 },
];

describe("notes", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("returns the ids of the notes it added", async () => {
    const { data, errors } = await gql(ADD, { n: TWO_NOTES });
    assert.equal(errors, undefined);
    assert.deepEqual(data.clip_add_new_notes, { note_ids: [100, 101], clip: { id: 40 } });
    assert.deepEqual(lom.notes[40].map((n) => n.note_id), [1, 100, 101]);
  });

  it("converts a boolean note member to Live's 0 and 1", async () => {
    await gql(ADD, { n: TWO_NOTES });
    const [, , , dictionary] = lom.log[0];
    assert.equal(dictionary.notes[0].mute, 1);
    assert.equal(dictionary.notes[1].mute, undefined);
  });

  /**
   * The shape `add_new_notes` comes back as under v8 is unverified, which is
   * why `toIntList` accepts several. Each shape here is one the bridge could
   * plausibly forward, not a claim that Live produces it.
   */
  for (const [name, returned] of [
    ["a Max list with a leading symbol", ["id", 100, 101]],
    ["a flat list of ints", [100, 101]],
    ["a JSON string", "[100, 101]"],
    ["a dictionary keyed note_ids", { note_ids: [100, 101] }],
  ]) {
    it(`reduces ${name} to the note ids`, async () => {
      lom.calls.add_new_notes = () => returned;
      const { data } = await gql(ADD, { n: TWO_NOTES });
      assert.deepEqual(data.clip_add_new_notes.note_ids, [100, 101]);
    });
  }

  it("sorts a note dictionary by start_time then pitch", async () => {
    lom.notes[40] = [
      { note_id: 1, pitch: 67, start_time: 2, duration: 1, velocity: 100, mute: 0, probability: 1, velocity_deviation: 0, release_velocity: 64 },
      { note_id: 2, pitch: 64, start_time: 0, duration: 1, velocity: 100, mute: 0, probability: 1, velocity_deviation: 0, release_velocity: 64 },
      { note_id: 3, pitch: 60, start_time: 0, duration: 1, velocity: 100, mute: 0, probability: 1, velocity_deviation: 0, release_velocity: 64 },
    ];
    const { data } = await gql("{ clip(id: 40) { get_all_notes_extended { notes { note_id pitch start_time } } } }");
    assert.deepEqual(data.clip.get_all_notes_extended.notes.map((n) => n.note_id), [3, 2, 1]);
  });

  it("passes the window of get_notes_extended through positionally", async () => {
    lom.notes[40].push({ note_id: 2, pitch: 72, start_time: 3, duration: 1, velocity: 100, mute: 0, probability: 1, velocity_deviation: 0, release_velocity: 64 });
    const { data } = await gql(
      "{ clip(id: 40) { get_notes_extended(from_pitch: 60, pitch_span: 5, from_time: 0, time_span: 4) { notes { note_id } } } }"
    );
    assert.deepEqual(lom.log, [["call", 40, "get_notes_extended", 60, 5, 0, 4]]);
    assert.deepEqual(data.clip.get_notes_extended.notes, [{ note_id: 1 }]);
  });

  it("answers an empty note_ids list without asking Live", async () => {
    const { data } = await gql("{ clip(id: 40) { get_notes_by_id(note_ids: []) { notes { note_id } } } }");
    assert.deepEqual(data.clip.get_notes_by_id.notes, []);
    assert.deepEqual(lom.log, []);
  });

  it("reads a dictionary with no notes key as no notes", async () => {
    const { data, errors } = await gql("{ clip(id: 40) { get_notes_by_id(note_ids: [999]) { notes { note_id } } } }");
    assert.equal(errors, undefined);
    assert.deepEqual(data.clip.get_notes_by_id.notes, []);
  });

  it("applies a modification with one call and no read first", async () => {
    const { errors } = await gql(
      "mutation { clip_apply_note_modifications(id: 40, notes: [{ note_id: 1, pitch: 62, mute: true }]) { id } }"
    );
    assert.equal(errors, undefined);
    assert.deepEqual(lom.log.map(([, , fn]) => fn), ["apply_note_modifications"]);
    assert.equal(lom.notes[40][0].pitch, 62);
    assert.equal(lom.notes[40][0].mute, 1);
  });
});
