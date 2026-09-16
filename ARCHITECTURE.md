# Architecture

A deep tour for anyone picking up, extending, or taking over HEURISTIC. Read
[`README.md`](./README.md) first for the what-and-why; this is the how.

## Stack

- **Next.js (App Router) + TypeScript** — server routes for the API proxy &
  screening endpoint; everything else is client components.
- **Tailwind CSS v4** — design tokens live in `app/globals.css` and `brand.md`.
- **d3-force** — physics for the graph layout only. All rendering is
  hand-written `<canvas>` 2D — there is **no graph library**.
- **No database, no auth, no env vars required.** State is URL params +
  `localStorage` (watchlist, data-source choice). All data is fetched live.

## Data flow

```
Browser ──▶ /api/btc/[...path]  ──▶ mempool.space (Esplora API)   [public mode]
        └─▶ your own node (direct, in-browser)                    [custom mode]
```

`lib/api.ts` is the single fetch layer. `restUrl()` (in `lib/datasource.ts`)
decides per-request whether to hit the proxy (public) or the user's node
directly (custom). The proxy (`app/api/btc/[...path]/route.ts`) enforces a
**regex allowlist** of Esplora paths and adds caching — it will not proxy
arbitrary URLs.

### Why a proxy at all?

1. Avoids CORS issues against mempool.space in public mode.
2. Adds server-side caching for immutable chain data.
3. Slices the multi-MB `/mempool/txids` response down to a small sample
   server-side (see `TXIDS_LIMIT`).

In **custom mode** the proxy is bypassed entirely so queries never touch the
app's server — that's the privacy guarantee.

## The analysis pipeline

```
trace(seedTxid, opts)                         lib/trace.ts
  ├─ BFS walk: ancestors (input→prevout) and/or descendants (output→spend)
  ├─ per-tx: analyzeTx()                       lib/heuristics.ts
  │    ├─ detectCoinjoin / detectChange / isPeelChain / isConsolidation
  │    ├─ extraSignals (address reuse, dusting, round payment, self-transfer)
  │    └─ risk = max(label taint, mixing exposure, direct label)
  ├─ AddressClusters (union-find)              lib/cluster.ts
  ├─ label taint propagation (inheritedRisk map)
  └─ cumulative coinjoin count via edge relaxation → mixingRiskFor()
        → final per-node re-analysis
```

Key design decisions:

- **Fan-out cap** — each tx expands only its top-N highest-value inputs/outputs
  (`fanout`), so a 100-input sweep can't saturate the graph and `depth` stays
  meaningful.
- **Node budget** — total nodes are capped (`maxNodes`); "both" direction splits
  the budget ~50/50 so descendants aren't starved by a large ancestor tree.
- **Risk = two factors combined by `max`**: *label taint* (flagged provenance →
  red) and *mixing exposure* (coinjoin count → medium, scaling up). A coinjoin
  only goes red when its source is actually flagged. See `mixingRiskFor()`.

### Value-weighted taint (the "check everything" engine)

`lib/taint.ts` → `traceTaint(seedTxid, fetchTx, opts, resume?)` propagates the
coin's value backward across the **whole** ancestor DAG (haircut taint), stopping
a branch only at a definitive origin — a labelled entity, a coinbase, a coinjoin
— or once its value share drops below `EPS`.

The binding constraint is **fetch throughput, not compute**: every ancestor is a
network round-trip. So the trace is **resumable** — it expands the highest-value
frontier within a node/time budget, returns a serializable `TaintState`, and the
next call picks up exactly where it stopped. That is what `/check`'s *keep
crawling* button does, one budget at a time.

`scripts/trace-full.mjs` drives that same loop to completion from the CLI
(`npm run trace`), which is only practical against your own node — see the README.
It imports `lib/taint.ts` directly rather than reimplementing anything, so a CLI
result and a UI result cannot drift. Node runs the TypeScript natively (22.6+);
a small `registerHooks` resolver in the script supplies the extension resolution
Node's ESM loader doesn't do for `lib/*.ts`'s extensionless imports.

### Screening & provenance (the product layer)

- `app/api/screen/[address]/route.ts` deliberately exposes only the **shallow**
  screening (direct counterparties): one upstream call, cheap and cacheable. It
  takes no depth/coverage parameter, because an endpoint that fans out to
  thousands of upstream fetches per anonymous request is an abuse vector, not a
  feature. Deep tracing lives in the UI (budgeted, user-driven) and in the CLI
  (your own node, your own capacity).
- `lib/screening.ts` → `buildScreening(address, txs, graph?)` — direct
  counterparty exposure + indirect ancestry exposure, aggregated by category
  into one acceptance-risk score. Pure function; reused by the UI **and** the
  JSON API.
- `lib/provenance.ts` → `traceProvenance(seedTxid, fetchTx)` — a single-path
  backward walk along the dominant input until it hits coinbase / an exchange /
  a flagged entity / the hop limit.
- `components/CoinCheck.tsx` turns both into the Safe / Review / Avoid verdict.

## Labels & attribution (the most important data)

`lib/labels.ts` exposes `labelFor(address)` — the single chokepoint every
heuristic consumes. It checks a small curated `SEED_LABELS` array, then falls
back to the **OFAC SDN** set in `lib/ofac.ts`.

- `lib/ofac.ts` is **auto-generated** — never edit by hand. Run
  `npm run update-ofac` (`scripts/update-ofac.mjs`) to refresh it from the
  public OFAC mirror. It bundles a dated snapshot for offline/deterministic use.
- To grow attribution, add to `SEED_LABELS` (with a `source`) **or** swap
  `labelFor` for a real attribution dataset/API — everything downstream just
  works. **Be conservative**: a wrong "exchange/clean" label is worse than no
  label (it falsely clears coins). Verify every address on-chain first.

Categories and their risk weights live in `CATEGORY_META` (`lib/screening.ts`).

## The canvas renderers

- `components/GraphCanvas.tsx` — the explorer graph. d3-force computes positions;
  a `requestAnimationFrame` loop draws nodes/edges/labels. Includes pan/zoom,
  drag, hover spotlight (dims non-connected nodes), auto-fit-on-settle, and the
  single-click-select / double-click-recenter model.
- `components/MempoolRain.tsx` — the falling-transaction physics. Custom
  gravity + inelastic circle collisions with a guaranteed gap, area-capped so it
  always packs without overlap, with a fade-out for retired bubbles. Physics
  constants were tuned against a headless convergence test (see commit history /
  the comments) — **if you change sizing or density, re-verify zero overlap**.

Both deliberately avoid React re-renders in the hot path (refs + rAF, not state).

## Conventions

- **Money colours**: BTC/sats = orange (`--accent`), USD = green (`--clean`).
  Always pair a number with a unit.
- **Number formatting** goes through `lib/format.ts` — no scientific notation,
  `--` for invalid, tabular-nums in CSS.
- Design language is documented in `brand.md` (the "forensics workstation"
  aesthetic). Keep the two canvas views visually consistent.

## Testing

There's no test suite yet (a good first contribution). The physics and risk
calibration have historically been verified with throwaway headless Node scripts
and Playwright screenshots. `playwright` is a devDependency for visual checks.
