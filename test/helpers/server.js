const Module = require("module");
const http = require("http");
const { createLom } = require("./fake-lom");
const { createMax } = require("./fake-max");

const N4M = require.resolve("../../liveql-n4m.js");

/**
 * Loads `liveql-n4m.js` the way Node for Max does — as a script with side
 * effects, not a module that exports anything — with `max-api` swapped for the
 * fake and `http.createServer` intercepted so the yoga instance is captured
 * instead of a port being opened. The require cache entry is dropped either
 * side of the load so every call gets its own action counter, result-handler
 * map and yoga instance.
 */
function createServer() {
  const lom = createLom();
  const max = createMax(lom);
  const loadOrig = Module._load;
  const createServerOrig = http.createServer;
  let yoga = null;
  Module._load = function (request, ...rest) {
    return request === "max-api" ? max : loadOrig.call(this, request, ...rest);
  };
  http.createServer = (handler) => {
    yoga = handler;
    return { listen: () => {} };
  };
  try {
    delete require.cache[N4M];
    require(N4M);
  } finally {
    Module._load = loadOrig;
    http.createServer = createServerOrig;
    delete require.cache[N4M];
  }

  return {
    lom,
    max,
    gql: async (query, variables) =>
      (
        await yoga.fetch("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        })
      ).json(),
    schema: yoga.getEnveloped().schema,
  };
}

/** The single error message of a response expected to carry exactly one. */
function errorMessage(response) {
  if (response.errors?.length !== 1) {
    throw new Error(
      `expected one error, got ${JSON.stringify(response.errors ?? null)}`,
    );
  }
  return response.errors[0].message;
}

module.exports = { createServer, errorMessage };
