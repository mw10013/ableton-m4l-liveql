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

  it("takes 0-9 for ClipView.grid_quantization and ignores anything outside", async () => {
    const { id: view_id, grid_quantization: originalGrid } =
      (await data(`{ clip(id: ${clip}) { view { id grid_quantization } } }`)).clip.view;
    const set = async (grid_quantization) =>
      (await data(
        `mutation { clip_view_set_properties(id: ${view_id}, properties: { grid_quantization: ${grid_quantization} }) { grid_quantization } }`
      )).clip_view_set_properties.grid_quantization;
    for (const grid of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.equal(await set(grid), grid);
    for (const out of [10, -1]) assert.equal(await set(out), 9, `${out} was not ignored`);
    await set(originalGrid);
    console.log("0 = Off, 1-4 = 8/4/2/1 Bars, 5-9 = 1/2 1/4 1/8 1/16 1/32 (read off Live's grid label)");
  });

  /**
   * Measures the `quantize` enum instead of trusting it: 64 notes on distinct
   * pitches at 0.0413-beat spacing land on no musical grid, so after a full
   * quantize the spacing of the distinct start times is the grid itself. The
   * spacing has to be irregular against the grid — a probe at 0.257 aliases
   * 1/16 and 1/32 into the same answer.
   */
  describe("quantize grid mapping", () => {
    const GRIDS = [
      { grid: 0, name: "no quantization", steps: [] },
      { grid: 1, name: "1/4", steps: [1] },
      { grid: 2, name: "1/8", steps: [1 / 2] },
      { grid: 3, name: "1/8T", steps: [1 / 3] },
      { grid: 4, name: "1/8 + 1/8T", steps: [1 / 2, 1 / 3] },
      { grid: 5, name: "1/16", steps: [1 / 4] },
      { grid: 6, name: "1/16T", steps: [1 / 6] },
      { grid: 7, name: "1/16 + 1/16T", steps: [1 / 4, 1 / 6] },
      { grid: 8, name: "1/32", steps: [1 / 8] },
      { grid: 9, name: "out of range, ignored", steps: [] },
    ];
    const PROBE = Array.from({ length: 64 }, (_, i) => ({
      pitch: 24 + i,
      start_time: Number((i * 0.0413).toFixed(6)),
      duration: 0.05,
      velocity: 100,
    }));
    const onAnyGrid = (time, steps) => steps.some((step) => Math.abs(time / step - Math.round(time / step)) < 1e-4);

    let swing;

    before(async () => {
      swing = (await data("{ live_set { id swing_amount } }")).live_set;
      await data(`mutation { song_set_properties(id: ${swing.id}, properties: { swing_amount: 0 }) { id } }`);
    });

    after(async () => {
      await gql(`mutation { song_set_properties(id: ${swing.id}, properties: { swing_amount: ${swing.swing_amount} }) { id } }`);
    });

    for (const { grid, name, steps } of GRIDS) {
      it(`quantizes ${grid} to ${name}`, async () => {
        const stale = (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { note_id } } } }`))
          .clip.get_all_notes_extended.notes.map((n) => n.note_id);
        if (stale.length > 0) await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${stale}]) { id } }`);
        await data(
          `mutation { clip_set_properties(id: ${clip}, properties: { looping: true, start_marker: 0, end_marker: 20, loop_start: 0, loop_end: 20 }) { id } }`
        );
        await data(`mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`, { n: PROBE });
        await data(`mutation { clip_quantize(id: ${clip}, quantization_grid: ${grid}, amount: 1.0) { id } }`);
        const after = (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { pitch start_time } } } }`))
          .clip.get_all_notes_extended.notes;
        const moved = after.filter((n) => Math.abs(n.start_time - PROBE.find((p) => p.pitch === n.pitch).start_time) > 1e-6);
        if (steps.length === 0) {
          assert.equal(moved.length, 0, `grid ${grid} moved ${moved.length} notes; it is not a no-op`);
          return;
        }
        assert.equal(moved.length, PROBE.length - 1, "the note already at 0 is the only one that should not move");
        const offGrid = after.filter((n) => !onAnyGrid(n.start_time, steps)).map((n) => n.start_time);
        assert.deepEqual(offGrid, [], `grid ${grid} is not ${name}: these landed off it: ${offGrid.slice(0, 5)}`);
      });
    }
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

  /**
   * Return and master tracks are where the LOM's absent members show up. The
   * bridge used to die on them: a track with no clip slots answers clip_slots
   * with the empty symbol, not an empty list, and the whole object read threw.
   */
  it("resolves return and master tracks, with their absent members as null", async () => {
    const TRACK = `id name type mute solo arm playing_slot_index fired_slot_index fold_state
      group_track { id } clip_slots { id } arrangement_clips { id }`;
    const { live_set } = await data(`{ live_set { return_tracks { ${TRACK} } master_track { ${TRACK} } } }`);
    assert.ok(live_set.return_tracks.length > 0, "open a Set with at least one return track");
    for (const track of [...live_set.return_tracks, live_set.master_track]) {
      assert.deepEqual(track.clip_slots, [], `${track.name} reported clip slots`);
      assert.deepEqual(track.arrangement_clips, [], `${track.name} reported arrangement clips`);
      assert.equal(track.group_track, null, `${track.name} reported a group track`);
      assert.equal(track.arm, null, `${track.name} reported arm; it cannot be armed`);
      assert.equal(track.fold_state, null, `${track.name} reported a fold state; it does not fold`);
      assert.equal(track.playing_slot_index, null, `${track.name} reported a playing slot`);
      assert.equal(track.fired_slot_index, null, `${track.name} reported a fired slot`);
    }
    const master = live_set.master_track;
    assert.equal(master.mute, null, "the master track reported mute");
    assert.equal(master.solo, null, "the master track reported solo");
    for (const track of live_set.return_tracks) {
      assert.equal(typeof track.mute, "boolean", "a return track lost its mute");
      assert.equal(typeof track.solo, "boolean", "a return track lost its solo");
    }
  });

  /**
   * The regular tracks are the control: the same members that must be null on
   * return and master tracks have to survive here, or the guard is too broad.
   */
  it("keeps those members on a regular track", async () => {
    const { live_set } = await data(
      "{ live_set { tracks { name can_be_armed is_foldable arm mute solo playing_slot_index fired_slot_index fold_state } } }"
    );
    const regular = live_set.tracks.filter((t) => t.can_be_armed);
    assert.ok(regular.length > 0, "open a Set with at least one regular track");
    for (const track of regular) {
      assert.equal(typeof track.arm, "boolean", `${track.name} lost arm`);
      assert.equal(typeof track.mute, "boolean", `${track.name} lost mute`);
      assert.equal(typeof track.solo, "boolean", `${track.name} lost solo`);
      assert.equal(typeof track.playing_slot_index, "number", `${track.name} lost playing_slot_index`);
      assert.equal(typeof track.fired_slot_index, "number", `${track.name} lost fired_slot_index`);
      assert.equal(track.fold_state, track.is_foldable ? track.fold_state : null, `${track.name} fold_state`);
    }
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
    assert.match(
      message,
      /clip_write_notes step apply_note_modifications failed after add_new_notes \(ids \d+\): apply_note_modifications on \d+: ignored because these note_ids are not in the clip: 999999$/
    );
    const added = message.match(/ids ([\d,]+)/)[1];
    await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${added}]) { id } }`);
  });

  /**
   * `clip_replace_notes` derives its deletion window from a snapshot on the
   * assumption `remove_notes_extended` selects by onset over a half-open
   * window, the way `get_notes_extended` does. Only Live can confirm that the
   * derived window really reaches the extremes: pitch 0 and 127, an onset
   * behind the start marker, and one past the loop.
   */
  describe("clip_replace_notes", () => {
    const REGION = { looping: true, start_marker: 0, end_marker: 8, loop_start: 0, loop_end: 8 };
    const FULL = { pitch: 61, start_time: 1.5, duration: 0.75, velocity: 93, mute: true, probability: 0.5, velocity_deviation: -7, release_velocity: 33 };
    const replace = (notes) =>
      gql(`mutation ($n: [ReplacementNoteInput!]!) { clip_replace_notes(id: ${clip}, notes: $n) { ${CLIP_STATE} } }`, { n: notes });
    const allNotes = async () =>
      (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { ${NOTE} } } } }`)).clip.get_all_notes_extended.notes;

    async function seed(notes) {
      const stale = (await allNotes()).map((n) => n.note_id);
      if (stale.length > 0) await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${stale}]) { id } }`);
      await data(`mutation ($p: ClipPropertiesInput!) { clip_set_properties(id: ${clip}, properties: $p) { id } }`, { p: REGION });
      if (notes.length > 0) {
        await data(`mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`, {
          n: notes.map((n) => ({ velocity: 100, duration: 0.25, ...n })),
        });
      }
      return allNotes();
    }

    it("empties a clip given an empty list", async () => {
      await seed([{ pitch: 60, start_time: 0 }, { pitch: 64, start_time: 1 }]);
      const response = await replace([]);
      assert.equal(response.errors, undefined, JSON.stringify(response.errors));
      assert.deepEqual(await allNotes(), []);
    });

    it("deletes the extremes of the snapshot window and adds the new list fresh", async () => {
      const seeded = await seed([
        { pitch: 0, start_time: 0 },
        { pitch: 127, start_time: 7.75 },
        { pitch: 60, start_time: 3 },
      ]);
      record("seeded onsets", seeded.map((n) => `${n.pitch}@${n.start_time}`).join(" "));
      const response = await replace([{ ...FULL, start_time: 2 }]);
      assert.equal(response.errors, undefined, JSON.stringify(response.errors));
      const after = await allNotes();
      assert.equal(after.length, 1, `expected only the replacement, got ${after.length}`);
      assert.equal(after[0].pitch, 61);
      assert.ok(
        !seeded.some((n) => n.note_id === after[0].note_id),
        "a replacement kept an old note_id"
      );
    });

    it("round-trips every modeled field", async () => {
      await seed([]);
      await replace([FULL]);
      const [{ note_id: _id, ...note }] = await allNotes();
      assert.deepEqual(note, FULL);
    });

    /**
     * Whether a note can sit behind the start marker at all is Live's call, not
     * LiveQL's, so this records what the seed produced before asserting the
     * replacement cleared whatever landed.
     */
    it("covers an onset behind the start marker", async () => {
      const seeded = await seed([{ pitch: 60, start_time: -2 }]);
      record("note seeded at start_time -2 landed at", seeded.map((n) => n.start_time).join(", ") || "(nothing)");
      await replace([{ ...FULL, start_time: 0 }]);
      const after = await allNotes();
      assert.equal(after.length, 1, `expected only the replacement, got ${after.length}`);
      assert.equal(after[0].start_time, 0);
    });

    it("rejects an audio clip before changing it", async (t) => {
      const audio = (await data(`{ live_set { tracks { clip_slots { clip { id is_midi_clip } } } } }`))
        .live_set.tracks.flatMap((tr) => tr.clip_slots.map((s) => s.clip)).find((c) => c && !c.is_midi_clip);
      if (!audio) return t.skip("no audio clip in the Set");
      const response = await gql(
        `mutation ($n: [ReplacementNoteInput!]!) { clip_replace_notes(id: ${audio.id}, notes: $n) { id } }`,
        { n: [FULL] }
      );
      assert.match(response.errors[0].message, /clip_replace_notes step preflight failed: clip \d+ is not a MIDI clip$/);
    });
  });

  /**
   * The LOM says an omitted `destination_time` places the copies "after the last
   * selected note" without saying what that means for a chord, a gap, or notes
   * running past the loop. Each case asserts the shape of the answer — one copy
   * per source note, all moved by a single uniform delta — and records the delta
   * itself, which is the number Prelive needs to predict a Duplicate.
   */
  describe("duplicate_notes_by_id default placement", () => {
    const REGION = { looping: true, start_marker: 0, end_marker: 8, loop_start: 0, loop_end: 8 };
    const CASES = [
      { name: "one grid-aligned sixteenth", notes: [{ pitch: 60, start_time: 0, duration: 0.25 }] },
      { name: "one off-grid note", notes: [{ pitch: 60, start_time: 0.3, duration: 0.25 }] },
      {
        name: "a chord with mixed durations",
        notes: [
          { pitch: 60, start_time: 0, duration: 1 },
          { pitch: 64, start_time: 0, duration: 0.5 },
          { pitch: 67, start_time: 0, duration: 2 },
        ],
      },
      {
        name: "two notes with a gap",
        notes: [
          { pitch: 60, start_time: 0, duration: 0.25 },
          { pitch: 62, start_time: 2, duration: 0.25 },
        ],
      },
      { name: "notes ending beyond loop_end", notes: [{ pitch: 60, start_time: 7.5, duration: 2 }] },
    ];

    async function allNotes() {
      return (await data(`{ clip(id: ${clip}) { get_all_notes_extended { notes { ${NOTE} } } } }`))
        .clip.get_all_notes_extended.notes;
    }

    async function seed(notes) {
      const stale = (await allNotes()).map((n) => n.note_id);
      if (stale.length > 0) await data(`mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${stale}]) { id } }`);
      await data(`mutation ($p: ClipPropertiesInput!) { clip_set_properties(id: ${clip}, properties: $p) { id } }`, { p: REGION });
      return (await data(`mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`, {
        n: notes.map((n) => ({ velocity: 100, ...n })),
      })).clip_add_new_notes.note_ids;
    }

    for (const { name, notes } of CASES) {
      it(`places the copies of ${name}`, async () => {
        const note_ids = await seed(notes);
        const { clip_duplicate_notes_by_id: after } = await data(
          `mutation { clip_duplicate_notes_by_id(id: ${clip}, note_ids: [${note_ids}]) { ${CLIP_STATE} } }`
        );
        const copies = (await allNotes()).filter((n) => !note_ids.includes(n.note_id));
        assert.equal(copies.length, notes.length, `expected one copy per source note, got ${copies.length}`);
        const deltas = copies.map((copy) => {
          const source = notes.find((n) => n.pitch === copy.pitch);
          assert.ok(source, `copy at pitch ${copy.pitch} matches no source note`);
          assert.equal(copy.duration, source.duration, "a copy changed duration");
          return copy.start_time - source.start_time;
        });
        record(`${name} moved by`, `${[...new Set(deltas)].join(", ")} (region now ${after.loop_start}..${after.loop_end}, end_marker ${after.end_marker})`);
        assert.equal(new Set(deltas).size, 1, `copies were not shifted uniformly: ${deltas}`);
        assert.ok(deltas[0] > 0, `copies landed at or before the source (delta ${deltas[0]})`);
      });
    }
  });
});
