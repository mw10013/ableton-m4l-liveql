// declare inlet/outlet count for the v8 object in the patcher
// bare globals — let/const breaks v8 attribute binding
inlets = 1;
outlets = 1;
autowatch = 1;

let sharedLive = null;

/**
 * Every action points one `LiveAPI` at its target instead of constructing a
 * new one. Measured in Live 12.4.6: `new LiveAPI` cost about 17 ms per action,
 * and every instance stays alive, so construction and `LiveAPI.get` both kept
 * slowing down for the whole Live session (a get went from 18 to 22 ms over
 * 3200 actions), and reopening the Set did not reset it. Retargeting by `id`
 * cost about 0.5 ms and stayed flat over 400 queries. It is made on first use because
 * a `LiveAPI` cannot be created in global code. The handlers run one at a time,
 * so no action sees another's target. Pointing it at an id no object has
 * leaves it on its previous target, which once sent a `track_set` for a bad id
 * to the track read before it, so it is first pointed at `id 0`, no object,
 * and a bad id or path leaves it there with an empty `path`.
 */
function getLive(idOrPath) {
  sharedLive ??= new LiveAPI();
  const live = sharedLive;
  live.id = 0;
  if (typeof idOrPath === "string") live.path = idOrPath;
  else live.id = idOrPath;
  if (live.path === "") {
    // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- `outletFailedResult` reports `message.toString()`, and an Error would prefix "Error: " to the message GraphQL clients see
    throw `Invalid live id or path: ${idOrPath}`;
  }
  return live;
}
getLive.local = 1; // prevent Max from exposing as a message handler

/**
 * A JSON message as symbols of at most 8000 code points. Max caps one symbol at
 * 32767 bytes in both directions between `node.script` and `v8`: measured in
 * Live 12.4.6, a 260-object `get` reply arrived cut at exactly 32767
 * characters, and a 32777-character request reached `v8` as truncated JSON.
 * 8000 code points stay under the cap even when every one is 4 bytes of UTF-8,
 * and splitting by code point never cuts a surrogate pair into two halves that
 * no encoding can carry. The receiver joins the atoms back into one string, and
 * `liveql-n4m.js` splits the same way.
 */
function atoms(json) {
  return json.match(/.{1,8000}/gsu);
}
atoms.local = 1;

function outletSuccessfulResult(actionId, data) {
  outlet(
    0,
    "result",
    ...atoms(
      JSON.stringify({
        status: "succeeded",
        actionId,
        data,
      }),
    ),
  );
}
outletSuccessfulResult.local = 1;

function outletFailedResult(actionId, message) {
  outlet(
    0,
    "result",
    ...atoms(
      JSON.stringify({
        status: "failed",
        actionId,
        message: message.toString(),
      }),
    ),
  );
}
outletFailedResult.local = 1; // prevent Max from exposing as a message handler

/**
 * A child id in a `LiveAPI.get` result, as opposed to the `id` tokens that
 * separate them or the junk Live pads an empty child list with. A track with no
 * clip slots (a return or master track) answers `clip_slots` with the empty
 * symbol rather than an empty list, and `id 0` is the LOM's way of saying no
 * child, so neither is an id to resolve.
 */
function isChildId(v) {
  return v !== "id" && v !== 0 && v !== "" && v !== undefined && v !== null;
}
isChildId.local = 1;

/** The names on the `property`, `child` and `children` lines of `LiveAPI.info`. */
function membersOf(live) {
  return new Set(
    String(live.info)
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([kind]) => ["property", "child", "children"].includes(kind))
      .map(([, name]) => name),
  );
}
membersOf.local = 1;

/**
 * The wire contract the Node layer is written against: a requested member the
 * object's `LiveAPI.info` does not list is never read and drops out of the
 * result. `LiveAPI.get` cannot tell: it answers 1 for a member the object
 * lacks, which arrived as `arm: true` on the master track and `fold_state: 1`
 * on a track that does not fold, while `info` lists only the members the
 * object has (`property`, `child` and `children` lines, the name second). A
 * single property is
 * recorded only when `LiveAPI.get` yields exactly one value, so a member that
 * reads as an empty list drops out of the result too; a
 * child is the id at index 1, where `id 0` means none; a multi-value property
 * that answers only the empty symbol is the empty list, which a Max list
 * cannot hold (a Simpler sample with no slices reads `slices` as `""`); a
 * child list is the ids
 * with the `id` tokens stripped. Every one of those reads is coerced because
 * `LiveAPI.get` does not always answer with an array: a return track's
 * `clip_slots` came back as something whose `.filter` is not a function, which
 * took out the whole object read. A non-array child list is treated as no
 * children, and a missing single child as none. `test/helpers/fake-lom.js` mirrors these four
 * loops, so a change to what this function returns means a change there.
 */
function readObject(params) {
  const live = getLive(params.idOrPath);

  /**
   * Live gives some objects no path: the Song's tuning system answers both
   * `path` and `unquotedpath` with null though the LOM documents
   * `live_set tuning_system` (Live 12.4.6). The bridge passes the null on,
   * and the class's override types its `path` nullable.
   *
   * `liveApiType` is `LiveAPI.type`, the class name the server resolves
   * types by. It is camelCase so no LOM member, all snake_case, can
   * overwrite it: Device's own `type` property, the DeviceType int, would.
   */
  const o = {
    id: Number(live.id), // LOM says this should be number instead of string
    path: live.unquotedpath,
    liveApiType: live.type,
  };
  const keys = [
    params.propertyKeysSingle,
    params.propertyKeysMultiple,
    params.childKeysSingle,
    params.childKeysMultiple,
  ].map((ks) => ks ?? []);
  const members = keys.flat().length > 0 ? membersOf(live) : new Set();
  const [
    propertyKeysSingle,
    propertyKeysMultiple,
    childKeysSingle,
    childKeysMultiple,
  ] = keys.map((ks) => ks.filter((k) => members.has(k)));

  for (const k of propertyKeysSingle) {
    const raw = live.get(k);
    const propertyArr = Array.isArray(raw)
      ? raw
      : raw === undefined || raw === null
        ? []
        : [raw];
    if (propertyArr.length === 1) {
      o[k] = propertyArr[0];
    }
  }

  for (const k of propertyKeysMultiple) {
    const raw = live.get(k);
    const list = Array.isArray(raw)
      ? raw
      : raw === undefined || raw === null
        ? []
        : [raw];
    o[k] = list.length === 1 && list[0] === "" ? [] : list;
  }

  for (const k of childKeysSingle) {
    const raw = live.get(k);
    const id = Array.isArray(raw) ? raw[1] : undefined;
    o[k] = isChildId(id) ? id : null;
  }

  for (const k of childKeysMultiple) {
    const raw = live.get(k);
    o[k] = Array.isArray(raw) ? raw.filter(isChildId) : [];
  }

  return o;
}
readObject.local = 1;

/**
 * Reads every object of `reads` in order and outlets their results as one
 * list, each `{ data }` or `{ message }`, so a bad id fails only its own read
 * and the rest of the batch still answers.
 */
function get(...parts) {
  let actionId = null;
  try {
    const params = JSON.parse(parts.join(""));
    actionId = params.actionId;
    outletSuccessfulResult(
      actionId,
      params.reads.map((read) => {
        try {
          return { data: readObject(read) };
        } catch (err) {
          return { message: err.toString() };
        }
      }),
    );
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}

/**
 * Raw `LiveAPI.info`: the object's id, type, description, and the children,
 * properties and functions Live reports for it, one per line, ending in `done`.
 */
function info(...parts) {
  let actionId = null;
  try {
    const params = JSON.parse(parts.join(""));
    actionId = params.actionId;
    outletSuccessfulResult(actionId, getLive(params.idOrPath).info);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}

function set(...parts) {
  let actionId = null;
  try {
    const params = JSON.parse(parts.join(""));
    actionId = params.actionId;
    const live = getLive(params.idOrPath);
    const data = live.set(params.property, params.value);
    outletSuccessfulResult(actionId, data);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}

function call(...parts) {
  let actionId = null;
  try {
    const params = JSON.parse(parts.join(""));
    actionId = params.actionId;
    const live = getLive(params.idOrPath);
    const data = live.call(params.args);
    outletSuccessfulResult(actionId, data);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}
