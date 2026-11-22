const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

/**
 * Opens a Live Set whose LiveQL device loads from this checkout, so each
 * checkout (main or a worktree) tests its own scripts. A Set references a Max
 * device by file, not by content: the device `FileRef` carries `RelativePath`
 * (from the Project folder) and an absolute `Path`, and a committed Set points
 * them at whichever checkout last saved it. This copies the Set's Project
 * folder into a fresh run folder under `checkoutDir`, rewrites both values
 * in every `FileRef` naming `liveql.amxd`, and hands the copy to Live. The
 * committed Set is never touched. Each run gets its own folder so the copy's
 * `file_path` differs from the Set it replaces, even when that was the same
 * fixture, and `openedSet` tells `test:live` which Set it should find open.
 *
 *   pnpm live:open [path/to/set.als]      (defaults to the fixture Set)
 *
 * Paths are real paths: macOS's temp dir is a symlink into `/private`, and Live
 * reports a Set's `file_path` resolved, so `test:live` can compare against it.
 */
const root = fs.realpathSync(path.resolve(__dirname, "../.."));
const checkoutDir = path.join(
  fs.realpathSync(os.tmpdir()),
  "liveql-live",
  `${path.basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`,
);

const escapeXml = (s) =>
  s.replaceAll(/[&<>"]/gu, (c) => `&#${c.codePointAt(0)};`);

const setValue = (fileRef, tag, value) =>
  fileRef.replace(
    new RegExp(`<${tag} Value="[^"]*" />`, "u"),
    () => `<${tag} Value="${escapeXml(value)}" />`,
  );

function open(source) {
  const project = path.dirname(source);
  if (!path.basename(project).endsWith(" Project")) {
    throw new Error(`${source} is not directly inside a Live Project folder`);
  }
  const amxd = path.join(root, "liveql.amxd");
  const target = path.join(
    checkoutDir,
    String(Date.now()),
    path.basename(project),
  );
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  fs.cpSync(project, target, {
    recursive: true,
    filter: (f) => path.basename(f) !== "Backup",
  });

  let count = 0;
  const xml = zlib
    .gunzipSync(fs.readFileSync(source))
    .toString("utf8")
    .replaceAll(/<FileRef>[\s\S]*?<\/FileRef>/gu, (fileRef) => {
      if (!/<Path Value="[^"]*\/liveql\.amxd" \/>/u.test(fileRef))
        return fileRef;
      count += 1;
      return setValue(
        setValue(fileRef, "RelativePath", path.relative(target, amxd)),
        "Path",
        amxd,
      );
    });
  if (count === 0) {
    throw new Error(`no LiveQL device FileRef in ${source}`);
  }

  const set = path.join(target, path.basename(source));
  fs.writeFileSync(set, zlib.gzipSync(xml));
  console.log(`live:open: ${count} LiveQL device(s) -> ${amxd}\n  ${set}`);
  execFileSync("open", ["-a", "Ableton Live 12 Suite", set]);
  dismissSavePrompt(path.basename(set, ".als"));
}

/**
 * Switching Sets makes Live ask "Save changes to ... before closing?" whenever
 * the open Set has unsaved changes, and undoing back to the start does not
 * clear that. The copy is throwaway, so this answers Don't Save. Live draws
 * the dialog itself: accessibility sees an `AXDialog` with no buttons, and it
 * ignores keystrokes, so this clicks by position. Don't Save is the bottom-left
 * button, 66 points from the dialog's left edge and 26 above its bottom; Save
 * is the default, so Return would be wrong. Live only takes the click when the
 * pointer moves onto the button first. The script returns once Live's window is
 * titled after the new Set, but not in the first 3 seconds, since reopening
 * the fixture over itself keeps the title while the prompt is still coming;
 * it gives up after 30 seconds.
 *
 * It needs Accessibility permission for the app running this (System Settings
 * > Privacy & Security > Accessibility). Without it, click Don't Save by hand.
 */
function dismissSavePrompt(setName) {
  const script = `
    ObjC.import("CoreGraphics");
    const live = Application("System Events").processes.byName("Live");
    const click = (x, y) => {
      const p = $.CGPointMake(x, y);
      for (const type of [$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, p, $.kCGMouseButtonLeft));
        delay(0.15);
      }
    };
    let result = "timeout";
    for (let i = 0; i < 60 && result === "timeout"; i++) {
      const windows = live.windows();
      if (i >= 6 && windows.some((w) => w.subrole() === "AXStandardWindow" && w.name() === ${JSON.stringify(setName)})) result = "open";
      const dialog = windows.find((w) => w.subrole() === "AXDialog");
      if (dialog) {
        live.frontmost = true;
        const [x, y] = dialog.position();
        const [, h] = dialog.size();
        click(x + 66, y + h - 26);
        result = "dismissed";
      }
      delay(0.5);
    }
    result;
  `;
  try {
    const result = execFileSync(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      {
        encoding: "utf8",
      },
    ).trim();
    if (result === "dismissed") console.log("live:open: answered Don't Save");
  } catch (err) {
    console.log(
      `live:open: could not answer Live's save prompt; click Don't Save if Live asks (${err.message.split("\n")[0]})`,
    );
  }
}

if (require.main === module) {
  open(
    path.resolve(
      process.argv[2] ?? path.join(__dirname, "fixture Project/fixture.als"),
    ),
  );
}

/** The Set the last `live:open` from this checkout wrote, if any. */
function openedSet() {
  const [run] = fs.existsSync(checkoutDir) ? fs.readdirSync(checkoutDir) : [];
  if (run === undefined) return undefined;
  const [project] = fs.readdirSync(path.join(checkoutDir, run));
  const dir = path.join(checkoutDir, run, project);
  const set = fs.readdirSync(dir).find((f) => f.endsWith(".als"));
  return set && path.join(dir, set);
}

module.exports = { openedSet, root };
