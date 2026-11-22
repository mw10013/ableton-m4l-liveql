const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { printSchema } = require("graphql");
const { createServer } = require("./helpers/server");

const LOM_DIR = path.join(__dirname, "..", "..", "m4l-docs", "apiref", "lom");
const LOM_OBJECT_TYPES = [
  "Application",
  "Song",
  "SongView",
  "Track",
  "ClipSlot",
  "Scene",
  "Clip",
  "ClipView",
  "Device",
  "GenericDevice",
  "SimplerDevice",
  "RackDevice",
  "WavetableDevice",
  "Eq8Device",
  "MaxDevice",
  "DeviceParameter",
  "Chain",
  "GenericChain",
  "DrumChain",
  "DrumPad",
  "ApplicationView",
  "TrackView",
  "TakeLane",
  "DeviceView",
  "GenericDeviceView",
  "RackDeviceView",
  "SimplerDeviceView",
  "Eq8DeviceView",
  "MixerDevice",
  "ChainMixerDevice",
  "Sample",
  "CuePoint",
  "Groove",
  "GroovePool",
  "CompressorDevice",
  "DriftDevice",
  "DrumCellDevice",
  "HybridReverbDevice",
  "LooperDevice",
  "MeldDevice",
  "RoarDevice",
  "ShifterDevice",
  "SpectralResonatorDevice",
  "PluginDevice",
  "TuningSystem",
  "DeviceIO",
];
const MUTATION_PREFIX = {
  Song: "song",
  SongView: "song_view",
  Track: "track",
  ClipSlot: "clip_slot",
  Scene: "scene",
  Clip: "clip",
  ClipView: "clip_view",
  ClipNotesPayload: "clip",
  Device: "device",
  SimplerDevice: "simpler_device",
  RackDevice: "rack_device",
  WavetableDevice: "wavetable_device",
  Eq8Device: "eq8_device",
  DeviceParameter: "device_parameter",
  Chain: "chain",
  DrumChain: "drum_chain",
  DrumPad: "drum_pad",
  ApplicationView: "application_view",
  TrackView: "track_view",
  TakeLane: "take_lane",
  DeviceView: "device_view",
  RackDeviceView: "rack_device_view",
  SimplerDeviceView: "simpler_device_view",
  Eq8DeviceView: "eq8_device_view",
  MixerDevice: "mixer_device",
  Sample: "sample",
  CuePoint: "cue_point",
  Groove: "groove",
  DriftDevice: "drift_device",
  DrumCellDevice: "drum_cell_device",
  HybridReverbDevice: "hybrid_reverb_device",
  LooperDevice: "looper_device",
  MeldDevice: "meld_device",
  RoarDevice: "roar_device",
  ShifterDevice: "shifter_device",
  SpectralResonatorDevice: "spectral_resonator_device",
  PluginDevice: "plugin_device",
  TuningSystem: "tuning_system",
  DeviceIO: "device_io",
  CompressorDevice: "compressor_device",
};
const INVENTED_FIELDS = new Set(["id", "info", "properties", "input"]);
/**
 * Keys of the TuningSystem dictionaries, named verbatim as Live returns them:
 * the docs describe those dictionaries only in prose.
 */
const LIVE_DICTIONARY_KEYS = new Set([
  "index_in_octave",
  "octave",
  "frequency",
]);
const INVENTED_ARGS = new Set(["id", "properties"]);
const INVENTED_MUTATIONS = new Set(["write_notes", "replace_notes"]);

/**
 * The LOM vocabulary as the reference docs spell it: `### name` headings cover
 * properties, children and functions, and inline code spans cover function
 * parameters (`` `record_length (optional)` ``). The docs are a shared reference
 * beside this checkout, so the tests that consume this skip themselves when it
 * has not been fetched.
 */
function lomNames() {
  const names = new Set();
  if (!fs.existsSync(LOM_DIR)) return names;
  for (const entry of fs.readdirSync(LOM_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(LOM_DIR, entry), "utf8");
    for (const { groups } of text.matchAll(
      /^#{2,4} (?<name>[a-z][a-z0-9_]*)/gmu,
    ))
      names.add(groups.name);
    for (const { groups } of text.matchAll(
      /`(?<name>[a-z][a-z0-9_]*)(?: \(optional\))?`/gu,
    ))
      names.add(groups.name);
  }
  return names;
}

describe("schema", () => {
  let schema;
  before(() => {
    schema = createServer().schema;
  });

  const fieldTypes = () =>
    Object.entries(schema.getTypeMap()).filter(
      ([name, type]) => !name.startsWith("__") && type.getFields,
    );

  it("builds with the types the LOM is exposed through", () => {
    for (const name of [
      ...LOM_OBJECT_TYPES,
      "Note",
      "NotesDictionary",
      "ClipNotesPayload",
    ]) {
      assert.ok(schema.getType(name), `missing type ${name}`);
    }
  });

  /**
   * `schema.graphql` is what a client generates its types from, so it has to
   * be the schema the device builds. Vite+'s `vp check` has no step for a
   * custom check, so the gate lives here.
   */
  it("matches the committed schema.graphql", () => {
    assert.equal(
      fs.readFileSync(path.join(__dirname, "..", "schema.graphql"), "utf8"),
      `${printSchema(schema)}\n`,
      "schema.graphql is stale: run pnpm schema:print",
    );
  });

  it("gives every LOM object type the bridge's id, path and type", () => {
    for (const name of LOM_OBJECT_TYPES) {
      const fields = schema.getType(name).getFields();
      assert.equal(String(fields.id.type), "Int!", `${name}.id`);
      assert.equal(
        String(fields.path.type),
        name === "TuningSystem" ? "String" : "String!",
        `${name}.path`,
      );
      assert.equal(String(fields.type.type), "String!", `${name}.type`);
    }
  });

  it("names every field and argument in snake_case", () => {
    for (const [typeName, type] of fieldTypes()) {
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        assert.match(
          fieldName,
          /^[a-z][a-z0-9_]*$/u,
          `${typeName}.${fieldName}`,
        );
        for (const arg of field.args ?? []) {
          assert.match(
            arg.name,
            /^[a-z][a-z0-9_]*$/u,
            `${typeName}.${fieldName}(${arg.name})`,
          );
        }
      }
    }
  });

  it("names every mutation <object>_<lom function or set_<property>>", () => {
    const names = lomNames();
    for (const [name, field] of Object.entries(
      schema.getMutationType().getFields(),
    )) {
      const returnType = String(field.type).replaceAll(/[![\]]/gu, "");
      const prefix = MUTATION_PREFIX[returnType];
      assert.ok(
        prefix,
        `${name} returns ${returnType}, which has no mutation prefix`,
      );
      assert.ok(
        name.startsWith(`${prefix}_`),
        `${name} does not start with ${prefix}_`,
      );
      const operation = name.slice(prefix.length + 1);
      const property = operation.startsWith("set_") ? operation.slice(4) : null;
      assert.ok(
        names.size === 0 ||
          operation === "set" ||
          INVENTED_MUTATIONS.has(operation) ||
          names.has(operation) ||
          names.has(property),
        `${name}: ${operation} is not a LOM function or settable property`,
      );
    }
  });

  it(
    "names every field and argument after the LOM",
    { skip: !fs.existsSync(LOM_DIR) && "m4l-docs not fetched" },
    () => {
      const names = lomNames();
      assert.ok(
        names.size > 100,
        "LOM vocabulary looks empty; has the ref format changed?",
      );
      // a singular indexed accessor for a LOM child list: Song.track -> tracks
      const known = (name) => names.has(name) || names.has(`${name}s`);
      for (const [typeName, type] of fieldTypes()) {
        if (typeName === "Mutation") continue;
        for (const [fieldName, field] of Object.entries(type.getFields())) {
          assert.ok(
            known(fieldName) ||
              INVENTED_FIELDS.has(fieldName) ||
              LIVE_DICTIONARY_KEYS.has(fieldName),
            `${typeName}.${fieldName} is not a LOM name`,
          );
          for (const arg of field.args ?? []) {
            assert.ok(
              known(arg.name) || INVENTED_ARGS.has(arg.name),
              `${typeName}.${fieldName}(${arg.name}) is not a LOM name`,
            );
          }
        }
      }
    },
  );
});
