/**
 * Get Involved (getinvolved.tamu.edu) - REGISTERED, NOT IMPLEMENTED.
 *
 * This is not a stub someone forgot to finish. It is a deliberate, documented
 * "no", and it exists so the Sources page can say so out loud.
 *
 * WHAT WAS ACTUALLY TESTED (2026-08-10), all against the live site:
 *
 *   /api/discovery/event/list?take=3                    -> 200, text/html
 *   /api/discovery/event/search/newsfeed?...            -> 200, text/html
 *   /api/discovery/search/events?top=3&skip=0           -> 200, text/html
 *   /events.rss, /events/rss                            -> 200, text/html
 *   /events (page source, 78KB)                         -> no embedded data:
 *       no __INITIAL_STATE__, no window.__*, no application/ld+json,
 *       no data-props, no "startsOn" key anywhere in the markup
 *
 * Every path returns the same client-rendered SPA shell with HTTP 200 - the
 * platform soft-200s unknown routes rather than 404ing, so "it returned 200"
 * means nothing here. The event data is fetched by JavaScript after load from
 * an endpoint that is not publicly documented.
 *
 * WHY NOT SCRAPE IT ANYWAY: a headless browser would work today and break on
 * the next front-end deploy, silently, returning zero events that look exactly
 * like "a quiet week on campus". A source that fails silently is worse than a
 * source that is honestly absent - which is the entire reason `SourceStatus`
 * has an `unavailable` value distinct from `failed`.
 *
 * WHAT TO DO INSTEAD, in preference order:
 *   1. Ask TAMU Student Activities whether a public feed or API key exists.
 *   2. Cover the same ground through the LiveWhale group feeds already
 *      ingested - 'Department of Student Activities', 'MSC Student Programs',
 *      and '*Student Interest' carry a good share of student-org events.
 *   3. Use the manual "Send to Radar" path for one-off flyers.
 *
 * If a documented endpoint appears, implement `fetchGetInvolved` to match the
 * other connectors and flip `status` to 'ok'; nothing else needs to change.
 */

import type { SourceReport, SourceResult, RawItem } from '@/types.ts';

export const GET_INVOLVED_REPORT: SourceReport = {
  id: 'getinvolved',
  label: 'Get Involved (student orgs)',
  vertical: 'campus',
  status: 'unavailable',
  itemCount: 0,
  fetchSource: 'empty',
  durationMs: 0,
  note:
    'No public API. Every path returns the same client-rendered page with HTTP 200 and no embedded event data, so there is no stable, lawful way to read it. Student-org events are partially covered via the Student Activities, MSC, and Student Interest calendar feeds.',
  docsUrl: 'https://getinvolved.tamu.edu/events',
};

/**
 * Always returns zero records, immediately, without touching the network.
 *
 * Present so the ingest pipeline can treat this source uniformly rather than
 * special-casing its absence.
 */
export function fetchGetInvolved(): SourceResult<RawItem> {
  return {
    source: 'getinvolved',
    records: [],
    fetchSource: 'empty',
    warnings: [],
    error: null,
    durationMs: 0,
  };
}
