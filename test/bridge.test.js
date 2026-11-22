const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer } = require("./helpers/server");

const DEVICES = "{ live_set { tracks { devices { name } } } }";

describe("bridge get batching", () => {
  let gql, lom, messages;
  beforeEach(() => {
    ({ gql, lom } = createServer());
    messages = [];
    const { exec } = lom;
    lom.exec = (params) => {
      messages.push(params);
      return exec(params);
    };
  });

  it("sends one get per level of the tree, not one per object", async () => {
    const { data, errors } = await gql(DEVICES);
    assert.equal(errors, undefined);
    assert.deepEqual(data.live_set.tracks, [
      { devices: [{ name: "Simpler" }, { name: "Operator" }] },
      { devices: [{ name: "Audio Effect Rack" }] },
    ]);
    assert.deepEqual(
      messages.map((m) => [m.action, m.reads.map((r) => r.idOrPath)]),
      [
        ["get", ["live_set"]],
        ["get", [10, 11]],
        ["get", [60, 61, 62]],
      ],
    );
  });

  it("fails only the field of a bad id inside a batch", async () => {
    lom.objects[11].props.devices = ["id", 62, "id", 999];
    const { data, errors } = await gql(DEVICES);
    assert.deepEqual(data.live_set.tracks, [
      { devices: [{ name: "Simpler" }, { name: "Operator" }] },
      { devices: null },
    ]);
    assert.deepEqual(
      errors.map((e) => [e.message, e.path]),
      [
        [
          "liveql: get on 999: Invalid live id or path: 999",
          ["live_set", "tracks", 1, "devices", 1],
        ],
      ],
    );
    assert.deepEqual(
      messages.at(-1).reads.map((r) => r.idOrPath),
      [60, 61, 62, 999],
    );
  });

  it("carries a message longer than one Max symbol", async () => {
    const name = `é${"🎹".repeat(20_000)}`;
    lom.objects[40].props.name = [name];
    const { data, errors } = await gql(
      `mutation { clip_set(id: 40, properties: [{ name: "${name}" }]) { name } }`,
    );
    assert.equal(errors, undefined);
    assert.equal(data.clip_set.name, name);
  });
});
