LiveQL

A GraphQL API for Ableton Live. LiveQL exposes a subset of Live's Object Model (LOM) through a local GraphQL server, letting you query and control your Live Set from any HTTP client, script, or web app.

## How it works

LiveQL runs as a Max for Live device with two components:

- A **Max JS script** that talks directly to the LOM via LiveAPI
- A **Node.js server** (via Node for Max) that serves a GraphQL API on `http://localhost:4000/graphql`

External clients send GraphQL queries and mutations over HTTP. The Node server translates these into LOM operations, executes them through the Max layer, and returns the results as JSON. Every mutation is exactly one LOM operation, a `set` or a `call`, followed by the readback its selection set needs; orchestration is the client's job. Several mutations can be sent in one document as aliased fields, and they run serially in order.

## Setup

Development setup. To build a distributable device, see [Productionizing the device](#productionizing-the-device).

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Drop `liveql.amxd` onto any track in your Live Set.

3. Click the start button on the device to launch the server.

4. The GraphQL API is now available at `http://localhost:4000/graphql`. The server also serves GraphiQL, an interactive query editor you can open in your browser at the same address.

## Tests

```bash
pnpm test        # schema and resolvers, no Live needed
pnpm test:n4m    # the same suite under Node for Max's bundled Node
```

`pnpm test` fakes `max-api` and answers `get` / `set` / `call` the way `liveql-m4l.js` does, then drives
the real schema through graphql-yoga. That covers everything up to the `v8` boundary: schema shape,
marker ordering, the by-id null semantics, note payloads and the error messages. It touches nothing in
Live and needs no device running. `pnpm test:n4m` reruns it under the Node binary the device actually
uses, which is not the Node on your PATH.

The questions only Live can answer live in `test/live/`, off by default because they mutate the open Set:

```bash
pnpm test:live   # open a disposable Set with a MIDI clip and the device started first
```

## Productionizing the device

`liveql.amxd` in the root only runs out of this repo. `dist/` is a throwaway, self-contained copy with
production-only dependencies — freezing the device _there_ bundles everything into a single file you can
hand to someone else. Your dev tree and dev device are never touched.

1. Build `dist/`:

   ```bash
   pnpm build:dist
   ```

   Copies the device and both scripts into `dist/`, then installs a production-only `node_modules` there
   (drops typescript, effect, @types/node — 139 MB to 19 MB). Most of what is left is `graphql` itself,
   11 MB of it, since v17 ships a separate `__dev__` build alongside the production one.

2. Open `dist/liveql.amxd` in Max and change the object box to
   `node.script liveql-n4m.js @autostart 0 @watch 0`.

3. Click **Freeze** in the device toolbar, then **File → Save**.

4. Ship `dist/liveql.amxd`. Delete `dist/` whenever you like — `pnpm build:dist` rebuilds it.

Not yet run for this device: if the frozen device can't find `node_modules`, the fallback is a Max Project
with `node_modules` in a folder registered in the project's search path with **Embedded** enabled — see
`docs/vignettes/03_n4m_projects_devices.maxvig.xml` in the Node for Max package that ships with Max.

## What you can query

**Song state** — Transport, tempo, time signature, arrangement loop, metronome, swing, record and overdub state, scale (`root_note`, `scale_name`, `scale_intervals`), undo/redo availability, and the song view: selected track, selected scene, highlighted clip slot, detail clip. `live_app` reports the Live version.

**Tracks and scenes** — List regular, return and visible tracks, the master track, and scenes; or address one by index. Read name, color, arm/mute/solo, fold state, playing and fired slot indices, and arrangement clips.

**Clip slots and clips** — Navigate the session grid. Read clip markers (`loop_start`, `loop_end`, `start_marker`, `end_marker`, `position`), looping, length, time signature, color, mute, launch settings, playing state, and the clip view's grid (`grid_quantization`, `grid_is_triplet`).

**By id** — `clip(id)`, `clip_slot(id)`, `track(id)` and `scene(id)` refetch exactly the object a mutation returned. They return `null` for an unknown id or an id of another type.

**MIDI notes** — The LOM's read-only note functions are clip fields under their own names: `get_all_notes_extended`, `get_notes_by_id`, `get_notes_extended` and `get_selected_notes_extended`, each returning `{ notes }` with pitch, start time, duration, velocity, probability, and mute state. Null on audio clips.

## What you can mutate

**Playback** — Start, continue, and stop the song; stop all clips; jump; undo and redo; capture MIDI; create MIDI tracks and scenes; fire and stop clip slots, scenes and clips.

**Properties** — `song_set_properties`, `track_set_properties`, `scene_set_properties`, `clip_set_properties`, `clip_view_set_properties` and `song_view_set_properties` batch property writes. Keys are written in a fixed order with no read first; Live drops a marker that would cross its partner without raising, so write markers one per mutation in the order that keeps start before end and compare the returned clip with what you asked for. Song view setters push a clip into Live's Detail View or select a track, scene or slot.

**Clips** — Create an empty MIDI clip in a slot or the arrangement, delete, duplicate to a slot or the arrangement, crop, duplicate loop, scrub.

**MIDI notes** — `clip_add_new_notes` returns the note ids Live assigned. Modify (Live silently ignores the whole list when any note id is stale; check with `get_notes_by_id` first if that matters), select, remove by id or region, duplicate by id or region, quantize.

Names mirror the LOM verbatim: fields and mutation suffixes are LOM properties and functions, and arguments are the LOM parameter or dictionary-key names.

## Examples

```bash
# get whether the song is playing
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { is_playing } }"}' | jq .

# get the first track by index
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { track(index: 0) { id name has_midi_input } } }"}' | jq .

# get the first clip slot from the first track by index
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { track(index: 0) { clip_slot(index: 0) { has_clip clip { id name looping } } } } }"}' | jq .

# get all tracks and their names
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { tracks { id name } } }"}' | jq .

# get clips with their ids and looping state
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { tracks { clip_slots { has_clip clip { id name looping } } } } }"}' | jq .

# get notes from the first clip slot of the first track
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ live_set { track(index: 0) { clip_slot(index: 0) { clip { name get_all_notes_extended { notes { pitch start_time duration velocity } } } } } } }"}' | jq .

# set looping off using the clip id looked up via indexes
# first query:
# { live_set { track(index: 0) { clip_slot(index: 0) { clip { id } } } } }
# then use that id here
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { clip_set_properties(id: 39, properties: { looping: false }) { id looping } }"}' | jq .

# refetch a clip by id, then add notes and get the ids Live assigned
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ clip(id: 39) { loop_start loop_end start_marker end_marker } }"}' | jq .
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { clip_add_new_notes(id: 39, notes: [{ pitch: 60, start_time: 0, duration: 1 }]) { note_ids clip { length } } }"}' | jq .

```
