// Downloads reference sources into refs/, pinned to the versions this workspace
// actually depends on. Each entry names the package.json that owns the pin, so a
// dependency bump is the only edit needed -- re-running the fetch picks up the new tag.
//
//   node scripts/refs.ts fetch <name...>   fetch those refs
//   node scripts/refs.ts fetch --all       fetch every ref except the opt-in ones
//   node scripts/refs.ts check             report refs that drifted from the pins (exit 1 if any)
//   node scripts/refs.ts list              same report, without exiting non-zero

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createHash } from "node:crypto";

interface VersionSource {
  /** Workspace directory holding the pin, or 'pnpm.overrides' for the root override block. */
  readonly from: string;
  readonly dep: string;
  /**
   * Set when the pin is a `file:` tarball spec rather than a semver range, in which
   * case the version is read out of the tarball filename (`...-1.0.0-beta.1.tgz`).
   * A vendored dependency has no registry version to read, but its filename carries
   * the same one, so bumping the vendored tarball still moves the ref.
   */
  readonly fromTarballName?: boolean;
}

/**
 * A documentation site crawled into markdown with siteone-crawler, for sources that
 * only exist as web pages. The flags this produces were arrived at against the Live
 * manual; two of them are load-bearing in non-obvious ways:
 *
 * - `include` is PCRE matched against the whole absolute URL, not the path. A
 *   path-anchored regex (`^/en/...`) matches nothing, and the crawl then quietly
 *   fetches the entry page alone and exits 0 -- a failure that looks like success.
 * - Under `browser`, the tall render viewport is what makes images work. Lazy-loaded
 *   figures carry only `data-src`, so without a browser the files download but the
 *   markdown gets no `![]()` at all, and with a normal-height viewport only the first
 *   screenful of figures resolves. Rendering the page ~30000px tall puts every figure
 *   "in view" on load.
 *
 * Two things the converter does to *every* crawl, worth knowing before trusting output:
 *
 * - **Headings lose characters.** In heading lines only, `_`, `*`, `[` and `]` are each
 *   replaced by a bare `\` rather than escaped, so `cue_points` exports as `cue\points`
 *   and `number[]` as `number\\`. (`(`, `)`, `|`, `+` are escaped correctly and their
 *   `\` must be left alone.) Where an API reference names each member only in its own
 *   heading, this makes the ref ungreppable by member name -- `is_playing` went from 8
 *   hits in the HTML to 0 in the markdown. It is not repairable with crawler flags:
 *   `--replace-content` does not reach the conversion, and `--markdown-replace-content`
 *   cannot match a literal backslash. Repair after the crawl, using what follows the
 *   closing `\` to disambiguate: `\1\` before a space is a type annotation (`number[4]`),
 *   before a word char it is an eaten pair (`mod_matrix_source_1_index`); `\\` between
 *   word chars is `__str__`, elsewhere an empty `[]`.
 * - **Inline `<svg>` is dropped silently**, leaving the surrounding prose intact, so a
 *   page can lose its only diagram with nothing in the output to say so.
 */
interface Crawl {
  readonly url: string;
  /** PCRE matched against the whole absolute URL; see the note above. */
  readonly include: string;
  /** Doc version this ref is pinned to. There is no package.json pin to read. */
  readonly version: string;
  /**
   * Render each page in Chromium before converting it. Needed only when the served
   * HTML is not already what you want -- lazy-loaded figures, or links that exist
   * only after JS runs. It costs roughly 20s per page against ~0.3s for plain HTTP,
   * so it turns a ten-minute crawl into an overnight one; leave it off and check the
   * output rather than switching it on speculatively.
   */
  readonly browser?: boolean;
  /**
   * PCRE patterns whose URLs are never queued. `include` cannot do this job: with
   * `--regex-filtering-only-for-pages` it gates pages only, so assets bypass it
   * entirely. Use this for per-page boilerplate assets, which are cheap individually
   * and ruinous in aggregate -- a relative `img/icon-warning.png` on every page is a
   * distinct URL per page, so six site icons became ~7900 queued URLs here.
   *
   * But `ignore` only reaches what `include` cannot when that flag is set, because the
   * flag makes *both* regex rules page-only -- so an asset escapes `ignore` too. The
   * trap is that "asset" is decided by URL shape at queue time, before any content type
   * is known: a docs page at `/reference/array.filter` reads as a `.filter` file, so it
   * bypasses both rules and lands on disk as raw HTML. On docs.cycling74.com that was
   * 185 files and 11 MB of a 13 MB ref, and no `ignore` pattern could touch it. When a
   * site has dotted extensionless page URLs, drop `--regex-filtering-only-for-pages` and
   * let `include` govern assets too (adding an arm for the image directory); `ignore` is
   * then unnecessary. Same reason a wanted dotted page cannot simply be added to
   * `include`: it downloads, but as HTML, never converted to markdown.
   */
  readonly ignore?: ReadonlyArray<string>;
  /** CSS selectors dropped before markdown conversion, e.g. site nav and footer. */
  readonly excludeSelector?: ReadonlyArray<string>;
  /** Other hosts whose assets should be downloaded, e.g. an image CDN. */
  readonly externalFileDomain?: ReadonlyArray<string>;
  /**
   * Let `include` gate assets as well as pages, by dropping
   * `--regex-filtering-only-for-pages`. Set this when the site has dotted page URLs that
   * read as filenames -- see the trap in `ignore` -- and give `include` an arm for the
   * image directory, or the crawl will fetch no images at all.
   */
  readonly filterAssetsToo?: boolean;
  /**
   * Strip query strings from discovered URLs. The crawler otherwise hashes a query string
   * into the filename, so inbound tracking parameters the site echoes into its own links
   * (`?source=post_page...`) fan one page out into many `index.<hash>.md` near-duplicates
   * -- 21 pages became 101 here. Harmless when a site has none.
   */
  readonly removeQueryParams?: boolean;
  /**
   * PCRE patterns for pages saved as raw HTML because their URL read as a filename (the
   * `ignore` trap), converted to markdown after the crawl. Matched against the staged
   * path, not the URL.
   */
  readonly convertAssetPages?: ReadonlyArray<string>;
  /**
   * An inline `<svg>` figure to rescue, since the converter drops those silently.
   * Extracted from `page`, written under `_assets/`, and linked into the markdown of the
   * page it came from. A Figma-exported diagram typically has no `<text>` -- labels are
   * outlined paths -- so it is unreadable as source and unsearchable; `png` renders it to
   * something legible, and `tree` writes the object graph out as text, which is the form
   * a grep actually reaches.
   */
  readonly inlineFigure?: {
    readonly page: string;
    /** Matched against each `<svg ...>` open tag to pick the figure out of the site chrome. */
    readonly match: string;
    readonly into: string;
    /** CSS custom properties to inline, since the figure renders blank without the page. */
    readonly cssVars?: Readonly<Record<string, string>>;
    /** Also rasterise, when `magick` is on PATH. */
    readonly png?: boolean;
  };
  /**
   * Scrape the documented product version off one page for the stamp, the way a Fluid
   * Topics fetch reports the version the portal gave it. For sites that serve one live
   * version at unversioned URLs, where the only version marker is in the prose.
   */
  readonly versionFrom?: { readonly page: string; readonly pattern: string };
}

/**
 * A Fluid Topics documentation portal, read through its public JSON API instead of
 * crawled. Tenants on this platform (steinberg.help among them) serve browsers a ~2.6KB
 * JS application shell with no content in it, so a crawl gets nothing without rendering,
 * and rendering thousands of DITA topics would take most of a day. The unauthenticated
 * API under `/api/khub` hands over the same content in minutes.
 *
 * Three things about it are load-bearing and not guessable from the field names:
 *
 * - Map ids are content hashes, not slugs. The same manual gets a new id on every
 *   republish and two versions of one manual have unrelated ids, so a map has to be
 *   located by title, version and locale at fetch time. Matching zero maps or several
 *   is a hard failure: silently taking the wrong one yields a complete, plausible,
 *   wrong manual.
 * - Topic bodies inline their figures as base64 `data:` URIs, and those are ~98% of the
 *   bytes. They have to be extracted to files before conversion -- left alone they pass
 *   straight through into the markdown, and one topic becomes a 400KB `.md` that
 *   poisons every grep over the ref.
 * - Cross-references are `<span data-tocid=...>`, not `<a href>`. Every markdown
 *   converter flattens them to plain text, so without a rewrite the ref silently loses
 *   all of its navigation -- and in this content they outnumber real `<a>` tags roughly
 *   60 to 1. The TOC is the lookup table that turns them back into links.
 */
interface FluidTopics {
  /** Portal origin, e.g. `https://www.steinberg.help`. */
  readonly tenant: string;
  /**
   * Doc version this ref is pinned to, matched as a prefix against each map's `version`
   * metadata. Deliberately loose: the tenant reports maintenance releases (`15.0.30`)
   * that a `15.0` pin should follow rather than report as drift. The exact version that
   * matched is written to the stamp.
   */
  readonly version: string;
  /** Locale prefix, matched against each map's `ft:locale` metadata. */
  readonly locale: string;
  /** Maps to pull, by exact `title`, each into its own directory under the ref. */
  readonly maps: ReadonlyArray<{ readonly title: string; readonly into: string }>;
}

interface Ref {
  readonly name: string;
  /** GitHub repo to download from; omitted for refs copied out of `dir`. */
  readonly repo?: string;
  /**
   * Directory to copy instead of downloading, relative to the repo root; {v} is the
   * resolved version. For sources that only exist on this machine -- a vendor's zip
   * distribution unpacked beside the repo -- with no upstream URL to fetch.
   */
  readonly dir?: string;
  /**
   * Entries to leave behind when copying from `dir`, matched against the end of the
   * name so a whole extension can be excluded without spelling out versioned filenames.
   */
  readonly exclude?: ReadonlyArray<string>;
  /**
   * Tag template for versioned refs; {v} is the resolved version. A tag with no {v} is
   * a fixed pin kept in this file, for a source with no package.json version to read.
   */
  readonly tag?: string;
  readonly version?: VersionSource;
  /** Branch to track, for refs with no version to align to. */
  readonly branch?: string;
  /** Private repos are fetched through `gh api`, which carries your auth. */
  readonly private?: boolean;
  /** Site to crawl into markdown, instead of a repo tarball or a local dir. */
  readonly crawl?: Crawl;
  /** Fluid Topics portal to read through its JSON API, instead of crawling it. */
  readonly fluidTopics?: FluidTopics;
  /**
   * Skipped by `fetch --all`, so it has to be named explicitly. For refs whose fetch
   * is slow enough or outward-facing enough that folding it into the bulk command
   * would be a surprise -- a multi-minute crawl of someone else's live server, say.
   */
  readonly optIn?: boolean;
}

const REFS: ReadonlyArray<Ref> = [
  {
    name: "effect",
    repo: "Effect-TS/effect",
    tag: "effect@{v}",
    // This script is the only thing here that depends on effect, so the root
    // devDependency is the pin -- there is no workspace to override it.
    version: { from: ".", dep: "effect" },
  },
  {
    name: "graphql",
    // graphql-js: the reference implementation the server actually executes against,
    // so the source is the answer to what a resolver signature or an error shape is.
    repo: "graphql/graphql-js",
    tag: "v{v}",
    version: { from: ".", dep: "graphql" },
  },
  {
    name: "graphql-yoga",
    repo: "dotansimha/graphql-yoga",
    tag: "graphql-yoga@{v}",
    version: { from: ".", dep: "graphql-yoga" },
  },
  {
    name: "graphql-spec",
    repo: "graphql/graphql-spec",
    // The edition graphql-js 16 implements, and the one its own documentation links to
    // throughout (`spec.graphql.org/October2021/#sec-...`). Deliberately not the working
    // draft: the draft is where the 17 line is heading, so on anything the two disagree
    // about -- incremental delivery, the newer error semantics -- it would describe a
    // runtime this project does not have. Bump alongside the `graphql` dependency, whose
    // major picks the edition: 17 lands on September2025.
    tag: "October2021",
  },
  {
    name: "graphql-docs",
    // Crawled rather than downloaded. The `source` branch of graphql.github.io is 599 MB,
    // and 2.3 MB of that is the documentation: `src/app/conf` alone is 309 MB of
    // GraphQLConf speaker photos, `public/img` another 160 MB. The rendered site carries
    // the same prose in ~5 MB with the conference site left behind.
    crawl: {
      // Seeded on /learn/ rather than the site root: the root is a marketing page whose
      // links reach the conference, the blog, the foundation and the library directory,
      // none of which `include` wants and all of which would have to be spelled out as
      // exclusions instead.
      url: "https://graphql.org/learn/",
      // The conceptual documentation plus the FAQ. Everything else on the host is
      // community or event material. `(/|$)` because the site links `/faq` and `/faq/`
      // interchangeably.
      //
      // Notably absent is `/graphql-js/`, which looks like it belongs here and does not:
      // it is a redirect to www.graphql-js.org, a separate host that a single-seed crawl
      // cannot follow. That is the `graphql-js-docs` ref below.
      include: String.raw`^https://graphql\.org/(learn|faq)(/|$)`,
      // graphql.org publishes one live edition at unversioned URLs, tracking the current
      // spec release. Nothing to bump, so `refs check` only ever reports this ref's age.
      version: "unversioned",
      // Required here, unlike every other crawl in this file. The worked examples that
      // carry most of /learn/ -- the query, its response, the SDL beside it -- are
      // CodeMirror panes hydrated on the client: the served HTML has the "Operation" and
      // "Response" labels around an empty `<div class="result-window">`. Without
      // rendering, the crawl still exits 0 and every page still reads as prose, with
      // "in the following query:" leading into nothing. Cheap here despite the JSDoc's
      // warning -- 31 pages, and this site renders in well under a second each.
      browser: true,
      // Nextra chrome: `nav` is the navbar, the section tabs and the per-page table of
      // contents; `aside` the sidebar, which repeats the whole section index on every
      // page. `header` is deliberately not in this list -- on graphql.org's own pages it
      // wraps section copy, not site furniture, so excluding it deletes prose.
      excludeSelector: [
        "nav",
        "aside",
        "footer",
        // Nextra puts an empty permalink `<a>` inside every heading; left in, each one
        // trails "Permalink for this section" into the heading text and through to the
        // markdown TOC. Selector-anchored rather than class-anchored on purpose -- the
        // class names around it are Tailwind utilities that change with the design.
        // All six levels: these pages nest to h5, and a level left off this list fails
        // silently on the handful of pages that reach it.
        'h1 a[href^="#"]',
        'h2 a[href^="#"]',
        'h3 a[href^="#"]',
        'h4 a[href^="#"]',
        'h5 a[href^="#"]',
        'h6 a[href^="#"]',
      ],
    },
  },
  {
    name: "graphql-js-docs",
    // The graphql-js guides and API reference. Their old home, graphql.org/graphql-js,
    // now 308s to this host, and the links it serves are host-relative -- so following
    // them from a graphql.org seed resolves them against the wrong origin and every one
    // 404s. Hence a second ref rather than another arm on `graphql-docs`.
    crawl: {
      url: "https://www.graphql-js.org/docs/",
      // `api-v16` only. The site publishes v16 and v17 reference side by side, and v17 is
      // the unreleased line: its `execution` module documents incremental delivery and
      // its `graphql` module a test harness, neither of which exists in the 16.x this
      // project pins. Two references that disagree are worse than one, and grep cannot
      // tell them apart. `upgrade-guides` is left out for the same reason.
      //
      // Bump this arm and `version` below together with the `graphql` dependency.
      include: String.raw`^https://www\.graphql-js\.org/(docs|api-v16)(/|$)`,
      // Matches the major of the `graphql` pin, so moving that dependency to 17 marks
      // this copy stale. A crawl's version is a literal -- `resolve` never reads a
      // package.json for one -- so this is a hand-kept mirror of that pin, not a read of it.
      version: "16",
      // Same Nextra shell as graphql.org, minus the marketing pages: no `<header>` on any
      // page here, so the list is the site furniture and nothing else. No `browser`
      // either -- this site's code blocks are static `<pre>`, not the client-rendered
      // panes graphql.org uses.
      excludeSelector: [
        "nav",
        "aside",
        "footer",
        // Nextra puts an empty permalink `<a>` inside every heading; left in, each one
        // trails "Permalink for this section" into the heading text and through to the
        // markdown TOC. Selector-anchored rather than class-anchored on purpose -- the
        // class names around it are Tailwind utilities that change with the design.
        // All six levels: these pages nest to h5, and a level left off this list fails
        // silently on the handful of pages that reach it.
        'h1 a[href^="#"]',
        'h2 a[href^="#"]',
        'h3 a[href^="#"]',
        'h4 a[href^="#"]',
        'h5 a[href^="#"]',
        'h6 a[href^="#"]',
      ],
    },
  },
  {
    name: "m4l-docs",
    crawl: {
      // Seeded on the Live Object Model because it links to the other three sections, so
      // one seed reaches all of them.
      url: "https://docs.cycling74.com/apiref/lom/",
      // Four sections plus the image directory, and three Max objects out of `reference/`.
      // The image arm is required, not cosmetic: `filterAssetsToo` puts assets under this
      // regex, so without it the crawl fetches no images.
      //
      // `reference/` is otherwise excluded on subject grounds -- it is 1806 pages of Max
      // object documentation. `live.path`, `live.object` and `live.observer` are the
      // exception because they are how a patch actually reaches the Live API, and they
      // were the three most-linked missing targets by a wide margin.
      //
      // No comma anywhere: the crawler splits `--include-regex` on them.
      include:
        "^https://docs\\.cycling74\\.com/(userguide/m4l/|apiref/(lom|js|nodeformax)/|reference/live\\.(path|object|observer)|images/)",
      // The site serves one live version at unversioned URLs, so this is a literal that
      // only marks the copy stale when bumped; `versionFrom` records what it actually said.
      version: "12.3",
      // Page URLs like `/reference/live.path` read as `.path` files -- see `ignore`.
      filterAssetsToo: true,
      // nodeformax links carry `?source=post_page...`; 21 pages fanned out into 101 files.
      removeQueryParams: true,
      // Semantic tags only. The site is Next.js and its CSS-module class names carry build
      // hashes (`article_asideWrapper__EYa1D`) that change on every rebuild, and a stale
      // selector fails silently -- the crawl still exits 0 with the boilerplate back in.
      // `nav` is load-bearing beyond the site header: it also holds the 46-entry class
      // list that would otherwise be re-emitted as a giant table on every LOM page.
      // The anchor selectors drop the `#`-links that bleed their id into heading text.
      excludeSelector: [
        "header",
        "footer",
        "nav",
        "aside",
        'h1 a[href^="#"]',
        'h2 a[href^="#"]',
        'h3 a[href^="#"]',
      ],
      convertAssetPages: [String.raw`reference/live\.`],
      inlineFigure: {
        page: "https://docs.cycling74.com/apiref/lom/",
        // The one 1920x1080 figure, as against the site's icon sprites.
        match: 'width="1920"',
        into: "_assets/lom-overview.svg",
        // The figure is monochrome and styled entirely by these two, so it renders blank
        // without them; substituting is lossless.
        cssVars: { "--svg-bg": "#ffffff", "--svg-fg": "#111111" },
        png: true,
      },
      versionFrom: {
        page: "https://docs.cycling74.com/apiref/lom/",
        // Only the LOM index carries it, and it names the *Live* version, which is the one
        // that matters here -- the Max version appears nowhere in the prose.
        pattern: "refers to Ableton Live version ([0-9.]+)",
      },
    },
    optIn: true,
  },
];

const refNames = REFS.map((ref) => ref.name);

/** Name column for `list`/`check`, widened by whichever ref name is longest. */
const NAME_COL = Math.max(...refNames.map((name) => name.length)) + 1;

class RefsError extends Schema.TaggedError<RefsError>()("RefsError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** The `.ref.json` stamp written into each fetched copy. */
const Stamp = Schema.Struct({
  repo: Schema.optional(Schema.String),
  /** Local source directory, for refs copied rather than downloaded. */
  dir: Schema.optional(Schema.String),
  /** Entry URL, for refs crawled rather than downloaded. */
  url: Schema.optional(Schema.String),
  /** Tag, branch, or version this copy came from. */
  resolved: Schema.String,
  version: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  fetchedAt: Schema.String,
});
const StampJson = Schema.fromJsonString(Stamp, { space: 2 });

/** The slice of Fluid Topics' `/api/khub/maps` this script reads. */
const FtMaps = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      metadata: Schema.Array(
        Schema.Struct({ key: Schema.String, values: Schema.Array(Schema.String) }),
      ),
    }),
  ),
);

/**
 * A node of a map's table of contents. `contentId` is the topic id the content endpoint
 * wants, so the TOC alone is enough to fetch every body -- the separate `/topics`
 * listing carries the same ids in a 4.9MB response and is not worth downloading.
 */
interface TocNode {
  readonly tocId: string;
  readonly contentId: string;
  readonly title: string;
  /** Reader path; its basename is the DITA source filename, which becomes the anchor. */
  readonly prettyUrl: string;
  readonly children: ReadonlyArray<TocNode>;
}

const TocNode = Schema.Struct({
  tocId: Schema.String,
  contentId: Schema.String,
  title: Schema.String,
  prettyUrl: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<TocNode> => TocNode)),
});

const FtToc = Schema.fromJsonString(Schema.Array(TocNode));

/** The slice of a package.json this script reads. */
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    pnpm: Schema.optional(
      Schema.Struct({
        overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
);

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const here = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.join(path.dirname(here), "..");
});

const readManifest = Effect.fn(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => new RefsError({ reason: `no package.json at ${manifestPath}` })));
  return yield* Schema.decodeEffect(Manifest)(text);
});

/** A range would make the ref ambiguous -- there is no single tag to fetch. */
const assertExact = (version: string, source: VersionSource) =>
  /^\d/u.test(version)
    ? Effect.succeed(version)
    : new RefsError({
        reason: `${source.dep} in ${source.from} is a range (${version}); pin it exactly`,
      });

/** Read the version back out of a `file:` pin, e.g. `file:../x/foo-1.0.0-beta.1.tgz`. */
const versionFromTarballName = (spec: string, source: VersionSource) => {
  const version = /-(?<version>\d[^/]*)\.tgz$/u.exec(spec)?.groups?.version;
  return version === undefined
    ? new RefsError({
        reason: `${source.dep} in ${source.from} is not a versioned tarball spec (${spec})`,
      })
    : Effect.succeed(version);
};

/** Resolve a ref's version from whichever manifest owns the pin. */
const resolveVersion = Effect.fn(function* (source: VersionSource) {
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  if (source.from === "pnpm.overrides") {
    const manifest = yield* readManifest(path.join(root, "package.json"));
    const version = manifest.pnpm?.overrides?.[source.dep];
    if (version === undefined)
      return yield* new RefsError({ reason: `${source.dep} is not in root pnpm.overrides` });
    return yield* assertExact(version, source);
  }
  const manifest = yield* readManifest(path.join(root, source.from, "package.json"));
  const version = manifest.dependencies?.[source.dep] ?? manifest.devDependencies?.[source.dep];
  if (version === undefined)
    return yield* new RefsError({ reason: `${source.dep} is not a dependency of ${source.from}` });
  return yield* source.fromTarballName
    ? versionFromTarballName(version, source)
    : assertExact(version, source);
});

interface Resolved {
  readonly ref: Ref;
  /** The tag or branch to fetch, or the version to copy. */
  readonly target: string;
  readonly version?: string;
  readonly source?: string;
}

const resolve = Effect.fn(function* (ref: Ref) {
  if (ref.branch) return { ref, target: ref.branch };
  // A crawl's version is a literal in this file rather than a package.json pin, so it
  // is the target directly. Leaving `version` unset puts the ref on the age-reported
  // path in `checkRefs`, which is what we want: bumping the literal marks the old copy
  // stale, and until then only its age says anything.
  if (ref.crawl) return { ref, target: ref.crawl.version };
  // Same reasoning for an API-read ref: the pin is a literal here, not a package.json
  // range. The exact version the portal reported goes in the stamp, not in the target,
  // so a maintenance release refreshes quietly instead of reading as drift.
  if (ref.fluidTopics) return { ref, target: ref.fluidTopics.version };
  // A tag with no {v} names itself -- a fixed pin in this file rather than a read of a
  // package.json. Reported as `ok <tag>` rather than by age, unlike a branch or a crawl:
  // a tag's content does not move, so only editing the pin can make the copy stale.
  if (ref.tag && !ref.version && !ref.tag.includes("{v}"))
    return { ref, target: ref.tag, version: ref.tag };
  if (!ref.version || !(ref.tag ?? ref.dir))
    return yield* new RefsError({
      reason: `${ref.name} needs either a branch or a version plus a tag or dir`,
    });
  const version = yield* resolveVersion(ref.version).pipe(
    Effect.mapError((error) =>
      error instanceof RefsError ? error : new RefsError({ reason: error.message }),
    ),
  );
  return {
    ref,
    // A local ref has no tag to name the copy, so the version is the target itself.
    target: ref.tag?.replace("{v}", version) ?? version,
    version,
    source: `${ref.version.from} ${ref.version.dep}`,
  };
});

const readStamp = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const stampPath = path.join(root, "refs", name, ".ref.json");
  if (!(yield* fs.exists(stampPath))) return undefined;
  return yield* Schema.decodeEffect(StampJson)(yield* fs.readFileString(stampPath));
});

/** Download the ref's tarball from GitHub and extract it into staging. */
const downloadInto = Effect.fn(function* (staging: string, ref: Ref, repo: string, target: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tarball = ref.private
    ? ChildProcess.make("gh", ["api", `repos/${repo}/tarball/${target}`], {
        stderr: "inherit",
      })
    : // GitHub's archive URLs are namespaced by git ref type, so a branch lives under
      // refs/heads and a tag under refs/tags; using the wrong one is a plain 404.
      ChildProcess.make(
        "curl",
        [
          "-fsSL",
          `https://github.com/${repo}/archive/refs/${ref.branch ? "heads" : "tags"}/${target}.tar.gz`,
        ],
        { stderr: "inherit" },
      );
  // Wire the download into tar by hand rather than with ChildProcess.pipeTo: a
  // pipeline reports only tar's exit code, and tar accepts empty input, so a
  // failed download would look like success. Checking both exit codes is the
  // `pipefail` the old bash pipeline had.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const download = yield* spawner.spawn(tarball);
      const extract = ChildProcess.make("tar", ["-xz", "-C", staging, "--strip-components=1"], {
        stderr: "inherit",
        stdin: download.stdout,
      });
      const tarExit = yield* spawner.exitCode(extract);
      const downloadExit = yield* download.exitCode;
      if (downloadExit !== 0 || tarExit !== 0) {
        return yield* new RefsError({
          reason: `download of ${target} failed (exit ${downloadExit || tarExit})`,
        });
      }
    }),
  );
});

// https://github.com/janreges/siteone-crawler
/** GET a URL as text, naming it when it fails. */
const httpGet = Effect.fn(function* (url: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    },
    catch: (error) =>
      new RefsError({
        reason: `GET ${url} failed -- ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
});

const CRAWLER = "siteone-crawler";

/**
 * Hoist cross-domain assets to where the markdown actually points at them.
 *
 * The crawler stores an asset from another host under `_<host>/<scheme>_/<host>/<path>`
 * but writes the link as `_<host>/<path>`, so every reference to one lands a directory
 * tree away from its file. Nothing errors -- the files are all there and the links all
 * look plausible -- they just resolve to nothing, so the miss only shows up if you
 * follow a link rather than count them.
 */
const flattenExternalAssets = Effect.fn(function* (staging: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs.readDirectory(staging)) {
    // Only the `_<host>` directories hold foreign assets; `en`, `de` and friends are pages.
    if (!entry.startsWith("_")) continue;
    const hostDir = path.join(staging, entry);
    for (const scheme of yield* fs.readDirectory(hostDir)) {
      const nested = path.join(hostDir, scheme, entry.slice(1));
      if (!scheme.endsWith("_") || !(yield* fs.exists(nested))) continue;
      for (const child of yield* fs.readDirectory(nested))
        yield* fs.rename(path.join(nested, child), path.join(hostDir, child));
      yield* fs.remove(path.join(hostDir, scheme), { recursive: true });
    }
  }
});

/** Every file under `dir`, walked iteratively so the effect stays non-recursive. */
const allFiles = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const out: Array<string> = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []))) {
      const full = path.join(current, entry);
      const type = yield* fs.stat(full).pipe(
        Effect.map((s) => s.type),
        Effect.orElseSucceed(() => "Other" as const),
      );
      if (type === "Directory") pending.push(full);
      else out.push(full);
    }
  }
  return out;
});

/**
 * Undo the converter's heading mangling -- see the `Crawl` JSDoc for what it does and why
 * no crawler flag can fix it. Order matters, and the ambiguity is resolved by what follows
 * the closing `\`: the same `\1\` is a type annotation before a space and an eaten `_1_`
 * before a word char. Verified against the live HTML for every page of the Cycling '74
 * ref: 1761 of 1761 headings recovered exactly.
 */
const repairHeading = (line: string) =>
  line.startsWith("#")
    ? line
        .replaceAll(/\\\\(?<name>\w+)\\\\/gu, "__$<name>__")
        .replaceAll(String.raw`\\`, "[]")
        .replaceAll(/\\(?<inner>[^\\|]*[ ,][^\\|]*)\\(?=[ \t]|$)/gu, "[$<inner>]")
        .replaceAll(/\\(?<word>\w+)\\(?=[ \t]|$)/gu, "[$<word>]")
        .replaceAll(/\\(?=[A-Za-z0-9])/gu, "_")
        .replaceAll(/\\(?=[ \t]|$)/gu, "_")
    : line;

/**
 * Run the heading repair over a finished crawl. Unconditional: the mangling is a converter
 * bug, not a property of any one site, so every crawled ref is exposed to it.
 */
const repairCrawledMarkdown = Effect.fn(function* (staging: string) {
  const fs = yield* FileSystem.FileSystem;
  let repaired = 0;
  for (const file of (yield* allFiles(staging)).filter((f) => f.endsWith(".md"))) {
    const before = yield* fs.readFileString(file);
    const after = before.split("\n").map(repairHeading).join("\n");
    if (after !== before) {
      yield* fs.writeFileString(file, after);
      repaired++;
    }
  }
  if (repaired > 0) yield* Console.log(`  repaired headings in ${repaired} file(s)`);
});

/** The crawler's converter, run over one HTML file already on disk. */
const htmlToMarkdown = Effect.fn(function* (
  from: string,
  to: string,
  excludeSelector: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exit = yield* spawner.exitCode(
    ChildProcess.make(
      CRAWLER,
      [
        `--html-to-markdown=${from}`,
        `--html-to-markdown-output=${to}`,
        ...excludeSelector.map((s) => `--markdown-exclude-selector=${s}`),
      ],
      // Silenced: this converter reports *success* on stderr, so inheriting it prints a
      // green line per file. The exit code is the signal.
      { stdout: "ignore", stderr: "ignore" },
    ),
  );
  if (exit !== 0)
    return yield* new RefsError({ reason: `converting ${from} failed (exit ${exit})` });
});

/**
 * Convert the pages the crawler mistook for assets and saved as raw HTML. They are already
 * downloaded, so this is a local conversion rather than a second fetch.
 */
const convertAssetPages = Effect.fn(function* (staging: string, crawl: Crawl) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const patterns = (crawl.convertAssetPages ?? []).map((p) => new RegExp(p, "u"));
  if (patterns.length === 0) return;
  let converted = 0;
  for (const file of yield* allFiles(staging)) {
    const rel = path.relative(staging, file);
    if (file.endsWith(".md") || !patterns.some((p) => p.test(rel))) continue;
    yield* htmlToMarkdown(file, `${file}.md`, crawl.excludeSelector ?? []);
    yield* fs.remove(file, { force: true });
    converted++;
  }
  if (converted > 0) yield* Console.log(`  converted ${converted} asset page(s) to markdown`);
});

/** Pull one `<svg>...</svg>` out of a page by matching its open tag. */
const extractSvg = (html: string, match: string) => {
  const open = new RegExp(`<svg\\b[^>]*${match}[^>]*>`, "u").exec(html);
  if (open === null) return undefined;
  const end = html.indexOf("</svg>", open.index);
  return end === -1 ? undefined : html.slice(open.index, end + "</svg>".length);
};

/** Where the crawler puts a page's markdown: `<path>/index.md` under the staging root. */
const pageFile = (staging: string, page: string, path: Path.Path) =>
  path.join(staging, new URL(page).pathname.replaceAll(/^\/|\/$/gu, ""), "index.md");

/**
 * Rescue the inline figure the converter dropped: write the SVG, rasterise it if asked and
 * `magick` is available, and link both from the page they came from.
 *
 * The PNG is not redundant. A Figma-exported diagram carries no `<text>` -- every label is
 * an outlined path -- so the SVG is a megabyte of bezier coordinates with nothing readable
 * in it, and grep never reaches an image either way. The rendered PNG is the only form
 * that can actually be looked at.
 */
const rescueInlineFigure = Effect.fn(function* (staging: string, crawl: Crawl) {
  const figure = crawl.inlineFigure;
  if (figure === undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const svg = extractSvg(yield* httpGet(figure.page), figure.match);
  if (svg === undefined)
    return yield* new RefsError({
      reason: `no <svg> matching ${figure.match} on ${figure.page}`,
    });

  const target = path.join(staging, figure.into);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(
    target,
    Object.entries(figure.cssVars ?? {}).reduce(
      (acc, [name, value]) => acc.replaceAll(`var(${name})`, value),
      svg,
    ),
  );

  // Rasterised beside the SVG when possible, skipped with a note when not: a missing
  // ImageMagick should cost the ref its diagram, not the whole fetch.
  const png = target.replace(/\.svg$/u, ".png");
  const havePng =
    figure.png === true &&
    (yield* spawner.exitCode(
      ChildProcess.make("which", ["magick"], { stdout: "ignore", stderr: "ignore" }),
    )) === 0 &&
    (yield* spawner.exitCode(
      ChildProcess.make("magick", ["-background", "white", target, "-resize", "1600x", png], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    )) === 0;
  if (figure.png === true && !havePng)
    yield* Console.log("  magick unavailable -- wrote the SVG without a PNG");

  const page = pageFile(staging, figure.page, path);
  if (!(yield* fs.exists(page))) return;
  const rel = path.relative(path.dirname(page), target).replaceAll("\\", "/");
  yield* fs.writeFileString(
    page,
    `${(yield* fs.readFileString(page)).trimEnd()}\n\n## Overview diagram\n\n![Object model overview](${
      havePng ? rel.replace(/\.svg$/u, ".png") : rel
    })\n${havePng ? `\nVector source: [${path.basename(target)}](${rel})\n` : ""}`,
  );
  yield* Console.log(`  rescued inline figure -> ${figure.into}${havePng ? " (+ png)" : ""}`);
});

/**
 * Preflight so a missing binary reads as an install hint rather than a bare ENOENT from
 * the spawner, minutes into a run.
 */
const assertCrawler = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const found = yield* spawner.exitCode(
    ChildProcess.make("which", [CRAWLER], { stdout: "ignore", stderr: "ignore" }),
  );
  if (found !== 0) {
    return yield* new RefsError({
      reason: `${CRAWLER} is not on PATH -- install it with \`brew install janreges/tap/${CRAWLER}\``,
    });
  }
});

/** Crawl a documentation site into markdown, images and all, under `staging`. */
const crawlInto = Effect.fn(function* (staging: string, crawl: Crawl) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* assertCrawler;
  const exit = yield* spawner.exitCode(
    ChildProcess.make(
      CRAWLER,
      [
        `--url=${crawl.url}`,
        `--include-regex=${crawl.include}`,
        // Without this the regex would also gate assets, dropping every image -- which is
        // exactly what `filterAssetsToo` wants, for a site whose page URLs read as filenames.
        ...(crawl.filterAssetsToo === true ? [] : ["--regex-filtering-only-for-pages"]),
        ...(crawl.removeQueryParams === true ? ["--remove-query-params"] : []),
        // Browser rendering plus a very tall viewport; see the Crawl JSDoc.
        ...(crawl.browser
          ? [
              "--browser",
              "--browser-wait=networkidle",
              "--browser-wait-extra=3000",
              "--screenshot-viewport=1600x30000",
              // Consent up front: with no browser installed the crawler otherwise stops
              // on an interactive prompt that a spawned process has no way to answer.
              "--browser-auto-download",
            ]
          : []),
        ...(crawl.externalFileDomain ?? []).map((d) => `--allowed-domain-for-external-files=${d}`),
        ...(crawl.ignore ?? []).map((r) => `--ignore-regex=${r}`),
        ...(crawl.excludeSelector ?? []).map((s) => `--markdown-exclude-selector=${s}`),
        `--markdown-export-dir=${staging}`,
        // Both of these default low enough to bite a mid-sized docs site, and both
        // fail silently: the crawler drops what does not fit and still exits 0, with
        // a clean audit report and plausible file counts. `include` is what actually
        // bounds a crawl; these two are only runaway guards.
        //
        // `--max-queue-length` (default 9000) is the dangerous one, and it cost two
        // wrong Logic refs to find. Pages are discovered first and their assets last,
        // so once the queue is full it is images that get dropped -- never requested,
        // absent from the log, and still linked from every page the converter wrote.
        // A run that ends "naturally" proves nothing: the dropped URLs left no trace.
        "--max-queue-length=100000",
        // Default 10000. Reaching it stops the crawl wherever it is, so the shortfall
        // again lands on assets, which queue behind pages.
        "--max-visited-urls=50000",
        "--workers=2",
        "--max-reqs-per-sec=3",
        // Empty paths switch off the audit report, JSON and text dumps, none of which
        // belong in a docs ref.
        "--output-html-report=",
        "--output-json-file=",
        "--output-text-file=",
      ],
      // Inherited, progress bar and all: this runs for minutes against a live site, and
      // silence for that long is worse than the crawler's noisy tail.
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (exit !== 0)
    return yield* new RefsError({ reason: `crawl of ${crawl.url} failed (exit ${exit})` });
  yield* flattenExternalAssets(staging);
  yield* convertAssetPages(staging, crawl);
  // After the asset pages, so their headings are repaired too.
  yield* repairCrawledMarkdown(staging);
  yield* rescueInlineFigure(staging, crawl);
  if (crawl.versionFrom === undefined) return undefined;
  const found = new RegExp(crawl.versionFrom.pattern, "u").exec(
    yield* httpGet(crawl.versionFrom.page),
  );
  if (found?.[1] === undefined)
    return yield* new RefsError({
      reason: `no version matching /${crawl.versionFrom.pattern}/ on ${crawl.versionFrom.page}`,
    });
  yield* Console.log(`  documents ${found[1]}`);
  return found[1];
});

/** Where one topic lands in the output tree. */
interface TopicSlot {
  readonly into: string;
  readonly file: string;
  readonly anchor: string;
}

/** A chapter file and the topics rolled into it, in reading order. */
interface Chapter {
  readonly file: string;
  readonly entries: ReadonlyArray<{
    readonly node: TocNode;
    readonly anchor: string;
    /** Heading depth in the chapter file: 1 for the chapter itself, deeper below it. */
    readonly level: number;
  }>;
}

const slugify = (title: string) =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

/**
 * Anchor for a topic: the basename of its reader path, which is the DITA source
 * filename. Unique across all 2419 topics of the Cubase manual bar one pair, and stable
 * across re-fetches in a way a title slug is not -- retitling a topic upstream would
 * churn every link pointing at it.
 */
const topicAnchor = (prettyUrl: string) =>
  prettyUrl
    .split("/")
    .pop()
    ?.replace(/\.html$/u, "") ?? "";

/** Make `name` unique within `used`, suffixing before the extension. */
const uniqueName = (name: string, used: Set<string>) => {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++)
    candidate = /\./u.test(name)
      ? name.replace(/(?<ext>\.[^.]+)$/u, `-${n}$<ext>`)
      : `${name}-${n}`;
  used.add(candidate);
  return candidate;
};

/**
 * Decide the output layout for one map before fetching any content: which chapter file
 * each topic lands in, and under which anchor. Doing this first is what lets a
 * cross-reference be rewritten the moment it is seen, rather than in a second pass over
 * finished markdown.
 */
const planMap = (toc: ReadonlyArray<TocNode>, into: string) => {
  const slots = new Map<string, TopicSlot>();
  const chapters: Array<Chapter> = [];
  const files = new Set<string>();
  for (const chapter of toc) {
    const file = uniqueName(`${slugify(chapter.title) || "topic"}.md`, files);
    const anchors = new Set<string>();
    const entries: Array<Chapter["entries"][number]> = [];
    const walk = (node: TocNode, level: number) => {
      const anchor = uniqueName(topicAnchor(node.prettyUrl) || slugify(node.title), anchors);
      entries.push({ node, anchor, level });
      slots.set(node.tocId, { into, file, anchor });
      // Markdown stops at h6, and this tree goes seven deep; past that, siblings share
      // a level rather than losing their heading altogether.
      for (const child of node.children) walk(child, Math.min(level + 1, 6));
    };
    walk(chapter, 1);
    chapters.push({ file, entries });
  }
  return { slots, chapters };
};

/** Push a converted topic's own headings below the heading we gave it. */
const shiftHeadings = (markdown: string, by: number) =>
  markdown.replaceAll(
    /^(?<hashes>#{1,6}) /gmu,
    (_, hashes: string) => `${"#".repeat(Math.min(hashes.length + by, 6))} `,
  );

const IMG_RE = /<img\b[^>]*>/gu;
const DATA_SRC_RE = /src="data:image\/(?<ext>[a-z]+);base64,(?<data>[^"]*)"/u;
const ASSET_NAME_RE = /data-ft-asset-display-name="(?<name>[^"]*)"/u;
const TOC_ID_RE = /data-tocid="(?<tocId>[^"]+)"/u;
const INTERNAL_LINK_RE =
  /<span\b(?<attrs>[^>]*\bft-internal-link\b[^>]*)>(?<text>[\s\S]*?)<\/span>/gu;
const KBD_RE = /<kbd\b[^>]*>(?<text>[\s\S]*?)<\/kbd>/gu;

/**
 * Rewrite one topic's HTML into something `--html-to-markdown` can carry through
 * faithfully. Three transforms, each covering something no converter can know:
 *
 * - Base64 figures are decoded to files under `_assets/` and the `src` repointed at
 *   them. Deduped by content hash, because the same screenshot appears in many topics.
 * - `ft-internal-link` spans become real `<a href>`, resolved through the slot table.
 *   A link whose target is not in the table (an unfetched map, say) degrades to its
 *   text rather than to a broken link.
 * - `<kbd>` becomes `<code>`, which the converter renders as backticks. Key commands
 *   are half the reason to have this manual, and bare `Ctrl/Cmd-Z` in prose reads badly.
 *
 * Injected `<a href>` and relative `<img src>` both survive conversion verbatim, which
 * is the property the whole design rests on.
 */
const prepareTopic = Effect.fn(function* (
  html: string,
  ctx: {
    readonly into: string;
    readonly slots: ReadonlyMap<string, TopicSlot>;
    readonly assetsDir: string;
    /** content hash -> filename already written, shared across the whole fetch. */
    readonly assets: Map<string, string>;
    readonly assetNames: Set<string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Two phases: write the files first (an effect), then a single pure pass over the
  // HTML. Replacing tag by tag as we go would re-scan from the start each time and can
  // rewrite the wrong occurrence when a topic repeats a figure.
  const rewrites = new Map<string, string>();
  for (const [tag] of html.matchAll(IMG_RE)) {
    const data = DATA_SRC_RE.exec(tag);
    if (data === null || rewrites.has(tag)) continue;
    const bytes = Buffer.from(data.groups?.data ?? "", "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    let name = ctx.assets.get(digest);
    if (name === undefined) {
      // The display name is the upstream's own filename; the digest is only a fallback
      // for a figure that arrives without one.
      const display = ASSET_NAME_RE.exec(tag)?.groups?.name;
      name = uniqueName(
        display === undefined || display === ""
          ? `figure-${digest.slice(0, 8)}.${data.groups?.ext ?? "png"}`
          : display,
        ctx.assetNames,
      );
      ctx.assets.set(digest, name);
      yield* fs.writeFile(path.join(ctx.assetsDir, name), bytes);
    }
    // Chapter files sit one directory below the ref root; `_assets` sits at it.
    rewrites.set(tag, tag.replace(DATA_SRC_RE, `src="../_assets/${name}"`));
  }

  return html
    .replaceAll(IMG_RE, (tag) => rewrites.get(tag) ?? tag)
    .replaceAll(INTERNAL_LINK_RE, (_, attrs: string, text: string) => {
      const slot = ctx.slots.get(TOC_ID_RE.exec(attrs)?.groups?.tocId ?? "");
      if (slot === undefined) return text;
      const href =
        slot.into === ctx.into
          ? `${slot.file}#${slot.anchor}`
          : `../${slot.into}/${slot.file}#${slot.anchor}`;
      return `<a href="${href}">${text}</a>`;
    })
    .replaceAll(KBD_RE, (_, text: string) => `<code>${text}</code>`);
});

/** First value of a map's metadata entry, e.g. `version` or `ft:locale`. */
const ftMeta = (
  metadata: ReadonlyArray<{ readonly key: string; readonly values: ReadonlyArray<string> }>,
  key: string,
) => metadata.find((entry) => entry.key === key)?.values[0];

/** Log every this many topics, so a six-minute fetch is not six minutes of silence. */
const FT_PROGRESS_EVERY = 200;

/**
 * Read a Fluid Topics portal into markdown under `staging`, returning the exact version
 * that matched so the stamp can record it.
 */
const fluidTopicsInto = Effect.fn(function* (staging: string, ft: FluidTopics) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* assertCrawler;

  const catalogue = yield* Schema.decodeEffect(FtMaps)(
    yield* httpGet(`${ft.tenant}/api/khub/maps`),
  );

  // Resolve and plan every map before converting anything: a cross-map reference can
  // only be rewritten once the other map's slots exist.
  const slots = new Map<string, TopicSlot>();
  const planned: Array<
    { readonly into: string; readonly mapId: string } & { chapters: ReadonlyArray<Chapter> }
  > = [];
  let resolvedVersion = ft.version;
  for (const wanted of ft.maps) {
    const matches = catalogue.filter(
      (map) =>
        map.title === wanted.title &&
        ftMeta(map.metadata, "version")?.startsWith(ft.version) === true &&
        ftMeta(map.metadata, "ft:locale")?.startsWith(ft.locale) === true,
    );
    if (matches.length !== 1) {
      return yield* new RefsError({
        reason: `${matches.length} maps titled "${wanted.title}" match ${ft.version} ${ft.locale} on ${ft.tenant}; expected exactly 1`,
      });
    }
    const [map] = matches;
    resolvedVersion = ftMeta(map.metadata, "version") ?? ft.version;
    const toc = yield* Schema.decodeEffect(FtToc)(
      yield* httpGet(`${ft.tenant}/api/khub/maps/${map.id}/toc`),
    );
    const plan = planMap(toc, wanted.into);
    for (const [tocId, slot] of plan.slots) slots.set(tocId, slot);
    planned.push({ into: wanted.into, mapId: map.id, chapters: plan.chapters });
  }

  const assetsDir = path.join(staging, "_assets");
  yield* fs.makeDirectory(assetsDir, { recursive: true });
  const ctxBase = {
    slots,
    assetsDir,
    assets: new Map<string, string>(),
    assetNames: new Set<string>(),
  };

  // The converter reads and writes files, so it needs a scratch pair outside the ref.
  const work = yield* fs.makeTempDirectory({ prefix: "refs-ft-" });
  const htmlPath = path.join(work, "topic.html");
  const mdPath = path.join(work, "topic.md");

  const total = planned.reduce(
    (sum, map) => sum + map.chapters.reduce((n, chapter) => n + chapter.entries.length, 0),
    0,
  );
  yield* Console.log(`  ${resolvedVersion}: ${total} topics in ${planned.length} map(s)`);

  let done = 0;
  for (const map of planned) {
    yield* fs.makeDirectory(path.join(staging, map.into), { recursive: true });
    for (const chapter of map.chapters) {
      const parts: Array<string> = [];
      for (const { node, anchor, level } of chapter.entries) {
        const html = yield* httpGet(
          `${ft.tenant}/api/khub/maps/${map.mapId}/topics/${node.contentId}/content`,
        );
        yield* fs.writeFileString(
          htmlPath,
          yield* prepareTopic(html, { ...ctxBase, into: map.into }),
        );
        const exit = yield* spawner.exitCode(
          ChildProcess.make(
            CRAWLER,
            [`--html-to-markdown=${htmlPath}`, `--html-to-markdown-output=${mdPath}`],
            // Both silenced, which is not the usual "inherit so a long job is not
            // silent" call the crawl branch makes: this converter reports *success* on
            // stderr, so inheriting it prints a green "Markdown written to" line 2419
            // times and buries the progress counter. The exit code is the signal, and
            // the error below names the topic and leaves its HTML on disk to re-run.
            { stdout: "ignore", stderr: "ignore" },
          ),
        );
        if (exit !== 0) {
          return yield* new RefsError({
            reason: `converting "${node.title}" failed (exit ${exit}); source at ${htmlPath}`,
          });
        }
        const markdown = (yield* fs.readFileString(mdPath)).trim();
        // The anchor rides below the heading rather than in it: markdown has no anchor
        // syntax, and a bare `<a id>` is both valid and greppable.
        parts.push(
          `${"#".repeat(level)} ${node.title}\n<a id="${anchor}"></a>\n\n${shiftHeadings(markdown, level)}`,
        );
        done++;
        if (done % FT_PROGRESS_EVERY === 0) yield* Console.log(`  ${done}/${total} topics`);
      }
      yield* fs.writeFileString(
        path.join(staging, map.into, chapter.file),
        `${parts.join("\n\n")}\n`,
      );
    }
  }
  yield* fs.remove(work, { recursive: true, force: true });
  yield* Console.log(`  ${done}/${total} topics, ${ctxBase.assets.size} images`);
  return resolvedVersion;
});

/** Fill staging with the ref's content: a copy for a local ref, a crawl or a download. */
const fillStaging = Effect.fn(function* (staging: string, ref: Ref, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (ref.repo) return yield* downloadInto(staging, ref, ref.repo, target);
  if (ref.crawl) return yield* crawlInto(staging, ref.crawl);
  // The only branch that returns anything: the resolved version, which the portal knows
  // and this file does not.
  if (ref.fluidTopics) return yield* fluidTopicsInto(staging, ref.fluidTopics);
  if (!ref.dir)
    return yield* new RefsError({
      reason: `${ref.name} needs a repo, a dir, a crawl or a fluidTopics portal`,
    });
  // resolve, not join: the source sits outside the repo, beside it.
  const from = path.resolve(yield* repoRoot, ref.dir.replace("{v}", target));
  if (!(yield* fs.exists(from)))
    return yield* new RefsError({ reason: `no local source at ${from}` });
  for (const entry of yield* fs.readDirectory(from)) {
    if (ref.exclude?.some((suffix) => entry.endsWith(suffix))) continue;
    yield* fs.copy(path.join(from, entry), path.join(staging, entry));
  }
});

/** How a ref without a package.json pin gets its content, for the fetch's first line. */
const sourceKind = (ref: Ref) => {
  if (ref.crawl) return "crawl";
  if (ref.fluidTopics) return "api";
  return ref.branch ? "branch" : "tag";
};

const fetchRef = Effect.fn(function* ({ ref, source, target, version }: Resolved) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;

  const label = source ? `${target}  (${source})` : `${target} (${sourceKind(ref)})`;
  yield* Console.log(`${ref.name}: ${label}`);

  // Fill a temp dir first so a failed fetch leaves the existing ref intact.
  const staging = yield* fs.makeTempDirectory({ prefix: `refs-${ref.name}-` });
  yield* Effect.gen(function* () {
    const reported = yield* fillStaging(staging, ref, target);

    const stamp = yield* Schema.encodeEffect(StampJson)({
      repo: ref.repo,
      dir: ref.dir,
      url: ref.crawl?.url ?? ref.fluidTopics?.tenant,
      resolved: target,
      // A portal reports a more precise version than the prefix we pin (`15.0.30` for a
      // `15.0` pin). Recording it keeps the drift visible without `refs check` failing
      // on every maintenance release.
      version: typeof reported === "string" ? reported : version,
      source,
      fetchedAt: new Date().toISOString(),
    });
    yield* fs.writeFileString(path.join(staging, ".ref.json"), `${stamp}\n`);

    const refDir = path.join(root, "refs", ref.name);
    yield* fs.makeDirectory(path.dirname(refDir), { recursive: true });
    yield* fs.remove(refDir, { recursive: true, force: true });
    yield* fs.rename(staging, refDir);
    yield* Console.log(`  -> refs/${ref.name}`);
  }).pipe(
    Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/** Print one status line per ref and return how many drifted from their pins. */
const checkRefs = Effect.gen(function* () {
  let stale = 0;
  for (const ref of REFS) {
    const resolved = yield* Effect.result(resolve(ref));
    if (Result.isFailure(resolved)) {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} ERROR  ${resolved.failure.message}`);
      stale++;
      continue;
    }
    const stamp = yield* readStamp(ref.name);
    if (stamp === undefined) {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} MISSING  want ${resolved.success.target}`);
      stale++;
    } else if (stamp.resolved !== resolved.success.target) {
      yield* Console.log(
        `${ref.name.padEnd(NAME_COL)} STALE  have ${stamp.resolved}  want ${resolved.success.target}`,
      );
      stale++;
    } else if (resolved.success.version === undefined) {
      // No resolved version means a branch or crawl ref, whose target names itself
      // rather than a pin, so age is the only thing left to report.
      const days = Math.floor((Date.now() - Date.parse(stamp.fetchedAt)) / 86_400_000);
      yield* Console.log(
        `${ref.name.padEnd(NAME_COL)} ${resolved.success.target}  fetched ${days === 0 ? "today" : `${days}d ago`}`,
      );
    } else {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} ok  ${resolved.success.version}`);
    }
  }
  return stale;
});

const toUserError = (error: unknown) =>
  new CliError.UserError({
    cause: error,
    userMessage: error instanceof Error ? error.message : String(error),
  });

const fetchCommand = Command.make(
  "fetch",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Fetch every ref except the opt-in ones"),
      Flag.withDefault(false),
    ),
    names: Argument.choice("name", refNames).pipe(
      Argument.variadic(),
      Argument.withDescription("Refs to fetch"),
    ),
  },
  Effect.fn(function* ({ all, names }) {
    if (!all && names.length === 0) {
      return yield* new CliError.UserError({
        cause: "no refs named",
        userMessage: "name refs to fetch, or pass --all",
      });
    }
    const refs = all
      ? REFS.filter((ref) => !ref.optIn)
      : REFS.filter((ref) => names.includes(ref.name));
    const failed: Array<string> = [];
    for (const ref of refs) {
      // A failed fetch leaves any existing copy in place, so keep going.
      yield* resolve(ref).pipe(
        Effect.flatMap(fetchRef),
        Effect.catch((error) =>
          Effect.gen(function* () {
            failed.push(ref.name);
            yield* Console.error(`${ref.name}: failed -- ${error.message}`);
          }),
        ),
      );
    }
    if (failed.length > 0) {
      return yield* new CliError.UserError({
        cause: "fetch failed",
        userMessage: `failed to fetch: ${failed.join(", ")}`,
      });
    }
  }),
).pipe(
  Command.withDescription("Download refs into refs/, pinned to the workspace versions"),
  Command.withExamples([
    { command: "refs fetch tan-router", description: "Fetch one ref" },
    { command: "refs fetch --all", description: "Fetch every ref except the opt-in ones" },
    {
      command: "refs fetch live-manual",
      description: "Crawl an opt-in ref (minutes, not seconds)",
    },
  ]),
);

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn(function* () {
    const stale = yield* checkRefs.pipe(Effect.mapError(toUserError));
    if (stale > 0) {
      return yield* new CliError.UserError({
        cause: "refs drifted",
        userMessage: `${stale} ref(s) drifted from the pins`,
      });
    }
  }),
).pipe(Command.withDescription("Report refs that drifted from the pins; exit 1 if any"));

const listCommand = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* checkRefs.pipe(Effect.mapError(toUserError));
  }),
).pipe(Command.withDescription("Report the status of every ref"));

const refsCommand = Command.make("refs").pipe(
  Command.withDescription("Manage the pinned reference sources in refs/"),
  Command.withSubcommands([fetchCommand, checkCommand, listCommand]),
);

NodeRuntime.runMain(
  refsCommand.pipe(Command.run({ version: "0.0.0" }), Effect.provide(NodeServices.layer)),
);
