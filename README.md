LiveQL

A GraphQL API for Ableton Live. LiveQL exposes a subset of Live's Object Model (LOM) through a local GraphQL server, letting you query and control your Live Set from any HTTP client, script, or web app.

## How it works

LiveQL runs as a Max for Live device with two components:

- A **Max JS script** that talks directly to the LOM via LiveAPI
- A **Node.js server** (via Node for Max) that serves a GraphQL API on `http://localhost:4000/graphql`

External clients send GraphQL queries and mutations over HTTP. The Node server translates these into LOM operations, executes them through the Max layer, and returns the results as JSON.

## Setup

Development setup. To build a distributable device, see [Productionizing the device](#productionizing-the-device).

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Drop `liveql.amxd` onto any track in your Live Set.

3. Click the start button on the device to launch the server.

4. The GraphQL API is now available at `http://localhost:4000/graphql`. The server also serves GraphiQL, an interactive query editor you can open in your browser at the same address.

## Productionizing the device

`liveql.amxd` in the root only runs out of this repo. `dist/` is a throwaway, self-contained copy with
production-only dependencies — freezing the device *there* bundles everything into a single file you can
hand to someone else. Your dev tree and dev device are never touched.

1. Build `dist/`:

   ```bash
   pnpm build:dist
   ```

   Copies the device and both scripts into `dist/`, then installs a production-only `node_modules` there
   (drops typescript, effect, @types/node — 116 MB to 9.2 MB).

2. Open `dist/liveql.amxd` in Max and change the object box to
   `node.script liveql-n4m.js @autostart 0 @watch 0`.

3. Click **Freeze** in the device toolbar, then **File → Save**.

4. Ship `dist/liveql.amxd`. Delete `dist/` whenever you like — `pnpm build:dist` rebuilds it.

Not yet run for this device: if the frozen device can't find `node_modules`, the fallback is a Max Project
with `node_modules` in a folder registered in the project's search path with **Embedded** enabled — see
`docs/vignettes/03_n4m_projects_devices.maxvig.xml` in the Node for Max package that ships with Max.

## What you can query

**Song state** — Check whether the song is playing, get the song view, see which track is selected or which clip is in the detail view.

**Tracks** — List all tracks or access a specific track by index. Read properties like name and whether a track has MIDI input.

**Clip slots and clips** — Navigate the session grid. Check if a clip slot contains a clip, then read clip properties like name, length, time signature, and looping state.

**MIDI notes** — Read the full list of notes from a MIDI clip, including pitch, start time, duration, velocity, probability, and mute state.

## What you can mutate

**Playback** — Start, continue, and stop the song.

**Tracks** — Rename tracks.

**Clips** — Toggle looping, set clip properties (name, time signature), and fire clips.

**MIDI notes** — Add new notes, modify existing notes, select notes, and remove notes by ID or by pitch/time range.

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
  -d '{"query":"{ live_set { track(index: 0) { clip_slot(index: 0) { clip { name notes { pitch start_time duration velocity } } } } } }"}' | jq .

# set looping off using the clip id looked up via indexes
# first query:
# { live_set { track(index: 0) { clip_slot(index: 0) { clip { id } } } } }
# then use that id here
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { clip_set_looping(id: 39, looping: false) { id looping } }"}' | jq .
  
```
