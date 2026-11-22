const http = require("http");
const path = require("path");
const Max = require("max-api");
const { createYoga, createSchema } = require("graphql-yoga");

// This will be printed directly to the Max console
Max.post(`liveql: loaded the ${path.basename(__filename)} script`);

async function get(
  idOrPath,
  propertyKeysSingle = null,
  propertyKeysMultiple = null,
  childKeysSingle = null,
  childKeysMultiple = null,
) {
  return exec({
    action: "get",
    idOrPath,
    propertyKeysSingle,
    propertyKeysMultiple,
    childKeysSingle,
    childKeysMultiple,
  });
}

async function set(id, property, value) {
  return exec({
    action: "set",
    idOrPath: id,
    property,
    value,
  });
}

async function call(id, ...args) {
  return exec({
    action: "call",
    idOrPath: id,
    args,
  });
}

async function info(parent) {
  return exec({ action: "info", idOrPath: parent.id });
}

let actionId = 0;
const actionResultHandlers = new Map();

/**
 * Failures from the v8 bridge arrive as a bare message with no record of which
 * LOM operation produced it. The message is wrapped here, where the action, the
 * property or function, and the target id are all still in hand, so a GraphQL
 * error reads `liveql: set loop_end on 42: ...` instead of just Live's text.
 */
function describeAction({ action, idOrPath, property, args }) {
  const subject = property ?? args?.[0];
  return `${action}${subject === undefined ? "" : ` ${subject}`} on ${idOrPath}`;
}

async function exec(params) {
  actionId += 1;

  const p = new Promise((resolve, reject) => {
    actionResultHandlers.set(actionId, { resolve, reject });
  });
  const action = { actionId, ...params };
  await Max.outlet(action.action, JSON.stringify(action));
  return p.catch((err) => {
    throw new Error(`liveql: ${describeAction(params)}: ${err.message}`);
  });
}

Max.addHandler("result", async (json) => {
  const result = JSON.parse(json);
  const handler = actionResultHandlers.get(result.actionId);
  actionResultHandlers.delete(result.actionId);
  if (!handler) return;
  if (result.status !== "succeeded") {
    await Max.post(`liveql: failed result: ${json}`);
    handler.reject(new Error(result.message));
    return;
  }
  handler.resolve(result.data);
});

function toLiveBool(value) {
  return value ? 1 : 0;
}

function toLiveValue(value) {
  return typeof value === "boolean" ? toLiveBool(value) : value;
}

/**
 * LOM functions and child setters that take an object take it as the atoms
 * `id N`, the form `live.object` and `live.path` exchange. The v8 `LiveAPI`
 * accepts a single string for that pair when constructing (`new LiveAPI("id 12")`,
 * which `liveql-m4l.js` already relies on), so the same string form is used for
 * arguments. Confirmed in Live for `set` (`song_view_set` with `detail_clip`); if a
 * child setter is ever rejected, the alternative to try is the two-atom form
 * `["id", id]`, and this is the only place to change.
 */
function idArg(id) {
  return `id ${id}`;
}

function parseMaybeJson(data) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Normalizes whatever the v8 bridge forwards from `LiveAPI.call` for functions
 * documented as returning a list of note IDs (`add_new_notes`). The exact shape
 * under v8 is not pinned down: it may be a flat int array, a Max list with a
 * leading symbol, a JSON string like the note dictionaries, or a single int.
 * Every shape reduces to the integers it contains, in order. Confirmed in Live
 * that what comes out is one id per input note, in input order.
 */
function toIntList(data) {
  const v = parseMaybeJson(data);
  if (Array.isArray(v)) return v.flatMap(toIntList);
  if (Number.isInteger(v)) return [v];
  if (typeof v === "string" && /^-?\d+$/u.test(v)) return [Number(v)];
  if (v && typeof v === "object")
    return toIntList(v.note_ids ?? Object.values(v));
  return [];
}

function firstInt(data) {
  return toIntList(data)[0] ?? 0;
}

function firstString(data) {
  const v = parseMaybeJson(data);
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

function isInvalidId(err) {
  return err.message.includes("Invalid live id or path");
}

/**
 * The resolver for `<object>_set`. Each `properties` item is `@oneOf`, so it
 * has exactly one key, and is one LOM `set` sent in list order. A child is set
 * by id, and `0` becomes `id 0`, the LOM's empty child. The first failed set
 * stops the list, because later items may depend on it (a marker is only valid
 * against its partner), and the error names that item and the ones already
 * applied, since Live keeps them. The object is read once, after the last set.
 */
function setter(read, children = new Set()) {
  return async (parent, { id, properties }, context, { fieldName }) => {
    const applied = [];
    for (const [index, item] of properties.entries()) {
      const [[property, value]] = Object.entries(item);
      try {
        await set(
          id,
          property,
          children.has(property) ? idArg(value) : toLiveValue(value),
        );
      } catch (err) {
        throw new Error(
          `${err.message}; ${fieldName} stopped at properties[${index}], applied: ${applied.join(", ") || "none"}`,
          { cause: err },
        );
      }
      applied.push(`properties[${index}] ${property}`);
    }
    return read(id);
  };
}

function normalizeNoteInput(note) {
  if (note.mute === undefined) {
    return note;
  }
  return { ...note, mute: toLiveBool(note.mute) };
}

function normalizeNotesDictionaryInput(notesDictionary) {
  return {
    ...notesDictionary,
    notes: notesDictionary.notes.map(normalizeNoteInput),
  };
}

function compareNotes(a, b) {
  // start_time ascending, pitch ascending
  if (a.start_time < b.start_time) return -1;
  if (a.start_time > b.start_time) return 1;
  return a.pitch - b.pitch;
}

/**
 * Live answers a notes function with a dictionary that has no `notes` key at
 * all, rather than `{"notes": []}`, when nothing matches — confirmed in Live for
 * `get_notes_by_id` with an id that is not in the clip. Reading the absent key
 * as an empty list keeps that an ordinary empty result, which is what the
 * `Clip.get_notes_by_id` query field returns for a stale id; spreading it
 * unguarded died with a TypeError instead.
 */
function sortJsonNotesDictionary(json) {
  const data = JSON.parse(json);
  return { notes: (data?.notes ?? []).toSorted(compareNotes) };
}

async function getNotesExtended(parent, args) {
  // resolver interface with parent arg unused
  var json = await call(
    args.id,
    "get_notes_extended",
    args.from_pitch,
    args.pitch_span,
    args.from_time,
    args.time_span,
  );
  return sortJsonNotesDictionary(json);
}

async function getNotesById(id, noteIds) {
  return noteIds.length === 0
    ? []
    : sortJsonNotesDictionary(await call(id, "get_notes_by_id", ...noteIds))
        .notes;
}

async function addNewNotes(id, notes) {
  return toIntList(
    await call(id, "add_new_notes", normalizeNotesDictionaryInput({ notes })),
  );
}

function midiOnly(fn) {
  return (parent, args) => (parent.is_midi_clip ? fn(parent, args) : null);
}

function byId(name) {
  return async (parent, args) => {
    const o = await get(args.id).catch((err) => {
      if (isInvalidId(err)) return null;
      throw err;
    });
    return o?.type === name ? getObject(name, args.id) : null;
  };
}

/**
 * The LOM takes optional function arguments positionally (`ClipSlot.fire
 * record_length launch_quantization`), so a later optional argument cannot be
 * given without every earlier one. Rejects that shape with a message naming the
 * missing argument instead of letting Live read the wrong value.
 */
function optionalPositional(name, values, argNames) {
  const given = values.slice(
    0,
    values.findLastIndex((v) => v !== undefined && v !== null) + 1,
  );
  const gap = given.findIndex((v) => v === undefined || v === null);
  if (gap !== -1) {
    throw new Error(
      `liveql: ${name}: ${argNames[gap]} is required when a later optional argument is given`,
    );
  }
  return given;
}

/**
 * GraphQL is the schema boundary for Live API type normalization.
 *
 * The Live Object Model documents many fields as `bool`, but Max's `LiveAPI`
 * commonly returns those values as numeric `0` / `1`. We keep the Max bridge in
 * `liveql-m4l.js` generic and expose those fields here as GraphQL `Boolean`
 * where appropriate.
 *
 * In practice, Yoga/GraphQL coerces `0` -> `false` and `1` -> `true` for output
 * fields typed as `Boolean`, so output boolean fields usually need no custom
 * resolver logic.
 *
 * For boolean mutations, GraphQL inputs arrive as normal JavaScript booleans.
 * Live property setters still expect the Max/Live representation, so mutation
 * resolvers convert `true` / `false` to `1` / `0` before calling `LiveAPI.set`.
 *
 * Field, argument and mutation names mirror the LOM verbatim. The schema for
 * the classes in `lom-overrides.js`'s `scope` is built here from `lom.json`,
 * which `scripts/lom-parse.js` parses out of the LOM reference, plus the
 * override rows for what the reference cannot say. Properties are nullable
 * unless an override types them: a member is absent on some objects of its
 * class (Track.arm on return and master tracks, ClipSlot.color outside Group
 * Track slots), and the bridge leaves out every member the object's
 * `LiveAPI.info` does not list, so an absent member resolves to null. A member
 * typed by a class outside the scope, a doc type with no GraphQL mapping, an
 * observe-only member and a function with an untyped parameter or a return
 * value are left out unless an override row says how to expose them.
 */
const LOM = require("./lom.json");
const OVERRIDES = require("./lom-overrides.js");

const SCOPE = new Set(OVERRIDES.scope);
const LOM_TYPES = {
  bool: "Boolean",
  int: "Int",
  long: "Int",
  float: "Float",
  symbol: "String",
  unicode: "String",
};
const FIELD_READERS = { Int: firstInt, String: firstString };
const INFO_DESCRIPTION =
  "Raw `LiveAPI.info`: id, type, description, and the children, properties\nand functions Live reports for this object, one per line, ending in `done`.\nRead only when selected.";
const CHILD_INPUT_DESCRIPTION = "A child is set by its id, and 0 clears it.";

const prefixOf = (name) =>
  name.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gu, "_").toLowerCase();
const isObjectType = (type) =>
  type === "live object" || type === "id" || type?.replaceAll(".", "") in LOM;
const nullable = (type) => type.replace(/!$/u, "");
const isList = (type) => type.startsWith("[");

/**
 * A documented parameter as a GraphQL argument, or null when the docs leave
 * its name or type unresolved. An object parameter is an `Int` id sent as
 * `id N`; an optional one is a nullable argument.
 */
function paramArg({ name, type, optional }) {
  if (!/^[a-z][a-z0-9_]*$/u.test(name ?? "")) return null;
  const id = isObjectType(type);
  const base = id ? "Int" : LOM_TYPES[type];
  return base ? { name, sdl: optional ? base : `${base}!`, id } : null;
}

const skipped = [];

/**
 * One class of the scope as the rows the SDL and the resolvers are built from:
 * its readable children and properties in doc order, with each property's
 * GraphQL type, and its functions as mutation arguments in LOM call order.
 */
function lomClass(name) {
  const { children, properties, functions } = LOM[name];
  const o = OVERRIDES.classes[name] ?? {};
  const skip = (member, reason) => {
    skipped.push(`${name}.${member}: ${reason}`);
    return [];
  };
  return {
    name,
    prefix: prefixOf(name),
    parent: SCOPE.has(LOM[name].parent) ? LOM[name].parent : null,
    children: Object.entries(children).flatMap(
      ([member, { type, list, access }]) => {
        if (!access.includes("get")) return skip(member, "not readable");
        if (!SCOPE.has(type)) return skip(member, `${type} is not in scope`);
        return [
          {
            member,
            type,
            list,
            settable: access.includes("set"),
            ...o.children?.[member],
          },
        ];
      },
    ),
    properties: Object.entries(properties).flatMap(
      ([member, { type: docType, access }]) => {
        const row = o.properties?.[member] ?? {};
        const type = row.type ?? LOM_TYPES[docType];
        if (row.skip) return skip(member, row.skip);
        if (!access.includes("get")) return skip(member, "not readable");
        if (!type) return skip(member, `doc type ${docType} has no mapping`);
        return [
          {
            member,
            settable: access.includes("set"),
            ...row,
            type,
          },
        ];
      },
    ),
    functions: Object.entries(functions).flatMap(
      ([member, { params, returns }]) => {
        const row = o.functions?.[member];
        if (row?.custom) return [];
        if (row?.skip) return skip(member, row.skip);
        if (row?.field) return [{ member, field: row.field }];
        if (!row && returns) return skip(member, `returns ${returns}`);
        const args = row?.args
          ? Object.entries(row.args).map(([argName, spec]) =>
              typeof spec === "string"
                ? { name: argName, sdl: spec }
                : { name: argName, sdl: spec.type, id: spec.id },
            )
          : params.map(paramArg);
        const unresolved = params.filter((_, i) => !args[i]);
        if (unresolved.length > 0)
          return skip(
            member,
            `unresolved parameter ${unresolved.map((p) => p.name ?? `[${p.type}]`).join(", ")}`,
          );
        return [{ member, args, description: row?.description }];
      },
    ),
  };
}

const CLASSES = Object.fromEntries(
  OVERRIDES.scope.map((name) => [name, lomClass(name)]),
);
Max.post(
  `liveql: left out ${skipped.length} LOM members: ${skipped.join("; ")}`,
);

const subclassesOf = (name) =>
  Object.values(CLASSES).filter((c) => c.parent === name);

/**
 * The members of several classes of one family as one class's rows, a member
 * the classes share kept once. Two classes naming one member as a different
 * kind or GraphQL type cannot share a read or an interface field, so that
 * throws at startup naming both.
 */
function mergeRows(classes) {
  const seen = new Map();
  const rows = (kind) => [
    ...new Map(
      classes.flatMap((c) =>
        c[kind].map((r) => {
          const shape = `${kind} ${r.type ?? r.field ?? "function"}${r.list ? " list" : ""}`;
          const prior = seen.get(r.member);
          if (prior && prior.shape !== shape)
            throw new Error(
              `liveql: ${prior.name}.${r.member} is a ${prior.shape} but ${c.name}.${r.member} is a ${shape}`,
            );
          seen.set(r.member, { name: c.name, shape });
          return [r.member, r];
        }),
      ),
    ).values(),
  ];
  return {
    children: rows("children"),
    properties: rows("properties"),
    functions: rows("functions"),
  };
}

/**
 * The GraphQL object types the scope is exposed through. A class with
 * subclasses in the scope (Device) becomes an interface of its own members,
 * implemented by each subclass with the parent's members followed by its own,
 * and by `Generic<Class>` with just the parent's for an object of the class
 * itself (Operator is a plain Device). A subclass with subclasses of its own
 * would need an interface implementing an interface, which nothing in the
 * scope has yet, so it throws.
 */
function objectTypesOf(c) {
  const subclasses = subclassesOf(c.name);
  if (c.parent && subclasses.length > 0)
    throw new Error(
      `liveql: ${c.name} has a parent and subclasses in scope, which the builder does not nest`,
    );
  if (subclasses.length > 0)
    return [
      { ...c, interface: true },
      { ...c, name: `Generic${c.name}`, implements: c.name },
    ];
  return [
    c.parent
      ? { ...c, ...mergeRows([CLASSES[c.parent], c]), implements: c.parent }
      : c,
  ];
}

/**
 * What one `getObject` of a class reads: its members and its parent's, plus
 * every subclass's when the class is an interface, so a `Track.devices` read
 * answers whichever device it finds in one round trip. The bridge skips the
 * members an object's `info` does not list, so asking a Simpler for a Rack's
 * members costs nothing.
 */
const READS = Object.fromEntries(
  Object.values(CLASSES).map((c) => [
    c.name,
    mergeRows([
      ...(c.parent ? [CLASSES[c.parent]] : []),
      c,
      ...subclassesOf(c.name),
    ]),
  ]),
);

const description = (text, indent) =>
  text
    ? `${indent}"""\n${text
        .split("\n")
        .map((line) => `${indent}${line}`)
        .join("\n")}\n${indent}"""\n`
    : "";
const field = (text, sdl) => `${description(text, "    ")}    ${sdl}\n`;

function objectSdl({
  name,
  interface: isInterface,
  implements: parent,
  children,
  properties,
  functions,
}) {
  return [
    `  ${isInterface ? "interface" : "type"} ${name}${parent ? ` implements ${parent}` : ""} {\n`,
    field(null, "id: Int!"),
    field(null, "path: String!"),
    field(null, "type: String!"),
    field(INFO_DESCRIPTION, "info: String!"),
    ...children.map(({ member, type, list, index, description: text }) =>
      list
        ? `${index ? field(null, `${index}(index: Int!): ${type}`) : ""}${field(text, `${member}: [${type}!]`)}`
        : field(text, `${member}: ${type}`),
    ),
    ...properties.map(({ member, type, description: text }) =>
      field(text, `${member}: ${type}`),
    ),
    ...functions
      .filter((f) => f.field)
      .map(({ member, field: type }) => field(null, `${member}: ${type}`)),
    "  }\n",
  ].join("");
}

/**
 * A class's `<Class>SetInput` and mutations, for its own members only: a
 * subclass's inherited members are set and called through the parent's
 * mutations, which return the parent's interface.
 */
function mutationSdl({ name, prefix, children, properties, functions }) {
  const settable = [
    ...children
      .filter((c) => c.settable)
      .map((c) => ({ ...c, inputType: "Int" })),
    ...properties
      .filter((p) => p.settable)
      .map((p) => ({ ...p, inputType: nullable(p.type) })),
  ];
  const mutations = [
    settable.length === 0
      ? ""
      : field(
          null,
          `${prefix}_set(id: Int!, properties: [${name}SetInput!]!): ${name}`,
        ),
    ...functions
      .filter((f) => !f.field)
      .map(({ member, args, description: text }) =>
        field(
          text,
          `${prefix}_${member}(${["id: Int!", ...args.map((a) => `${a.name}: ${a.sdl}`)].join(", ")}): ${name}`,
        ),
      ),
  ].join("");
  return [
    ...(settable.length === 0
      ? []
      : [
          description(
            children.some((c) => c.settable) && CHILD_INPUT_DESCRIPTION,
            "  ",
          ),
          `  input ${name}SetInput @oneOf {\n`,
          ...settable.map(({ member, inputType, inputDescription }) =>
            field(inputDescription, `${member}: ${inputType}`),
          ),
          "  }\n",
        ]),
    mutations && `  extend type Mutation {\n${mutations}  }\n`,
  ].join("");
}

/**
 * Reads one object of a scope class with a single bridge `get` naming every
 * member the class exposes. A property with an override `default` resolves to
 * it when the read leaves it out: an empty symbol (Song.name and
 * Song.file_path on an unsaved Set, an unnamed clip) may come back as an empty
 * list, which the bridge drops, and the `String!` field would fail the whole
 * query.
 */
function getObject(name, idOrPath) {
  const { children, properties } = READS[name];
  const members = (rows) => rows.map((r) => r.member);
  return get(
    idOrPath,
    members(properties.filter((p) => !isList(p.type))),
    members(properties.filter((p) => isList(p.type))),
    members(children.filter((c) => !c.list)),
    members(children.filter((c) => c.list)),
  ).then((o) => ({
    ...o,
    ...Object.fromEntries(
      properties
        .filter((p) => p.default !== undefined)
        .map((p) => [p.member, o[p.member] ?? p.default]),
    ),
  }));
}

/**
 * The LOM arguments of one generated function call, in call order: the
 * positional rule applied, an object passed as `id N`, a list spread into
 * separate atoms, booleans as 0 and 1.
 */
function callArgs(fieldName, params, args) {
  return optionalPositional(
    fieldName,
    params.map((p) => args[p.name]),
    params.map((p) => p.name),
  ).flatMap((v, i) => (params[i].id ? idArg(v) : [v].flat().map(toLiveValue)));
}

/**
 * An interface resolves to the subclass named by the bridge's `type`, which
 * is `LiveAPI.type` and so the LOM class (`SimplerDevice`, and `RackDevice`
 * for both an Instrument and a Drum Rack), or to `Generic<Class>` for the
 * class itself or a subclass outside the scope.
 */
function objectResolvers({
  name,
  interface: isInterface,
  children,
  functions,
}) {
  if (isInterface) {
    const subclasses = new Set(subclassesOf(name).map((c) => c.name));
    return {
      __resolveType: ({ type }) =>
        subclasses.has(type.replaceAll(".", ""))
          ? type.replaceAll(".", "")
          : `Generic${name}`,
    };
  }
  return {
    info,
    ...Object.fromEntries(
      children.flatMap(({ member, type, list, index }) =>
        list
          ? [
              [
                member,
                (parent) =>
                  parent[member]?.map((id) => getObject(type, id)) ?? null,
              ],
              ...(index
                ? [
                    [
                      index,
                      (parent, args) => {
                        const id = parent[member]?.[args.index];
                        return id === undefined ? null : getObject(type, id);
                      },
                    ],
                  ]
                : []),
            ]
          : [
              [
                member,
                (parent) =>
                  parent[member] ? getObject(type, parent[member]) : null,
              ],
            ],
      ),
    ),
    ...Object.fromEntries(
      functions
        .filter((f) => f.field)
        .map(({ member, field: type }) => [
          member,
          async (parent) =>
            FIELD_READERS[type.replace(/!$/u, "")](
              await call(parent.id, member),
            ),
        ]),
    ),
  };
}

function classMutations({ name, prefix, children, properties, functions }) {
  const read = (id) => getObject(name, id);
  return {
    ...([...children, ...properties].some((m) => m.settable)
      ? {
          [`${prefix}_set`]: setter(
            read,
            new Set(children.filter((c) => c.settable).map((c) => c.member)),
          ),
        }
      : {}),
    ...Object.fromEntries(
      functions
        .filter((f) => !f.field)
        .map(({ member, args }) => [
          `${prefix}_${member}`,
          async (parent, values, context, { fieldName }) => {
            await call(values.id, member, ...callArgs(fieldName, args, values));
            return read(values.id);
          },
        ]),
    ),
  };
}

const typeDefs = /* GraphQL */ `
  ${Object.values(CLASSES)
    .map((c) => [...objectTypesOf(c).map(objectSdl), mutationSdl(c)].join(""))
    .join("\n")}
  extend type Clip {
    """
    Every note in the clip, sorted by start_time then pitch. Null on an audio
    clip, as are the other three note fields.
    """
    get_all_notes_extended: NotesDictionary
    """
    The notes with these ids. Ids that are not in the clip are simply absent
    from the result rather than an error, so a shorter list than you asked for
    means some ids are stale.
    """
    get_notes_by_id(note_ids: [Int!]!): NotesDictionary
    get_notes_extended(
      from_pitch: Int!
      pitch_span: Int!
      from_time: Float!
      time_span: Float!
    ): NotesDictionary
    get_selected_notes_extended: NotesDictionary
  }

  type Note {
    note_id: Int!
    pitch: Int!
    start_time: Float!
    duration: Float!
    velocity: Float!
    mute: Boolean!
    probability: Float!
    velocity_deviation: Float!
    release_velocity: Float!
  }

  type NotesDictionary {
    notes: [Note!]!
  }

  input NoteInput {
    note_id: Int
    pitch: Int
    start_time: Float
    duration: Float
    velocity: Float
    mute: Boolean
    probability: Float
    velocity_deviation: Float
    release_velocity: Float
  }

  type ClipNotesPayload {
    clip: Clip!
    note_ids: [Int!]!
  }

  type Query {
    live_set: Song!
    live_app: Application!
    """
    The clip with this LOM id, or null if no object has it or the object is not
    a Clip. The by-id queries never raise for a bad id.
    """
    clip(id: Int!): Clip
    clip_slot(id: Int!): ClipSlot
    track(id: Int!): Track
    scene(id: Int!): Scene
  }

  """
  Each <object>_set does one LOM set per properties item, in list order, then
  reads the object back once. It stops at the first set that fails, and the
  error names that item and the items already applied, which stay applied.
  """
  type Mutation {
    """
    Adds notes and returns the ids Live assigned, in the order the notes were
    given.
    """
    clip_add_new_notes(id: Int!, notes: [NoteInput!]!): ClipNotesPayload
    """
    Live silently ignores the entire list when any note_id in it is not in the
    clip: no error, nothing changes, and the returned clip is unchanged. Check the
    ids first with clip(id) { get_notes_by_id(note_ids: [...]) } if that matters,
    and compare the returned notes with what you asked for.
    """
    clip_apply_note_modifications(id: Int!, notes: [NoteInput!]!): Clip
    """
    Omit destination_time to place the copies the way the GUI's Duplicate does:
    every copy is shifted by the span of the selection, its last note end minus
    its first note start. The shift is not snapped to the editor grid, and
    copies landing past loop_end do not extend the clip's region.
    """
    clip_duplicate_notes_by_id(
      id: Int!
      note_ids: [Int!]!
      destination_time: Float
      transposition_amount: Int
    ): Clip
  }
`;

const resolvers = {
  ...Object.fromEntries(
    Object.values(CLASSES)
      .flatMap(objectTypesOf)
      .map((t) => [t.name, objectResolvers(t)]),
  ),
  Query: {
    live_set: () => getObject("Song", "live_set"),
    live_app: () => getObject("Application", "live_app"),
    clip: byId("Clip"),
    clip_slot: byId("ClipSlot"),
    track: byId("Track"),
    scene: byId("Scene"),
  },
  Mutation: {
    ...Object.assign({}, ...Object.values(CLASSES).map(classMutations)),
    clip_add_new_notes: async (parent, args) => {
      const note_ids = await addNewNotes(args.id, args.notes);
      return { clip: await getObject("Clip", args.id), note_ids };
    },
    clip_apply_note_modifications: async (parent, args) => {
      await call(
        args.id,
        "apply_note_modifications",
        normalizeNotesDictionaryInput({ notes: args.notes }),
      );
      return getObject("Clip", args.id);
    },
    /**
     * Dictionary form so `destination_time` and `transposition_amount` can be
     * omitted independently; when `destination_time` is absent Live inserts
     * "after the last selected note", the same placement as Duplicate in the
     * GUI. Only supplied keys go in the dictionary so an absent key keeps that
     * default.
     */
    /**
     * Omitting `destination_time` is what the LOM calls placing the copies
     * "after the last selected note". Confirmed in Live, that means a uniform
     * shift by the span of the selection — its last note end minus its first
     * note start — so a lone sixteenth moves by 0.25, a chord by its longest
     * note, and two notes two beats apart by 2.25. The shift is not snapped to
     * the editor grid (an off-grid source keeps its offset), and copies landing
     * past `loop_end` do not extend the clip's region.
     */
    clip_duplicate_notes_by_id: async (parent, args) => {
      const { id, note_ids, destination_time, transposition_amount } = args;
      await call(id, "duplicate_notes_by_id", {
        note_ids,
        ...(destination_time === undefined || destination_time === null
          ? {}
          : { destination_time }),
        ...(transposition_amount === undefined || transposition_amount === null
          ? {}
          : { transposition_amount }),
      });
      return getObject("Clip", id);
    },
  },
  Clip: {
    ...objectResolvers(CLASSES.Clip),
    get_all_notes_extended: midiOnly(async (parent) =>
      sortJsonNotesDictionary(await call(parent.id, "get_all_notes_extended")),
    ),
    get_notes_by_id: midiOnly(async (parent, args) => ({
      notes: await getNotesById(parent.id, args.note_ids),
    })),
    get_notes_extended: midiOnly((parent, args) =>
      getNotesExtended(parent, { ...args, id: parent.id }),
    ),
    get_selected_notes_extended: midiOnly(async (parent) =>
      sortJsonNotesDictionary(
        await call(parent.id, "get_selected_notes_extended"),
      ),
    ),
  },
};

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  maskedErrors: false,
});

const port = Number(process.argv[2]) || 5100;

// oxlint-disable-next-line typescript/no-misused-promises -- yoga is built to be a Node request listener and settles its own errors
const server = http.createServer(yoga);
server.listen(port, () => {
  Max.post(
    `liveql: server ready at http://localhost:${port}${yoga.graphqlEndpoint}`,
  );
});
