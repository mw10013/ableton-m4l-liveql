# Liveql Max for Live Research Notes

Date: 2026-03-17

## What This Project Appears To Do
The repository includes two JavaScript entry points and a `.amxd` Max for Live device. The JS files suggest a two-process bridge that exposes a GraphQL API to Ableton Live's Live Object Model (LOM).

High level flow:
GraphQL -> Node for Max -> Max JS -> LiveAPI -> Ableton Live LOM

## Code-Based Findings

### `liveql-m4l.js`
- Runs in Max's JS runtime (not Node).
- Uses `LiveAPI` to talk to the Live Object Model.
- Exposes three message handlers that Max can call: `get`, `set`, `call`.
- Input: JSON string. Output: `result` message with JSON containing `status`, `actionId`, and `data` or `message`.
- `get` can fetch:
  - Single-value properties (`propertyKeysSingle`).
  - Multi-value properties (`propertyKeysMultiple`).
  - Single child IDs (`childKeysSingle`).
  - Multi child IDs (`childKeysMultiple`).
- `call` invokes LOM methods like `get_notes_extended`, `add_new_notes`, etc.

### `liveql-n4m.js`
- Runs in Node for Max (`node.script`).
- Creates a GraphQL API using `apollo-server`.
- Sends `get/set/call` actions to Max via `Max.outlet(action, JSON.stringify(action))`.
- Receives `result` messages and resolves/rejects pending promises by `actionId`.
- Starts the server with `server.listen()` (default port 4000 unless configured elsewhere).

### LOM Coverage (from the GraphQL schema)
- `live_set` (Song), `Song.view`, `Song.tracks`, `Track.clip_slots`, `ClipSlot.clip`.
- Clip properties: `name`, `length`, `start_time`, `end_time`, `signature_*`, `is_midi_clip`, `is_arrangement_clip`.
- Note APIs used: `get_notes_extended`, `get_all_notes_extended`, `add_new_notes`, `apply_note_modifications`, `remove_notes_extended`, `remove_notes_by_id`, `select_all_notes`.

### Local Runtime Notes
- `package.json` lists `apollo-server` and `graphql` dependencies. Node for Max expects `node_modules` present.
- `package.json` sets `main: "liveql-n4l.js"` but the repo file is `liveql-n4m.js` (possible typo).

## What To Verify Inside The `.amxd`
The `.amxd` device is binary, but likely contains a Max patcher with these components:

- A `js` object that loads `liveql-m4l.js`.
- A `node.script` object that loads `liveql-n4m.js`.
- Routing in the patcher:
  - `node.script` outlet -> `route get set call` -> `js liveql-m4l.js`.
  - `js` output -> `route result` -> back into `node.script`.
- `loadbang` or startup logic that initializes `node.script`.
- Optional UI to show port / server status.

## Companion App: `liveql_note_list`
The sibling project at `../liveql_note_list` looks like a CRA web app that connects to the device's GraphQL endpoint.

- Apollo client is hardcoded to `http://localhost:4000/graphql` in `src/App.tsx`.
- UI hints: it expects a single MIDI clip selected in Live (shows "No single midi clip selected in Live.").
- Actions include Fetch, Save (replace notes), Fire Clip, Start/Stop song.
- Script `npm run download-schema` points at the same `http://localhost:4000/graphql` endpoint.

## How To Validate This In Current Ableton Live (Practical Steps)
These steps focus on confirming it still works in modern Live versions without rewriting the device.

1) Install dependencies for the Node side
- Run `pnpm install` in this repo so `node_modules` exists for `liveql-n4m.js`. (This repo is pnpm-managed; `npm` cannot read its `node_modules` layout.)

2) Load the `.amxd` in Live and confirm Node for Max is running
- Insert the device on a track.
- Open the Max Console in Live and look for the `liveql: loaded the liveql-n4m.js script` log from `Max.post()`.
- If the log is missing, the patcher might not be loading `liveql-n4m.js` (verify inside the device).

3) Verify the GraphQL server is listening
- In a browser, open `http://localhost:4000/graphql` and check if GraphiQL or a response appears.
- If the port is blocked or different, check the Max patcher for a port setting.

4) Run the web app
- In `../liveql_note_list`, run `npm install` then `npm start`.
- Open `http://localhost:3000/`.
- In Live, select a single MIDI clip in the Detail View, then click Fetch in the app.

5) Troubleshooting focus areas (Live version changes)
- Node for Max version compatibility with `apollo-server` v2 and Node runtime in your Live build.
- Max JS `LiveAPI` availability and method support (the device relies on `get_notes_extended` and related calls).
- If you see GraphQL errors in the app, check the Max Console for `liveql: failed result` logs.
