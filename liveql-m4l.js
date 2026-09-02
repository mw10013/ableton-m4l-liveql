// declare inlet/outlet count for the v8 object in the patcher
// bare globals — let/const breaks v8 attribute binding
inlets = 1;
outlets = 1;

function getLive(idOrPath) {
  const live = new LiveAPI(
    typeof idOrPath === "string" ? idOrPath : `id ${idOrPath}`,
  );
  if (live.path === "") {
    throw `Invalid live id or path: ${idOrPath}`;
  }
  return live;
}
getLive.local = 1; // prevent Max from exposing as a message handler

function outletSuccessfulResult(actionId, data) {
  outlet(
    0,
    "result",
    JSON.stringify({
      status: "succeeded",
      actionId,
      data,
    }),
  );
}
outletSuccessfulResult.local = 1;

function outletFailedResult(actionId, message) {
  outlet(
    0,
    "result",
    JSON.stringify({
      status: "failed",
      actionId,
      message: message.toString(),
    }),
  );
}
outletFailedResult.local = 1; // prevent Max from exposing as a message handler

/**
 * The wire contract the Node layer is written against: a single property is
 * recorded only when `LiveAPI.get` yields exactly one value, so a member Live
 * omits on this object reads as an empty list and drops out of the result; a
 * child is the id at index 1, where `id 0` means none; a child list is the ids
 * with the `id` tokens stripped. Every one of those reads is coerced because
 * `LiveAPI.get` does not always answer with an array: a return track's
 * `clip_slots` came back as something whose `.filter` is not a function, which
 * took out the whole object read. A non-array child list is treated as no
 * children, and a missing single child as none. `test/helpers/fake-lom.js` mirrors these four
 * loops, so a change to what this function outlets means a change there.
 */
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

function get(json) {
  let actionId = null;
  try {
    const params = JSON.parse(json);
    actionId = params.actionId;
    const live = getLive(params.idOrPath);

    const o = {
      id: parseInt(live.id), // LOM says this should be number instead of string
      path: live.unquotedpath,
      type: live.type,
    };

    for (const k of params.propertyKeysSingle || []) {
      const raw = live.get(k);
      const propertyArr = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
      if (propertyArr.length === 1) {
        o[k] = propertyArr[0];
      }
    }

    for (const k of params.propertyKeysMultiple || []) {
      const raw = live.get(k);
      o[k] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    }

    for (const k of params.childKeysSingle || []) {
      const raw = live.get(k);
      const id = Array.isArray(raw) ? raw[1] : undefined;
      o[k] = isChildId(id) ? id : null;
    }

    for (const k of params.childKeysMultiple || []) {
      const raw = live.get(k);
      o[k] = Array.isArray(raw) ? raw.filter(isChildId) : [];
    }

    outletSuccessfulResult(actionId, o);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}

function set(json) {
  let actionId = null;
  try {
    const params = JSON.parse(json);
    actionId = params.actionId;
    const live = getLive(params.idOrPath);
    const data = live.set(params.property, params.value);
    outletSuccessfulResult(actionId, data);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}

function call(json) {
  let actionId = null;
  try {
    const params = JSON.parse(json);
    actionId = params.actionId;
    const live = getLive(params.idOrPath);
    const data = live.call(params.args);
    outletSuccessfulResult(actionId, data);
  } catch (err) {
    outletFailedResult(actionId, err);
  }
}
