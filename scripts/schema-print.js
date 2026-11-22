const fs = require("node:fs");
const path = require("node:path");
const { printSchema } = require("graphql");
const { createServer } = require("../test/helpers/server");

/**
 * Writes `schema.graphql`, the schema `liveql-n4m.js` builds when it starts,
 * printed without Max: the fake `max-api` of the test helpers stands in, and
 * building the schema sends nothing to it. Committed so a client can generate
 * types from it and a review can diff it. Prints the LOM members the build
 * left out, and why, which is where to look when a member is missing.
 */
const { schema, max } = createServer();
fs.writeFileSync(
  path.join(__dirname, "..", "schema.graphql"),
  `${printSchema(schema)}\n`,
);
console.log(max.posts.find((post) => post.includes("left out")));
