const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer } = require("./helpers/server");

const keysOf = (g) =>
  [
    g.propertyKeysSingle,
    g.propertyKeysMultiple,
    g.childKeysSingle,
    g.childKeysMultiple,
  ].flatMap((k) => k ?? []);

describe("selection-driven reads", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });
  const readsOf = (id) => lom.gets.filter((g) => g.idOrPath === id).map(keysOf);

  it("asks the bridge only for the selected members, by field name not alias", async () => {
    const { data } = await gql(
      "{ live_set { bpm: tempo id tracks { label: name type } } }",
    );
    assert.equal(data.live_set.bpm, 120);
    assert.deepEqual(readsOf("live_set"), [["tempo", "tracks"]]);
    assert.deepEqual(readsOf(10), [["name"]]);
  });

  it("asks for nothing beyond id, path and type when no member is selected", async () => {
    await gql("{ live_set { id path type info } }");
    assert.deepEqual(readsOf("live_set"), [[]]);
  });

  it("reads an indexed accessor's child list", async () => {
    const { data } = await gql("{ live_set { track(index: 0) { name } } }");
    assert.deepEqual(data.live_set.track, { name: "MIDI" });
    assert.deepEqual(readsOf("live_set"), [["tracks"]]);
  });

  it("reads the members selected in interface fragments, inline and named", async () => {
    const { data } = await gql(
      "{ track(id: 10) { devices { name ... on SimplerDevice { playback_mode } ...Voices } } } fragment Voices on SimplerDevice { voices }",
    );
    assert.deepEqual(data.track.devices, [
      { name: "Simpler", playback_mode: 0, voices: 1 },
      { name: "Operator" },
    ]);
    const [keys] = readsOf(60);
    for (const k of ["name", "playback_mode", "voices"])
      assert.ok(keys.includes(k), `reads ${k}`);
    assert.ok(!keys.includes("class_name"));
  });

  it("reads only the interface's selected members when nothing needs the concrete type", async () => {
    await gql("{ track(id: 10) { devices { name } } }");
    assert.deepEqual(readsOf(60), [["name"]]);
  });

  it("reads the member a hand-written resolver depends on", async () => {
    const { data } = await gql(
      "{ clip(id: 40) { get_all_notes_extended { notes { pitch } } } }",
    );
    assert.deepEqual(data.clip.get_all_notes_extended, {
      notes: [{ pitch: 60 }],
    });
    assert.deepEqual(readsOf(40).at(-1), ["is_midi_clip"]);
  });

  /**
   * A device view's `LiveAPI.type` is a bare `View`, so its subclass comes
   * from which subclass's own members the read holds; leaving them out would
   * resolve every view to GenericDeviceView.
   */
  const TYPENAMES = [
    { __typename: "SimplerDeviceView" },
    { __typename: "GenericDeviceView" },
  ];
  for (const { what, query, expected } of [
    {
      what: "__typename",
      query: "{ track(id: 10) { devices { view { __typename } } } }",
      expected: TYPENAMES,
    },
    {
      what: "a fragment on a subclass",
      query:
        "{ track(id: 10) { devices { view { is_collapsed ... on SimplerDeviceView { s: is_collapsed } } } } }",
      expected: [{ is_collapsed: false, s: false }, { is_collapsed: false }],
    },
    {
      what: "__typename in a named fragment on the interface",
      query:
        "{ track(id: 10) { devices { view { ...V } } } } fragment V on DeviceView { __typename }",
      expected: TYPENAMES,
    },
  ])
    it(`resolves a device view's subclass for ${what}`, async () => {
      const { data } = await gql(query);
      assert.deepEqual(
        data.track.devices.map((d) => d.view),
        expected,
      );
      assert.ok(readsOf(64)[0].includes("selected_slice"));
    });

  it("reads back after a set only what the mutation selects", async () => {
    const { data } = await gql(
      'mutation { track_set(id: 10, properties: [{ name: "Bass" }]) { renamed: name } }',
    );
    assert.deepEqual(data.track_set, { renamed: "Bass" });
    assert.deepEqual(readsOf(10), [["name"]]);
  });

  it("reads back a function mutation's selection", async () => {
    const { data } = await gql(
      "mutation { clip_slot_fire(id: 20) { has_clip } }",
    );
    assert.deepEqual(data.clip_slot_fire, { has_clip: true });
    assert.deepEqual(readsOf(20), [["has_clip"]]);
  });

  it("reads back a notes mutation's clip only when it is selected", async () => {
    const added = await gql(
      "mutation { clip_add_new_notes(id: 40, notes: [{ pitch: 64, start_time: 1, duration: 1 }]) { note_ids } }",
    );
    assert.deepEqual(added.data.clip_add_new_notes, { note_ids: [100] });
    assert.deepEqual(readsOf(40), []);
    const { data } = await gql(
      "mutation { clip_add_new_notes(id: 40, notes: [{ pitch: 65, start_time: 2, duration: 1 }]) { clip { looping } } }",
    );
    assert.deepEqual(data.clip_add_new_notes, { clip: { looping: true } });
    assert.deepEqual(readsOf(40), [["looping"]]);
  });
});
