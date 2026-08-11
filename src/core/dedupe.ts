/**
 * Cross-source deduplication.
 *
 * The same thing shows up repeatedly and Radar must show it once:
 *
 *   a paper    Europe PMC + Crossref + OpenAlex + (later) PubMed
 *   an event   Career Center feed + College of Engineering feed + a company's
 *              own listing, often with slightly different titles and rooms
 *
 * Two passes, in this order for a reason:
 *
 *   1. EXACT, by shared identity key, via union-find. Transitive by
 *      construction, which is what handles the awkward case: source A knows
 *      only the DOI, source B knows only the PMID, source C knows both and
 *      therefore welds A and B together. A pairwise scan would miss that.
 *   2. FUZZY, within same-vertical blocks, for items with no shared key.
 *      Deliberately conservative - a false merge HIDES an event, which is a
 *      worse failure than showing two cards. Every threshold below is set
 *      where a miss is cheaper than a mistake.
 *
 * Merging is not "pick one and discard". The survivor keeps the union of the
 * sources, the richest facet data, and the earliest `firstSeen`, because
 * `firstSeen` is what the "since your last visit" feed reads.
 */

import type { ItemSource, RadarItem, SourceId } from '@/types.ts';
import { baseConfidence } from '@/core/normalize.ts';
import { canonicalTitle, titleSimilarity } from '@/core/text.ts';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Title similarity required to merge two items that share no identity key.
 *
 * 0.82 is high. Measured against the failure it prevents: "Engineering Career
 * Fair - Day 1" and "Engineering Career Fair - Day 2" score ~0.79, and merging
 * those would erase a whole day of a career fair from the feed. Anything that
 * clears 0.82 without a shared key is nearly always genuine feed duplication.
 */
const FUZZY_TITLE_THRESHOLD = 0.82;

/**
 * How far apart two campus events may start and still be the same event.
 *
 * Feeds disagree by minutes constantly - one lists the doors-open time, another
 * the talk time. Two hours absorbs that. It is deliberately NOT a whole day:
 * a weekly seminar series shares its title across every instance, and a
 * day-wide window would collapse a semester of talks into one card.
 */
const EVENT_TIME_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * How far apart two papers may be dated and still be the same paper.
 *
 * Generous on purpose: a preprint's date and its journal publication date can
 * be a year apart, and Crossref's `issued` vs Europe PMC's `pubYear` routinely
 * differ by months for the same article.
 */
const PAPER_DATE_TOLERANCE_MS = 400 * 24 * 60 * 60 * 1000;

/** Corroboration bonus per additional independent source, and its ceiling. */
const CORROBORATION_STEP = 0.04;
const CONFIDENCE_CEILING = 0.99;

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    const seen: string[] = [];
    let current = key;
    while (true) {
      const next = this.parent.get(current);
      if (next === undefined || next === current) break;
      seen.push(current);
      current = next;
    }
    // Path compression keeps repeated lookups flat across thousands of items.
    for (const node of seen) this.parent.set(node, current);
    if (!this.parent.has(current)) this.parent.set(current, current);
    return current;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Confidence for a merged item.
 *
 * Starts at the best single source's base confidence and adds a step per
 * ADDITIONAL DISTINCT source. Distinct is the operative word: two feeds inside
 * calendar.tamu.edu are one publisher agreeing with itself, not independent
 * corroboration, so they count once. Capped below 1 - nothing here is certain.
 */
export function mergedConfidence(sources: readonly ItemSource[]): number {
  const distinct = new Set<SourceId>(sources.map((s) => s.source));
  let best = 0;
  for (const source of distinct) best = Math.max(best, baseConfidence(source));
  const bonus = Math.max(0, distinct.size - 1) * CORROBORATION_STEP;
  return Math.min(CONFIDENCE_CEILING, Number((best + bonus).toFixed(4)));
}

/** Prefer the longer of two strings; used for summaries and abstracts. */
function richer(a: string, b: string): string {
  return b.length > a.length ? b : a;
}

function earliest(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Rank for choosing which item's shape survives a merge.
 *
 * Base source confidence, plus a nudge for having a populated facet, so a
 * bare Crossref stub does not out-rank a full Europe PMC record with authors
 * and an abstract just because Crossref scores marginally higher.
 */
function canonicalRank(item: RadarItem): number {
  const source = item.sources[0]?.source ?? 'getinvolved';
  let rank = baseConfidence(source);
  if (item.research !== undefined) {
    if (item.research.abstract.length > 200) rank += 0.05;
    if (item.research.authors.length > 0) rank += 0.03;
  }
  if (item.campus !== undefined) {
    if (item.campus.location !== null) rank += 0.03;
    if (item.campus.startsAt !== null) rank += 0.03;
  }
  return rank;
}

/**
 * Fold a cluster into one item.
 *
 * The winner supplies identity and shape; every member supplies data. Fields
 * are combined by "most informative wins" rather than "first wins", so a
 * cluster never loses information it collectively had.
 */
export function mergeCluster(cluster: readonly RadarItem[]): RadarItem {
  const ordered = [...cluster].sort((a, b) => canonicalRank(b) - canonicalRank(a));
  const winner = ordered[0];
  if (winner === undefined) throw new Error('mergeCluster called with an empty cluster');
  if (ordered.length === 1) return winner;

  const merged: RadarItem = { ...winner };

  const sources: ItemSource[] = [];
  const seenSourceKeys = new Set<string>();
  const identity = new Set<string>(winner.identity);
  const tags: string[] = [...winner.tags];
  const seenTags = new Set(tags.map((t) => t.toLowerCase()));

  for (const item of ordered) {
    for (const source of item.sources) {
      const key = `${source.source}:${source.externalId}`;
      if (seenSourceKeys.has(key)) continue;
      seenSourceKeys.add(key);
      sources.push(source);
    }
    for (const key of item.identity) identity.add(key);
    for (const tag of item.tags) {
      const lower = tag.toLowerCase();
      if (seenTags.has(lower)) continue;
      seenTags.add(lower);
      tags.push(tag);
    }

    merged.summary = richer(merged.summary, item.summary);
    merged.firstSeen = earliest(merged.firstSeen, item.firstSeen);
    merged.lastSeen = latest(merged.lastSeen, item.lastSeen) ?? merged.lastSeen;
    merged.lastModified = latest(merged.lastModified, item.lastModified);
    merged.occurredAt = merged.occurredAt ?? item.occurredAt;
    merged.endsAt = merged.endsAt ?? item.endsAt;

    if (merged.research !== undefined && item.research !== undefined) {
      const a = merged.research;
      const b = item.research;
      merged.research = {
        ...a,
        doi: a.doi ?? b.doi,
        pmid: a.pmid ?? b.pmid,
        pmcid: a.pmcid ?? b.pmcid,
        arxivId: a.arxivId ?? b.arxivId,
        openAlexId: a.openAlexId ?? b.openAlexId,
        journal: a.journal ?? b.journal,
        authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
        abstract: richer(a.abstract, b.abstract),
        publishedDate: a.publishedDate ?? b.publishedDate,
        citedByCount: Math.max(a.citedByCount ?? 0, b.citedByCount ?? 0) || (a.citedByCount ?? b.citedByCount),
        isOpenAccess: a.isOpenAccess || b.isOpenAccess,
        openAccessUrl: a.openAccessUrl ?? b.openAccessUrl,
        topics: a.topics.length >= b.topics.length ? a.topics : b.topics,
        lifecycle: {
          // Highest version wins: a cluster holding v1 and v2 is a v2 paper.
          preprintVersion: Math.max(a.lifecycle.preprintVersion ?? 0, b.lifecycle.preprintVersion ?? 0) || null,
          publishedDoi: a.lifecycle.publishedDoi ?? b.lifecycle.publishedDoi,
          publishedIn: a.lifecycle.publishedIn ?? b.lifecycle.publishedIn,
          isSuperseded: a.lifecycle.isSuperseded || b.lifecycle.isSuperseded,
        },
      };
    }

    if (merged.campus !== undefined && item.campus !== undefined) {
      const a = merged.campus;
      const b = item.campus;
      merged.campus = {
        ...a,
        startsAt: a.startsAt ?? b.startsAt,
        endsAt: a.endsAt ?? b.endsAt,
        location: a.location ?? b.location,
        coordinates: a.coordinates ?? b.coordinates,
        organizer: a.organizer ?? b.organizer,
        onlineUrl: a.onlineUrl ?? b.onlineUrl,
        // If ANY source says cancelled, treat it as cancelled. A stale feed
        // still advertising a cancelled event is the common case; the reverse
        // (a feed inventing a cancellation) is not.
        isCancelled: a.isCancelled || b.isCancelled,
        isOnline: a.isOnline || b.isOnline,
        hasRegistration: a.hasRegistration || b.hasRegistration,
        audience: a.audience.length >= b.audience.length ? a.audience : b.audience,
        eventTypes: [...new Set([...a.eventTypes, ...b.eventTypes])],
        companies: [...new Set([...a.companies, ...b.companies])],
        // Keep the best-evidenced food signal across the cluster.
        food: foodRank(b.food.confidence) > foodRank(a.food.confidence) ? b.food : a.food,
        cost: a.cost ?? b.cost,
        compensation: a.compensation ?? b.compensation,
        compensationUsd: a.compensationUsd ?? b.compensationUsd,
        deadlineAt: a.deadlineAt ?? b.deadlineAt,
      };
    }
  }

  merged.sources = sources;
  merged.identity = [...identity].sort();
  merged.tags = tags;
  merged.sourceConfidence = mergedConfidence(sources);
  return merged;
}

function foodRank(confidence: string): number {
  return { confirmed: 3, provided: 2, mentioned: 1, none: 0 }[confidence] ?? 0;
}

// ---------------------------------------------------------------------------
// Blocking + fuzzy match
// ---------------------------------------------------------------------------

/**
 * Cheap blocking key so fuzzy comparison stays near-linear.
 *
 * Items only get compared when they share a block. The key is the first two
 * significant title tokens, which survives the edits feeds actually make
 * (suffixes, room numbers, "- Day 2") while cutting the comparison set from
 * O(n^2) over everything to O(n^2) within small buckets.
 */
function blockKey(item: RadarItem): string {
  const canonical = canonicalTitle(item.title);
  return canonical.split(' ').slice(0, 2).join(' ');
}

/**
 * Namespaces that name a thing globally rather than within one publisher.
 *
 * Two records with different DOIs are different works, full stop. Two records
 * with different `event:` ids may well be one event described twice.
 */
const GLOBAL_IDENTITY_NAMESPACES = ['doi:', 'pmid:', 'pmcid:', 'arxiv:', 'openalex:'];

function isGlobalIdentity(key: string): boolean {
  return GLOBAL_IDENTITY_NAMESPACES.some((namespace) => key.startsWith(namespace));
}

function timesAreClose(a: string | null, b: string | null, toleranceMs: number): boolean {
  if (a === null || b === null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= toleranceMs;
}

/**
 * Should these two be merged, absent a shared identity key?
 *
 * Requires a strong title match AND temporal agreement. Title alone is not
 * enough: recurring seminars, weekly club meetings, and career-fair day splits
 * all share titles by design, and collapsing them silently deletes events.
 */
export function shouldFuzzyMerge(a: RadarItem, b: RadarItem): boolean {
  if (a.vertical !== b.vertical) return false;

  // Disagreeing identifiers as a veto - but ONLY for globally-scoped ones.
  //
  // A DOI, PMID, or arXiv id names a work universally: if two records carry
  // different ones, they are different works, and no amount of title
  // similarity should override that.
  //
  // A LiveWhale `event:` id does NOT work that way. It is a per-record local
  // id, and the same real-world event routinely carries several - verified in
  // live data: "Women's Soccer Pre-Season Practice" appears under both
  // 'Rec Sports' and 'Department of Rec Sports' with the same start time and
  // two different ids, and one university deadline appears three times under
  // three departments. Vetoing on those ids left all of them as duplicate
  // cards, which is the exact failure this module exists to prevent.
  const aGlobal = a.identity.filter(isGlobalIdentity);
  const bGlobal = b.identity.filter(isGlobalIdentity);
  if (aGlobal.length > 0 && bGlobal.length > 0) {
    const aKeys = new Set(aGlobal);
    if (!bGlobal.some((key) => aKeys.has(key))) return false;
  }

  const similarity = titleSimilarity(a.title, b.title);
  if (similarity < FUZZY_TITLE_THRESHOLD) return false;

  if (a.vertical === 'campus') {
    const startA = a.campus?.startsAt ?? null;
    const startB = b.campus?.startsAt ?? null;

    // Both undated: study listings from Aggie Research Volunteers have no
    // start time by nature (they are open until they expire), so a time
    // comparison can never fire and they would never merge however identical
    // they are. Fall back to a near-exact title match plus the same organizer,
    // which is strict enough that a false merge is very unlikely.
    if (startA === null && startB === null) {
      const sameOrganizer = (a.campus?.organizer ?? '') === (b.campus?.organizer ?? '');
      return sameOrganizer && similarity >= 0.94;
    }

    // One dated, one not: no basis for comparison. Do not merge.
    if (startA === null || startB === null) return false;

    return timesAreClose(startA, startB, EVENT_TIME_TOLERANCE_MS);
  }

  // Research: dates are soft, so a very high title match can carry the merge
  // on its own, and a merely-good match needs date agreement to back it up.
  if (similarity >= 0.94) return true;
  return timesAreClose(
    a.research?.publishedDate ?? a.occurredAt,
    b.research?.publishedDate ?? b.occurredAt,
    PAPER_DATE_TOLERANCE_MS,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DedupeResult {
  items: RadarItem[];
  /** How many input items were folded away. */
  collapsed: number;
  /** Clusters with more than one member, for the ingest log. */
  clusters: { id: string; title: string; sources: SourceId[] }[];
}

/**
 * Collapse duplicates across sources.
 *
 * Output order is deterministic: clusters are emitted in the order their first
 * member appeared in the input, so a snapshot diff shows real changes rather
 * than reshuffling.
 */
export function dedupe(items: readonly RadarItem[]): DedupeResult {
  const uf = new UnionFind();

  // Pass 1 - exact, by shared identity key.
  // Each item is unioned with a synthetic node per identity key it carries, so
  // any two items sharing any key land in one set, transitively.
  for (const item of items) {
    uf.find(item.id);
    for (const key of item.identity) uf.union(item.id, `key:${key}`);
  }

  // Pass 2 - fuzzy, within blocks.
  const blocks = new Map<string, RadarItem[]>();
  for (const item of items) {
    const key = `${item.vertical}|${blockKey(item)}`;
    const bucket = blocks.get(key);
    if (bucket === undefined) blocks.set(key, [item]);
    else bucket.push(item);
  }

  for (const bucket of blocks.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        if (uf.find(a.id) === uf.find(b.id)) continue;
        if (shouldFuzzyMerge(a, b)) uf.union(a.id, b.id);
      }
    }
  }

  // Group, preserving first-appearance order.
  const groups = new Map<string, RadarItem[]>();
  for (const item of items) {
    const root = uf.find(item.id);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [item]);
    else group.push(item);
  }

  const out: RadarItem[] = [];
  const clusters: DedupeResult['clusters'] = [];
  let collapsed = 0;

  for (const group of groups.values()) {
    const merged = mergeCluster(group);
    out.push(merged);
    if (group.length > 1) {
      collapsed += group.length - 1;
      clusters.push({
        id: merged.id,
        title: merged.title,
        sources: [...new Set(merged.sources.map((s) => s.source))],
      });
    }
  }

  return { items: out, collapsed, clusters };
}
