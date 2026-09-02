const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");

/**
 * The questions only a running Live can answer, written as assertions. Opt-in:
 * it mutates the open Set, so it never runs as part of `pnpm test`.
 *
 *   LIVEQL_E2E=1 pnpm test:live      (LIVEQL_URL overrides the endpoint)
 *
 * Expects a disposable Set with the LiveQL device started and at least one MIDI
 * track holding one clip; the clip's loop, markers and notes are restored
 * afterwards. Cases that answer an open question print a `RECORD:` line rather
 * than asserting an outcome — the answer belongs in the JSDoc of the code that
 * assumes it, in `liveql-n4m.js`, after a human has seen it.
 */
const URL = process.env.LIVEQL_URL ?? "http://localhost:4000/graphql";
const SKIP = !process.env.LIVEQL_E2E && "set LIVEQL_E2E=1 and open a disposable Set with the device running";

const CLIP_STATE = "id looping loop_start loop_end start_marker end_marker position length end_time";
const NOTE = "note_id pitch start_time duration velocity mute probability velocity_deviation release_velocity";

async function gql(query, variables) {
  const response = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

async function data(query, variables) {
  const response = await gql(query, variables);
  assert.equal(response.errors, undefined, JSON.stringify(response.errors));
  return response.data;
}

function record(question, answer) {
  console.log(`RECORD: ${question} -> ${answer}`);
}

describe("live", { skip: SKIP }, () => {
  let clip, track, view, original, originalNotes;

  before(async () => {
    const { live_set } = await data(`{
      live_set {
        id name file_path
        view { id }
        tracks { id has_midi_input clip_slots { clip { ${CLIP_STATE} } } }
      }
    }`).catch((err) => {
      assert.fail(`no LiveQL server at ${URL}: ${err.message}`);
    });
    view = live_set.view.id;
    track = live_set.tracks.find((t) => t.has_midi_input && t.clip_slots.some((s) => s.clip));
    assert.ok(track, "open a Set with a MIDI track holding at least one clip");
    original = track.clip_slots.find((s) => s.clip).clip;
    clip = original.id;
    originalNotes = (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { ${NOTE} } } } }`))
      .clip.get_all_notes_extended.notes;
    console.log(`live: using clip ${clip} on track ${track.id} of "${live_set.name || "(unsaved Set)"}"`);
  });

  after(async () => {
    if (!clip) return;
    const ids = (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { note_id } } } }`))
      .clip.get_all_notes_extended.notes.map((n) => n.note_id);
    if (ids.length > 0) {
      await gql(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${ids}]) { id } }`);
    }
    if (originalNotes.length > 0) {
      await gql(`mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`, {
        n: originalNotes.map(({ note_id: _id, ...note }) => note),
      });
    }
    const { id: _clipId, length: _length, end_time: _endTime, ...properties } = original;
    await gql(`mutation ($p: ClipPropertiesInput!) { clip_set_properties(id: ${clip}, properties: $p) { id } }`, {
      p: properties,
    });
  });

  it("returns one id per added note, in the order they were given", async () => {
    const notes = [
      { pitch: 61, start_time: 0, duration: 0.25, velocity: 100 },
      { pitch: 63, start_time: 0.5, duration: 0.25, velocity: 100 },
      { pitch: 65, start_time: 1, duration: 0.25, velocity: 100 },
    ];
    const { clip_add_new_notes } = await data(
      `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`,
      { n: notes }
    );
    const note_ids = clip_add_new_notes.note_ids;
    record("add_new_notes return shape reduces to", JSON.stringify(note_ids));
    assert.equal(note_ids.length, notes.length);
    const found = (await data(
      `{ clip(id: ${clip}) { get_notes_by_id(note_ids: [${note_ids}]) { notes { note_id pitch } } } }`
    )).clip.get_notes_by_id.notes;
    assert.equal(found.length, notes.length);
    assert.deepEqual(
      note_ids.map((id) => found.find((n) => n.note_id === id).pitch),
      notes.map((n) => n.pitch)
    );
    await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${note_ids}]) { id } }`);
  });

  it("applies a marker batch that grows the region", async () => {
    const p = { looping: true, start_marker: 0, end_marker: 8, loop_start: 0, loop_end: 8 };
    const { clip_set_properties } = await data(
      `mutation ($p: ClipPropertiesInput!) { clip_set_properties(id: ${clip}, properties: $p) { ${CLIP_STATE} } }`,
      { p }
    );
    record("grow batch returned", JSON.stringify(clip_set_properties));
    for (const [k, v] of Object.entries(p)) {
      assert.equal(clip_set_properties[k], v, `${k} came back as ${clip_set_properties[k]}; Live clamped or ignored it`);
    }
  });

  it("applies a marker batch that shrinks the region", async () => {
    const p = { start_marker: 1, end_marker: 2, loop_start: 1, loop_end: 2 };
    const { clip_set_properties } = await data(
      `mutation ($p: ClipPropertiesInput!) { clip_set_properties(id: ${clip}, properties: $p) { ${CLIP_STATE} } }`,
      { p }
    );
    record("shrink batch returned", JSON.stringify(clip_set_properties));
    for (const [k, v] of Object.entries(p)) {
      assert.equal(clip_set_properties[k], v, `${k} came back as ${clip_set_properties[k]}; Live clamped or ignored it`);
    }
  });

  it("never silently accepts a start_marker behind the end marker", async () => {
    await data(
      `mutation { clip_set_properties(id: ${clip}, properties: { start_marker: 0, end_marker: 4 }) { id } }`
    );
    const response = await gql(
      `mutation { clip_set_properties(id: ${clip}, properties: { start_marker: 6 }) { start_marker end_marker } }`
    );
    const answer = response.errors
      ? `error: ${response.errors[0].message}`
      : `no error, start_marker is ${response.data.clip_set_properties.start_marker}`;
    record("start_marker past end_marker", answer);
    if (!response.errors) {
      assert.notEqual(response.data.clip_set_properties.start_marker, 6, "Live took a start_marker behind the end marker");
    }
  });

  it("reports whether loop_end aliases end_marker when the clip is unlooped", async () => {
    const { clip_set_properties: unlooped } = await data(
      `mutation { clip_set_properties(id: ${clip}, properties: { looping: false, start_marker: 0, end_marker: 4 }) { ${CLIP_STATE} } }`
    );
    record("unlooped loop_end vs end_marker", `${unlooped.loop_end} vs ${unlooped.end_marker}`);
    record("unlooped end_time vs end_marker", `${unlooped.end_time} vs ${unlooped.end_marker}`);
    const { clip_set_properties: looped } = await data(
      `mutation { clip_set_properties(id: ${clip}, properties: { looping: true, loop_start: 0, loop_end: 2 }) { ${CLIP_STATE} } }`
    );
    record("looped end_time vs loop_end", `${looped.end_time} vs ${looped.loop_end}`);
  });

  it("round-trips every grid_quantization int", async () => {
    const view_id = (await data(`{ clip(id: ${clip}) { view { id } } }`)).clip.view.id;
    for (const grid_quantization of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const response = await gql(
        `mutation { clip_view_set_properties(id: ${view_id}, properties: { grid_quantization: ${grid_quantization} }) { grid_quantization } }`
      );
      record(
        `grid_quantization ${grid_quantization}`,
        response.errors ? `error: ${response.errors[0].message}` : `reads back ${response.data.clip_view_set_properties.grid_quantization}`
      );
    }
    console.log("MANUAL: compare the RECORD lines above with the grid Live's editor shows for each value");
  });

  it("returns an empty string for the members of an unsaved Set", async (t) => {
    const { live_set } = await data("{ live_set { name file_path } }");
    if (live_set.file_path !== "") {
      t.skip(`Set is saved at ${live_set.file_path}; open an unsaved Set to answer this`);
      return;
    }
    assert.equal(live_set.name, "");
    record("unsaved Set name and file_path", '"" (the empty symbol did not drop the field)');
  });

  it("sets a child object by id", async () => {
    const { song_view_set_detail_clip } = await data(
      `mutation { song_view_set_detail_clip(id: ${view}, detail_clip: ${clip}) { detail_clip { id } } }`
    );
    record('set with the "id N" string form', "accepted");
    assert.equal(song_view_set_detail_clip.detail_clip.id, clip);
  });

  it("returns null, not an error, for an id of the wrong type", async () => {
    const response = await gql(`{ a: clip(id: ${track.id}) { id } b: track(id: 999999) { id } }`);
    assert.equal(response.errors, undefined);
    assert.deepEqual(response.data, { a: null, b: null });
  });

  it("names the failing step and the ids already added in a write", async () => {
    const response = await gql(
      `mutation ($n: [NoteInput!]!) {
        clip_write_notes(id: ${clip}, input: { add_new_notes: $n, apply_note_modifications: [{ note_id: 999999, pitch: 63 }] }) { note_ids }
      }`,
      { n: [{ pitch: 61, start_time: 0, duration: 0.25, velocity: 100 }] }
    );
    assert.ok(response.errors, "expected the stale note_id to fail the write");
    const message = response.errors[0].message;
    record("clip_write_notes step failure", message);
    assert.match(message, /clip_write_notes step apply_note_modifications failed after add_new_notes \(ids \d+\)/);
    const added = message.match(/ids ([\d,]+)/)[1];
    await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${added}]) { id } }`);
  });
});
