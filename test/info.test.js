const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { createServer } = require("./helpers/server");

describe("info", () => {
  let gql, lom;
  beforeEach(() => {
    ({ gql, lom } = createServer());
  });

  it("is not read unless a query selects it", async () => {
    await gql("{ live_set { id tracks { id } } }");
    assert.deepEqual(
      lom.log.filter(([action]) => action === "info"),
      [],
    );
  });

  it("returns the bridge's text unchanged on every object type", async () => {
    const { data } = await gql(`{
      live_app { info }
      live_set {
        info
        view { info }
        tracks { info clip_slots { info clip { info view { info } } } }
        scenes { info }
      }
    }`);
    const track = data.live_set.tracks[0];
    const clip = track.clip_slots[0].clip;
    assert.match(data.live_app.info, /^id 3\ntype Application\n/u);
    assert.match(data.live_set.info, /^id 1\ntype Song\n[\s\S]*\ndone$/u);
    for (const { info } of [
      data.live_set.view,
      track,
      track.clip_slots[0],
      clip,
      clip.view,
      data.live_set.scenes[0],
    ])
      assert.match(info, /^id \d+\ntype \S+\n/u);
  });
});
