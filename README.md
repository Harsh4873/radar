# Radar

Three discovery engines over one pipeline, published at `https://harsh.bet/radar/`.

- **CampusRadar** (`/radar/campus`) — watches Texas A&M and tells you which of ~2,000 listings you'd actually care about.
- **Studies** (`/radar/studies`) — ranks Aggie Research Volunteers listings by guaranteed pay per hour. Screening profile and filters stay local-first.
- **ResearchRadar** (`/radar/research`) — watches the literature and tells you which papers are worth reading, with the reasons shown.
- **`/radar`** — the combined home: what is worth your time across all three.

They share ingestion, change detection, and the private owner vault. Only the ranking differs: literature and campus score relevance; studies score guaranteed $/hour. Raffles are never counted as pay.

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

Studies is the same idea for paid research: the official board never puts pay and time on one axis, so Radar parses both, divides guaranteed dollars by stated hours, and ranks. A prize drawing is shown separately and never treated as a wage.

## Architecture

```
   RESEARCH                          CAMPUS                         STUDIES
   Europe PMC  PubMed                TAMU calendar (main + group)   Aggie Research Volunteers
   bioRxiv     medRxiv               Get Involved student events     (WordPress study API)
   OpenAlex    arXiv                 IMLeagues Fall 2026 public
   Crossref (enrichment only)
        │                                  │                              │
        └──────────────┬───────────────────┴──────────────┬───────────────┘
                       ▼                                  ▼
                   RAW ITEMS                         STUDY RECORDS
                       ▼                                  ▼
      NORMALIZE     clean text, strip emails,      parse pay / time / eligibility
                    stable ids                     strip contact addresses
                       ▼                                  ▼
      DEDUPE        union-find on identity keys    collapse duplicate IRB postings
                       ▼                                  ▼
      ENRICH        Crossref metadata
                       ▼                                  ▼
      RANK          additive over named signals    guaranteed $/hour (never raffles)
                       ▼                                  ▼
      DIFF          against the previous snapshot
                       ▼
                 FEED · CHANGE LIST · /radar/studies
```

Everything upstream is read at **build time**. Not one of these APIs sends CORS headers, so a browser `fetch()` to any of them is blocked — the browser only ever gets static JSON. See the note in `astro.config.mjs`.

## Commands

```bash
npm install
npm run ingest      # pull every upstream, rank, diff, write src/data/
npm run ingest:studies
npm run dev         # local site
npm run test:run    # hermetic - never touches the network
npm run typecheck
npm run build       # ingest + astro build
```

Useful flags: `npm run ingest -- --only=campus`, `--only=studies`, `--offline`, `--days=30`.

Optional environment (see `.env.example`): `NCBI_API_KEY` raises E-utilities from 3 to 10 requests/second; `RADAR_CONTACT_EMAIL` opts into Crossref's and OpenAlex's polite pools. Neither is required, and neither is ever written into the output.

## Things worth knowing before changing this

**Item ids are identity-derived, not content-derived.** An event that changes rooms keeps its id, so your saved/dismissed state survives. Only `contentHash` moves, and that's what change detection reads.

**Never claim food is free unless the source says so.** `src/campus/freebies.ts` returns a tier — `confirmed` / `provided` / `mentioned` / `none` — and the UI renders all three differently. "Coffee Chat with the Dean" contains the word "coffee" and is not free coffee.

**Campus never publishes participant recruitment.** The Aggie Research Volunteers registry and equivalent calendar language belong to Studies. Academic papers, seminars, organizations, sponsors, and research events remain in Campus and Research.

**Studies ranks guaranteed pay, not relevance.** Unknown rates are a separate section, never sorted as $0. Prize drawings are labelled as chance, never as wages. The screening profile defaults every question to "prefer not to say" so an unanswered criterion cannot hide a listing.

**Emails never reach the build.** `calendar.tamu.edu` publishes `registration_owner_email` — a real staff address — on well over half its events, and the study registry publishes coordinator addresses. Three defences: the connectors never read those fields, `stripEmails` / hex-tokenized contact buttons scrub free text, and CI fails the build if an address appears anywhere in `dist/`.

**Recency is a modifier, not a reason.** A paper matching no profile term is not published however new it is. An early run published 297 papers whose entire justification was "very recent" plus "open access" — coronary intervention, insomnia therapy, virus biosensing. `hasProfileMatch` is the gate that fixed it.

**Crossref is enrichment, not discovery.** Its free-text search returns a paper about teacher efficacy in Kenya as the top hit for a tuberculosis query, dated `date-parts: [[2106]]`. It's an excellent metadata registry and a poor relevance engine; `assertPlausibleDate` exists because of that 2106.

**Dates with no timezone are UTC.** WordPress returns `2025-02-17T15:53:22` with no zone, and `new Date()` parses that as *local* time — so the same input produced instants seven hours apart on a laptop in US Central and a CI runner in UTC, flipping 62 items to "Updated" on every alternation. `toIso` pins bare datetimes to UTC.

**Timing bands are calendar days, not elapsed hours.** An event at 9am tomorrow is "tomorrow" even when it is 26 hours away. Elapsed-hours arithmetic also made a dozen events flip bands together at round times, so the snapshot differed between ingests three minutes apart for no reason a reader would recognise.

**A failed request never deletes anything.** arXiv timed out on two of three queries in one live run; ten papers dropped out of the feed and came back marked NEW next time. `retainUnfetched` carries forward items whose every source was unreachable. It keys off `failedRequests > 0`, *not* `status === 'degraded'` — the TAMU calendar reports its 1000-record cap as a warning on every healthy run, and keying off that would retain every past event forever.

**Series collapsing is not deduplication.** Dedupe merges records that are the same thing seen through different feeds. `src/campus/series.ts` merges records that are *different* things you think of as one — a five-day conference published as five events with five ids.

## Layout

```
src/
  types.ts              the central RadarItem contract
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
    sources/            tamu-calendar · getinvolved · imleagues
  studies/
    parsers for pay, time, eligibility, and the ARV fetch
  client/               local-first owner-vault state and browser re-ranking
  pages/                the routes, including /studies/
fixtures/               frozen real upstream responses; the test corpus
scripts/                ingest · capture-fixtures
```

## Privacy

Radar has no analytics. Saved, dismissed, tracked, author, company, feedback, visit, study-filter, and screening-profile state stays local-first; after a provisioned Google sign-in it mirrors to the same private owner vault as the other harsh.bet apps. It never enters public ingest or ranking. `/radar/research/watchlist/` can export or clear the private research state.
