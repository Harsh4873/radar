# Radar phase 1 audit

**Status:** findings only. No product fixes in this change.
**Live:** https://harsh.bet/radar/
**Repo:** https://github.com/Harsh4873/radar
**Audited SHA:** `ea0475ce345ad7c700e069d0d561584118fd1df9` (`chore(data): refresh snapshot`, 2026-09-11 15:11 UTC)
**Snapshot `fetchedAt`:** `2026-09-11T15:04:24.714Z` (10:04 AM US Central) — matches the live footer.
**Method:** read source and workflows; `gh` for Actions/Pages; curl/GET against the live site; inspect committed `src/data/*.json`. No campus events, tickets, or literature hits were invented. Where a source was down or a field was empty, that is stated as missing.

There is no `AGENTS.md` in the published repo (it is gitignored). Privacy stance in README was treated as load-bearing.

---

## Verdict

The ingest → commit → `workflow_dispatch` → GitHub Pages path **is actually updating the live site**. The 11 Sep 15:04 UTC snapshot is what https://harsh.bet/radar/ is serving (footer, `Last-Modified: Fri, 11 Sep 2026 15:12:33 GMT`, paper/event/study counts).

The product still has two user-visible failures that break the promises on the tin:

1. **CampusRadar opens on a stale intramural season**, not today. Live `/radar/campus/` starts at Sunday 30 August (Battleship, Indoor Soccer) because IMLeagues is a hardcoded 16 Aug 2026 snapshot that bypasses the relevance floor and is sorted chronologically.
2. **Studies still ranks #8331 at $96/hr in live slot 2.** The listing pays $80 across two sessions of 40–50 minutes; the honest band is **$48–$60/hr**. This is the remaining top-of-board lie documented in `src/studies/__audit__.md` (F9) and still shipping.

Everything else is P1/P2: bioRxiv timed out on the last run, OpenAlex 429’d, coordinator emails sit in the public git snapshot, the campus HTML is 2.1 MB, research “Top” is methods-heavy rather than organism-first, and several honest pages (Sources, Topics, Digests) are almost unreachable from the nav.

---

## Pipeline: GitHub Actions → Pages

### What exists

| Workflow | Trigger | Role |
|---|---|---|
| `refresh.yml` | cron `20 11 * * *` and `20 23 * * *` UTC (~06:20 / 18:20 America/Chicago) + `workflow_dispatch` | Live ingest, collapse gate, astro build, `git add -f src/data/*`, commit, `gh workflow run deploy-pages.yml --ref main` |
| `deploy-pages.yml` | `push` to `main` + `workflow_dispatch` | Restore committed snapshot (no live ingest), test, build, upload Pages artifact |
| `ci.yml` | `push`/`pull_request` | Offline ingest + typecheck + tests + email-in-`dist/` guard |

Design notes that checked out:

- `GITHUB_TOKEN` commits **do not** retrigger `on: push`, so refresh must dispatch deploy explicitly. It does. Recent deploys are all `workflow_dispatch` immediately after a successful refresh.
- `src/data/` is gitignored and force-added because it is both the published snapshot and the change-detection baseline. Without the commit, every item would look new.
- `fetchedAt` is ignored by the material-change gate (`scripts/refresh-gate.ts`), so a no-op ingest does not commit twice a day.
- A collapse of more than half the item count refuses to publish unless `accept_collapse` is set.
- Email plaintext in `dist/` fails the refresh **before** commit (observed: run [32965282614](https://github.com/Harsh4873/radar/actions/runs/32965282614) on 2026-08-26 failed at “No contact addresses in the published output”; commit and deploy were skipped).

### Recent runs (as of 2026-09-11 ~18:30 UTC)

Last 14 days of `Refresh Radar data` + matching `Deploy Radar to GitHub Pages`: **all green**. Cadence is twice daily. Latest pair:

- Refresh [34613901248](https://github.com/Harsh4873/radar/actions/runs/34613901248) `schedule` 15:04–15:11 UTC → commit `ea0475c`
- Deploy [34614650903](https://github.com/Harsh4873/radar/actions/runs/34614650903) `workflow_dispatch` 15:11–15:12 UTC
- Pages environment deployment `6395981598` sha `ea0475c`, updated 15:12:38 UTC
- Live `Last-Modified: Fri, 11 Sep 2026 15:12:33 GMT`

CI does **not** run on `chore(data)` commits (token-push suppression). Deploy still typechecks, tests, and builds, so the data land is not untested. CI last ran on the 8 Sep code push `5a4fc70`.

### Drift and hygiene

- **Cron delay.** Scheduled for 11:20 and 23:20 UTC. Actual starts cluster around **15:00–15:15** and **01:00–01:20** UTC (~3.5–4 h late in the morning slot). Consistent with GitHub’s public-repo schedule delay, not a dead workflow. The comment in `refresh.yml` (“deliberately off the hour”) is not enough to beat that queue.
- **Actions Node 20 deprecation warning** on `actions/checkout@v4` and `actions/setup-node@v4` (forced onto Node 24). Not failing runs today.
- **npm cache** is hitting (`Cache hit occurred on the primary key…`). Not a staleness bug; the snapshot is committed, not restored from that cache.
- **GitHub Pages** `cache-control: max-age=600`, `build_type: workflow`, custom domain on the user site, **no CNAME in this repo** (correct). `custom_404: false`.
- **HTTPS cert** on harsh.bet: approved, `expires_at: 2026-10-14`. GitHub usually auto-renews; worth watching, not a break today.

**Conclusion:** the pipeline is live and coupled. Stale chores in the last two weeks are the intended `chore(data): refresh snapshot` commits, not stuck jobs. Failed jobs in the window: none. The one historical failure (26 Aug) failed closed on the email guard.

---

## Sources: what exists vs gaps

Live `/radar/campus/sources/` on this snapshot:

| Source | Status | Records this run | Notes |
|---|---|---|---|
| Europe PMC | ok | 57 | |
| PubMed / NCBI | ok | 13 | |
| **bioRxiv** | **failed** | **0** | `timeout after 20000ms`. Default HTTP timeout is 20s; `api.biorxiv.org` is not in `HOST_TIMEOUT_MS` (arXiv got 60s after the same class of bug). medRxiv on the same API took 86s and succeeded. ~20 bioRxiv papers remain via `retainUnfetched`. |
| medRxiv | ok | 281 | Date-range dump, then profile filter |
| **OpenAlex** | **degraded** | 16 | HTTP **429** on the TB + positive-selection query. Two failed requests. `RADAR_CONTACT_EMAIL` opts into the polite pool; could not list Actions secrets (403). |
| arXiv | ok | 170 | **No date window.** `sortBy=submittedDate` + `max_results=60` per query. That is why 2004–2017 methods papers are in the live feed. |
| Crossref | ok | 72 | Enrichment only (72/73 DOIs). `assertPlausibleDate` lives here, not on Europe PMC. |
| TAMU Events Calendar | ok | 5698 raw | Date-sharded to beat the 1000-record cap. “6 optional group feed(s) had no events” — LiveWhale returns 200 + `[]` on a title mismatch, so this is silent about *which* groups. |
| Get Involved | ok | 151 | Server-rendered `/events` HTML, up to 10×250 pages |
| IMLeagues | ok | 29 | **Not a live fetch.** Checked-in Fall 2026 snapshot, verified 2026-08-16. `durationMs: 2`. |
| Aggie Research Volunteers | ok (at ingest) | 84 | WordPress `wp/v2/study` |
| ClinicalTrials.gov | ok | 22 | API v2, TAMU sponsor + location, post-filtered |

Snapshot sizes after rank/dedupe/floor: **140 papers, 757 campus items, 100 studies** (84 ARV + 22 CT.gov, deduped). Research scanned 537 / matched 140. Campus scanned 5878 / matched 757.

### ARV at audit time (not at ingest time)

`GET https://research.tamu.edu/wp-json/wp/v2/study?per_page=1` and the human ARV page both returned **HTTP 503** during this audit (~18:30 UTC, ~3.5 h after the successful ingest). That is current upstream downtime, not a Radar invent. The next scheduled refresh will either carry the committed snapshot (studies ingest falls back) or skip if the gate sees a collapse. **Do not treat the live board as proof ARV is up right now.**

### Known, not ingested (already documented on Sources)

Gmail CampusRadar label, Instagram, X, YouTube. Reasons in `/radar/campus/sources/` are accurate: static site, no OAuth backend; Meta public-content caps; X is paid.

### Missing sources worth adding later (not present; not faked)

**Campus**

- Live IMLeagues / Rec Sports schedule (registration windows, Spring 2027, cancelled divisions). Today’s 29 sports are a frozen Fall 2026 dump.
- HireAggies / Handshake job and info-session APIs.
- 12th Man / athletics ticket inventory (calendar has game listings, not ticket state).
- Howdy/Compass class meeting times (different product; not an event feed).
- Canvas / Howdy announcements.
- Dining specials, Transit alerts as structured feeds (Transit Fall Service appears only if the calendar says so).
- Get Involved **organization directory** (events are in; orgs with no public event are correctly absent).
- MSC OPAS / ticketed performance inventory beyond LiveWhale.

**Research**

- Semantic Scholar / OpenAlex-as-primary-discovery with polite-pool identity.
- bioRxiv **subject** collections (currently: every preprint in the window, then profile-filter). The 20s timeout makes that design fragile.
- Europe PMC / PubMed query expansion (only seven `RESEARCH_QUERIES`; no “Mtb + PAML” pairing as its own query).
- Date filter on arXiv.
- `assertPlausibleDate` on Europe PMC (2027-04-26 WHO TB paper is live).
- Unpaywall / PMC full-text as a dedicated OA resolver (OpenAlex + source flags already cover some OA).

**Studies**

- Any participant board other than ARV + ClinicalTrials.gov (SONA, ResearchMatch, department flyers). Missing, not invented.
- ClinicalTrials.gov **pay and duration** — the registry does not publish them; CT.gov-only rows are unrated. Honest.
- Compensation from `content.rendered` is already a fallback (F3 in the studies audit); remaining holes are F9 / F7 / F4 / emails-in-git.

Fixtures `tamu-athletics.json` and `tamu-career-center.json` are captured for tests; Athletics and Career Center are also LiveWhale **group feeds**, not separate connectors.

---

## Ranking, explainability, change detection

### Research

Additive named reasons in `src/research/profile.ts` + `src/research/score.ts`. Cards show the top reasons; paper pages show the full split. `/radar/research/topics/` prints every term, weight, and live hit count. That part is good.

**What the live Top list actually is** (score ≥ 55, cap 15). Rank 1–4 on this snapshot are methods papers **without** *M. tuberculosis*:

| Score | Title (truncated) | Why |
|---:|---|---|
| 92 | Unique adaptive evolution of the synaptonemal complex… | +24 positive selection, +21 codon-model, +18 comparative genomics |
| 87 | Comparative chloroplast genomics of 75 *Asparagus* species… | same stack + PAML |
| 82 | Ultra-deep sequencing reveals intra-host diversity… | positive selection + codon-model (not Mtb) |
| 82 | Comparative Genomic Assessment of Invasive Potential… | same |
| 79 | Single-cell profiling of the lung immune cells of diabetes-tb… | actual core: +28 Mtb +17 diabetes |

Core band still requires the organism (`bandFor`). The **Top tab does not**. `FOR_YOU_MIN = 55` plus methods weights (24+21+18) puts a chloroplast paper above every TB paper. Recency is a modifier (`hasProfileMatch` gate holds — no “very recent + OA” ghosts). The 2027-04-26 WHO epidemic paper scores 78 with **+10 just posted** because `assertPlausibleDate` is Crossref-only.

arXiv methods queries have no `fromDate`, so 2011–2017 phylogenetics papers sit in “New” with −6 older work, still above the ingest floor.

### Campus

Same additive model. Timing is a first-class term (`imminenceSignal`). Food uses evidence tiers (`confirmed` / `provided` / `mentioned`); `mentioned` scores 0.

Distortion on this snapshot:

- Pattern `seminar` lives under **workshop / training** (+7). **384 / 757** items fire it, including every colloquium.
- Pattern `systems` under computer science matches “BAE Systems”, “electric transmission system”, etc. Only 11 CS hits, but several are false friends.
- **For You (score ≥ 55) has six campus events.** The campus index does not even put For You on the tab strip; it is a dropdown under “My events”. Default view is chronological **all**, which is why the stale IMLeagues rows are the first thing a visitor sees.
- IMLeagues items skip `INGEST_THRESHOLD` on purpose (`ingestCampus`). Past season starts then score 0 (`already happened` −60 + intramural +8) and remain in the agenda.

### Studies

Guaranteed $/hour, raffles excluded, unknown ≠ $0. The long-form correctness audit is `src/studies/__audit__.md` (three rounds). **Live board on this snapshot, ranked:**

1. `#9821` $137.50/hr — still the real top (ceiling close to floor).
2. **`#8331` $96.00/hr — still ~1.6–2× high (F9).** Duration `40-50 minutes` / `sessionCount: null` / confidence high on hours, low on pay. Body and compensation both describe two sessions for $80.
3. `#11315` $60.00 — exact.
4. `#12766` $60.00 — F2 fix holding.
5. `#9957` $45.00
6. `#10126` $40.00
7. `#8399` $33.33
8. `#8408` $33.33
9. **`#14020` $33.25/hr — new F7-shaped row** (not in the 86-record fixture). Raw: *“paid an average of $20 per hour, with the hourly rate beginning at $19 … increasing … to $28.50 and then $33.25”*. Ranked at the top of the ladder. `#14020` did not exist in the studies audit corpus; it is in the live 100-study snapshot.
10. `#6960` $30.00

Low confidence still ranks (F10). Ceilings still feed `guaranteedMax` into the rate (F6). Dedupe still keeps the newer IRB twin (F4). Unrated $1,000 study `#11321` is first among unknowns (F11 holding).

Raffle exclusion re-checked on `#8331`: $200 drawing is not in guaranteed pay.

### Change detection

Pipeline exists (`src/core/change.ts`, studies `diff.ts`). This run:

| Lane | added | removed | field changes |
|---|---:|---:|---:|
| Research | 34 | 24 | **0** |
| Campus | 147 | 143 | **12** (10 time, 1 location, 1 title) |
| Studies | 0 | 0 | 0 |

**UI:** Research “What changed” only lists `preprint-revised` / `preprint-published`. This run had none, so the live research page has **no change section** (confirmed). Campus has **no change list at all** — only `New` / `Updated` badges on cards, which do not say “room changed” or “start moved”. Studies UI has no change list; RSS union’s `diff.changed`. bioRxiv being down this run is exactly the source that feeds preprint version transitions.

`firstSeen` is carried forward. Retention on failed sources works (20 bioRxiv papers still present).

### Combined home

README: “`/radar` — the combined home: what is worth your time across all three.” Live `/radar/` is three path cards + “pick up where you left off” links. **No combined ranked feed.**

---

## Ranked issues

### P0

#### P0-1 — Campus agenda opens on an expired IMLeagues season

**Why it is P0:** the first screen of CampusRadar is “what’s on,” and it currently starts in late August.

**Repro**

1. Open https://harsh.bet/radar/campus/ (JS on or off).
2. Read the first agenda headings and first card titles.

**Observed 2026-09-11 (data gathered 10:04 AM Central):** headings `Sunday, August 30` → `September 1` → `4` → `8` → `9` → **then** `Friday, September 11`. First cards: Battleship Tournament, Indoor Soccer League (7v7), Kickball, Badminton, Pickleball, Fantasy Football Super-League. All `source: imleagues`, relevance 0, startsAt 2026-08-30 through 2026-09-09.

**Cause:** `src/campus/sources/imleagues.ts` is a public-page snapshot dated `VERIFIED_AT = 2026-08-16`. Registration windows in that file include `Aug 24 12:00PM – Aug 24 6:00PM` (Indoor Soccer) and similar closed windows. `ingestCampus` keeps every IMLeagues row regardless of score. `byCampusDate` sorts oldest-first. `KEEP_FINISHED_HOURS = 18` uses `endsAt ?? startsAt`; season end is still in the future, so August start dates survive.

**Do not invent replacements.** Until there is a live Rec Sports read, the honest fix is to stop leading the agenda with season-start timestamps that have already passed, or to drop/hide rows whose registration window is closed — without fabricating current divisions.

#### P0-2 — Studies rank 2 is still ~2× high (`#8331` at $96/hr)

**Why it is P0:** Studies’ product promise is “the top of this list is the best real deal.” Rank 2 is the first thing a rate-sorted reader acts on after the genuine $137.50 outlier.

**Repro**

1. Open https://harsh.bet/radar/studies/ (default ranked list).
2. Note live order: `#9821` $137.50, **`#8331` $96.00**, `#11315` $60, `#12766` $60.
3. Open the `#8331` study page. Compensation raw text: $30 first session + $50 second = $80. Duration raw: `40-50 minutes`. Body (ARV): two sessions.

**Arithmetic:** $80 / 0.67–0.83 h = $96–$120 if 40–50 min is the whole study; $80 / 1.33–1.67 h = **$48–$60** if it is per session. Compensation `visitCount` is null; duration `sessionCount` is null; `confidence` on pay is `low` and still ranks in the `great` bucket.

Pinned in `src/studies/__audit__.md` F9 across three re-audit rounds. `reconcileEffectiveHourly` cannot fix it (`sessionCount !== null` vetoes per-session hour scaling). Fix belongs in `parse-duration.ts` (multiply when compensation/body already named two sessions).

---

### P1

#### P1-1 — Campus listing is a 2.1 MB HTML document (757 cards)

**Repro:** `curl -sI https://harsh.bet/radar/campus/` then GET. Body **2,155,057 bytes**, 757 `data-item-id` nodes, all in one page for client-side filter/search. TTFB is fine (GitHub edge, ~45 ms here). Parse + layout + `feed.ts` walking every card on a phone is not. `/radar/profile/` is 610 KB; `/radar/research/` 515 KB; `/radar/studies/` 390 KB. No virtualization, no pagination, no JSON + render path.

Mobile CSS itself is thoughtful (44 px targets, 1-column filters under 40 rem, `touch-action: manipulation`). The weight still dominates.

#### P1-2 — Public git snapshot republishes coordinator emails

`dist/` and `/radar/studies/api/studies.json` are clean (API `contactEmail/Name/Phone` all null; live JSON has 0 address regex hits). **`src/data/studies.json` is force-committed** and currently holds **63 unique `contactEmail` values, 82 names, 38 phones**.

**Repro:** open https://github.com/Harsh4873/radar/blob/main/src/data/studies.json and search `@tamu.edu`, or `raw.githubusercontent.com/Harsh4873/radar/main/src/data/studies.json`.

That is the “clean structured list” `studies.json.ts` says it refuses to publish. The 26 Aug refresh already failed closed when an address reached `dist/`. The git snapshot is the remaining hole. Addresses are also on ARV’s own public API when it is up; Radar still promised not to mirror them into this repo.

#### P1-3 — bioRxiv ingest failed this run; preprint change-detection is blind

**Repro:** https://harsh.bet/radar/campus/sources/ → bioRxiv `failed`, `timeout after 20000ms`, 0 records. Research “What changed” absent on https://harsh.bet/radar/research/ (no `preprint-revised` / `preprint-published` events; `research.diff.changes.length === 0`). Twenty older bioRxiv items remain via retention, so the lane looks populated.

`HOST_TIMEOUT_MS` sets arXiv and NCBI but not `api.biorxiv.org`. medRxiv on the same host succeeded in 86 s of paging.

#### P1-4 — Research Top is methods-stack, not organism-first

**Repro:** https://harsh.bet/radar/research/ with tab Top (default). First cards are synaptonemal-complex / *Asparagus* chloroplast papers at 92 and 87. Hero copy: “15 are probably worth reading.” Compare `/radar/research/topics/` (core requires organism). Scoring is explainable and internally consistent; it does not match a TB-first reading of the product.

#### P1-5 — Future-dated paper gets “just posted”

**Repro:** research feed / paper page for “State of the global tuberculosis epidemic…” `publishedDate` / `occurredAt` **2027-04-26**, source Europe PMC, relevance 78, reason `+10 just posted`. `assertPlausibleDate` in `crossref.ts` would have dropped a 2106 Crossref date; it is not applied here.

#### P1-6 — arXiv methods firehose has no recency window

**Repro:** on https://harsh.bet/radar/research/ search or scan for “RNA-based Phylogenetic Methods” (2004), “Limitations of Markov chain Monte Carlo” (2005), etc. `fetchArxiv` does not pass the ingest `--days` window. 170 arXiv records this run; a large fraction predate 2025 and still clear the floor on phylogenetics + MCMC + OA.

#### P1-7 — Campus ranking: `seminar` ⇒ +7 workshop on ~half the board

**Repro:** any colloquium card, e.g. “Colloquium - Julian Wolfson”, shows `+7 workshop / training` because `CAMPUS_INTERESTS` workshop patterns include `seminar`. 384 items. Inflates academic events uniformly and compresses real workshops vs talks.

#### P1-8 — `#14020` ranked at the top of an hourly ladder ($33.25 vs stated average $20)

**Repro:** https://harsh.bet/radar/studies/ → rank 9, “From Fear to Reinforcement…”. Compensation raw: average $20/hr, beginning $19, rising to $28.50 then $33.25. Same F7 pattern as `#7660` / `#4632` in the studies audit. New live row; not in `fixtures/arv-snapshot.json`.

#### P1-9 — Remaining studies parser holes still shipping

See `src/studies/__audit__.md`. Still live: F4 (IRB dedupe drops the rankable twin), F6 (ceilings ranked as guaranteed), F7 (`hourlyMax` short-circuit), F10 (low confidence ranks), F12 (first-400 condition dropped), F13 (task bonus labelled raffle), F14 (keep-the-device perks = $0), F15 duration half (`#8338` 4 h vs 4.25 h). F1/F2/F3/F5/F8/F11/F16 hold on this snapshot.

#### P1-10 — OpenAlex 429

**Repro:** Sources page, OpenAlex `degraded`, note starts `query failed … HTTP 429 Too Many Requests`. 16 records still landed. Without a polite-pool mailto this will keep clipping the TB + selection query.

#### P1-11 — ARV 503 at audit time (stale-data risk, not a fake outage)

**Repro:** `curl -I https://research.tamu.edu/wp-json/wp/v2/study?per_page=1` → 503. Radar’s last successful ARV read was 15:04 UTC. Studies ingest is designed not to throw (fixture/cache fallback). Next refresh must not publish an empty studies snapshot; confirm the gate still refuses `empty`.

#### P1-12 — Campus field-level changes are computed and not shown

This run: 10 start-time edits, 1 location, 1 title. Campus UI has no “Room changed / time moved” list (the README example). Only a generic Updated badge. Research change UI is preprint-only and currently empty.

---

### P2

#### P2-1 — No in-site 404

https://harsh.bet/radar/this-does-not-exist/ → GitHub Pages stock 404 (“Page not found · GitHub Pages”), not Radar chrome, no link home. `custom_404` is false. Broken event/paper ids that were never built also 404 this way (static paths only exist for current snapshot ids).

#### P2-2 — Sources, Topics, Digests are almost undiscoverable

Sources: linked from `/radar/campus/clubs/` prose, not from header, footer, or home. Topics: linked from the research empty-state only. Digests: 10 stored weeks (campus + research, 2026-08-10 … 2026-09-07), no nav link from `/radar/research/`. Desktop `section-nav` is campus-only; on viewports &lt; 64 rem it is `display: none`.

#### P2-3 — Search is literal substring AND

Campus/research: `data-search` haystack = title, summary, tags, location, organizer, formatted date, journal, authors. Studies: same idea on card text. No stemming, no synonym (`tb` vs `tuberculosis`), no abstract-only fields beyond `summary`. Empty state exists (`data-empty-state`) and Reset/Clear work. `preventDefault` on submit — Enter does not navigate away. Query is mirrored into `?q=`. Fine for exact tokens; weak for the research profile’s own aliases.

#### P2-4 — Home is a directory, not a combined radar

https://harsh.bet/radar/ does not rank across engines. Quick links to `?personal=interested` / `going` / studies saved / profile work as URL contracts (`feed.ts` migrates old `tab=` bookmarks into the new selects).

#### P2-5 — Error states are honest on Sources, thin elsewhere

Sources is the right design (`failed` ≠ quiet zero). Feed pages do not banner “bioRxiv timed out” or “OpenAlex 429”. A visitor on Research sees 140 papers and no health chip. Cancelled campus events are badged and struck through (three “CANCELED: Maroon & White Night” rows). Studies expired rows sit in a collapsed `<details>`. JS-off: all items remain in the DOM; tabs/search/save do not. Studies eligibility with JS off does not hide listings (correct, fail-open).

#### P2-6 — Cron delay ~4 h on the morning slot

Documented above. Not a broken pipeline; freshness SLA is “twice a day,” not “at 06:20.”

#### P2-7 — CI skipped on data commits; Actions Node 20 warning

Deploy still tests. `checkout@v4` / `setup-node@v4` warn about Node 20 deprecation.

#### P2-8 — Comments / docs drift

- `src/campus/profile.ts` cites `src/client/personalize.ts` — file does not exist (logic is `src/client/feed.ts` + `store.ts`).
- `src/pages/studies/api/studies.json.ts` cites `DEPLOY.md` — missing (CORS note: static file; `Access-Control-Allow-Origin` only in `astro preview`).
- `fetch-studies.ts` still says `npm run fetch:data` (the command is `ingest` / `ingest:studies`).
- `notIngested` YouTube entry has a stray `way: true` field, unused.
- Studies `__audit__.md` still mentions cron `17 11 * * *`; current file is `20 11` / `20 23`.

#### P2-9 — HTTPS certificate expiry 2026-10-14

Pages API: approved cert for harsh.bet / www.harsh.bet. Watch auto-renewal; do not mint a CNAME in this repo.

#### P2-10 — Group-feed empty-list ambiguity

Six LiveWhale groups returned 0 events. A typo in `GROUP_FEEDS` looks identical to a quiet group. Names must match LiveWhale titles exactly (already documented in `tamu-calendar.ts`).

#### P2-11 — `robots: noindex` on every page

Intentional for a personal tool. Mentioned so a later “why isn’t this on Google” report is not a bug.

#### P2-12 — Recall handoff

Paper pages link `https://harsh.bet/research/?…` (200, 1.9 KB). Out of Radar’s tree; not audited as a reader. If Recall is down, the button still looks live.

---

## Broken links (checked)

Internal sample of campus events, IMLeagues events, papers, study slugs, Sources, Topics, Digests: **all 200**. `/radar` and `/radar/campus` 301 to trailing slash (Astro `trailingSlash: 'always'`). `harsh4873.github.io/radar/` 301s to the custom domain.

Source docs URLs: Europe PMC, PubMed, bioRxiv API, OpenAlex, arXiv, Crossref, LiveWhale feeds, IMLeagues SPA, Get Involved, ClinicalTrials.gov API: **200**. ARV human page and WP JSON: **503 at audit time** (see P1-11).

No CNAME in `dist/` (deploy assertion). `/radar/_astro/` prefix present on live home.

---

## Mobile / UX notes (non-ranked)

- Viewport meta, `color-scheme: light dark`, skip link, 44 px nav/tabs, campus filters collapse to a 6.5 rem + field grid under 40 rem: done.
- Header is a left rail from 64 rem; below that it wraps. Brand tagline hidden under 40 rem.
- 757-card page on a phone is the real mobile bug (P1-1), not missing media queries.
- Studies filter bar + screening profile are local-first; vault sync is behind a footer `<details>`. No analytics (matches README).
- Food badges distinguish tiers; raffles are not painted as wages on `RateBadge`.

---

## What is working (do not “fix”)

- Twice-daily refresh really does republish Pages; live footer matches `fetchedAt`.
- Email guard on `dist/` fail-closes (26 Aug).
- `retainUnfetched` kept bioRxiv papers instead of marking them NEW.
- Research `hasProfileMatch` still blocks recency-only junk.
- Campus food evidence tiers; cancelled strike + badge.
- Studies raffle split; F1 multi-visit hours; F2 per-visit scope; F3 content fallback; F5 unrankable EMA; F8 contingent $5; F11 unrated money-first; F16 exact $60.00 — all holding on this snapshot.
- Studies public JSON redacts contact fields.
- Identity-derived ids; series collapse ≠ dedupe.
- Get Involved is a real HTML source, not a stub.
- Privacy: saved/dismissed/tracked/screening stay in the browser / owner vault; ingest does not read them.

---

## Suggested fix order (for a later phase; not done here)

1. Stop IMLeagues season-start dates from leading `/radar/campus/` when those starts are already past; then replace the 16 Aug dump with a live public read if one exists without private SPA calls.
2. Multiply `#8331` duration by the two sessions the same record already states; keep low-confidence rows out of `great`.
3. Raise bioRxiv timeout (or page like medRxiv); apply `assertPlausibleDate` to Europe PMC; add an arXiv `fromDate`.
4. Redact `contactEmail` / `contactPhone` / `contactName` **before** `git add -f src/data/studies.json` (keep dist/API guards).
5. Paginate or window the campus agenda so the HTML is not 2.1 MB.
6. Surface source health and campus field diffs on the feeds that people actually open.

---

## Audit artifacts

| Item | Value |
|---|---|
| Live Pages sha | `ea0475ce345ad7c700e069d0d561584118fd1df9` |
| Live `fetchedAt` | 2026-09-11T15:04:24.714Z |
| Papers / campus / studies | 140 / 757 / 100 |
| Research scanned → matched | 537 → 140 (29 ≥ 55, Top tab caps at 15) |
| Campus For You (≥ 55) | 6 |
| Studies live / ranked / expired | 88 / 63 / 12 |
| Studies unique emails in git snapshot | 63 |
| Campus HTML bytes | 2,155,057 |
| Last failed refresh | 2026-08-26, email-in-dist guard |
| ARV at audit clock | HTTP 503 |

No campus events, tickets, or papers were added to any feed as part of this audit.
