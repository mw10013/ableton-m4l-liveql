const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { describe, it, before, after } = require("node:test");
const path = require("node:path");
const LOM = require("../../lom.json");
const OVERRIDES = require("../../lom-overrides.js");
const { openedSet, root } = require("./open.js");

/**
 * The questions only a running Live can answer, written as assertions. Opt-in:
 * it mutates the open Set, so it never runs as part of `pnpm test`.
 *
 *   pnpm live:open && pnpm test:live
 *
 * `LIVEQL_URL` overrides the endpoint and `LIVEQL_WAIT_S` how long to wait for
 * it (120). Runs only against a Set `pnpm live:open` opened from this
 * checkout, never a Set of real work, and expects at least one MIDI track
 * holding one clip;
 * the clip's loop, markers and notes are restored afterwards. Cases that answer an open question print a `RECORD:` line rather
 * than asserting an outcome — the answer belongs in the JSDoc of the code that
 * assumes it, in `liveql-n4m.js`, after a human has seen it.
 */
const URL = process.env.LIVEQL_URL ?? "http://localhost:5100/graphql";
const SKIP =
  !process.env.LIVEQL_E2E && "set LIVEQL_E2E=1 and run pnpm live:open first";

const CLIP_STATE =
  "id looping loop_start loop_end start_marker end_marker position length end_time";
/**
 * `clip_set` applies its items in list order. This keeps the order the old
 * `clip_set_properties` input object applied them in, its schema field order,
 * so marker writes behave as they did when these answers were recorded.
 */
const CLIP_SET_ORDER = [
  "looping",
  "loop_start",
  "loop_end",
  "start_marker",
  "end_marker",
  "position",
];
const clipItems = (p) =>
  CLIP_SET_ORDER.filter((k) => k in p).map((k) => ({ [k]: p[k] }));
const NOTE =
  "note_id pitch start_time duration velocity mute probability velocity_deviation release_velocity";

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

/**
 * `pnpm live:open` returns as soon as Live is asked to open the Set; the server
 * answers only after Live has loaded it and the device has started Node, which
 * takes tens of seconds on a cold launch. Until then the port refuses the
 * connection, and while the bridge is still coming up a query can fail. Worse,
 * while Live waits on its "save changes?" prompt the previous Set's server may
 * still answer, and the suite would mutate that Set, so ready means the open
 * Set is exactly the copy this checkout's last `live:open` wrote.
 */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await gql("{ live_set { file_path } }").catch((err) => ({
      errors: [err],
    }));
    const filePath = response.data?.live_set?.file_path;
    const expected = openedSet();
    if (expected !== undefined && filePath === expected) return;
    if (Date.now() > deadline) {
      assert.fail(
        `${expected ?? "no live:open Set"} is not open at ${URL} after ${timeoutMs / 1000}s (run pnpm live:open): ${filePath ?? response.errors?.[0]?.message}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
}

function record(question, answer) {
  console.log(`RECORD: ${question} -> ${answer}`);
}

describe("live", { skip: SKIP }, () => {
  let clip, original, originalNotes, track, view;

  before(async () => {
    await waitForServer(Number(process.env.LIVEQL_WAIT_S ?? 120) * 1000);
    const { live_set } = await data(`{
      live_set {
        id name file_path
        view { id }
        tracks { id has_midi_input clip_slots { clip { ${CLIP_STATE} } } }
      }
    }`);
    view = live_set.view.id;
    track = live_set.tracks.find(
      (t) => t.has_midi_input && t.clip_slots.some((s) => s.clip),
    );
    assert.ok(track, "open a Set with a MIDI track holding at least one clip");
    original = track.clip_slots.find((s) => s.clip).clip;
    clip = original.id;
    originalNotes = (
      await data(
        `{ clip(id: ${clip}) { get_all_notes_extended { notes { ${NOTE} } } } }`,
      )
    ).clip.get_all_notes_extended.notes;
    console.log(
      `live: using clip ${clip} on track ${track.id} of "${live_set.name === "" ? "(unsaved Set)" : live_set.name}"`,
    );
  });

  after(async () => {
    if (!clip) return;
    const ids = (
      await data(
        `{ clip(id: ${clip}) { get_all_notes_extended { notes { note_id } } } }`,
      )
    ).clip.get_all_notes_extended.notes.map((n) => n.note_id);
    if (ids.length > 0) {
      await gql(
        `mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${ids}]) { id } }`,
      );
    }
    if (originalNotes.length > 0) {
      await gql(
        `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`,
        {
          n: originalNotes.map(({ note_id: _id, ...note }) => note),
        },
      );
    }
    const {
      id: _clipId,
      length: _length,
      end_time: _endTime,
      ...properties
    } = original;
    await gql(
      `mutation ($p: [ClipSetInput!]!) { clip_set(id: ${clip}, properties: $p) { id } }`,
      {
        p: clipItems(properties),
      },
    );
  });

  /**
   * Live loads the device from whichever `liveql.amxd` the Set's `FileRef`
   * names, and Max resolves both scripts from that device's folder, so a Set
   * left over from another checkout runs that checkout's code. Node for Max
   * starts the server with its script's folder as the working directory, which
   * pins down which checkout is serving.
   */
  it("serves from this checkout", () => {
    const lsof = (...args) =>
      execFileSync("lsof", ["-nP", ...args], { encoding: "utf8" });
    const pid = /^p(?<pid>\d+)$/mu.exec(
      lsof(`-iTCP:${new globalThis.URL(URL).port}`, "-sTCP:LISTEN", "-Fp"),
    )?.groups.pid;
    assert.ok(pid, `no process listening for ${URL}`);
    assert.equal(
      /^n(?<cwd>.*)$/mu.exec(lsof("-a", "-p", pid, "-d", "cwd", "-Fn"))?.groups
        .cwd,
      root,
    );
  });

  it("returns one id per added note, in the order they were given", async () => {
    const notes = [
      { pitch: 61, start_time: 0, duration: 0.25, velocity: 100 },
      { pitch: 63, start_time: 0.5, duration: 0.25, velocity: 100 },
      { pitch: 65, start_time: 1, duration: 0.25, velocity: 100 },
    ];
    const { clip_add_new_notes } = await data(
      `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`,
      { n: notes },
    );
    const note_ids = clip_add_new_notes.note_ids;
    record("add_new_notes return shape reduces to", JSON.stringify(note_ids));
    assert.equal(note_ids.length, notes.length);
    const found = (
      await data(
        `{ clip(id: ${clip}) { get_notes_by_id(note_ids: [${note_ids}]) { notes { note_id pitch } } } }`,
      )
    ).clip.get_notes_by_id.notes;
    assert.equal(found.length, notes.length);
    assert.deepEqual(
      note_ids.map((id) => found.find((n) => n.note_id === id).pitch),
      notes.map((n) => n.pitch),
    );
    await data(
      `mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${note_ids}]) { id } }`,
    );
  });

  /**
   * Ordering markers so start never crosses end is the caller's job: `clip_set`
   * applies its items in list order. Grow moves the ends first, shrink the
   * starts.
   */
  const setMarkers = async (keys, p) =>
    (
      await data(
        `mutation ($p: [ClipSetInput!]!) { clip_set(id: ${clip}, properties: $p) { ${CLIP_STATE} } }`,
        { p: [...keys, "looping"].map((k) => ({ [k]: p[k] })) },
      )
    ).clip_set;

  it("grows the region one marker per mutation, ends first", async () => {
    const p = {
      looping: true,
      start_marker: 0,
      end_marker: 8,
      loop_start: 0,
      loop_end: 8,
    };
    const state = await setMarkers(
      ["end_marker", "loop_end", "start_marker", "loop_start"],
      p,
    );
    record("grow returned", JSON.stringify(state));
    for (const [k, v] of Object.entries(p)) {
      assert.equal(
        state[k],
        v,
        `${k} came back as ${state[k]}; Live clamped or ignored it`,
      );
    }
  });

  it("shrinks the region one marker per mutation, starts first", async () => {
    const p = {
      looping: true,
      start_marker: 1,
      end_marker: 2,
      loop_start: 1,
      loop_end: 2,
    };
    const state = await setMarkers(
      ["start_marker", "loop_start", "end_marker", "loop_end"],
      p,
    );
    record("shrink returned", JSON.stringify(state));
    for (const [k, v] of Object.entries(p)) {
      assert.equal(
        state[k],
        v,
        `${k} came back as ${state[k]}; Live clamped or ignored it`,
      );
    }
  });

  it("never silently accepts a start_marker behind the end marker", async () => {
    await data(
      `mutation { clip_set(id: ${clip}, properties: [{ start_marker: 0 }, { end_marker: 4 }]) { id } }`,
    );
    const response = await gql(
      `mutation { clip_set(id: ${clip}, properties: [{ start_marker: 6 }]) { start_marker end_marker } }`,
    );
    const answer = response.errors
      ? `error: ${response.errors[0].message}`
      : `no error, start_marker is ${response.data.clip_set.start_marker}`;
    record("start_marker past end_marker", answer);
    if (!response.errors) {
      assert.notEqual(
        response.data.clip_set.start_marker,
        6,
        "Live took a start_marker behind the end marker",
      );
    }
  });

  it("reports whether loop_end aliases end_marker when the clip is unlooped", async () => {
    const { clip_set: unlooped } = await data(
      `mutation { clip_set(id: ${clip}, properties: [{ looping: false }, { start_marker: 0 }, { end_marker: 4 }]) { ${CLIP_STATE} } }`,
    );
    record(
      "unlooped loop_end vs end_marker",
      `${unlooped.loop_end} vs ${unlooped.end_marker}`,
    );
    record(
      "unlooped end_time vs end_marker",
      `${unlooped.end_time} vs ${unlooped.end_marker}`,
    );
    const { clip_set: looped } = await data(
      `mutation { clip_set(id: ${clip}, properties: [{ looping: true }, { loop_start: 0 }, { loop_end: 2 }]) { ${CLIP_STATE} } }`,
    );
    record(
      "looped end_time vs loop_end",
      `${looped.end_time} vs ${looped.loop_end}`,
    );
  });

  it("takes 0-9 for ClipView.grid_quantization and ignores anything outside", async () => {
    const { id: view_id, grid_quantization: originalGrid } = (
      await data(`{ clip(id: ${clip}) { view { id grid_quantization } } }`)
    ).clip.view;
    const set = async (grid_quantization) =>
      (
        await data(
          `mutation { clip_view_set(id: ${view_id}, properties: [{ grid_quantization: ${grid_quantization} }]) { grid_quantization } }`,
        )
      ).clip_view_set.grid_quantization;
    for (const grid of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      assert.equal(await set(grid), grid);
    for (const out of [10, -1])
      assert.equal(await set(out), 9, `${out} was not ignored`);
    await set(originalGrid);
    console.log(
      "0 = Off, 1-4 = 8/4/2/1 Bars, 5-9 = 1/2 1/4 1/8 1/16 1/32 (read off Live's grid label)",
    );
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
    const onAnyGrid = (time, steps) =>
      steps.some(
        (step) => Math.abs(time / step - Math.round(time / step)) < 1e-4,
      );

    let swing;

    before(async () => {
      swing = (await data("{ live_set { id swing_amount } }")).live_set;
      await data(
        `mutation { song_set(id: ${swing.id}, properties: [{ swing_amount: 0 }]) { id } }`,
      );
    });

    after(async () => {
      await gql(
        `mutation { song_set(id: ${swing.id}, properties: [{ swing_amount: ${swing.swing_amount} }]) { id } }`,
      );
    });

    for (const { grid, name, steps } of GRIDS) {
      it(`quantizes ${grid} to ${name}`, async () => {
        const stale = (
          await data(
            `{ clip(id: ${clip}) { get_all_notes_extended { notes { note_id } } } }`,
          )
        ).clip.get_all_notes_extended.notes.map((n) => n.note_id);
        if (stale.length > 0)
          await data(
            `mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${stale}]) { id } }`,
          );
        await data(
          `mutation { clip_set(id: ${clip}, properties: [{ looping: true }, { loop_start: 0 }, { loop_end: 20 }, { start_marker: 0 }, { end_marker: 20 }]) { id } }`,
        );
        await data(
          `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`,
          { n: PROBE },
        );
        await data(
          `mutation { clip_quantize(id: ${clip}, quantization_grid: ${grid}, amount: 1.0) { id } }`,
        );
        const after = (
          await data(
            `{ clip(id: ${clip}) { get_all_notes_extended { notes { pitch start_time } } } }`,
          )
        ).clip.get_all_notes_extended.notes;
        const moved = after.filter(
          (n) =>
            Math.abs(
              n.start_time - PROBE.find((p) => p.pitch === n.pitch).start_time,
            ) > 1e-6,
        );
        if (steps.length === 0) {
          assert.equal(
            moved.length,
            0,
            `grid ${grid} moved ${moved.length} notes; it is not a no-op`,
          );
          return;
        }
        assert.equal(
          moved.length,
          PROBE.length - 1,
          "the note already at 0 is the only one that should not move",
        );
        const offGrid = after
          .filter((n) => !onAnyGrid(n.start_time, steps))
          .map((n) => n.start_time);
        assert.deepEqual(
          offGrid,
          [],
          `grid ${grid} is not ${name}: these landed off it: ${offGrid.slice(0, 5)}`,
        );
      });
    }
  });

  it("returns an empty string for the members of an unsaved Set", async (t) => {
    const { live_set } = await data("{ live_set { name file_path } }");
    if (live_set.file_path !== "") {
      t.skip(
        `Set is saved at ${live_set.file_path}; open an unsaved Set to answer this`,
      );
      return;
    }
    assert.equal(live_set.name, "");
    record(
      "unsaved Set name and file_path",
      '"" (the empty symbol did not drop the field)',
    );
  });

  it("sets a child object by id", async () => {
    const { song_view_set } = await data(
      `mutation { song_view_set(id: ${view}, properties: [{ detail_clip: ${clip} }]) { detail_clip { id } } }`,
    );
    record('set with the "id N" string form', "accepted");
    assert.equal(song_view_set.detail_clip.id, clip);
  });

  /**
   * The LOM types TuningSystem's notes as dictionaries, which the schema types
   * as objects and writes back as the JSON string Live reads them as.
   */
  it("sets a tuning system note from a typed input, which moves highest_note too", async () => {
    const NOTES =
      "lowest_note { index_in_octave octave } highest_note { index_in_octave octave }";
    const { live_set } = await data(
      `{ live_set { tuning_system { id path ${NOTES} } } }`,
    );
    const { id, lowest_note, highest_note } = live_set.tuning_system;
    record("TuningSystem path", JSON.stringify(live_set.tuning_system.path));
    const set = async (p) =>
      (
        await data(
          `mutation ($p: [TuningSystemSetInput!]!) { tuning_system_set(id: ${id}, properties: $p) { ${NOTES} } }`,
          { p },
        )
      ).tuning_system_set;
    try {
      const up = (n) => ({ ...n, octave: n.octave + 1 });
      assert.deepEqual(await set([{ lowest_note: up(lowest_note) }]), {
        lowest_note: up(lowest_note),
        highest_note: up(highest_note),
      });
    } finally {
      assert.deepEqual(await set([{ lowest_note }, { highest_note }]), {
        lowest_note,
        highest_note,
      });
    }
  });

  it("sets a track's input routing channel by identifier, and ignores one outside the list", async () => {
    const ROUTING =
      "input_routing_channel { display_name identifier } available_input_routing_channels { display_name identifier }";
    const { live_set } = await data(
      `{ live_set { tracks { id has_midi_input ${ROUTING} } } }`,
    );
    const target = live_set.tracks.find(
      (t) => t.has_midi_input && t.available_input_routing_channels?.length > 1,
    );
    assert.ok(target, "the fixture Set has no MIDI track with input channels");
    const { input_routing_channel: current } = target;
    const available = target.available_input_routing_channels;
    assert.ok(available.some((c) => c.identifier === current.identifier));
    const other = available.find((c) => c.identifier !== current.identifier);
    const set = async (identifier) =>
      (
        await data(
          `mutation { track_set(id: ${target.id}, properties: [{ input_routing_channel: { identifier: ${identifier} } }]) { input_routing_channel { display_name identifier } } }`,
        )
      ).track_set.input_routing_channel;
    try {
      assert.deepEqual(await set(other.identifier), other);
      const outside = Math.max(...available.map((c) => c.identifier)) + 1000;
      assert.deepEqual(
        await set(outside),
        other,
        "Live no longer ignores an identifier outside the list",
      );
    } finally {
      assert.deepEqual(await set(current.identifier), current);
    }
  });

  /**
   * Return and master tracks are where the LOM's absent members show up. The
   * bridge used to die on them: a track with no clip slots answers clip_slots
   * with the empty symbol, not an empty list, and the whole object read threw.
   */
  /**
   * `LiveAPI.get` answers 1 for a member a track lacks, but `info` leaves the
   * member out, so `info` can tell which members an object really has.
   */
  it("lists in info only the members a track has", async () => {
    const { live_set } = await data(
      "{ live_set { master_track { info } return_tracks { info } tracks { info has_midi_input } } }",
    );
    const members = (info) =>
      new Set(
        info
          .split("\n")
          .filter((line) => line.startsWith("property "))
          .map((line) => line.split(" ")[1]),
      );
    const has = (info, names) => names.map((n) => members(info).has(n));
    assert.deepEqual(has(live_set.master_track.info, ["arm", "mute", "solo"]), [
      false,
      false,
      false,
    ]);
    assert.deepEqual(
      has(live_set.return_tracks[0].info, ["arm", "mute", "solo"]),
      [false, true, true],
    );
    assert.deepEqual(
      has(live_set.tracks.find((t) => t.has_midi_input).info, [
        "arm",
        "mute",
        "solo",
      ]),
      [true, true, true],
    );
  });

  it("resolves return and master tracks, with their absent members as null", async () => {
    const TRACK = `id name type mute solo arm playing_slot_index fired_slot_index fold_state
      group_track { id } clip_slots { id } arrangement_clips { id }`;
    const { live_set } = await data(
      `{ live_set { return_tracks { ${TRACK} } master_track { ${TRACK} } } }`,
    );
    assert.ok(
      live_set.return_tracks.length > 0,
      "open a Set with at least one return track",
    );
    for (const track of [...live_set.return_tracks, live_set.master_track]) {
      assert.deepEqual(
        track.clip_slots,
        [],
        `${track.name} reported clip slots`,
      );
      assert.equal(
        track.arrangement_clips,
        null,
        `${track.name} reported arrangement clips; its info has none`,
      );
      assert.equal(
        track.group_track,
        null,
        `${track.name} reported a group track`,
      );
      assert.equal(
        track.arm,
        null,
        `${track.name} reported arm; it cannot be armed`,
      );
      assert.equal(
        track.fold_state,
        null,
        `${track.name} reported a fold state; it does not fold`,
      );
      assert.equal(
        track.playing_slot_index,
        null,
        `${track.name} reported a playing slot`,
      );
      assert.equal(
        track.fired_slot_index,
        null,
        `${track.name} reported a fired slot`,
      );
    }
    const master = live_set.master_track;
    assert.equal(master.mute, null, "the master track reported mute");
    assert.equal(master.solo, null, "the master track reported solo");
    for (const track of live_set.return_tracks) {
      assert.equal(
        typeof track.mute,
        "boolean",
        "a return track lost its mute",
      );
      assert.equal(
        typeof track.solo,
        "boolean",
        "a return track lost its solo",
      );
    }
  });

  /**
   * The regular tracks are the control: the same members that must be null on
   * return and master tracks have to survive here, or the guard is too broad.
   */
  it("keeps those members on a regular track", async () => {
    const { live_set } = await data(
      "{ live_set { tracks { name can_be_armed is_foldable arm mute solo playing_slot_index fired_slot_index fold_state } } }",
    );
    const regular = live_set.tracks.filter((t) => t.can_be_armed);
    assert.ok(regular.length > 0, "open a Set with at least one regular track");
    for (const track of regular) {
      assert.equal(typeof track.arm, "boolean", `${track.name} lost arm`);
      assert.equal(typeof track.mute, "boolean", `${track.name} lost mute`);
      assert.equal(typeof track.solo, "boolean", `${track.name} lost solo`);
      assert.equal(
        typeof track.playing_slot_index,
        "number",
        `${track.name} lost playing_slot_index`,
      );
      assert.equal(
        typeof track.fired_slot_index,
        "number",
        `${track.name} lost fired_slot_index`,
      );
      assert.equal(
        track.fold_state,
        track.is_foldable ? track.fold_state : null,
        `${track.name} fold_state`,
      );
    }
  });

  it("returns null, not an error, for an id of the wrong type", async () => {
    const response = await gql(
      `{ a: clip(id: ${track.id}) { id } b: track(id: 999999) { id } }`,
    );
    assert.equal(response.errors, undefined);
    assert.deepEqual(response.data, { a: null, b: null });
  });

  it("resolves a device by id as its subclass and a parameter by id, and null for any other object", async () => {
    const { live_set } = await data(
      "{ live_set { tracks { devices { cls: __typename id view { id } parameters { id name } } } } }",
    );
    const device = live_set.tracks
      .flatMap((t) => t.devices)
      .find((d) => d.cls !== "GenericDevice");
    const [parameter] = device.parameters;
    const response = await gql(
      `{ a: device(id: ${device.id}) { cls: __typename } b: device_parameter(id: ${parameter.id}) { name } c: device(id: ${device.view.id}) { id } d: device_parameter(id: ${device.id}) { id } e: device(id: ${track.id}) { id } }`,
    );
    assert.equal(response.errors, undefined);
    assert.deepEqual(response.data, {
      a: { cls: device.cls },
      b: { name: parameter.name },
      c: null,
      d: null,
      e: null,
    });
  });

  /**
   * The bridge points one `LiveAPI` at each action's target, and Live leaves it
   * on its previous target when the id names no object, so a set on a bad id
   * once renamed the track read just before it.
   */
  it("fails a set on an id no object has without touching the object read before it", async () => {
    const { name } = (await data(`{ track(id: ${track.id}) { name } }`)).track;
    const response = await gql(
      'mutation { track_set(id: 999999, properties: [{ name: "liveql-stray" }]) { id } }',
    );
    assert.match(
      response.errors?.[0]?.message ?? "",
      /Invalid live id or path: 999999/u,
    );
    assert.equal(
      (await data(`{ track(id: ${track.id}) { name } }`)).track.name,
      name,
    );
  });

  /**
   * The LOM says an omitted `destination_time` places the copies "after the last
   * selected note" without saying what that means for a chord, a gap, or notes
   * running past the loop. Each case asserts the shape of the answer — one copy
   * per source note, all moved by a single uniform delta — and records the delta
   * itself, which is the number Prelive needs to predict a Duplicate.
   */
  describe("duplicate_notes_by_id default placement", () => {
    const REGION = {
      looping: true,
      start_marker: 0,
      end_marker: 8,
      loop_start: 0,
      loop_end: 8,
    };
    const CASES = [
      {
        name: "one grid-aligned sixteenth",
        notes: [{ pitch: 60, start_time: 0, duration: 0.25 }],
      },
      {
        name: "one off-grid note",
        notes: [{ pitch: 60, start_time: 0.3, duration: 0.25 }],
      },
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
      {
        name: "notes ending beyond loop_end",
        notes: [{ pitch: 60, start_time: 7.5, duration: 2 }],
      },
    ];

    async function allNotes() {
      return (
        await data(
          `{ clip(id: ${clip}) { get_all_notes_extended { notes { ${NOTE} } } } }`,
        )
      ).clip.get_all_notes_extended.notes;
    }

    async function seed(notes) {
      const stale = (await allNotes()).map((n) => n.note_id);
      if (stale.length > 0)
        await data(
          `mutation { clip_remove_notes_by_id(id: ${clip}, note_ids: [${stale}]) { id } }`,
        );
      await data(
        `mutation ($p: [ClipSetInput!]!) { clip_set(id: ${clip}, properties: $p) { id } }`,
        { p: clipItems(REGION) },
      );
      return (
        await data(
          `mutation ($n: [NoteInput!]!) { clip_add_new_notes(id: ${clip}, notes: $n) { note_ids } }`,
          {
            n: notes.map((n) => ({ velocity: 100, ...n })),
          },
        )
      ).clip_add_new_notes.note_ids;
    }

    for (const { name, notes } of CASES) {
      it(`places the copies of ${name}`, async () => {
        const note_ids = await seed(notes);
        const { clip_duplicate_notes_by_id: after } = await data(
          `mutation { clip_duplicate_notes_by_id(id: ${clip}, note_ids: [${note_ids}]) { ${CLIP_STATE} } }`,
        );
        const copies = (await allNotes()).filter(
          (n) => !note_ids.includes(n.note_id),
        );
        assert.equal(
          copies.length,
          notes.length,
          `expected one copy per source note, got ${copies.length}`,
        );
        const deltas = copies.map((copy) => {
          const source = notes.find((n) => n.pitch === copy.pitch);
          assert.ok(
            source,
            `copy at pitch ${copy.pitch} matches no source note`,
          );
          assert.equal(
            copy.duration,
            source.duration,
            "a copy changed duration",
          );
          return copy.start_time - source.start_time;
        });
        record(
          `${name} moved by`,
          `${[...new Set(deltas)].join(", ")} (region now ${after.loop_start}..${after.loop_end}, end_marker ${after.end_marker})`,
        );
        assert.equal(
          new Set(deltas).size,
          1,
          `copies were not shifted uniformly: ${deltas}`,
        );
        assert.ok(
          deltas[0] > 0,
          `copies landed at or before the source (delta ${deltas[0]})`,
        );
      });
    }
  });

  /**
   * The functions whose parameters the docs leave untyped or that answer a
   * value, called on the fixture's objects where they only read, and
   * otherwise on tracks, return tracks and scenes made for the purpose and
   * deleted afterwards, so the fixture's own are back as they were. `trigger_session_record` and
   * `press_current_dialog_button` are not called: the first records into
   * whichever track is armed, and the second only means something while Live
   * shows a dialog.
   */
  describe("functions whose parameters the docs leave untyped or that answer a value", () => {
    const LISTS = "id tracks { id } return_tracks { id } scenes { id }";
    let original;
    const ids = (list) => list.map((o) => o.id);
    const newTrack = async (kind) =>
      (
        await data(
          `mutation { song_create_${kind}_track(id: ${original.id}) { tracks { id } } }`,
        )
      )[`song_create_${kind}_track`].tracks.at(-1).id;

    before(async () => {
      original = (await data(`{ live_set { ${LISTS} } }`)).live_set;
    });

    after(async () => {
      const now = (await data(`{ live_set { ${LISTS} } }`)).live_set;
      for (const [list, fn] of [
        ["tracks", "delete_track"],
        ["return_tracks", "delete_return_track"],
        ["scenes", "delete_scene"],
      ])
        for (let i = now[list].length - 1; i >= original[list].length; i--)
          await data(
            `mutation { song_${fn}(id: ${original.id}, index: ${i}) { id } }`,
          );
      assert.deepEqual(
        (await data(`{ live_set { ${LISTS} } }`)).live_set,
        original,
      );
    });

    it("creates and duplicates a track, and deletes a return track and a scene, by index", async () => {
      const song = original.id;
      const created = (
        await data(
          `mutation { song_create_audio_track(id: ${song}, index: -1) { tracks { id has_audio_input } } }`,
        )
      ).song_create_audio_track.tracks;
      assert.equal(created.length, original.tracks.length + 1);
      assert.equal(created.at(-1).has_audio_input, true);
      assert.equal(
        (
          await data(
            `mutation { song_duplicate_track(id: ${song}, index: ${created.length - 1}) { tracks { id } } }`,
          )
        ).song_duplicate_track.tracks.length,
        created.length + 1,
      );
      const returns = (
        await data(
          `mutation { song_create_return_track(id: ${song}) { return_tracks { id } } }`,
        )
      ).song_create_return_track.return_tracks;
      assert.equal(returns.length, original.return_tracks.length + 1);
      assert.deepEqual(
        ids(
          (
            await data(
              `mutation { song_delete_return_track(id: ${song}, index: ${returns.length - 1}) { return_tracks { id } } }`,
            )
          ).song_delete_return_track.return_tracks,
        ),
        ids(original.return_tracks),
      );
      const last = original.scenes.length - 1;
      assert.equal(
        (
          await data(
            `mutation { song_duplicate_scene(id: ${song}, index: ${last}) { scenes { id } } }`,
          )
        ).song_duplicate_scene.scenes.length,
        original.scenes.length + 1,
      );
      assert.deepEqual(
        ids(
          (
            await data(
              `mutation { song_delete_scene(id: ${song}, index: ${last + 1}) { scenes { id } } }`,
            )
          ).song_delete_scene.scenes,
        ),
        ids(original.scenes),
      );
    });

    it("creates an audio clip in a slot from a file, and selects an envelope parameter in its view", async () => {
      const track = await newTrack("audio");
      const { clip_slots, mixer_device } = (
        await data(
          `{ track(id: ${track}) { clip_slots { id } mixer_device { volume { id } } } }`,
        )
      ).track;
      const sample = path.join(
        path.dirname(openedSet()),
        "Samples/Imported/liveql-sine-a440.wav",
      );
      const { clip } = (
        await data(
          `mutation ($p: String!) { clip_slot_create_audio_clip(id: ${clip_slots[0].id}, path: $p) { clip { id is_audio_clip file_path view { id } } } }`,
          { p: sample },
        )
      ).clip_slot_create_audio_clip;
      assert.equal(clip.is_audio_clip, true);
      assert.equal(clip.file_path, sample);
      await data(
        `mutation { clip_view_select_envelope_parameter(id: ${clip.view.id}, parameter: ${mixer_device.volume.id}) { id } }`,
      );
    });

    it("selects a device by id, sets a Wavetable modulation amount, and deletes a device by index", async () => {
      const track = await newTrack("midi");
      const inserted = await data(
        `mutation { a: track_insert_device(id: ${track}, device_name: "Wavetable") { id } b: track_insert_device(id: ${track}, device_name: "Compressor") { devices { id } view { id } } }`,
      );
      const [wavetable, compressor] = ids(inserted.b.devices);
      const { song_view_select_device } = await data(
        `mutation { song_view_select_device(id: ${view}, device: ${compressor}) { id } }`,
      );
      assert.equal(song_view_select_device.id, view);
      assert.equal(
        (
          await data(
            `{ track(id: ${track}) { view { selected_device { id } } } }`,
          )
        ).track.view.selected_device.id,
        compressor,
      );
      const modulation = async (mutation) =>
        (
          await data(
            `${mutation} { wavetable: track(id: ${track}) { devices { ... on WavetableDevice { get_modulation_value(modulation_target_index: 0, modulation_source_index: 1) } } } }`,
          )
        ).wavetable.devices[0].get_modulation_value;
      assert.equal(await modulation(""), 0);
      await data(
        `mutation { wavetable_device_set_modulation_value(id: ${wavetable}, modulation_target_index: 0, modulation_source_index: 1, value: 0.25) { id } }`,
      );
      assert.equal(await modulation(""), 0.25);
      assert.deepEqual(
        ids(
          (
            await data(
              `mutation { track_delete_device(id: ${track}, index: 1) { devices { id } } }`,
            )
          ).track_delete_device.devices,
        ),
        [wavetable],
      );
    });

    it("returns Live's answer to move_device, select_instrument and create_scene beside the read-back object", async () => {
      const song = original.id;
      const track = await newTrack("midi");
      const empty = await newTrack("midi");
      const inserted = await data(
        `mutation { a: track_insert_device(id: ${track}, device_name: "Wavetable") { id } b: track_insert_device(id: ${track}, device_name: "Compressor") { id } c: track_insert_device(id: ${track}, device_name: "Reverb") { devices { id } } }`,
      );
      const [wavetable, compressor, reverb] = ids(inserted.c.devices);
      const { song_move_device } = await data(
        `mutation { song_move_device(id: ${song}, device: ${reverb}, target: ${track}, target_position: 1) { move_device song { id } } }`,
      );
      assert.deepEqual(song_move_device, {
        move_device: 1,
        song: { id: song },
      });
      assert.deepEqual(
        ids(
          (await data(`{ track(id: ${track}) { devices { id } } }`)).track
            .devices,
        ),
        [wavetable, reverb, compressor],
      );
      const views = await data(
        `{ a: track(id: ${track}) { view { id } } b: track(id: ${empty}) { view { id } } }`,
      );
      const select = async (id) =>
        (
          await data(
            `mutation { track_view_select_instrument(id: ${id}) { select_instrument track_view { selected_device { id } } } }`,
          )
        ).track_view_select_instrument;
      assert.deepEqual(await select(views.a.view.id), {
        select_instrument: true,
        track_view: { selected_device: { id: wavetable } },
      });
      assert.deepEqual(await select(views.b.view.id), {
        select_instrument: false,
        track_view: { selected_device: null },
      });
      const { song_create_scene } = await data(
        `mutation { song_create_scene(id: ${song}) { create_scene { id } song { scenes { id } } } }`,
      );
      assert.equal(
        song_create_scene.create_scene.id,
        song_create_scene.song.scenes.at(-1).id,
      );
    });

    it("reads an audio clip's warp markers, and adds one from a typed dictionary", async () => {
      const track = await newTrack("audio");
      const sample = path.join(
        path.dirname(openedSet()),
        "Samples/Imported/liveql-sine-a440.wav",
      );
      const WARP =
        "id warping available_warp_modes warp_markers { beat_time sample_time }";
      const [clip] = (
        await data(
          `mutation ($f: String!) { track_create_audio_clip(id: ${track}, file_path: $f, position: 0) { arrangement_clips { ${WARP} } } }`,
          { f: sample },
        )
      ).track_create_audio_clip.arrangement_clips;
      record("new audio clip warp state", JSON.stringify(clip));
      assert.ok(clip.available_warp_modes.every(Number.isInteger));
      if (!clip.warping)
        await data(
          `mutation { clip_set(id: ${clip.id}, properties: [{ warping: true }]) { id } }`,
        );
      const add = async (marker) =>
        gql(
          `mutation ($m: WarpMarkerInput!) { clip_add_warp_marker(id: ${clip.id}, warp_marker: $m) { warp_markers { beat_time sample_time } } }`,
          { m: marker },
        );
      const added = await add({ beat_time: 1 });
      assert.equal(added.errors, undefined, JSON.stringify(added.errors));
      const markers = added.data.clip_add_warp_marker.warp_markers;
      assert.equal(markers.length, clip.warp_markers.length + 1);
      assert.ok(markers.some((m) => m.beat_time === 1));
      /**
       * 0.5 beats over 0.01 s is far past 999 BPM, and 1000 s is past the
       * sample's end: Live drops both without an error.
       */
      for (const marker of [
        { beat_time: 0.5, sample_time: 0.01 },
        { beat_time: 0.75, sample_time: 1000 },
      ]) {
        const dropped = await add(marker);
        assert.equal(dropped.errors, undefined, JSON.stringify(dropped.errors));
        assert.deepEqual(
          dropped.data.clip_add_warp_marker.warp_markers,
          markers,
          `Live no longer drops ${JSON.stringify(marker)} silently`,
        );
      }
    });

    it("reads the functions that only read as fields", async () => {
      const { live_app, live_set } = await data(`{
        live_app { get_document { id } view { available_main_views is_view_visible(view_name: "Browser") } }
        live_set {
          id get_beats_loop_length get_beats_loop_start get_current_beats_song_time
          get_current_smpte_song_time(format: 0) is_cue_point_selected
          tracks { id devices {
            cls: __typename id
            parameters { id value }
            ... on SimplerDevice { guess_playback_length sample { gain_display_string } }
            ... on MaxDevice { get_bank_count get_bank_name(bank_index: 0) get_bank_parameters(bank_index: 0) }
            ... on WavetableDevice { get_modulation_target_parameter_name(index: 0) get_modulation_value(modulation_target_index: 0, modulation_source_index: 0) }
          } }
        }
      }`);
      assert.equal(live_app.get_document.id, live_set.id);
      assert.deepEqual(live_app.view.available_main_views, [
        "Browser",
        "Arranger",
        "Session",
        "Detail",
        "Detail/Clip",
        "Detail/DeviceChain",
      ]);
      assert.equal(typeof live_app.view.is_view_visible, "boolean");
      for (const f of [
        "get_beats_loop_length",
        "get_beats_loop_start",
        "get_current_beats_song_time",
      ])
        assert.match(live_set[f], /^\d+\.\d+\.\d+\.\d+$/u, f);
      assert.match(live_set.get_current_smpte_song_time, /^\d+:\d+:\d+:\d+$/u);
      assert.equal(typeof live_set.is_cue_point_selected, "boolean");
      const devices = live_set.tracks.flatMap((t) =>
        t.devices.map((d) => ({ ...d, track: t.id })),
      );
      const of = (typename) => devices.find((d) => d.cls === typename);
      const simpler = of("SimplerDevice");
      assert.equal(typeof simpler.guess_playback_length, "number");
      assert.match(simpler.sample.gain_display_string, / dB$/u);
      const max = of("MaxDevice");
      assert.ok(Number.isInteger(max.get_bank_count));
      assert.equal(typeof max.get_bank_name, "string");
      assert.ok(max.get_bank_parameters.every(Number.isInteger));
      record(
        "MaxDevice banks",
        JSON.stringify({ ...max, parameters: undefined }),
      );
      const wavetable = of("WavetableDevice");
      assert.equal(
        typeof wavetable.get_modulation_target_parameter_name,
        "string",
      );
      assert.equal(typeof wavetable.get_modulation_value, "number");
      const [parameter] = wavetable.parameters.slice(-1);
      const { track: read } = await data(
        `{ track(id: ${wavetable.track}) { devices { ... on WavetableDevice { is_parameter_modulatable(parameter: ${parameter.id}) parameters { id str_for_value(value: ${parameter.value}) } } } } }`,
      );
      const own = read.devices.find((d) => "is_parameter_modulatable" in d);
      assert.equal(typeof own.is_parameter_modulatable, "boolean");
      const str = own.parameters.find(
        (p) => p.id === parameter.id,
      ).str_for_value;
      assert.equal(typeof str, "string");
      record(
        "Wavetable last parameter",
        `${parameter.value} is ${JSON.stringify(str)}, modulatable ${own.is_parameter_modulatable}`,
      );
      const eq8 = of("Eq8Device");
      const before = live_set.tracks.find((t) => t.id === eq8.track).devices;
      assert.ok(
        Number.isInteger(
          (
            await data(
              `{ live_set { find_device_position(device: ${eq8.id}, target: ${wavetable.track}, target_position: 0) } }`,
            )
          ).live_set.find_device_position,
        ),
      );
      assert.deepEqual(
        ids(
          (await data(`{ track(id: ${eq8.track}) { devices { id } } }`)).track
            .devices,
        ),
        ids(before),
      );
    });
  });

  /**
   * Compares what Live reports for each object of the fixture Set with what the
   * LOM docs say about its class. Every object's `info` is read and grouped by
   * `__typename`, and a member counts as present when any object of the class
   * lists it, since one object lacking a member (the master track's `arm`) is
   * Live's normal absence and not drift. Only readable members are compared:
   * `info` never lists an observe-only one. Types are compared after mapping
   * the docs' vocabulary onto the Python names `info` prints, and `NoneType`
   * says only that the value is None right now (`info` then lists even a
   * child as a property), so neither its kind nor its type is compared, and a
   * real type from another object of the class wins over it. The
   * fixture holds no audio clip, so one is made in the arrangement from the
   * fixture's sample and deleted afterwards. A mismatch prints as a `RECORD:`
   * line holding the `drift` row that records it in `lom-overrides.js`, rather
   * than failing, because the docs are in flux; a `drift` row Live no longer
   * bears out prints too.
   */
  describe("drift between info and lom.json", () => {
    const LIVE_TYPES = {
      symbol: "str",
      unicode: "str",
      dictionary: "dict",
      long: "int",
      list: "Vector",
    };
    const INFO = "cls: __typename info";
    /**
     * The device classes the fixture lacks, inserted by browser name on
     * throwaway MIDI tracks: one instrument per track, because Live drops an
     * instrument inserted on a track that holds one, with audio effects after
     * it. The first track also gets a take lane holding a MIDI clip, which only
     * deleting its track removes: `Track.delete_clip` leaves a take lane's clip
     * in place, and a TakeLane has no delete. The empty Max Audio Effect is
     * the one device with DeviceIO buses: the fixture's MIDI-effect LiveQL
     * device lists all four bus children empty.
     */
    const INSERTED = [
      ["Drift", "Compressor", "Hybrid Reverb", "Looper"],
      ["Meld", "Roar", "Shifter", "Max Audio Effect"],
      ["DrumSampler", "Spectral Resonator"],
    ];
    let audioClip, audioTrack, song, tracks;

    before(async () => {
      const { live_set } = await data(
        "{ live_set { id tracks { id has_audio_input is_foldable arrangement_clips { id } } } }",
      );
      song = live_set.id;
      tracks = live_set.tracks.map((t) => t.id);
      audioTrack = live_set.tracks.find(
        (t) => t.has_audio_input && !t.is_foldable,
      ).id;
      const sample = path.join(
        path.dirname(openedSet()),
        "Samples/Imported/liveql-sine-a440.wav",
      );
      const before = new Set(
        live_set.tracks
          .find((t) => t.id === audioTrack)
          .arrangement_clips.map((c) => c.id),
      );
      audioClip = (
        await data(
          `mutation ($f: String!) { track_create_audio_clip(id: ${audioTrack}, file_path: $f, position: 0) { arrangement_clips { id is_audio_clip } } }`,
          { f: sample },
        )
      ).track_create_audio_clip.arrangement_clips.find(
        (c) => c.is_audio_clip && !before.has(c.id),
      )?.id;
      assert.ok(audioClip, "track_create_audio_clip made no audio clip");
      const created = [];
      for (const names of INSERTED) {
        const track = (
          await data(
            `mutation { song_create_midi_track(id: ${song}) { tracks { id } } }`,
          )
        ).song_create_midi_track.tracks.at(-1).id;
        const inserted = await data(
          `mutation { ${names.map((n, i) => `d${i}: track_insert_device(id: ${track}, device_name: "${n}") { devices { name } }`).join(" ")} }`,
        );
        assert.equal(
          inserted[`d${names.length - 1}`].devices.length,
          names.length,
          `inserted only some of ${names}`,
        );
        created.push(track);
      }
      const lane = (
        await data(
          `mutation { track_create_take_lane(id: ${created[0]}) { take_lanes { id } } }`,
        )
      ).track_create_take_lane.take_lanes.at(-1).id;
      assert.equal(
        (
          await data(
            `mutation { take_lane_create_midi_clip(id: ${lane}, start_time: 0, length: 4) { arrangement_clips { id } } }`,
          )
        ).take_lane_create_midi_clip.arrangement_clips.length,
        1,
      );
    });

    after(async () => {
      if (audioClip)
        await data(
          `mutation { track_delete_clip(id: ${audioTrack}, clip: ${audioClip}) { id } }`,
        );
      const { live_set } = await data("{ live_set { tracks { id } } }");
      for (let i = live_set.tracks.length - 1; i >= tracks.length; i--)
        await data(
          `mutation { song_delete_track(id: ${song}, index: ${i}) { id } }`,
        );
      assert.deepEqual(
        (await data("{ live_set { tracks { id } } }")).live_set.tracks.map(
          (t) => t.id,
        ),
        tracks,
      );
    });

    /**
     * Each LOM dictionary property's keys as Live returns them against its
     * GraphQL type's fields, as the server reports them in the
     * `dictionary_drift` extension: a key the type lacks, which the response
     * drops, or a field Live left out. Every dictionary row is selected on
     * every object of the fixture and the inserted devices, and each must read
     * non-null somewhere so the check is not vacuous.
     */
    it("records every dictionary key Live and its GraphQL type disagree on", async () => {
      const rows = Object.entries(OVERRIDES.classes).flatMap(
        ([name, { properties = {} }]) =>
          Object.entries(properties)
            .filter(([, row]) => row.dictionary)
            .map(([member, row]) => ({
              name,
              member,
              type: row.type.replaceAll(/[![\]]/gu, ""),
            })),
      );
      const types = [...new Set(rows.map((r) => r.type))];
      const introspected = await data(
        `{ ${types.map((t) => `${t}: __type(name: "${t}") { fields { name } }`).join(" ")} }`,
      );
      const selectionOf = (name) =>
        rows
          .filter((r) => r.name === name)
          .map(
            ({ member, type }) =>
              `${member}${introspected[type]?.fields ? ` { ${introspected[type].fields.map((f) => f.name).join(" ")} }` : ""}`,
          )
          .join(" ");
      const DEVICE_IO = `cls: __typename ${selectionOf("DeviceIO")}`;
      const TRACK = `cls: __typename ${selectionOf("Track")} arrangement_clips { cls: __typename ${selectionOf("Clip")} } devices { cls: __typename ... on CompressorDevice { ${selectionOf("CompressorDevice")} } ... on SimplerDevice { sample { cls: __typename ${selectionOf("Sample")} } } ... on MaxDevice { audio_inputs { ${DEVICE_IO} } audio_outputs { ${DEVICE_IO} } midi_inputs { ${DEVICE_IO} } midi_outputs { ${DEVICE_IO} } } }`;
      const response = await gql(`{ live_set {
        tuning_system { cls: __typename ${selectionOf("TuningSystem")} }
        tracks { ${TRACK} } return_tracks { ${TRACK} } master_track { ${TRACK} }
      } }`);
      const drift = response.extensions?.dictionary_drift ?? [];
      for (const { at, unknown, missing } of drift)
        record(
          `drift ${at}`,
          `keys the GraphQL type lacks [${unknown.join(", ")}], fields Live left out [${missing.join(", ")}]`,
        );
      if (drift.length > 0) return;
      assert.equal(response.errors, undefined, JSON.stringify(response.errors));
      const read = new Set();
      const walk = (o) => {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === "object") {
          for (const [k, v] of Object.entries(o)) {
            if (v !== null && o.cls) read.add(`${o.cls}.${k}`);
            walk(v);
          }
        }
      };
      walk(response.data);
      assert.deepEqual(
        rows.map((r) => `${r.name}.${r.member}`).filter((m) => !read.has(m)),
        [],
        "these dictionaries read null on every object",
      );
    });

    it("records every member Live and the docs disagree on", async () => {
      const CLIP = `${INFO} view { ${INFO} } groove { ${INFO} }`;
      const NESTED = `${INFO} parameters { ${INFO} } view { ${INFO} }`;
      const CHAIN = `${INFO} mixer_device { ${INFO} } devices { ${NESTED} }`;
      const DEVICE = `${NESTED} ... on SimplerDevice { sample { ${INFO} } } ... on MaxDevice { audio_inputs { ${INFO} } audio_outputs { ${INFO} } midi_inputs { ${INFO} } midi_outputs { ${INFO} } } ... on RackDevice { chain_selector { ${INFO} } chains { ${CHAIN} } return_chains { ${CHAIN} } drum_pads { ${INFO} chains { ${CHAIN} } } }`;
      const TRACK = `${INFO} view { ${INFO} } mixer_device { ${INFO} } take_lanes { ${INFO} arrangement_clips { ${CLIP} } } arrangement_clips { ${CLIP} } clip_slots { ${INFO} clip { ${CLIP} } } devices { ${DEVICE} }`;
      const { live_app, live_set } = await data(`{
        live_app { ${INFO} get_version_string view { ${INFO} } }
        live_set {
          ${INFO} view { ${INFO} } scenes { ${INFO} }
          tuning_system { ${INFO} } cue_points { ${INFO} } groove_pool { ${INFO} grooves { ${INFO} } }
          tracks { ${TRACK} } return_tracks { ${TRACK} } master_track { ${TRACK} }
        }
      }`);
      const seen = new Map();
      const walk = (o) => {
        if (Array.isArray(o)) {
          o.forEach(walk);
          return;
        }
        if (!o || typeof o !== "object") return;
        if (o.info) {
          const members = seen.get(o.cls) ?? new Map();
          for (const [kind, name, type] of o.info
            .split("\n")
            .map((line) => line.trim().split(" ")))
            if (
              ["property", "child", "children", "function"].includes(kind) &&
              (type !== "NoneType" || !members.has(name))
            )
              members.set(name, { kind, type });
          seen.set(o.cls, members);
        }
        Object.values(o).forEach(walk);
      };
      walk(live_set);
      walk(live_app);

      const scope = new Set(OVERRIDES.scope);
      const parentOf = (name) =>
        scope.has(LOM[name].parent) ? LOM[name].parent : null;
      const docsOf = (name) => {
        const { children, properties, functions } = LOM[name];
        return new Map([
          ...Object.entries(children)
            .filter(([, m]) => m.access.includes("get"))
            .map(([n, m]) => [
              n,
              { kind: m.list ? "children" : "child", type: m.type },
            ]),
          ...Object.entries(properties)
            .filter(([, m]) => m.access.includes("get"))
            .map(([n, m]) => [n, { kind: "property", type: m.type }]),
          ...Object.keys(functions).map((n) => [n, { kind: "function" }]),
        ]);
      };
      /**
       * A class with subclasses in scope is seen through `Generic<Class>`, its
       * plain objects, and a subclass is compared with its own members and its
       * parent's. A mismatch a subclass shares with its parent's plain objects
       * is the parent's, so it is recorded once, under the parent. An
       * undocumented member counts as shared whatever type it lists, because a
       * child like `canonical_parent` is typed by where the object sits: a
       * Track for a device on a track, a Chain for one inside a Rack.
       */
      const typenameOf = (name) =>
        OVERRIDES.scope.some((n) => parentOf(n) === name)
          ? `Generic${name}`
          : name;
      const compare = (name) => {
        const live = seen.get(typenameOf(name));
        assert.ok(live, `the fixture Set has no ${typenameOf(name)}`);
        const parent = parentOf(name);
        const docs = new Map([
          ...(parent ? docsOf(parent) : []),
          ...docsOf(name),
        ]);
        const found = [];
        const mismatch = (member, text) => found.push({ member, text });
        for (const [member, doc] of docs) {
          const got = live.get(member);
          if (!got)
            mismatch(
              member,
              `documented as a ${doc.kind}, in no {class}'s info`,
            );
          else if (got.type === "NoneType" || doc.kind === "function") continue;
          else if (doc.kind !== got.kind)
            mismatch(
              member,
              `documented as a ${doc.kind}, info lists a ${got.kind} ${got.type}`,
            );
          else if (!doc.type) continue;
          else if (
            doc.kind === "property"
              ? !got.type.endsWith(
                  LIVE_TYPES[doc.type] ?? doc.type.split("/")[0],
                )
              : !doc.type.endsWith(got.type)
          )
            mismatch(
              member,
              `documented as ${doc.type}, info says ${got.type}`,
            );
        }
        for (const [member, got] of live)
          if (!docs.has(member))
            mismatch(
              member,
              `undocumented, info lists a ${got.kind} ${got.type ?? ""}`.trim(),
            );
        if (!parent) return found;
        const key = ({ member, text }) =>
          `${member} ${text.startsWith("undocumented") ? "undocumented" : text}`;
        const inherited = new Set(compare(parent).map(key));
        return found.filter((m) => !inherited.has(key(m)));
      };
      const mismatches = OVERRIDES.scope.flatMap((name) =>
        compare(name).map(({ member, text }) => ({
          name,
          member,
          text: text.replace("{class}", typenameOf(name)),
        })),
      );

      const version = live_app.get_version_string;
      const rows = new Set();
      for (const { name, member, text } of mismatches) {
        rows.add(`${name}.${member}`);
        if (!OVERRIDES.classes[name]?.drift?.[member])
          record(
            `drift ${name}.${member}`,
            `add to classes.${name}.drift in lom-overrides.js: ${member}: ${JSON.stringify(`${text} (Live ${version})`)},`,
          );
      }
      for (const [name, { drift = {} } = {}] of Object.entries(
        OVERRIDES.classes,
      ))
        for (const member of Object.keys(drift))
          if (!rows.has(`${name}.${member}`))
            record(
              `drift ${name}.${member}`,
              "this Set no longer shows it; delete the row unless the fixture lacks the object that did",
            );
    });
  });
});
