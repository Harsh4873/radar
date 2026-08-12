# Radar

Two discovery engines over one pipeline, published at `https://harsh.bet/radar/`.

- **ResearchRadar** (`/radar/research`) — watches the literature and tells you which papers are worth reading, with the reasons shown.
- **CampusRadar** (`/radar/campus`) — watches Texas A&M and tells you which of ~2,000 listings you'd actually care about.
- **`/radar`** — the combined home: what changed since your last visit.

They share ingestion, deduplication, ranking, change detection, and digests. Only the data differs.

## The idea

A PubMed alert tells you 30 things happened. Radar tells you five are worth reading and shows its working:

```
Relevance 94
  +28 M. tuberculosis        +21 codon-model analysis
  +17 diabetes / host        +13 cites 2 papers you saved
  +10 very recent            -6  title only, no abstract
```

Every point traces to a named rule in `src/research/profile.ts`. If a score looks wrong, you can see exactly why it happened and edit the line that caused it. There is no model to interrogate.

The other half is **change detection**. "What's new?" is answerable by any RSS reader. Radar keeps the previous snapshot and diffs against it, so it can answer *what changed*:

```
Google Tech Talk    Room changed: Zachry 297 → Zachry 420
Genomics seminar    CANCELLED
That preprint       bioRxiv v1 → v2
That preprint       now published in Evolutionary Applications
```

## Architecture

```
   RESEARCH                          CAMPUS
   Europe PMC  PubMed                TAMU calendar (main + 23 group feeds)
   bioRxiv     medRxiv               org · company · sponsor · campus events
   OpenAlex    arXiv
   Crossref (enrichment only)
        │                                  │
        └──────────────┬───────────────────┘
                       ▼
                   RAW ITEMS
                       ▼
      NORMALIZE     clean text, strip emails, stable ids
                       ▼
      DEDUPE        union-find on identity keys, then conservative fuzzy
                       ▼
      ENRICH        Crossref metadata, preprint→published linking
                       ▼
      RANK          additive over named signals, fully itemized
                       ▼
      DIFF          against the previous snapshot
                       ▼
              FEED · DIGESTS · CHANGE LIST
```

Everything upstream is read at **build time**. Not one of these APIs sends CORS headers, so a browser `fetch()` to any of them is blocked — the browser only ever gets static JSON. See the note in `astro.config.mjs`.

## Commands

```bash
npm install
npm run ingest      # pull every upstream, rank, diff, write src/data/
npm run dev         # local site
npm run test:run    # 146 tests, hermetic - never touches the network
npm run typecheck
npm run build       # ingest + astro build
```

Useful flags: `npm run ingest -- --only=campus`, `--offline`, `--days=30`.

Optional environment (see `.env.example`): `NCBI_API_KEY` raises E-utilities from 3 to 10 requests/second; `RADAR_CONTACT_EMAIL` opts into Crossref's and OpenAlex's polite pools. Neither is required, and neither is ever written into the output.

## Things worth knowing before changing this

**Item ids are identity-derived, not content-derived.** An event that changes rooms keeps its id, so your saved/dismissed state survives. Only `contentHash` moves, and that's what change detection reads.

**Never claim food is free unless the source says so.** `src/campus/freebies.ts` returns a tier — `confirmed` / `provided` / `mentioned` / `none` — and the UI renders all three differently. "Coffee Chat with the Dean" contains the word "coffee" and is not free coffee.

**Studies owns participant recruitment.** Radar does not ingest the Aggie Research Volunteers registry and filters equivalent recruitment language from calendar feeds and retained snapshots. Academic papers, seminars, organizations, sponsors, and research events remain in scope.

**Emails never reach the build.** `calendar.tamu.edu` publishes `registration_owner_email` — a real staff address — on well over half its events. Three defences: the connectors never read those fields, `stripEmails` scrubs free text, and CI fails the build if an address appears anywhere in `dist/`.

**Recency is a modifier, not a reason.** A paper matching no profile term is not published however new it is. An early run published 297 papers whose entire justification was "very recent" plus "open access" — coronary intervention, insomnia therapy, virus biosensing. `hasProfileMatch` is the gate that fixed it.

**Crossref is enrichment, not discovery.** Its free-text search returns a paper about teacher efficacy in Kenya as the top hit for a tuberculosis query, dated `date-parts: [[2106]]`. It's an excellent metadata registry and a poor relevance engine; `assertPlausibleDate` exists because of that 2106.

**Dates with no timezone are UTC.** WordPress returns `2025-02-17T15:53:22` with no zone, and `new Date()` parses that as *local* time — so the same input produced instants seven hours apart on a laptop in US Central and a CI runner in UTC, flipping 62 items to "Updated" on every alternation. `toIso` pins bare datetimes to UTC.

**Timing bands are calendar days, not elapsed hours.** An event at 9am tomorrow is "tomorrow" even when it is 26 hours away. Elapsed-hours arithmetic also made a dozen events flip bands together at round times, so the snapshot differed between ingests three minutes apart for no reason a reader would recognise.

**A failed request never deletes anything.** arXiv timed out on two of three queries in one live run; ten papers dropped out of the feed and came back marked NEW next time. `retainUnfetched` carries forward items whose every source was unreachable. It keys off `failedRequests > 0`, *not* `status === 'degraded'` — the TAMU calendar reports its 1000-record cap as a warning on every healthy run, and keying off that would retain every past event forever.

**Series collapsing is not deduplication.** Dedupe merges records that are the same thing seen through different feeds. `src/campus/series.ts` merges records that are *different* things you think of as one — a five-day conference published as five events with five ids.

## Layout

```
src/
  types.ts              the central contract
  core/                 vertical-agnostic engine
    http · text · xml · hash · normalize · dedupe · rank · change · digest
  research/
    profile.ts          the terms, weights, and phrases that define relevance
    score.ts            banding and scoring
    sources/            europepmc · pubmed · biorxiv · arxiv · openalex · crossref
  campus/
    profile.ts          the campus interest model
    classify.ts         category routing and employer extraction
    freebies.ts         the free-stuff evidence tiers
    series.ts           multi-day event collapsing
    sources/            tamu-calendar · getinvolved (documented refusal)
  client/               local-first owner-vault state and browser re-ranking
  pages/                the routes
fixtures/               frozen real upstream responses; the test corpus
scripts/                ingest · capture-fixtures
```

## Privacy

Radar has no analytics. Saved, dismissed, tracked, author, company, feedback, and visit state stays local-first; after a provisioned Google sign-in it mirrors to the same private owner vault as the other harsh.bet apps. It never enters public ingest or ranking. `/radar/research/watchlist/` can export or clear the private state.
