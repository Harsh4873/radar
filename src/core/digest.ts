/**
 * The weekly digest.
 *
 * Radar ingests daily; the user-facing ritual is weekly. This builds the
 * "5 papers worth reading this week" / "3 events I'd seriously consider"
 * artifact at INGEST time rather than recomputing it per page view, for two
 * reasons: the digest for a past week must never change retroactively, and a
 * static site has no request-time compute anyway.
 *
 * The digest is intentionally short. A 40-item digest is a feed with extra
 * steps; the value is in the cut.
 */

import type { ChangeEvent, Digest, RadarItem, Vertical } from '@/types.ts';
import { byRelevance } from '@/core/rank.ts';

/** Hard ceiling on recommendations. The brief says five; this allows a little slack. */
const MAX_RECOMMENDED = 6;

/**
 * Reading-time estimate, minutes.
 *
 * Abstract length is a poor proxy for how long a paper takes to read, so this
 * is deliberately coarse and labelled as an estimate everywhere it appears.
 * ~12 minutes for a paper you actually engage with, longer for one with a
 * substantial abstract, which correlates loosely with a substantial paper.
 */
export function estimateReadingMinutes(item: RadarItem): number {
  if (item.research === undefined) return 0;
  const abstractWords = item.research.abstract.split(/\s+/).filter(Boolean).length;
  if (abstractWords === 0) return 8;
  return Math.min(45, 10 + Math.round(abstractWords / 40));
}

/** Monday 00:00 UTC of the week containing `iso`, as `YYYY-MM-DD`. */
export function weekOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const day = date.getUTCDay();
  // getUTCDay: 0 = Sunday. Shift so Monday starts the week.
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday));
  return monday.toISOString().slice(0, 10);
}

/**
 * One-line "why this is here" hook.
 *
 * Built from the item's own top scoring reasons rather than written by hand or
 * generated, so the digest can never claim something the ranking did not
 * actually credit.
 */
export function headlineFor(item: RadarItem): string {
  const top = item.reasons.filter((r) => r.points > 0).slice(0, 3).map((r) => r.label);
  if (top.length === 0) return item.summary.slice(0, 120);
  return top.join(' · ');
}

export interface DigestOptions {
  /** ISO timestamp of the ingest run. */
  now: string;
  /** Candidates seen before the relevance floor, for the "317 scanned" line. */
  scanned: number;
  /** How many items cleared the floor. */
  candidates: number;
  changes: readonly ChangeEvent[];
}

/**
 * Build this week's digest for one vertical.
 *
 * Only items FIRST SEEN in the current week are eligible. An item that has sat
 * in the feed for a month is not news, however well it scores - including it
 * would make every week's digest look identical.
 */
export function buildDigest(
  vertical: Vertical,
  items: readonly RadarItem[],
  options: DigestOptions,
): Digest {
  const week = weekOf(options.now);
  const weekStart = Date.parse(`${week}T00:00:00.000Z`);

  const fresh = items.filter((item) => {
    const seen = Date.parse(item.firstSeen);
    if (Number.isNaN(seen) || seen < weekStart) return false;
    // A cancelled event is news for the change list, not a recommendation.
    return item.campus?.isCancelled !== true;
  });

  const recommended = [...fresh].sort(byRelevance).slice(0, MAX_RECOMMENDED);

  return {
    weekOf: week,
    vertical,
    scanned: options.scanned,
    candidates: options.candidates,
    recommended: recommended.map((item) => item.id),
    headlines: recommended.map(headlineFor),
    changes: options.changes.filter((change) => change.kind !== 'summary'),
    estimatedMinutes: recommended.reduce((sum, item) => sum + estimateReadingMinutes(item), 0),
  };
}

/**
 * Merge a newly built digest into the stored history.
 *
 * Same week replaces (a re-run mid-week should refine, not duplicate); other
 * weeks are preserved. Capped so the file cannot grow without bound - a year
 * of two verticals is 104 entries.
 */
export function mergeDigests(existing: readonly Digest[], incoming: readonly Digest[], keep = 104): Digest[] {
  const byKey = new Map(existing.map((d) => [`${d.vertical}:${d.weekOf}`, d]));
  for (const digest of incoming) byKey.set(`${digest.vertical}:${digest.weekOf}`, digest);
  return [...byKey.values()]
    .sort((a, b) => (a.weekOf < b.weekOf ? 1 : a.weekOf > b.weekOf ? -1 : a.vertical.localeCompare(b.vertical)))
    .slice(0, keep);
}
