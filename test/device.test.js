const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer } = require("./helpers/server");

const DEVICES = "{ track(id: 10) { devices { __typename id type name } } }";

describe("device", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("resolves a device to its LOM subclass, and a plain one to GenericDevice", async () => {
    const { data } = await gql(DEVICES);
    assert.deepEqual(data.track.devices, [
      {
        __typename: "SimplerDevice",
        id: 60,
        type: "SimplerDevice",
        name: "Simpler",
      },
      { __typename: "GenericDevice", id: 61, type: "Device", name: "Operator" },
    ]);
  });

  /**
   * The LOM's DeviceType int is also named `type`; reading it would overwrite
   * the bridge's `type`, which is what picks the concrete GraphQL type.
   */
  it("reads every device with one get that, for __typename, names each subclass's own members but not type", async () => {
    await gql(DEVICES);
    const reads = lom.gets.filter((g) => g.idOrPath === 60);
    assert.equal(reads.length, 1);
    const keys = reads[0].propertyKeysSingle;
    for (const k of ["name", "voices", "variation_count", "edit_mode"])
      assert.ok(keys.includes(k), `reads ${k}`);
    assert.ok(!keys.includes("type"));
  });

  it("gives a subclass the Device members it inherits", async () => {
    const { data } = await gql(
      "{ track(id: 10) { devices { class_name ... on SimplerDevice { voices is_active latency_in_ms } } } }",
    );
    assert.deepEqual(data.track.devices, [
      {
        class_name: "OriginalSimpler",
        voices: 1,
        is_active: true,
        latency_in_ms: 0,
      },
      { class_name: "Operator" },
    ]);
  });

  it("sets an inherited member through device_set and reads back the concrete type", async () => {
    const { data } = await gql(
      'mutation { device_set(id: 60, properties: [{ name: "Kick" }, { is_using_compare_preset_b: true }]) { __typename name is_using_compare_preset_b } }',
    );
    assert.deepEqual(data.device_set, {
      __typename: "SimplerDevice",
      name: "Kick",
      is_using_compare_preset_b: true,
    });
    assert.deepEqual(
      lom.log.filter(([action]) => action === "set"),
      [
        ["set", 60, "name", "Kick"],
        ["set", 60, "is_using_compare_preset_b", 1],
      ],
    );
  });

  it("sets and calls a subclass's own members through its prefix", async () => {
    const { data } = await gql(
      "mutation { simpler_device_set(id: 60, properties: [{ voices: 4 }]) { voices } simpler_device_warp_as(id: 60, beats: 8) { id } }",
    );
    assert.deepEqual(data, {
      simpler_device_set: { voices: 4 },
      simpler_device_warp_as: { id: 60 },
    });
    assert.deepEqual(
      lom.log.filter(([action]) => action !== "info"),
      [
        ["set", 60, "voices", 4],
        ["call", 60, "warp_as", 8],
      ],
    );
  });

  it("leaves inherited members out of a subclass's setter", async () => {
    const response = await gql(
      'mutation { simpler_device_set(id: 60, properties: [{ name: "Kick" }]) { id } }',
    );
    assert.ok(response.errors?.length);
    assert.deepEqual(lom.log, []);
  });

  it("reads a device's parameters, value_items only where info lists it", async () => {
    const { data } = await gql(
      "{ track(id: 10) { devices { parameters { id name value is_quantized value_items } } } }",
    );
    assert.deepEqual(data.track.devices[0].parameters, [
      {
        id: 70,
        name: "Volume",
        value: 0.5,
        is_quantized: false,
        value_items: null,
      },
      {
        id: 71,
        name: "Snap",
        value: 1,
        is_quantized: true,
        value_items: ["Off", "On"],
      },
    ]);
  });

  it("sets a parameter's value through device_parameter_set", async () => {
    const { data } = await gql(
      "mutation { device_parameter_set(id: 70, properties: [{ value: 0.25 }]) { id value } }",
    );
    assert.deepEqual(data.device_parameter_set, { id: 70, value: 0.25 });
    assert.deepEqual(
      lom.log.filter(([action]) => action === "set"),
      [["set", 70, "value", 0.25]],
    );
  });

  it("resolves a subclass the fixture Set lacks, such as a return track's Shifter", async () => {
    const { data } = await gql(
      "{ track(id: 13) { devices { __typename type class_name ... on ShifterDevice { pitch_bend_range pitch_mode_index } } } }",
    );
    assert.deepEqual(data.track.devices, [
      {
        __typename: "ShifterDevice",
        type: "ShifterDevice",
        class_name: "Shifter",
        pitch_bend_range: 2,
        pitch_mode_index: 0,
      },
    ]);
  });

  it("resolves a device nested in a rack's chain", async () => {
    const { data } = await gql(
      "{ track(id: 11) { devices { __typename ... on RackDevice { chains { __typename id name devices { __typename id name } } return_chains { id } } } } }",
    );
    assert.deepEqual(data.track.devices, [
      {
        __typename: "RackDevice",
        chains: [
          {
            __typename: "GenericChain",
            id: 80,
            name: "Chain",
            devices: [
              { __typename: "GenericDevice", id: 63, name: "Saturator" },
            ],
          },
        ],
        return_chains: [],
      },
    ]);
  });

  /**
   * Every device view's `LiveAPI.type` is a bare `View`, so the read's members
   * pick the subclass: only a Simpler's view lists selected_slice.
   */
  it("resolves a device's view to its subclass by the members its info lists", async () => {
    const { data } = await gql(
      "{ track(id: 10) { devices { view { __typename type is_collapsed ... on SimplerDeviceView { selected_slice } } } } }",
    );
    assert.deepEqual(
      data.track.devices.map((d) => d.view),
      [
        {
          __typename: "SimplerDeviceView",
          type: "View",
          is_collapsed: false,
          selected_slice: -1,
        },
        { __typename: "GenericDeviceView", type: "View", is_collapsed: false },
      ],
    );
  });
});
