const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer } = require("./helpers/server");

describe("functions that answer a value", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  const calls = () => lom.log.filter(([action]) => action === "call");

  it("reads a function as a field, with its arguments in LOM order and an object by id", async () => {
    Object.assign(lom.calls, {
      get_beats_loop_length: () => "004.00.00.000",
      get_current_smpte_song_time: () => ["000:00:01:000"],
      is_cue_point_selected: () => 0,
      find_device_position: () => [1],
      str_for_value: () => "1 st",
      guess_playback_length: () => 4.5,
    });
    const { data, errors } = await gql(`{
      live_set {
        get_beats_loop_length
        get_current_smpte_song_time(format: 1)
        is_cue_point_selected
        find_device_position(device: 60, target: 11, target_position: 0)
      }
      track(id: 10) { devices { ... on SimplerDevice { guess_playback_length parameters { str_for_value(value: 0.5) } } } }
    }`);
    assert.equal(errors, undefined);
    assert.deepEqual(data.live_set, {
      get_beats_loop_length: "004.00.00.000",
      get_current_smpte_song_time: "000:00:01:000",
      is_cue_point_selected: false,
      find_device_position: 1,
    });
    assert.deepEqual(data.track.devices[0], {
      guess_playback_length: 4.5,
      parameters: [{ str_for_value: "1 st" }, { str_for_value: "1 st" }],
    });
    assert.deepEqual(calls(), [
      ["call", 1, "get_beats_loop_length"],
      ["call", 1, "get_current_smpte_song_time", 1],
      ["call", 1, "is_cue_point_selected"],
      ["call", 1, "find_device_position", "id 60", "id 11", 0],
      ["call", 60, "guess_playback_length"],
      ["call", 70, "str_for_value", 0.5],
      ["call", 71, "str_for_value", 0.5],
    ]);
  });

  it("reads a list and a bool a function answers", async () => {
    Object.assign(lom.calls, {
      available_main_views: () => ["Browser", "Arranger"],
      is_view_visible: () => [1],
      get_bank_parameters: () => 1,
    });
    lom.objects[4] = {
      id: 4,
      path: "live_app view",
      type: "Application.View",
      props: {},
    };
    lom.objects.live_app.props.view = ["id", 4];
    const { data, errors } = await gql(`{
      live_app { view { available_main_views is_view_visible(view_name: "Browser") } }
      live_set { master_track { devices { ... on MaxDevice { get_bank_parameters(bank_index: -1) } } } }
    }`);
    assert.equal(errors, undefined);
    assert.deepEqual(data.live_app.view, {
      available_main_views: ["Browser", "Arranger"],
      is_view_visible: true,
    });
    assert.deepEqual(data.live_set.master_track.devices[1], {
      get_bank_parameters: [1],
    });
  });

  it("reads an object a function answers through the field's selection", async () => {
    lom.calls.get_document = () => ["id", 1];
    const { data, errors } = await gql(
      "{ live_app { get_document { id tempo } } }",
    );
    assert.equal(errors, undefined);
    assert.deepEqual(data.live_app.get_document, { id: 1, tempo: 120 });
    assert.deepEqual(
      lom.gets.find((g) => g.idOrPath === 1).propertyKeysSingle,
      ["tempo"],
    );
  });

  it("returns a mutation's answer beside the object it reads back", async () => {
    lom.calls.move_device = () => [2];
    lom.calls.create_scene = () => ["id", 30];
    const { data, errors } = await gql(`mutation {
      song_move_device(id: 1, device: 61, target: 11, target_position: 3) { move_device song { id tempo } }
      song_create_scene(id: 1) { create_scene { id is_empty } }
    }`);
    assert.equal(errors, undefined);
    assert.deepEqual(data, {
      song_move_device: { move_device: 2, song: { id: 1, tempo: 120 } },
      song_create_scene: { create_scene: { id: 30, is_empty: false } },
    });
    assert.deepEqual(calls(), [
      ["call", 1, "move_device", "id 61", "id 11", 3],
      ["call", 1, "create_scene", -1],
    ]);
  });

  it("reads back nothing for a mutation's answer when its object is not selected", async () => {
    lom.calls.select_instrument = () => [0];
    lom.gets.length = 0;
    const { data, errors } = await gql(
      "mutation { track_view_select_instrument(id: 11) { select_instrument } }",
    );
    assert.equal(errors, undefined);
    assert.deepEqual(data, {
      track_view_select_instrument: { select_instrument: false },
    });
    assert.deepEqual(lom.gets, []);
  });
});
