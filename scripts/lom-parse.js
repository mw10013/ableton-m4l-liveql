const fs = require("node:fs");
const path = require("node:path");

/**
 * Parses the Live Object Model reference (one Markdown page per class) into
 * `lom.json`, which `liveql-n4m.js` builds its schema from. Dev only: the
 * device reads the committed `lom.json`, never the docs. Each `### name type`
 * heading under `## Children`, `## Properties` or `## Functions` is a member,
 * with its `Access:` line split into a list. A property typed by a link to a
 * class page is a child, which is how `Song.appointed_device [Device]` reads.
 * Raw doc types are kept as written (`bool`, `long`, `dict/bang`); mapping
 * them to GraphQL is the schema builder's job. Function parameters come from
 * the code spans after a `Parameter:` line, each with the `[type]` that follows
 * it if any; the docs describe some only in prose, so a parameter may come out
 * with no type, which the builder treats as unresolved. Inheritance is prose
 * ("is a type of Device", "has all the properties ... of a Device"), so a
 * parent is the first other class that sentence names.
 *
 *   pnpm lom:parse [lom dir]
 */
const dir =
  process.argv[2] ??
  path.join(__dirname, "..", "..", "m4l-docs", "apiref", "lom");

const pages = Object.fromEntries(
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")])
    .map(([f, text]) => [
      f,
      { text, title: /^# (?<title>.+)$/mu.exec(text)?.groups.title.trim() },
    ])
    .filter(([, { title }]) => /^[A-Z]/u.test(title ?? "")),
);

const className = (title) => title.replaceAll(".", "");
const classOfLink = (file) =>
  pages[file] ? className(pages[file].title) : null;
const unlink = (s) =>
  s.replaceAll(/\[(?<text>[^\]]+)\]\([^)]*\)/gu, "$<text>").trim();
const accessOf = (body) =>
  /^Access:\s*(?<access>.+)$/mu
    .exec(body)
    ?.groups.access.split(",")
    .map((a) => a.trim())
    .filter(Boolean) ?? [];

function parentOf(text, title) {
  const intro = text.split(/^## /mu)[0];
  const sentence =
    /(?:[^.]|\.\S)*\b(?:is a type of|has all|shares all)\b(?:[^.]|\.\S)*/iu.exec(
      intro,
    )?.[0];
  if (!sentence) return null;
  const titles = Object.values(pages)
    .map((p) => p.title)
    .filter((t) => t !== title)
    .toSorted((a, b) => b.length - a.length);
  const hits = titles
    .map((t) => ({
      t,
      at: sentence.search(
        new RegExp(
          `\\b${t.replaceAll(".", String.raw`\.`)}(?!\\w|\\.\\w)`,
          "iu",
        ),
      ),
    }))
    .filter(({ at }) => at !== -1)
    .toSorted((a, b) => a.at - b.at || b.t.length - a.t.length);
  return hits[0] ? className(hits[0].t) : null;
}

/**
 * The parameter lines are the `Parameter:` line and the lines straight after
 * it that open with a code span, blank lines aside; a `` `key` : [type] ``
 * line documents a key of a dictionary argument, not an argument, and is
 * skipped.
 */
function paramsOf(body) {
  const lines = body.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => /^Parameters?\b/u.test(l));
  if (start === -1) return [];
  const headerOptional = /^Parameters? \(optional\)/u.test(lines[start]);
  const rest = lines.slice(start + 1).filter(Boolean);
  const end = rest.findIndex(
    (l) => !l.startsWith("`") || /^`[^`]+`\s*:/u.test(l),
  );
  const text = [
    lines[start].replace(/^[^:]*:?/u, ""),
    ...rest.slice(0, end === -1 ? rest.length : end),
  ].join(" ");
  const params = [];
  for (const { groups } of text.matchAll(
    /(?:`(?<name>[^`]+)`)?\s*(?:\[(?<type>[^\]]+)\](?:\([^)]*\))?)?(?<optional>\s*\(optional\))?/gu,
  )) {
    if (!groups.name && !groups.type) continue;
    const raw = groups.name ?? null;
    const name = raw?.replace(/\s*\(optional\)$/u, "") ?? null;
    const optional = headerOptional || Boolean(groups.optional) || raw !== name;
    const seen = params.find((p) => p.name !== null && p.name === name);
    if (seen) {
      seen.type ??= groups.type ?? null;
      seen.optional ||= optional;
    } else if (name !== null || groups.type)
      params.push({ name, type: groups.type ?? null, optional });
  }
  return params;
}

function returnsOf(body) {
  const lines = body.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /^Returns\b/u.test(l));
  if (at === -1) return null;
  const line = /^Returns:?$/u.test(lines[at])
    ? `${lines[at]} ${lines[at + 1] ?? ""}`
    : lines[at];
  return (
    /\[(?<type>[^\]]+)\]/u.exec(line)?.groups.type ??
    lines[at].replace(/^Returns:?\s*/u, "").trim()
  );
}

function parseClass({ text, title }) {
  const cls = {
    parent: parentOf(text, title),
    children: {},
    properties: {},
    functions: {},
  };
  let section = null;
  for (const block of text.split(/^(?=##+ )/mu)) {
    if (block.startsWith("## ")) {
      section = /^## (?<section>.+)$/mu.exec(block).groups.section.trim();
      continue;
    }
    const heading = /^### (?<name>\S+)[ \t]*(?<typeMd>.*)$/mu.exec(block);
    if (!heading) continue;
    const { name, typeMd } = heading.groups;
    const body = block.slice(heading[0].length);
    if (section === "Functions") {
      cls.functions[name] = {
        params: paramsOf(body),
        returns: returnsOf(body),
      };
      continue;
    }
    if (section !== "Children" && section !== "Properties") continue;
    const link = /\]\((?<file>[a-z0-9_]+\.md)/u.exec(typeMd)?.groups.file;
    const child = link ? classOfLink(link) : null;
    if (child)
      cls.children[name] = {
        type: child,
        list: /^list of\b/u.test(typeMd.trim()),
        access: accessOf(body),
      };
    else
      cls.properties[name] = {
        type: unlink(typeMd) === "" ? null : unlink(typeMd),
        access: accessOf(body),
      };
  }
  return cls;
}

fs.writeFileSync(
  path.join(__dirname, "..", "lom.json"),
  `${JSON.stringify(
    Object.fromEntries(
      Object.values(pages)
        .toSorted((a, b) => a.title.localeCompare(b.title))
        .map((page) => [className(page.title), parseClass(page)]),
    ),
    null,
    2,
  )}\n`,
);
