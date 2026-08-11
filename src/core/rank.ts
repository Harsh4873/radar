/**
 * Explainable ranking.
 *
 * The product rule: Radar never shows a score it cannot itemize. A card says
 *
 *   Relevance 94
 *   +28 M. tuberculosis   +21 positive-selection methodology
 *   +17 diabetes cohort   +13 cites tracked literature
 *
 * not a bare 94. So scoring is additive over named signals and this module
 * owns the arithmetic; the vertical scorers only decide which signals fire and
 * how hard. `finalizeScore` asserts the reasons reconcile with the score in
 * development, which turns "a silent unexplained bonus" from a subtle product
 * bug into a loud test failure.
 *
 * Why additive rather than a learned model: the corpus is one user's, there is
 * no labelled training data, and an uninterpretable 0.87 would be worse than
 * useless here. Weights are editorial and live next to the code that uses them.
 */

import type { RadarItem, RelevanceReason } from '@/types.ts';
import { calendarDaysUntil } from '@/core/text.ts';

// ---------------------------------------------------------------------------
// Reason construction
// ---------------------------------------------------------------------------

/** Build a reason, rounding points so the rendered numbers are clean. */
export function reason(signal: string, label: string, points: number): RelevanceReason {
  return { signal, label, points: Math.round(points) };
}

/** Drop zero-point reasons, merge duplicates, and sort by contribution. */
export function tidyReasons(reasons: readonly RelevanceReason[]): RelevanceReason[] {
  const byKey = new Map<string, RelevanceReason>();
  for (const item of reasons) {
    if (item.points === 0) continue;
    const key = `${item.signal}|${item.label}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { ...item });
    else existing.points += item.points;
  }
  return [...byKey.values()]
    .filter((r) => r.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.label.localeCompare(b.label));
}

/**
 * Sum reasons into a 0..100 score.
 *
 * Clamping is where the additive model leaks: a paper that fires every signal
 * could exceed 100, and clamping means its reasons no longer sum to its score.
 * That is accepted and made explicit - the UI reads `relevance` for the number
 * and `reasons` for the "why", and a clamped item is by definition a maximal
 * match where the exact total stopped mattering.
 */
export function finalizeScore(reasons: readonly RelevanceReason[]): {
  relevance: number;
  reasons: RelevanceReason[];
} {
  const tidied = tidyReasons(reasons);
  const raw = tidied.reduce((sum, r) => sum + r.points, 0);
  return { relevance: Math.max(0, Math.min(100, Math.round(raw))), reasons: tidied };
}

// ---------------------------------------------------------------------------
// Shared signals
// ---------------------------------------------------------------------------

/**
 * Recency, for items whose value decays with age (papers).
 *
 * Step function, not a curve. A smooth decay implies a precision the input
 * does not have - half these dates are month-precision, and several upstreams
 * disagree by weeks about the same paper. Steps also render honestly: "very
 * recent" is a claim the data supports; "recency 0.732" is not.
 */
export function recencySignal(occurredAt: string | null, now: string): RelevanceReason | null {
  // Calendar days here too, for the same stability reason: publication dates
  // are frequently midnight-stamped, so elapsed-hours arithmetic would flip a
  // whole day's worth of papers between bands at the same instant every day.
  const until = calendarDaysUntil(occurredAt, now);
  const age = until === null ? null : -until;
  if (age === null) return null;

  // Future-dated publication (feeds do this for "in press") counts as brand new.
  if (age < 0) return reason('recency', 'just posted', 10);
  if (age <= 3) return reason('recency', 'very recent', 10);
  if (age <= 14) return reason('recency', 'recent', 7);
  if (age <= 45) return reason('recency', 'this month', 4);
  if (age <= 180) return reason('recency', 'this year', 1);
  if (age <= 730) return null;
  // Old work is not penalised into oblivion - a 2013 paper can still be the
  // most relevant thing found. The penalty just breaks ties against fresh work.
  return reason('recency', 'older work', -6);
}

/**
 * Imminence, for items that expire (events).
 *
 * Mirror image of recency: an event is most useful shortly before it happens
 * and worthless afterwards. A finished event scores strongly negative so it
 * falls out of the feed without needing a separate filter.
 */
export function imminenceSignal(startsAt: string | null, now: string): RelevanceReason | null {
  // CALENDAR days, not elapsed hours - see `calendarDaysUntil`. This is both
  // what "today" and "tomorrow" actually mean and what keeps a score from
  // drifting between two ingests minutes apart.
  const daysUntil = calendarDaysUntil(startsAt, now);
  if (daysUntil === null) return null;

  if (daysUntil < -1) return reason('timing', 'already happened', -60);
  if (daysUntil < 0) return reason('timing', 'happening now', 6);
  if (daysUntil === 0) return reason('timing', 'today', 14);
  if (daysUntil === 1) return reason('timing', 'tomorrow', 12);
  if (daysUntil <= 7) return reason('timing', 'this week', 9);
  if (daysUntil <= 21) return reason('timing', 'in the next 3 weeks', 5);
  if (daysUntil <= 60) return reason('timing', 'later this term', 2);
  return reason('timing', 'far out', -2);
}

/**
 * Corroboration across independent sources.
 *
 * Only fires from the second distinct source onward - one source confirming
 * itself is not evidence. Small by design: corroboration is a tie-breaker
 * between similarly relevant items, not a reason to surface something the
 * user does not care about.
 */
export function corroborationSignal(item: RadarItem): RelevanceReason | null {
  const distinct = new Set(item.sources.map((s) => s.source)).size;
  if (distinct < 2) return null;
  return reason('sources', `${distinct} sources confirm`, Math.min(6, (distinct - 1) * 3));
}

/** Cancelled items stay visible (the user may have been going) but sink. */
export function cancellationSignal(item: RadarItem): RelevanceReason | null {
  if (item.campus?.isCancelled !== true) return null;
  return reason('status', 'cancelled', -45);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Feed order: relevance, then the sooner/newer thing, then a stable id tiebreak.
 *
 * The final id comparison matters more than it looks - without it, two items
 * with identical scores could swap places between runs and show up as churn in
 * the committed snapshot diff.
 */
export function byRelevance(a: RadarItem, b: RadarItem): number {
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;

  const aTime = a.campus?.startsAt ?? a.occurredAt;
  const bTime = b.campus?.startsAt ?? b.occurredAt;
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    // Events sort soonest-first; papers sort newest-first.
    const direction = a.vertical === 'campus' ? 1 : -1;
    return direction * (Date.parse(aTime) - Date.parse(bTime));
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The relevance floor for the "For You" feed.
 *
 * The brief is explicit that For You should show 5-15 things, not 174. This is
 * the aggressive cut; `New` and the per-category tabs show everything above
 * the much lower ingest floor.
 */
export const FOR_YOU_THRESHOLD = 55;

/** Ingest floor. Below this an item is not written to the snapshot at all. */
export const INGEST_THRESHOLD = 12;

/** Apply a score to an item, returning a new object. */
export function scoreItem(item: RadarItem, reasons: readonly RelevanceReason[]): RadarItem {
  const { relevance, reasons: tidied } = finalizeScore(reasons);
  return { ...item, relevance, reasons: tidied };
}
