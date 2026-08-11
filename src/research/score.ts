/**
 * ResearchRadar ranking.
 *
 * Produces the itemized "why Radar picked it" list the cards render:
 *
 *   Relevance 94
 *   +28 M. tuberculosis        +21 codon-model analysis
 *   +17 diabetes / host        +13 cites tracked literature
 *   +10 very recent            +5  watched author
 *
 * Every point traces to a named signal. Two rules keep that honest:
 *
 *   - A profile term fires ONCE regardless of how often it appears. Counting
 *     occurrences would rank a long paper that says "tuberculosis" forty times
 *     above a precise one that says it twice.
 *   - Matching runs over title + abstract only. Not the full text (not
 *     available), and not the keyword/MeSH bag alone (indexers are generous,
 *     and a MeSH term of "Tuberculosis" on a health-policy paper is not a
 *     reason to surface it to someone studying selection in the genome).
 */

import type { RadarItem, RelevanceReason, ResearchBand } from '@/types.ts';
import { corroborationSignal, reason, recencySignal, scoreItem } from '@/core/rank.ts';
import { matchProfile, searchable, type ProfileMatch } from '@/research/profile.ts';

/** What the user has told Radar to care about, beyond the static profile. */
export interface ResearchContext {
  now: string;
  /** OpenAlex ids of works the user saved or tracked. Drives citation proximity. */
  trackedWorkIds?: ReadonlySet<string>;
  /** Lowercased author names on the watchlist. */
  watchedAuthors?: ReadonlySet<string>;
  /** Lowercased institution/lab names on the watchlist. */
  watchedInstitutions?: ReadonlySet<string>;
  /** Profile term ids the user marked "not relevant". */
  mutedTerms?: ReadonlySet<string>;
}

/**
 * Band verdict, from the profile matches.
 *
 * `core` is the red band on the home page, so the bar is a genuine core-topic
 * hit rather than "anything that matched at all". A paper that only fires
 * methods terms is a methods paper even if it also mentions the organism in
 * passing - which is the correct read for a tooling paper benchmarked on TB.
 */
export function bandFor(matches: readonly ProfileMatch[]): ResearchBand {
  let core = 0;
  let methods = 0;
  let hasOrganism = false;
  for (const match of matches) {
    if (match.term.band === 'core') core += match.term.weight;
    else if (match.term.band === 'methods') methods += match.term.weight;
    if (match.term.signal === 'organism') hasOrganism = true;
  }

  // CORE REQUIRES THE ORGANISM. Weight alone is not enough, and a live run
  // proved why: 24 of 51 "core" papers had no organism hit at all - fish
  // mitogenomes and RNA-replication models that fired `positive selection`
  // plus a methods term. Those are real methods papers and belong in the
  // methods band; calling them core makes the red "highly relevant" count on
  // the home page meaningless, which is the one number that has to be true.
  if (hasOrganism && core >= 24) return 'core';
  // A very high core score without the organism is still core-adjacent work
  // (e.g. TB-free comparative genomics of a related pathogen).
  if (core >= 45) return 'core';
  if (methods >= 18) return 'methods';
  return 'adjacent';
}

/** Signal families that come from the profile itself, as opposed to modifiers. */
const PROFILE_SIGNALS = new Set(['organism', 'method', 'topic', 'host', 'domain']);

/**
 * Did anything about the CONTENT match, as opposed to its packaging?
 *
 * The gate that keeps the feed honest. bioRxiv and medRxiv are date-range
 * feeds, not topic queries - a run ingests every preprint posted in the
 * window, ~850 of them - so the profile scorer is the only filter. Without
 * this check, "very recent" (+10) plus "open access" (+4) clears the ingest
 * floor on its own, and a live run published 297 papers whose entire
 * justification was those two modifiers: coronary intervention, insomnia
 * therapy, virus biosensing. None of them matched a single profile term.
 *
 * Recency and access modify how much a relevant paper is worth. They are
 * never themselves a reason to surface one.
 */
export function hasProfileMatch(item: RadarItem): boolean {
  return item.reasons.some((r) => PROFILE_SIGNALS.has(r.signal) && r.points > 0);
}

/**
 * Score one paper.
 *
 * Returns the item with `relevance` and `reasons` populated, plus the band
 * written into the research facet.
 */
export function scoreResearchItem(item: RadarItem, context: ResearchContext): RadarItem {
  const research = item.research;
  if (research === undefined) return scoreItem(item, []);

  const reasons: RelevanceReason[] = [];
  const haystack = searchable(item.title, research.abstract);
  const muted = context.mutedTerms ?? new Set<string>();

  // --- 1. Profile terms --------------------------------------------------
  const matches = matchProfile(haystack).filter((match) => !muted.has(match.term.id));
  for (const match of matches) {
    reasons.push(reason(match.term.signal, match.term.label, match.term.weight));
  }

  // --- 2. Combination bonus ----------------------------------------------
  // The specific intersection this research lives at. An organism hit and a
  // methods hit each mean something; together they mean this paper is doing
  // the same kind of work, which is worth more than the sum.
  const hasOrganism = matches.some((m) => m.term.signal === 'organism');
  const hasMethod = matches.some((m) => m.term.signal === 'method');
  const hasHost = matches.some((m) => m.term.signal === 'host');
  if (hasOrganism && hasMethod) {
    reasons.push(reason('combination', 'selection methods applied to Mtb', 12));
  }
  if (hasOrganism && hasHost) {
    reasons.push(reason('combination', 'TB + host metabolic angle', 10));
  }

  // --- 3. Recency --------------------------------------------------------
  const recency = recencySignal(research.publishedDate ?? item.occurredAt, context.now);
  if (recency !== null) reasons.push(recency);

  // --- 4. Citation proximity ---------------------------------------------
  // The graph signal: this paper cites work the user already cared about.
  // Capped so a review citing 300 papers cannot brute-force its way up.
  const tracked = context.trackedWorkIds;
  if (tracked !== undefined && tracked.size > 0) {
    const hits = research.citesTracked.filter((ref) => tracked.has(ref));
    if (hits.length > 0) {
      reasons.push(
        reason('citation', `cites ${hits.length} paper${hits.length === 1 ? '' : 's'} you saved`, Math.min(16, hits.length * 6)),
      );
    }
  }

  // --- 5. Author and lab watchlists --------------------------------------
  const watchedAuthors = context.watchedAuthors;
  if (watchedAuthors !== undefined && watchedAuthors.size > 0) {
    const hit = research.authors.find((author) => watchedAuthors.has(author.name.toLowerCase()));
    if (hit !== undefined) reasons.push(reason('author', `watched author: ${hit.name}`, 14));
  }

  const watchedInstitutions = context.watchedInstitutions;
  if (watchedInstitutions !== undefined && watchedInstitutions.size > 0) {
    const hit = research.authors.find(
      (author) => author.affiliation !== null && watchedInstitutions.has(author.affiliation.toLowerCase()),
    );
    if (hit?.affiliation != null) reasons.push(reason('lab', `watched lab: ${hit.affiliation}`, 10));
  }

  // --- 6. Access ---------------------------------------------------------
  // Small and unapologetic: a paper you can actually read today is more useful
  // than one behind a paywall. Not large enough to promote irrelevant work.
  if (research.isOpenAccess && research.openAccessUrl !== null) {
    reasons.push(reason('access', 'open access', 4));
  }

  // --- 7. Preprint lifecycle ---------------------------------------------
  if (research.lifecycle.publishedDoi !== null) {
    // Now peer-reviewed. Worth telling the user, but the preprint itself drops
    // down the feed because the published version supersedes it.
    reasons.push(reason('lifecycle', 'preprint now published', -8));
  } else if (research.kind === 'preprint' && (research.lifecycle.preprintVersion ?? 1) > 1) {
    reasons.push(reason('lifecycle', `revised preprint (v${research.lifecycle.preprintVersion})`, 5));
  }

  // --- 8. Corroboration --------------------------------------------------
  const corroboration = corroborationSignal(item);
  if (corroboration !== null) reasons.push(corroboration);

  // --- 9. Assessability --------------------------------------------------
  // No abstract means the profile only ever saw the title, so the score is
  // built on a fraction of the evidence. Flagging it is more honest than
  // pretending a title-only match is as strong as a full one.
  if (research.abstract.length < 80) {
    reasons.push(reason('evidence', 'title only - no abstract available', -6));
  }

  const scored = scoreItem(item, reasons);
  return {
    ...scored,
    research: { ...research, band: bandFor(matches) },
  };
}

/** Score a batch. */
export function scoreResearch(items: readonly RadarItem[], context: ResearchContext): RadarItem[] {
  return items.map((item) => scoreResearchItem(item, context));
}

/**
 * Link preprints to their published versions across the whole corpus.
 *
 * bioRxiv tells us "this preprint became DOI X"; if X is also in the corpus,
 * the two are related and the preprint is marked superseded. Run AFTER dedupe
 * so both sides are already merged, and BEFORE scoring so the lifecycle
 * penalty above can see the result.
 */
export function linkPreprintLifecycles(items: readonly RadarItem[]): RadarItem[] {
  const byDoi = new Map<string, RadarItem>();
  for (const item of items) {
    const doi = item.research?.doi;
    if (typeof doi === 'string') byDoi.set(doi, item);
  }

  return items.map((item) => {
    const research = item.research;
    const publishedDoi = research?.lifecycle.publishedDoi;
    if (research === undefined || publishedDoi == null) return item;

    const published = byDoi.get(publishedDoi);
    return {
      ...item,
      research: {
        ...research,
        lifecycle: {
          ...research.lifecycle,
          // Prefer the real journal name from the published record when Radar
          // also ingested it; fall back to whatever the preprint server said.
          publishedIn: published?.research?.journal ?? research.lifecycle.publishedIn,
          isSuperseded: true,
        },
      },
    };
  });
}
