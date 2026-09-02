# The `script npm install` Button in `liveql.amxd`

Date: 2026-08-31

One question: **the device has a "Just once, you'll need to npm install" comment and a
`script npm install` message box in presentation mode. Do we need it?**

Short answer: **no — remove both.** It is a copied idiom from a Cycling '74 vignette that describes a
distribution model we do not use, it cannot work against this repo's pnpm tree (reproduced below, it
crashes), and it is actively harmful in `dist/` right before a freeze. Cycling '74's own bundling
walkthrough tells you to delete the message once you are done with it.

---

## 1. What is actually in the device

`.amxd` is a small binary container: a 32-byte header of FourCC chunks (`ampf`, `mmmm`, `meta`, `ptch`)
followed by the patcher as plain JSON. Decoded (see [Appendix](#appendix-how-this-was-verified)), the
patch is 26 boxes. The two that matter:

| id | class | text | presentation | rect |
| --- | --- | --- | --- | --- |
| `obj-38` | `comment` | `Just once, you'll need to npm install` | yes | `[498, 6, 184, 18]` |
| `obj-14` | `message` | `script npm install` | yes | `[498, 28.5, 100, 20]` |

One patchline carries it: `obj-14:0 → obj-3:0`, where `obj-3` is
`node.script liveql-n4m.js @autostart 0 @watch 1`. Nothing else references either box, and neither
appears in the patcher's `parameters` map (only `obj-4` / `obj-5`, the Start button and the port numbox).
So the removal is: delete two boxes and one patchline. No other wiring changes.

Both boxes sit to the *right* of the `n4m.monitor` bpatcher, which ends at x=493. They push the
presentation bounding box out to x=682. The patcher's `openrect` is `[0, 0, 0, 169]` — a zero width, so
Live derives the device width from that bounding box. Removing them should narrow the device by ~190px
down to the monitor's own width. (Expected, not measured — verify by eye in Live.)

---

## 2. What `script npm install` does

From the `node.script` reference page that ships with Max
(`$N4M/docs/refpages/node.script.maxref.xml:145-148`):

> `npm` - Interface with the Node Package Manager (npm). If the node script is in a node package, then
> this message can be used to (for example) install module dependencies listed in package.json into
> node_modules. **The npm message assumes that package.json is in the same folder as the script specified
> as the first argument to node.script.** Symbols following npm will be sent as arguments to npm (for
> example `script npm install` will run `npm install`).

Implementation, in `$N4M/source/lib/nsNPMCommand.js`:

- `this._cwd = options.path` (line 38) — the script's own folder, i.e. **this repo's root**.
- `this._args.push("--scripts-prepend-node-path=true")` (line 69).
- Spawns `NPM_CMD_PATH` with `cwd: this.cwd` and a `PATH` prefixed with the bundled npm/npx/node
  (lines 146-165). That is the **bundled npm on the bundled Node** — 10.9.3 on v22.18.0 as of
  2026-09-01, 9.8.1 on v20.6.1 when the runs below were captured — not the pnpm on your `PATH`.
- Writes stderr to `npm-debug-<uniqID>.log` **inside the cwd** (line 42), and deletes it only on a
  zero exit (`await this._removeNPMDebug()`, line 268).

That last detail is how the failure announces itself.

---

## 3. It does not work in this repo — reproduced

There is a `npm-debug-u70453400004.log` sitting in the repo root, dated 2026-08-31 01:28:

```
npm ERR! Cannot read properties of null (reading 'edgesOut')
```

By §2 that file is *by construction* the residue of a **failed** `script npm install` — a successful run
deletes it. It survives in the working tree unnoticed because `.gitignore` has `*.log`.

Reproduced exactly, running the bundled npm the way `nsNPMCommand` runs it, against a copy of this repo's
`node_modules`:

```
npm ERR! Cannot read properties of null (reading 'edgesOut')
```

Stack, from the npm log:

```
TypeError: Cannot read properties of null (reading 'edgesOut')
    at #loadPeerSet   (.../@npmcli/arborist/lib/arborist/build-ideal-tree.js:1302:38)
    at #buildDepStep  (.../build-ideal-tree.js:917:11)
    at Arborist.buildIdealTree (.../build-ideal-tree.js:196:7)
...
verbose unfinished npm timer idealTree:node_modules/.pnpm/pure-rand@8.4.2/node_modules/pure-rand
```

**Cause:** npm's arborist walks the existing `node_modules` to build the ideal tree, descends into pnpm's
virtual store `node_modules/.pnpm/**`, and hits a peer-resolution edge it has no node for. pnpm's layout
is a symlink farm plus a `.pnpm` store; the bundled npm has no concept of it. This is not fixable by ordering or
flags — the two package managers disagree about what `node_modules` *is*.

So on this machine the button has never done anything except leave a log file behind.

---

## 4. And it would be wrong even if it worked

Three separate problems, independent of the pnpm crash.

**It installs devDependencies.** `npm install` with no flags installs both dependency sets. Against a
clean tree holding only our `package.json`:

```
added 77 packages
```

against the 13 top-level entries a `--prod` install produces. That drags in `typescript`, `effect`, and
`@types/node` — the `scripts/refs.ts` tooling, which has no business inside a device.

**It warns on engines it cannot satisfy.** The same clean install:

```
npm WARN EBADENGINE   package: 'undici@8.10.1',
npm WARN EBADENGINE   required: { node: '>=22.19.0' },
npm WARN EBADENGINE   current: { node: 'v20.6.1', npm: '9.8.1' }
```

`undici` arrives via `@effect/platform-node`, a devDependency, and wants a Node newer than the one Live 12
Suite ships — still true on the v22.18.0 binary, which misses `>=22.19.0` by a patch. A user clicking this button gets warnings about a package the device never loads.

**In `dist/` it silently undoes the build.** `pnpm build:dist` produces a prod-only, flat (hoisted) tree:
9.2 MB, 13 top-level entries. Running the same command there:

```
added 49 packages
```

Those 49 are the devDependencies coming back — 9.2 MB → ~116 MB, in the folder you are about to freeze.
The button survives into `dist/liveql.amxd` because `build:dist` copies the device verbatim. So the one
place it is most likely to get clicked by mistake is the one place it does the most damage.

`script npm ci` is not an escape hatch either. It needs a `package-lock.json`, and this repo has
`pnpm-lock.yaml`:

```
npm ERR! code EUSAGE
npm ERR! The `npm ci` command can only install with an existing package-lock.json or
npm ERR! npm-shrinkwrap.json with lockfileVersion >= 1.
```

---

## 5. Where the button came from, and why it does not apply to us

The pattern is verbatim out of Cycling '74's own vignette, `02_n4m_usingnpm.maxvig.xml`:

> This can be useful for distributing a Max patch with Node dependencies. You shouldn't need to distribute
> the node_modules directory, since anyone with an internet connection can regenerate that folder and its
> contents by running `script npm install`. **If you look at a few Node for Max projects, you will
> probably encounter a Max patch with a button `script npm install` and a comment like "You only need to
> push this once."** That's because the patch includes a package.json or package-lock.json, but still
> needs to install its dependencies.

That is our comment, near-word-for-word. But the same vignette carves out the exception, twice:

> **There is an exception: you should include node_modules in any Standalone, Collective or frozen Max for
> Live Device.**

> There is one exception to this rule, which is when working with a Standalone Application, a Max
> Collective, or a frozen Max for Live Device. In these cases, you will want to indicate that the contents
> of node_modules should be included in whatever you export from Max.

We are the exception. Our distribution model is the frozen device
(`README.md` → "Productionizing the device"; `docs/node-for-max-runtime-research.md` §8), where
`node_modules` is bundled *into* the `.amxd` via a Max Project search-path entry with **Embedded**
enabled. There is nothing for an end user to install, and no folder for npm to install it into.

And the bundling vignette, `03_n4m_projects_devices.maxvig.xml`, explicitly ends the button's life once
dependencies exist:

> Once done you should find a node_modules folder and a package-lock.json in the node_content folder and
> **can remove the message from the patcher.**

So: Cycling '74 recommends the button for *unfrozen* patch distribution, and recommends deleting it for
the *frozen/bundled* path. We are on the frozen path.

---

## 6. Who installs what, in each of the three situations

| Situation | Who needs `node_modules` | Who provides it | Button needed? |
| --- | --- | --- | --- |
| Dev, this repo | `node.script`, cwd = repo root | **We do**, `pnpm install` from the terminal (README step 1) | No — and it crashes if pressed (§3) |
| Build, `dist/` | the freeze operation | **`pnpm build:dist`**, prod-only hoisted install | No — and it un-does the build if pressed (§4) |
| Shipped frozen `.amxd` | the extracted script at runtime | **the frozen device itself**, deps embedded | No — nothing to install, nowhere to install it |

Every column is already covered before the device is ever loaded. There is no fourth situation in which
the button is the answer.

The only scenario that would justify keeping it is shipping **loose, unfrozen** files — `.amxd` +
`.js` + `package.json` — and asking the recipient to press it. We do not do that, it is not what the
README describes, and making it work would require adding a `package-lock.json` and moving the refs
tooling out of `devDependencies` (or out of this `package.json` entirely).

---

## 7. Recommendation

**Remove `obj-14` and `obj-38`, and the `obj-14 → obj-3` patchline.**

In the Max editor: unlock `liveql.amxd`, select the `script npm install` message box and the
"Just once, you'll need to npm install" comment, delete, save. The patchline goes with the box.

Risk is as close to zero as patcher edits get: no other box connects to either, neither is a device
parameter, and `node.script`'s `npm` message handler is untouched — anyone who genuinely wants to run it
once can still type the message into an unlocked copy of the patch.

Side effects, both wanted:

- The device narrows by ~190px in Live (§1).
- `dist/liveql.amxd` inherits the removal on the next `pnpm build:dist`, since the build copies the
  device.

### Loose ends this surfaced

- `npm-debug-u70453400004.log` in the repo root is dead residue of the failed run. Delete it.
- `docs/m4l-amxd-research.md:174` still lists **"Click the `script npm install` message box"** as a
  required setup step, contradicting `README.md` step 1 (`pnpm install`) and
  `docs/node-for-max-runtime-research.md` §7a ("Never use Max's `script npm install`"). Fix or drop it.
- `docs/m4l-amxd-research.md:34` claims the device has a `script npm --version` box. It does not — the
  current patch has only `script npm install`. Stale.
- Unrelated but adjacent, already documented in `docs/node-for-max-runtime-research.md` §7b: the shipped
  device should be `@watch 0`, not `@watch 1`.

---

## Appendix: how this was verified

```bash
N4M="/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/Contents/Resources/C74/packages/Node for Max"

# Decode the patcher JSON out of the .amxd (32-byte chunk header, then JSON)
tail -c +33 liveql.amxd > patcher.json
python3 -c "import json;d=json.JSONDecoder();o,_=d.raw_decode(open('patcher.json').read());
print([(b['box']['id'], b['box'].get('text')) for b in o['patcher']['boxes']])"

# Reproduce the pnpm crash, the way nsNPMCommand spawns npm
mkdir repro && cp package.json pnpm-lock.yaml liveql-n4m.js repro/ && cp -Rc node_modules repro/
cd repro && PATH="$N4M/source/bin/osx/npm:$N4M/source/bin/osx/npx:$N4M/source/bin/osx/node:$PATH" \
  "$N4M/source/bin/osx/npm/npm" install --dry-run --scripts-prepend-node-path=true
# => npm ERR! Cannot read properties of null (reading 'edgesOut')

# What a clean install would pull in
mkdir clean && cp package.json clean/ && cd clean
"$N4M/source/bin/osx/npm/npm" install --dry-run --scripts-prepend-node-path=true   # added 77 packages + EBADENGINE
"$N4M/source/bin/osx/npm/npm" ci --dry-run                                         # EUSAGE, no package-lock.json

# What it would do to a built dist/
cp -Rc dist distrepro && cd distrepro
"$N4M/source/bin/osx/npm/npm" install --dry-run --scripts-prepend-node-path=true   # added 49 packages

# Versions in play (2026-09-01; v20.6.1 / 9.8.1 when the runs above were captured)
"$N4M/source/bin/osx/node/node" --version   # v22.18.0
"$N4M/source/bin/osx/npm/npm"   --version   # 10.9.3
```

| Claim | Source |
| --- | --- |
| `script npm` runs npm in the script's folder | `$N4M/docs/refpages/node.script.maxref.xml:145-148` |
| npm cwd = script folder | `$N4M/source/lib/nsNPMCommand.js:38`, spawn at `:146-165` |
| `npm-debug-<id>.log` written to cwd, removed only on success | `$N4M/source/lib/nsNPMCommand.js:42, 107-119, 265-268` |
| the "push this once" button idiom, and the frozen-device exception | `$N4M/docs/vignettes/02_n4m_usingnpm.maxvig.xml` |
| "can remove the message from the patcher"; Embedded search path bundling | `$N4M/docs/vignettes/03_n4m_projects_devices.maxvig.xml` |
| our frozen distribution model | `README.md` "Productionizing the device"; `docs/node-for-max-runtime-research.md` §8 |
| prior "never use `script npm install`" finding | `docs/node-for-max-runtime-research.md` §7a |
| why the old `node.script .` npm subpatcher was removed | `docs/archive/node-script-dot-error-research.md` |
