/**
 * Stub of `max-api`. Routes the JSON `liveql-n4m.js` sends out its outlet into
 * the fake LOM and answers on the `result` handler with the same
 * `{ status, actionId, data | message }` envelope `liveql-m4l.js` outlets,
 * JSON-encoded so an `undefined` member is dropped there too. The reply is
 * deferred with `setImmediate` because the real round trip is never synchronous.
 */
function createMax(lom) {
  const handlers = new Map();
  const posts = [];
  return {
    posts,
    post: (message) => Promise.resolve(void posts.push(String(message))),
    addHandler: (name, fn) => handlers.set(name, fn),
    outlet: (action, json) =>
      new Promise((resolve) => {
        const params = JSON.parse(json);
        if (action !== params.action)
          throw new Error(
            `fake-max: outlet selector ${action} does not match action ${params.action}`,
          );
        const { actionId } = params;
        let result;
        try {
          result = { status: "succeeded", actionId, data: lom.exec(params) };
        } catch (err) {
          result = { status: "failed", actionId, message: String(err) };
        }
        const reply = JSON.stringify(result);
        setImmediate(() => handlers.get("result")?.(reply));
        resolve();
      }),
  };
}

module.exports = { createMax };
