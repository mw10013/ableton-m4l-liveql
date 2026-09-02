const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./helpers/server");

const LOM_DIR = path.join(__dirname, "..", "refs", "m4l-docs", "apiref", "lom");
const LOM_OBJECT_TYPES = ["Application", "Song", "SongView", "Track", "ClipSlot", "Scene", "Clip", "ClipView"];
const MUTATION_PREFIX = {
  Song: "song",
  SongView: "song_view",
  Track: "track",
  ClipSlot: "clip_slot",
  Scene: "scene",
  Clip: "clip",
  ClipView: "clip_view",
  ClipNotesPayload: "clip",
};
const INVENTED_FIELDS = ["id", "properties", "input"];
const INVENTED_ARGS = ["id", "properties", "input"];
const INVENTED_MUTATIONS = ["write_notes", "replace_notes"];

/**
 * The LOM vocabulary as the reference docs spell it: `### name` headings cover
 * properties, children and functions, and inline code spans cover function
 * parameters (`` `record_length (optional)` ``). `refs/` is gitignored, so the
 * tests that consume this skip themselves when it has not been fetched.
 */
function lomNames() {
  const names = new Set();
  if (!fs.existsSync(LOM_DIR)) return names;
  for (const entry of fs.readdirSync(LOM_DIR)) {
    const file = path.join(LOM_DIR, entry, "index.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/^#{2,4} ([a-z][a-z0-9_]*)/gm)) names.add(name);
    for (const [, name] of text.matchAll(/`([a-z][a-z0-9_]*)(?: \(optional\))?`/g)) names.add(name);
  }
  return names;
}

describe("schema", () => {
  let schema;
  before(() => {
    schema = createServer().schema;
  });

  const fieldTypes = () =>
    Object.entries(schema.getTypeMap()).filter(([name, type]) => !name.startsWith("__") && type.getFields);

  it("builds with the types the LOM is exposed through", () => {
    for (const name of [...LOM_OBJECT_TYPES, "Note", "NotesDictionary", "ClipNotesPayload"]) {
      assert.ok(schema.getType(name), `missing type ${name}`);
    }
  });

  it("gives every LOM object type the bridge's id, path and type", () => {
    for (const name of LOM_OBJECT_TYPES) {
      const fields = schema.getType(name).getFields();
      assert.equal(String(fields.id.type), "Int!", `${name}.id`);
      assert.equal(String(fields.path.type), "String!", `${name}.path`);
      assert.equal(String(fields.type.type), "String!", `${name}.type`);
    }
  });

  it("names every field and argument in snake_case", () => {
    for (const [typeName, type] of fieldTypes()) {
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        assert.match(fieldName, /^[a-z][a-z0-9_]*$/, `${typeName}.${fieldName}`);
        for (const arg of field.args ?? []) {
          assert.match(arg.name, /^[a-z][a-z0-9_]*$/, `${typeName}.${fieldName}(${arg.name})`);
        }
      }
    }
  });

  it("names every mutation <object>_<lom function or set_<property>>", () => {
    const names = lomNames();
    for (const [name, field] of Object.entries(schema.getMutationType().getFields())) {
      const returnType = String(field.type).replace(/[![\]]/g, "");
      const prefix = MUTATION_PREFIX[returnType];
      assert.ok(prefix, `${name} returns ${returnType}, which has no mutation prefix`);
      assert.ok(name.startsWith(`${prefix}_`), `${name} does not start with ${prefix}_`);
      const operation = name.slice(prefix.length + 1);
      const property = operation.startsWith("set_") ? operation.slice(4) : null;
      assert.ok(
        names.size === 0 ||
          operation === "set_properties" ||
          INVENTED_MUTATIONS.includes(operation) ||
          names.has(operation) ||
          names.has(property),
        `${name}: ${operation} is not a LOM function or settable property`
      );
    }
  });

  it("names every field and argument after the LOM", { skip: !fs.existsSync(LOM_DIR) && "refs/m4l-docs not fetched" }, () => {
    const names = lomNames();
    assert.ok(names.size > 100, "LOM vocabulary looks empty; has the ref format changed?");
    // a singular indexed accessor for a LOM child list: Song.track -> tracks
    const known = (name) => names.has(name) || names.has(`${name}s`);
    for (const [typeName, type] of fieldTypes()) {
      if (typeName === "Mutation") continue;
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        assert.ok(
          known(fieldName) || INVENTED_FIELDS.includes(fieldName),
          `${typeName}.${fieldName} is not a LOM name`
        );
        for (const arg of field.args ?? []) {
          assert.ok(
            known(arg.name) || INVENTED_ARGS.includes(arg.name),
            `${typeName}.${fieldName}(${arg.name}) is not a LOM name`
          );
        }
      }
    }
    for (const arg of schema.getMutationType().getFields().clip_write_notes.args) {
      assert.ok(known(arg.name) || INVENTED_ARGS.includes(arg.name), `clip_write_notes(${arg.name})`);
    }
  });
});
