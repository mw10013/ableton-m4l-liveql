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
  it("reads every device with one get that names the whole family's members but not type", async () => {
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
});
