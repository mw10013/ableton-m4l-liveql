const assert = require("node:assert/strict");
const { describe, it, beforeEach, mock } = require("node:test");
const { createServer, errorMessage } = require("./helpers/server");

const DEVICES = "{ live_set { tracks { devices { name } } } }";

describe("bridge get batching", () => {
  let gql, lom, max, messages;
  beforeEach(() => {
    ({ gql, lom, max } = createServer());
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

  it("sends at most 32 reads a message, the next only after the last answers", async () => {
    lom.objects.live_set.props.tracks = Array.from({ length: 40 }, () => [
      "id",
      10,
    ]).flat();
    const outlet = max.outlet;
    let inFlight = 0;
    let overlapped = false;
    max.outlet = async (...args) => {
      overlapped ||= inFlight > 0;
      inFlight += 1;
      await outlet(...args);
      setImmediate(() => {
        inFlight -= 1;
      });
    };
    const { data } = await gql("{ live_set { tracks { name } } }");
    assert.equal(data.live_set.tracks.length, 40);
    assert.deepEqual(
      messages.map((m) => m.reads.length),
      [1, 32, 8],
    );
    assert.equal(overlapped, false);
  });

  it("fails a request Live never answers after 10 s instead of hanging", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      max.outlet = () => Promise.resolve();
      const response = gql("{ live_set { tempo } }");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      mock.timers.tick(10_000);
      assert.equal(
        errorMessage(await response),
        "liveql: get on live_set: no result from Live in 10000 ms",
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("logs and drops a result that is not JSON, and keeps serving", async () => {
    await max.handlers.get("result")('{"status":"succ');
    assert.match(max.posts.at(-1), /^liveql: unreadable result: \{"status"/u);
    const { data } = await gql("{ live_set { tempo } }");
    assert.equal(data.live_set.tempo, 120);
  });
});
