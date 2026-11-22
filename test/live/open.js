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
 * folder into `checkoutDir`, rewrites both values in every `FileRef` naming
 * `liveql.amxd`, and hands the copy to Live. The committed Set is never
 * touched, and rerunning overwrites the same copy.
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
  const target = path.join(checkoutDir, path.basename(project));
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
}

if (require.main === module) {
  open(
    path.resolve(
      process.argv[2] ?? path.join(__dirname, "fixture Project/fixture.als"),
    ),
  );
}

module.exports = { checkoutDir, root };
