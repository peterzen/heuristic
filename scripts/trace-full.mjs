#!/usr/bin/env node
/**
 * Full-coverage ancestry taint trace, from the command line.
 *
 * The web UI (/check) runs the same engine in ~12s bursts and makes you click
 * "keep crawling" for each next burst, because a deep trace is thousands of
 * round-trips into a rate-limited public API. Against your OWN node there is no
 * such limit, so this script pumps the loop automatically until the frontier is
 * exhausted — the 100%-of-value trace the button gets you to one click at a time.
 *
 *   node scripts/trace-full.mjs bc1q...            # or a seed txid
 *   npm run trace -- bc1q... --json report.json
 *
 * It imports lib/taint.ts directly: the same engine, the same labels, the same
 * scoring as the UI. Nothing is reimplemented here, so results cannot drift.
 */

import * as nodeModule from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

// Fail with a sentence rather than a linker error: running lib/*.ts directly
// needs Node's own TypeScript support (22.6, unflagged in 22.18) and the
// synchronous module hooks below (22.15). A namespace import is used above so
// this check is reached at all on an older runtime.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(
    `\nscripts/trace-full.mjs runs lib/taint.ts directly, which needs Node 22.18+.\n` +
      `This is Node ${process.versions.node}. The app itself still runs on Node 20+.\n\n`
  );
  process.exit(1);
}

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Node runs TypeScript natively (22.6+), but it does NOT do extension
// resolution, and lib/*.ts import each other extensionlessly ("./labels"). This
// hook bridges that gap — and tags the result as ESM so Node doesn't have to
// sniff the module type and warn about it on every file.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) base = resolvePath(ROOT, specifier.slice(2));
    else if (specifier.startsWith("file:")) base = fileURLToPath(specifier);
    else if (/^\.{1,2}\//.test(specifier) && context.parentURL?.startsWith("file:"))
      base = fileURLToPath(new URL(specifier, context.parentURL));
    if (base) {
      for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) {
        if (cand.endsWith(".ts") && existsSync(cand))
          return {
            url: pathToFileURL(cand).href,
            format: "module-typescript",
            shortCircuit: true,
          };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { traceTaint, knownEntityTaint } = await import(
  pathToFileURL(`${ROOT}/lib/taint.ts`).href
);
const { labelFor } = await import(pathToFileURL(`${ROOT}/lib/labels.ts`).href);
const { formatBtc } = await import(pathToFileURL(`${ROOT}/lib/format.ts`).href);

// ── arguments ───────────────────────────────────────────────────────────────

const HELP = `
HEURISTIC — full ancestry taint trace (runs to 100% coverage, no clicking)

  node scripts/trace-full.mjs <address|txid> [options]

  <address>  screens the address's most recent transaction, exactly like /check
  <txid>     traces that transaction's inputs directly

Options
  --api <url>          Esplora REST base. Default: $ESPLORA_API_BASE, else
                       http://127.0.0.1:3006/api (a local electrs/esplora).
  --concurrency <n>    Parallel tx fetches. Default 64 local, 8 remote.
  --round <sec>        Work budget per resume step. Default 10. Lower = more
                       frequent checkpoints and a snappier Ctrl-C.
  --max-nodes <n>      Stop after about this many ancestor txs (a round always
                       finishes its current batch of --concurrency fetches, so
                       the real total can overshoot by up to that much).
  --timeout <sec>      Stop after this much wall-clock time. Default: no cap.
  --min-fraction <f>   Dust floor: a branch holding less than this share of the
                       coin is not followed. Default 0.00001 (the engine's EPS).
                       Lower = more complete and much slower. Must be > 0.
  --deep               Trace a labelled sender's own ancestry too. By default a
                       known entity's label IS the answer (as in the UI).
  --json <file>        Write the full result as JSON. "-" writes to stdout.
  --save-state <file>  Checkpoint the resumable state every round, and on Ctrl-C.
  --resume <file>      Continue a trace from a --save-state file.
  --quiet              No live progress line.
  -h, --help           This text.

Exit codes: 0 complete · 2 stopped on a budget (resumable) · 1 error.
`;

function parseArgs(argv) {
  const o = {
    target: null,
    api: null,
    concurrency: null,
    round: 10,
    maxNodes: Infinity,
    timeout: Infinity,
    minFraction: 1e-5,
    deep: false,
    json: null,
    saveState: null,
    resume: null,
    quiet: false,
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) die(`--${name} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0); break;
      case "--api": o.api = next(); break;
      case "--concurrency": o.concurrency = num(next(), "concurrency"); break;
      case "--round": o.round = num(next(), "round"); break;
      case "--max-nodes": o.maxNodes = num(next(), "max-nodes"); break;
      case "--timeout": o.timeout = num(next(), "timeout"); break;
      case "--min-fraction": o.minFraction = num(next(), "min-fraction"); break;
      case "--deep": o.deep = true; break;
      case "--json": o.json = next(); break;
      case "--save-state": o.saveState = next(); break;
      case "--resume": o.resume = next(); break;
      case "--quiet": o.quiet = true; break;
      default:
        if (a.startsWith("-")) die(`unknown option ${a}`);
        if (o.target) die("give one address or txid");
        o.target = a;
    }
  }
  if (o.minFraction >= 1) die("--min-fraction must be below 1");
  return o;
}

function die(msg) {
  process.stderr.write(`${c.bad("error")} ${msg}\n\nRun with --help for usage.\n`);
  process.exit(1);
}

// ── presentation ────────────────────────────────────────────────────────────

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  good: wrap("32"),
  warn: wrap("33"),
  bad: wrap("31"),
  accent: wrap("38;5;208"), // the brand orange: BTC values
};

const BAND_COLOR = {
  clean: c.good, low: c.good, medium: c.warn, high: c.bad, critical: c.bad,
};

const n = (v) => Math.round(v).toLocaleString("en-US");
const pct = (f, dp = 1) => {
  const shown = (f * 100).toFixed(dp);
  // Never round a real, non-zero exposure down to a reassuring "0.0%".
  if (f > 0 && Number(shown) === 0) return `<${(10 ** -dp).toFixed(dp)}%`;
  return `${shown}%`;
};
const plural = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function bar(frac, width = 22) {
  const filled = Math.max(frac > 0 ? 1 : 0, Math.round(frac * width));
  return "█".repeat(Math.min(width, filled)) + "░".repeat(Math.max(0, width - filled));
}

// Categories whose mere presence sets the verdict (see the score in lib/taint.ts).
const FLAGGED = new Set(["sanctioned", "hack"]);

const ORIGIN_COLOR = (o) =>
  o.key === "sanctioned" || o.key === "hack" ? c.bad
    : o.key === "mixed" || o.key === "service" ? c.warn
      : o.key === "unresolved" ? c.dim
        : c.good;

function utc(unix) {
  if (!unix) return "unconfirmed";
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ── data source ─────────────────────────────────────────────────────────────

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$|\.(local|lan|internal|home)$/i;

const opts = parseArgs(process.argv.slice(2));
const API = (opts.api ?? process.env.ESPLORA_API_BASE ?? "http://127.0.0.1:3006/api")
  .replace(/\/+$/, "");

let host;
try {
  host = new URL(API).hostname;
} catch {
  die(`--api is not a valid URL: ${API}`);
}
const isLocal = PRIVATE_HOST.test(host);
const concurrency = opts.concurrency ?? (isLocal ? 64 : 8);

const stats = { fetches: 0, hits: 0, retries: 0, failures: 0 };
const txCache = new Map();
const CACHE_MAX = 20_000; // bounded: a deep trace can touch 100k+ txs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, tries = 3) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      stats.fetches += 1;
      res = await fetch(`${API}/${path}`, { headers: { accept: "application/json" } });
    } catch (e) {
      if (attempt >= tries) throw e;
      stats.retries += 1;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    // A missing or malformed tx will never appear on a retry; only transient
    // conditions (429 / 5xx / a node still syncing) are worth waiting on.
    if (res.status === 400 || res.status === 404)
      throw new Error(`${res.status} ${res.statusText} — ${path}`);
    if (attempt >= tries) throw new Error(`${res.status} ${res.statusText} — ${path}`);
    const retryAfter = Number(res.headers.get("retry-after"));
    stats.retries += 1;
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
  }
}

async function fetchTx(txid) {
  const hit = txCache.get(txid);
  if (hit) {
    stats.hits += 1;
    return hit;
  }
  try {
    const tx = await getJson(`tx/${txid}`);
    if (txCache.size >= CACHE_MAX) txCache.delete(txCache.keys().next().value);
    txCache.set(txid, tx);
    return tx;
  } catch (e) {
    // The engine treats a rejected fetch as an unresolved branch, which is the
    // honest outcome — but count it so the summary can own the gap.
    stats.failures += 1;
    throw e;
  }
}

// ── the trace ───────────────────────────────────────────────────────────────

const ADDR = /^(bc1[a-zA-HJ-NP-Z0-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const TXID = /^[0-9a-f]{64}$/i;

let resumeState = null;
if (opts.resume) {
  if (!existsSync(opts.resume)) die(`no such state file: ${opts.resume}`);
  try {
    resumeState = JSON.parse(readFileSync(opts.resume, "utf8"));
  } catch (e) {
    die(`could not read state file: ${e.message}`);
  }
  if (!resumeState?.seed) die(`${opts.resume} is not a trace state file`);
}
if (!resumeState && !opts.target) {
  process.stdout.write(HELP);
  process.exit(1);
}

const log = (s = "") => process.stderr.write(`${s}\n`);
let progressLive = false;
const clearProgress = () => {
  if (progressLive) {
    process.stderr.write(`\r${" ".repeat(78)}\r`);
    progressLive = false;
  }
};

if (!opts.quiet) {
  log();
  log(`${c.bold("HEURISTIC")} ${c.dim("· full ancestry taint trace")}`);
  log(`${c.dim("  source   ")} ${API} ${isLocal ? c.good("(local)") : c.warn("(remote)")}`);
  if (!isLocal)
    log(
      c.warn("  note      ") +
        "a full trace is thousands of requests — a public endpoint will\n" +
        "            rate-limit you. Point --api at your own node for the real run."
    );
}

// Resolve what to trace: a seed txid, plus the label of the address if given.
let seedTxid;
let selfLabel;
if (resumeState) {
  seedTxid = resumeState.seed;
  if (!opts.quiet) log(`${c.dim("  resuming ")} ${n(resumeState.visitedCount)} txs already traced`);
} else if (TXID.test(opts.target)) {
  seedTxid = opts.target.toLowerCase();
} else if (ADDR.test(opts.target)) {
  selfLabel = labelFor(opts.target);
  let txs;
  try {
    txs = await getJson(`address/${opts.target}/txs`);
  } catch (e) {
    clearProgress();
    die(`could not reach ${API} — ${e.message}`);
  }
  if (!Array.isArray(txs) || txs.length === 0)
    die(`no transactions for ${opts.target} yet`);
  // Same seed the UI picks: the address's most recent transaction.
  seedTxid = txs[0].txid;
} else {
  die(`"${opts.target}" is neither a Bitcoin address nor a txid`);
}

const seedTx = await fetchTx(seedTxid).catch(() => null);
if (!seedTx && !resumeState) die(`could not fetch seed transaction ${seedTxid}`);
const seedSat = seedTx ? seedTx.vin.reduce((s, v) => s + (v.prevout?.value ?? 0), 0) : 0;

if (!opts.quiet) {
  log(`${c.dim("  seed tx  ")} ${seedTxid}`);
  if (seedTx) {
    log(`${c.dim("  mined    ")} ${utc(seedTx.status?.block_time)}`);
    log(`${c.dim("  value    ")} ${c.accent(`${formatBtc(seedSat, "detailed")} BTC`)}`);
  }
  if (selfLabel)
    log(`${c.dim("  sender   ")} ${c.bold(selfLabel.name)} ${c.dim(`(${selfLabel.category})`)}`);
  log();
}

const startedAt = Date.now();
let result;
let rounds = 0;
let stopReason = "complete";

// A labelled sender's own label IS the provenance answer — crawling an
// exchange's internal ancestry is both enormous and meaningless. Same rule the
// UI applies; --deep overrides it.
if (selfLabel && !opts.deep && !resumeState) {
  result = knownEntityTaint(seedTxid, selfLabel, seedSat, seedTx?.status?.block_time);
  stopReason = "labelled-sender";
} else {
  let interrupts = 0;
  let stop = false;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts >= 2) {
      clearProgress();
      log(c.bad("aborted."));
      process.exit(2);
    }
    stop = true;
    clearProgress();
    log(c.warn("\n  stopping after this round — press Ctrl-C again to abort now"));
  };
  process.on("SIGINT", onSigint);

  let lastPaint = 0;
  const paint = (visited, coverage, queued) => {
    if (opts.quiet || !process.stderr.isTTY) return;
    const now = Date.now();
    if (now - lastPaint < 100) return;
    lastPaint = now;
    progressLive = true;
    process.stderr.write(
      `\r  ${c.accent("⟳")} ${plural(visited, "ancestor tx", "ancestor txs")} · ${coverage}% of value resolved` +
        `${queued === null ? "" : ` · ${n(queued)} queued`} · ${elapsed(now - startedAt)}   `
    );
  };

  let state = resumeState;
  let lastVisited = resumeState?.visitedCount ?? 0;
  let stalls = 0;

  for (;;) {
    const remainingNodes = opts.maxNodes - lastVisited;
    if (remainingNodes <= 0) { stopReason = "max-nodes"; break; }
    const remainingMs = opts.timeout * 1000 - (Date.now() - startedAt);
    if (remainingMs <= 0) { stopReason = "timeout"; break; }

    result = await traceTaint(
      seedTxid,
      fetchTx,
      {
        concurrency,
        minFraction: opts.minFraction,
        maxNodesPerCall: Math.min(remainingNodes, 2000),
        timeBudgetMs: Math.min(remainingMs, opts.round * 1000),
        onProgress: (visited, coverage) => paint(visited, coverage, null),
      },
      state ?? undefined
    );
    rounds += 1;
    state = result.state;
    paint(result.nodesVisited, Math.round(result.coverage * 100), result.frontierSize);

    if (opts.saveState) {
      try {
        writeFileSync(opts.saveState, JSON.stringify(state));
      } catch (e) {
        clearProgress();
        log(`${c.warn("warning")} could not write ${opts.saveState}: ${e.message}`);
      }
    }

    if (result.done) break;
    if (stop) { stopReason = "interrupted"; break; }

    // The engine always drains or expands the frontier, so zero progress twice
    // running means something outside it is wrong (node down, budget too small
    // to fetch even one tx). Bail instead of spinning forever.
    if (result.nodesVisited === lastVisited) {
      if (++stalls >= 2) { stopReason = "stalled"; break; }
    } else stalls = 0;
    lastVisited = result.nodesVisited;
  }
  process.off("SIGINT", onSigint);
}

clearProgress();

// ── the report ──────────────────────────────────────────────────────────────

const took = Date.now() - startedAt;
// What is left on the frontier. On a COMPLETE run it is by definition all below
// the dust floor ("done" means no material tip remains), and saying so is more
// honest than letting it disappear into "unresolved". On a PARTIAL run it is
// real un-crawled work, so the two cases are reported differently below.
const frontierValue = (result.state.frontier ?? []).reduce((sum, [, v]) => sum + v, 0);
const frontierTips = (result.state.frontier ?? []).length;

const STOP_TEXT = {
  complete: () =>
    frontierValue > 0
      ? `${c.good("COMPLETE")} — every path followed down to the dust floor`
      : `${c.good("COMPLETE")} — every funding path resolved to an origin`,
  "labelled-sender": () =>
    `${c.good("COMPLETE")} — sender is a labelled entity; its label is the origin` +
    `\n${" ".repeat(11)}${c.dim("re-run with --deep to trace its own funding history anyway")}`,
  "max-nodes": () => `${c.warn("PARTIAL")} — stopped at the --max-nodes cap`,
  timeout: () => `${c.warn("PARTIAL")} — stopped at the --timeout cap`,
  interrupted: () => `${c.warn("PARTIAL")} — interrupted`,
  stalled: () => `${c.bad("PARTIAL")} — no progress for two rounds; check that ${API} is up`,
};

if (opts.json !== "-") {
  const band = BAND_COLOR[result.band] ?? ((s) => s);
  log(`  ${c.bold("ORIGIN OF FUNDS")} ${c.dim("· value-weighted across every ancestry path")}`);
  log();
  let hidden = 0;
  let hiddenValue = 0;
  for (const o of result.origins) {
    // A hack or sanctions hit is never too small to print: the score is driven
    // by its existence, not its size, so hiding it would hide the verdict.
    if (o.fraction < 1e-4 && !FLAGGED.has(o.key)) {
      hidden += 1;
      hiddenValue += o.fraction;
      continue;
    }
    const paint = ORIGIN_COLOR(o);
    log(
      `    ${o.name.slice(0, 28).padEnd(29)}${paint(bar(o.fraction))}` +
        `  ${pct(o.fraction).padStart(7)}   ${c.dim(`risk ${o.risk.toFixed(2)}`)}`
    );
  }
  if (hidden > 0)
    log(
      `    ${c.dim(`+ ${plural(hidden, "origin")} under 0.01% (${pct(hiddenValue, 3)} of value)`)}`
    );
  log();
  log(`  ${c.bold("score")} ${band(`${Math.round(result.score)} / 100`)}   ` +
      `${c.bold("band")} ${band(result.band.toUpperCase())}`);
  log(
    `  ${c.dim("flagged")} ${pct(result.badFraction)}  ` +
      `${c.dim("mixed")} ${pct(result.mixedFraction)}  ` +
      `${c.dim("clean")} ${pct(result.cleanFraction)}  ` +
      `${c.dim("unresolved")} ${pct(result.unresolvedFraction)}`
  );
  log(
    `  ${c.dim("coverage")} ${pct(result.coverage)} of value · ` +
      `${plural(result.nodesVisited, "ancestor tx", "ancestor txs")} · ` +
      `${plural(rounds, "round")} · ${elapsed(took)}`
  );
  log(`  ${c.dim("status")}   ${(STOP_TEXT[stopReason] ?? STOP_TEXT.complete)()}`);
  if (result.done && frontierValue > 0)
    log(
      `           ${c.dim(
        `${plural(frontierTips, "tip")} left below the ${pct(opts.minFraction, 4)} dust floor ` +
          `(${pct(frontierValue, 3)} of value) — lower --min-fraction to chase them`
      )}`
    );
  if (!result.done && result.frontierSize > 0)
    log(
      `           ${c.dim(`${plural(result.frontierSize, "ancestor tx", "ancestor txs")} still queued`)}` +
        (opts.saveState
          ? c.dim(` — continue with --resume ${opts.saveState}`)
          : c.dim(" — re-run with --save-state to make a stop resumable"))
    );
  if (stats.failures > 0)
    log(
      `  ${c.warn("gaps")}     ${n(stats.failures)} tx fetch${stats.failures === 1 ? "" : "es"} failed ` +
        `— that value is counted as unresolved, not as clean`
    );
  log(
    `  ${c.dim("fetches")}  ${n(stats.fetches)} requests · ${n(stats.hits)} cache hits · ` +
      `${n(stats.retries)} retries · ${n(stats.failures)} failed`
  );
  log();
  log(
    c.dim(
      "  Heuristic estimate over an open label set. Glass-box, not legal or\n" +
        "  financial advice. Unresolved value is unknown, not clean."
    )
  );
  log();
}

if (opts.json) {
  // Everything the UI would show, minus the resumable state (that is what
  // --save-state is for, and it dwarfs the rest).
  const payload = {
    ...result,
    seedAddress: selfLabel ? opts.target : (ADDR.test(opts.target ?? "") ? opts.target : null),
    selfLabel: selfLabel ?? null,
    meta: {
      generatedAt: new Date().toISOString(),
      apiBase: API,
      rounds,
      elapsedMs: took,
      stopReason,
      minFraction: opts.minFraction,
      concurrency,
      frontierValue,
      frontierTips,
      requests: {
        total: stats.fetches,
        cacheHits: stats.hits,
        retries: stats.retries,
        failures: stats.failures,
      },
    },
  };
  delete payload.state;
  const json = JSON.stringify(payload, null, 2);
  if (opts.json === "-") process.stdout.write(`${json}\n`);
  else {
    writeFileSync(opts.json, `${json}\n`);
    log(`  ${c.dim("wrote")} ${opts.json}`);
  }
}

process.exit(result.done ? 0 : 2);
