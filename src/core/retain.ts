/**
 * Retention across a partial upstream failure.
 *
 * THE BUG THIS EXISTS FOR, observed live: arXiv timed out on two of three
 * queries in one ingest. The connector behaved correctly - it reported
 * `DEGRADED` with both failures named - but the pipeline downstream treated
 * "arXiv did not return these papers" as "these papers are gone". Ten items
 * dropped out of the published feed, and on the next successful run they came
 * back marked NEW.
 *
 * That is wrong twice over. The papers never went anywhere, and telling
 * someone a 2023 paper is new because a server was slow is worse than not
 * mentioning it: the NEW badge is the one signal the whole product rests on.
 *
 * So: an item whose every source failed to deliver this run is CARRIED
 * FORWARD from the previous snapshot rather than dropped.
 *
 * THE PRECISION THAT MATTERS. Retention keys off `failedRequests > 0`, not off
 * `status === 'degraded'`. A source can be degraded for reasons that are not a
 * fetch failure - the TAMU calendar reports its 1000-record cap as a warning on
 * every healthy run - and keying off `degraded` would retain every past event
 * forever, quietly turning the feed into an archive that never forgets.
 *
 * Items that a HEALTHY source simply stopped returning are still dropped, which
 * is what should happen when an event passes or a listing is withdrawn.
 */

import type { RadarItem, SourceId, SourceReport } from '@/types.ts';

export interface RetainResult {
  items: RadarItem[];
  /** Items carried forward because their sources could not be reached. */
  retained: RadarItem[];
  /** The sources that failed to deliver, for the log and the warning. */
  impaired: SourceId[];
}

/**
 * Add back previous items that this run could not have seen.
 *
 * `next` wins wherever both have an item - a source that DID answer is the
 * more current truth. Only genuinely absent items are considered.
 */
export function retainUnfetched(
  previous: readonly RadarItem[] | null,
  next: readonly RadarItem[],
  reports: readonly SourceReport[],
): RetainResult {
  const impaired = new Set<SourceId>(
    reports.filter((report) => report.failedRequests > 0).map((report) => report.id),
  );

  if (previous === null || previous.length === 0 || impaired.size === 0) {
    return { items: [...next], retained: [], impaired: [...impaired] };
  }

  const present = new Set(next.map((item) => item.id));
  const retained: RadarItem[] = [];

  for (const item of previous) {
    if (present.has(item.id)) continue;

    // Only retain when EVERY source that knows this item was impaired. If any
    // healthy source could have returned it and did not, its absence is real.
    const sources = item.sources.map((source) => source.source);
    if (sources.length === 0) continue;
    if (!sources.every((source) => impaired.has(source))) continue;

    // Carried forward untouched apart from the status. It is not 'new', it did
    // not 'update' - Radar simply could not check on it this run.
    retained.push({ ...item, status: 'unchanged' });
  }

  return { items: [...next, ...retained], retained, impaired: [...impaired] };
}
