# Radar Maintenance

This repository is the owner's personal discovery system: ResearchRadar (literature) and CampusRadar (Texas A&M), sharing one pipeline.

## Product Boundary

- Radar lives on `main` and publishes under `/radar/`.
- Do not add or modify PickLedger, betting, prediction, grading, player-prop, Gym, Daymark, Slate, Fare, Notes, or Recall source in this repository.
- ResearchRadar **finds**; Recall **understands**. Do not rebuild paper reading, annotation, or study-guide features here. The handoff is the "Open in Recall" link on the paper page, which passes identifiers and nothing else.
- `/studies` is a separate repo that indexes the same Aggie Research Volunteers registry. Radar reads it as one source among many; do not merge the two projects or move features between them.
- Keep Radar local-first. Saved, dismissed, and tracked items stay in the visitor's browser. Do not add an account, a server, a backend database, or analytics.

## Invariants — do not break these without reading why they exist

- **Item ids are identity-derived, not content-derived.** An event that changes rooms must keep its id, or every visitor silently loses their saved state on the next deploy. See `src/core/normalize.ts`.
- **Never claim food is free unless the source says so.** `FoodConfidence` has four tiers and the UI must render `confirmed`, `provided`, and `mentioned` differently. Never flatten them to a boolean or to the words "free food". See `src/campus/freebies.ts`.
- **A raffle is not money.** Lottery-shaped compensation yields `compensationUsd: null` and keeps the original wording. Never parse a raffle prize into a dollar figure.
- **Recency and open access never justify an item on their own.** Research items must match a profile term to be published at all (`hasProfileMatch`).
- **Connectors never throw.** A dead upstream produces a warning, a `SourceReport`, and a smaller feed — never a failed build.
- **Every point the ranker awards must be itemized in `reasons`.** If a scorer adds a silent bonus, the card is lying about why something is there.
- **Crossref is enrichment only.** Do not wire it to discovery; its free-text search returns unrelated work with impossible dates.

## Privacy — the hard rule

`calendar.tamu.edu` publishes `registration_owner_email` (a real staff address) on well over half its events, and the study registry publishes a coordinator address on nearly every listing. This site deploys publicly.

- Connectors must never read those fields into a `RawItem`.
- `stripEmails` runs over every text field in `normalize.ts`.
- CI and both deploy paths fail the build if any email address appears in `dist/`.

Do not weaken any of the three. They are independent on purpose.

## Being a good guest

Radar reads public university and government APIs that owe this project nothing.

- Keep the descriptive User-Agent with its contact URL on every request.
- Per-host rate limits live in `src/core/http.ts` and are enforced by hostname so the budget holds across every caller. NCBI is 3 req/s unkeyed; arXiv asks for one request per three seconds.
- Do not add a connector that scrapes a client-rendered page. `src/campus/sources/getinvolved.ts` documents why that was refused for Get Involved: it would work today, break silently on the next front-end deploy, and return zero events that look exactly like a quiet week.
- Do not increase the ingest schedule beyond twice daily without a reason.

## Verification

- Never open the deployed site, a browser preview, rendered output, or live URL to verify Radar. The owner confirms production behavior.
- Agents may inspect source, build output paths as text, tests, GitHub Actions, and APIs.
- Tests must stay hermetic: parse `fixtures/`, never the network. Connectors take an injectable `fetchImpl` for this.
- Before publishing, run `npm run test:run`, `npm run typecheck`, and `npm run build`.
- After changing a connector, run `npm run ingest` once and read the summary. The funnel counts (scanned → published) and the top-5 listings are the fastest way to catch a ranking regression.

## GitHub Publish

- Commit Radar work on `main`; every push runs the Pages deployment workflow.
- `deploy-pages.yml` builds the **committed** snapshot rather than running a live ingest — a deploy must not depend on eight upstreams being healthy. `refresh.yml` owns data freshness and dispatches the deploy when it lands new data.
- `src/data/` is git-ignored but `refresh.yml` force-adds the snapshots, because they are also the change-detection baseline and the build input for CI.
- Commits and pushes must come from the currently logged-in GitHub user.
- Never add AI co-author trailers, `Co-authored-by:` lines, or AI/Cursor/Codex taglines.
- Do not overwrite or revert unrelated user changes. Do not force-push to `main`.

## Privacy in the repo

These repositories deploy publicly. Never write the owner's real name, personal email, home location, or other personal/sensitive details into committed files (source, docs, AGENTS.md, CLAUDE.md) or commit messages. Refer to "the owner" generically; the GitHub commit identity is the only owner reference that belongs in the repo.
