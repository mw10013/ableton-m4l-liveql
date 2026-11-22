/**
 * Times the #12 benchmark queries against a running device: each query once to
 * warm up, then `LIVEQL_BENCH_RUNS` (10) times, printing the median and the
 * spread in ms as JSON lines so two runs diff cleanly.
 */
const URL = process.env.LIVEQL_URL ?? "http://localhost:5100/graphql";
const RUNS = Number(process.env.LIVEQL_BENCH_RUNS ?? 10);
const QUERIES = {
  parameters:
    "{ live_set { tracks { devices { parameters { name value } } } } }",
  devices: "{ live_set { tracks { devices { name } } } }",
  clip_slots: "{ live_set { tracks { name clip_slots { has_clip } } } }",
};

const time = async (query) => {
  const start = performance.now();
  const response = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const { errors } = await response.json();
  if (errors) throw new Error(JSON.stringify(errors));
  return performance.now() - start;
};

async function main() {
  for (const [name, query] of Object.entries(QUERIES)) {
    await time(query);
    const ms = [];
    for (let i = 0; i < RUNS; i += 1) ms.push(await time(query));
    const sorted = ms.toSorted((a, b) => a - b);
    const round = (n) => Math.round(n * 10) / 10;
    console.log(
      JSON.stringify({
        name,
        median: round(sorted[Math.floor(RUNS / 2)]),
        min: round(sorted[0]),
        max: round(sorted.at(-1)),
      }),
    );
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- CommonJS, like every script here, has no top-level await
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
