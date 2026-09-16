# HEURISTIC

**Open-source Bitcoin chain-forensics — "is this coin safe to accept?"**

HEURISTIC traces a Bitcoin UTXO's history back toward its origin, clusters
wallets, detects coinjoins, screens against the OFAC sanctions list, and gives a
plain-language verdict on whether a regulated exchange would accept the coins —
with **every reason shown**. It's a transparent, self-hostable alternative to
commercial chain-analysis tools (Chainalysis, Elliptic, TRM), built on open data.

> ⚠️ **Heuristic, not proof.** Every verdict is a probabilistic read of on-chain
> structure, not cryptographic certainty. Privacy is legitimate; a high score is
> a lead to investigate, never an accusation. This is a screening aid, **not
> legal or financial advice**.

![Bitcoin only](https://img.shields.io/badge/chain-Bitcoin-f5a623) ![License](https://img.shields.io/badge/license-MIT-7fb069)

---

## What it does

| Feature | Route | Description |
|---|---|---|
| **Check a coin** | `/check` | Paste a sender address → instant **Safe / Review / Avoid** verdict with the reasoning. The headline use case. |
| **Explorer** | `/explore` | Interactive force-directed UTXO flow graph — trace ancestry & spends, cluster wallets, flag coinjoins. |
| **Live mempool** | `/mempool` | Real-time "transaction rain" sized by value & coloured by fee, projected fee blocks, watchlist + alerts. |
| **Address pages** | `/address/<addr>` | Balance, history, risk screening, exposure breakdown, source-of-funds provenance. |
| **Screening API** | `/api/screen/<addr>` | Machine-readable JSON risk assessment. |
| **Methodology** | `/methodology` | Exactly how each heuristic works and where it breaks. |
| **Full trace (CLI)** | `npm run trace` | Runs the deep ancestry trace to completion against your own node — the whole thing, no clicking. |

### The analysis engine

- **Common-input-ownership clustering** (union-find) — co-spent addresses → one entity.
- **CoinJoin fingerprinting** — Whirlpool, Wasabi 1 & 2 (WabiSabi), JoinMarket, each with a confidence.
- **Change-output detection** — script-type, round-number, and unnecessary-input heuristics.
- **Source-of-funds provenance** — a backward walk along the dominant value path to coinbase / exchange / flagged origin.
- **Exposure analysis** — direct (counterparties) + indirect (ancestry) exposure aggregated by risk category.
- **Sanctions screening** — the full U.S. Treasury **OFAC SDN** Bitcoin address list.
- **Exchange-acceptance risk score** — see [the risk model](#the-risk-model).

---

## Quick start

```bash
git clone <your-fork-url> heuristic
cd heuristic
npm install
npm run dev          # → http://localhost:3000
```

```bash
npm run build        # production build
npm run start        # serve the production build
npm run lint
npm run update-ofac  # refresh the bundled OFAC sanctions list
npm run trace -- <address|txid>   # full ancestry trace against your own node
```

Requires **Node 20+** — except `npm run trace`, which runs `lib/taint.ts`
directly and needs **Node 22.18+**. No API keys, no database, no environment
variables needed to run against the public mempool.space API.

---

## Data source & privacy

By default the app proxies the public [mempool.space](https://mempool.space)
Esplora API through its own server route (`/api/btc/...`), which adds caching and
an allowlist. Two modes, switchable in-app from **⚙ Settings**:

- **Public (default)** — browser → this app's proxy → mempool.space. Convenient
  and cached, but the operator and mempool.space can see your queries.
- **Your instance** — the browser fetches **directly** from an
  Esplora/mempool node you run, so requests never touch the app's server. Full
  query privacy and no public rate limits.

To point the default proxy at your own node, set one environment variable:

```bash
# .env.local
ESPLORA_API_BASE=http://your-node.local:3006/api
```

Run [mempool/mempool](https://github.com/mempool/mempool) or
[Blockstream/electrs](https://github.com/Blockstream/electrs) against any full
Bitcoin node. (Your instance must allow CORS from the app's origin for in-browser
direct mode.)

---

## Full trace from the command line

A deep source-of-funds trace is thousands of transaction fetches. On the public
API that is slow enough that `/check` runs it in short bursts and asks you to
click **keep crawling** for each next one. Against your own node there is no such
limit, so `scripts/trace-full.mjs` pumps that loop automatically until the
frontier is exhausted — the same engine, the same labels, the same score, run to
100% of value in one command:

```bash
npm run trace -- bc1qexample... --api http://your-node.local:3006/api
npm run trace -- <txid> --json report.json          # machine-readable output
npm run trace -- <addr> --save-state run.json       # checkpoint every round
npm run trace -- --resume run.json                  # …and pick it back up
```

`npm run trace -- --help` lists every option. The useful ones:

| Option | What it does |
|---|---|
| `--api <url>` | Esplora REST base. Defaults to `$ESPLORA_API_BASE`, else `http://127.0.0.1:3006/api`. |
| `--min-fraction <f>` | Dust floor — branches holding less than this share of the coin aren't followed. Default `0.00001`, the engine's own `EPS`. Lower is more complete and much slower. |
| `--max-nodes` / `--timeout` | Off-ramps. Combine with `--save-state` so a stop is resumable. |
| `--deep` | Trace a labelled sender's own ancestry too (by default, as in the UI, a known entity's label *is* the origin). |
| `--json <file>` | The full result — origins, fractions, score, band, graph — as JSON. `-` writes to stdout. |
| `--log-failures <f>` | Every failed *and* retried request as JSONL, one object per attempt. |
| `--request-timeout <sec>` | Give up on one request after this long. Default 10 local, 30 remote. |

Exit code `0` means the trace completed and the result is usable, `2` means it is
incomplete — it stopped on a budget (resumable via `--save-state`/`--resume`), or
too little of the value resolved to rely on. A low score on a thin trace is
reported as `UNVERIFIED`: "nothing found" is not "nothing there".

Expect the **long tail** to dominate the runtime. The progress line reaches
`>99%` early and then grinds for a long time: the last fraction of a percent is
spread across thousands of small branches, each still a round-trip. The queued
count next to it is the honest measure of what's left. The ancestor-tx counter
tracks *distinct* transactions, so it can also sit still while the crawl
re-expands ancestors it has already seen — neither is a stall.

### When coverage comes back low

Low coverage is almost always the endpoint, not the ancestry. Every run ends with
the cause named:

```
  gaps     677 tx fetches failed — that value is counted as unresolved, not as clean
           HTTP 500 Internal Server Error × 612 · UND_ERR_SOCKET × 51 · HTTP 404 × 14
  upstream said:
           HTTP 500 Internal Server Error → {"error":"Bitcoind RPC error: No such
           mempool or blockchain transaction. Use -txindex or provide a block hash."}
  retried  2,482 attempts · HTTP 500 Internal Server Error × 2,301
```

`upstream said` is the endpoint's own error body, one sample per distinct cause.
It shows even when every request eventually succeeded, because a run that only
*retried* heavily leaves no other trace — and on a 500 with nothing in your
node's logs, that message is usually the whole diagnosis.

A retry count in the thousands means requests are being rejected or dropped. On a
public endpoint that is throttling. On your own node, look for `UND_ERR_SOCKET`
or `ECONNRESET` (the node is dropping connections — try `--concurrency 16`),
`HTTP 404` (it does not have that history: still syncing, or pruned), or
`TimeoutError` (requests wedging).

`TimeoutError` is worth understanding, because the engine only checks its round
budget *between* batches: one request that never answers holds up its whole batch
of `--concurrency` fetches, and a 10-second round can run for minutes. If your
rounds are taking far longer than `--round`, that is what is happening, and a
tighter `--request-timeout` is the fix. `--log-failures <file>` writes every attempt as JSONL for
digging further:

```bash
npm run trace -- <addr> --log-failures failures.jsonl
jq -r .reason failures.jsonl | sort | uniq -c | sort -rn     # what failed
jq -r 'select(.willRetry==false).path' failures.jsonl        # what was given up on
```

Each line carries `ts`, `path`, `attempt`, `status`, `reason`, `retryAfterSec`
and `willRetry`, so a request that failed twice and then succeeded is
distinguishable from one that was abandoned. The file is truncated per run.

Pointed at a public endpoint it warns you and throttles itself; it is built for
your own node.

---

## The risk model

The score is **"exchange-acceptance risk"** (0–100): higher = less likely a
regulated exchange accepts the coins / more likely to be flagged or frozen. It is
**not** a guilt score. Two independent factors combine by `max`:

1. **Label taint** — exposure to flagged entities, propagated downstream from a
   seed of documented addresses + the live OFAC list.
2. **Mixing exposure** — rises with the number of coinjoins the coins passed
   through. A coinjoin is a privacy tool, so 1–2 mixes is **medium**; only heavy
   remixing trends toward high.

| Category | Treatment |
|---|---|
| Exchange (KYC) | clean origin — good |
| Mining / coinbase | cleanest possible origin |
| Seizure (gov. custody) | low — government-controlled, not criminal |
| Coinjoin / PayJoin | **medium** (privacy, not proof of crime) |
| Stolen funds / hack | **high → critical** |
| Sanctioned / OFAC | **critical** |

Bands: `clean (<8) · low (8–25) · medium (25–50) · high (50–75) · critical (75+)`.

**Known limitations** (documented honestly in `/methodology`): the label set is
small beyond OFAC, so screening lights up on known entities but is blank for
unknown ones; PayJoin defeats detection by design; clustering can be fooled by
PayJoin/multi-party protocols. The engine is the moat — **broader attribution
data is the ongoing work**.

---

## Architecture

A single [Next.js](https://nextjs.org) (App Router) + TypeScript app. The graph
is a hand-written `<canvas>` force renderer (d3-force layout) — no off-the-shelf
graph component. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full tour.

```
app/
  page.tsx              landing ("is this coin safe to accept?")
  check/                the Coin Check verdict tool (headline feature)
  explore/              the graph explorer
  mempool/              live mempool view
  address/[address]/    address hub: balance, screening, provenance
  methodology/          how each heuristic works & where it breaks
  api/btc/[...path]/     Esplora proxy (allowlist + caching)
  api/screen/[address]/  JSON screening API
lib/
  api.ts                fetchers (proxy or direct) + query classification
  types.ts              all shared type definitions
  heuristics.ts         coinjoin / change / peel / consolidation + per-tx analysis
  cluster.ts            union-find common-input-ownership clustering
  trace.ts              BFS ancestry/descendant walk + risk propagation
  screening.ts          address screening / exposure analysis
  provenance.ts         source-of-funds backward walk
  labels.ts             curated entity labels (consumed via labelFor)
  ofac.ts               AUTO-GENERATED OFAC SDN sanctioned-address set
  format.ts             number formatting (BTC/sats, no sci-notation, tabular)
  colors.ts             semantic colour tokens + risk ramp
components/             canvas renderers + UI (Explorer, MempoolRain, Inspector, …)
scripts/
  update-ofac.mjs       refreshes lib/ofac.ts from the public OFAC mirror
  trace-full.mjs        CLI: runs lib/taint.ts to 100% against your own node
```

---

## Deploy

The app is a standard Next.js project and deploys to any Node host. On
[Vercel](https://vercel.com): import the repo, no configuration required (no env
vars needed for the public data source). Optionally set `ESPLORA_API_BASE` to use
your own node.

---

## Guardrails

The public API routes are **rate-limited** (`lib/ratelimit.ts`) as a baseline
guardrail against abuse into the upstream API, and the proxy enforces a strict
path **allowlist** (no SSRF). The limiter is per-instance on serverless — for
production-grade, distributed limiting, put Vercel's WAF or a shared store in
front. See [`PRINCIPLES.md`](./PRINCIPLES.md) for the engineering philosophy
(readiness, blast-radius containment, glass-box transparency) this project is
built on.

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`PRINCIPLES.md`](./PRINCIPLES.md). The single highest-impact contribution is
**more / better attribution data** (entity labels).

## License

[MIT](./LICENSE) — free to use, modify, and self-host.

## Acknowledgements

Bitcoin data via [mempool.space](https://mempool.space) / the Esplora API. OFAC
sanctioned-address list parsed from the U.S. Treasury SDN list via the
[0xB10C mirror](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses).
Inspired by mempool.space and commercial chain-analysis tools — built to make
those techniques transparent and contestable.
