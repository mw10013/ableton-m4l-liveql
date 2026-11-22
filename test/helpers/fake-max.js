/**
 * Stub of `max-api`. Routes the JSON `liveql-n4m.js` sends out its outlet into
 * the fake LOM and answers on the `result` handler with the same
 * `{ status, actionId, data | message }` envelope `liveql-m4l.js` outlets,
 * JSON-encoded so an `undefined` member is dropped there too, and split into
 * symbols the way both sides split it. The reply is
 * deferred with `setImmediate` because the real round trip is never synchronous.
 */
const atoms = (json) => json.match(/.{1,8000}/gsu);

/**
 * The atoms as Max carries them, as UTF-8 symbols: a lone surrogate comes out
 * as U+FFFD, and a symbol past 32767 bytes, which Max truncates, throws.
 */
const symbols = (parts) =>
  parts.map((part) => {
    const bytes = Buffer.from(part);
    if (bytes.length > 32_767)
      throw new Error(`fake-max: a ${bytes.length}-byte symbol`);
    return bytes.toString();
  });

function createMax(lom) {
  const handlers = new Map();
  const posts = [];
  return {
    posts,
    handlers,
    post: (message) => Promise.resolve(void posts.push(String(message))),
    addHandler: (name, fn) => handlers.set(name, fn),
    outlet: (action, ...parts) =>
      new Promise((resolve) => {
        const params = JSON.parse(symbols(parts).join(""));
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
        const reply = symbols(atoms(JSON.stringify(result)));
        setImmediate(() => handlers.get("result")?.(...reply));
        resolve();
      }),
  };
}

module.exports = { createMax };
