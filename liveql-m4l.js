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
 * with the `id` tokens stripped. `test/helpers/fake-lom.js` mirrors these four
 * loops, so a change to what this function outlets means a change there.
 */
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
      const propertyArr = live.get(k);
      if (propertyArr.length === 1) {
        o[k] = propertyArr[0];
      }
    }

    for (const k of params.propertyKeysMultiple || []) {
      o[k] = live.get(k);
    }

    for (const k of params.childKeysSingle || []) {
      const id = live.get(k)[1];
      o[k] = id === 0 ? null : id;
    }

    for (const k of params.childKeysMultiple || []) {
      o[k] = live.get(k).filter((v) => v !== "id");
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
