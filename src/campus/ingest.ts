/**
 * CampusRadar ingestion.
 *
 * Shorter funnel than the research side because the sources are cleaner - a
 * university calendar is already structured, where a literature search is not:
 *
 *   TAMU calendar (main + ~23 group feeds)
 *        -> normalize          strip emails, clean HTML, stable ids
 *        -> dedupe             the same event appears in several group feeds
 *        -> score              interests + value + timing
 *        -> drop finished      an event that ended is not "content"
 */

import type { Logger, RadarItem, RawItem, SourceReport, SourceResult } from '@/types.ts';
import { consoleLogger, type RequestOptions } from '@/core/http.ts';
import { dedupe } from '@/core/dedupe.ts';
import { normalizeAll } from '@/core/normalize.ts';
import { INGEST_THRESHOLD, byRelevance } from '@/core/rank.ts';
import { fetchTamuCalendar } from '@/campus/sources/tamu-calendar.ts';
import { GET_INVOLVED_REPORT } from '@/campus/sources/getinvolved.ts';
import { collapseSeries } from '@/campus/series.ts';
import { scoreCampus, type CampusContext } from '@/campus/score.ts';

const LABELS: Record<string, string> = {
  'tamu-calendar': 'TAMU Events Calendar',
};

const DOCS: Record<string, string> = {
  'tamu-calendar': 'https://calendar.tamu.edu/feeds/',
};

function reportFor(result: SourceResult<unknown>): SourceReport {
  return {
    id: result.source,
    label: LABELS[result.source] ?? result.source,
    vertical: 'campus',
    status: result.error !== null ? 'failed' : result.warnings.length > 0 ? 'degraded' : 'ok',
    itemCount: result.records.length,
    fetchSource: result.fetchSource,
    durationMs: result.durationMs,
    failedRequests: result.failedRequests,
    note: result.error ?? (result.warnings[0] ?? null),
    docsUrl: DOCS[result.source] ?? '',
  };
}

/**
 * How long after an event ends it stays in the snapshot.
 *
 * Not zero. An event that finished this morning is still worth showing today
 * (it explains why a room was busy, and the user may want the recording), and
 * the "already happened" scorer has already pushed it to the bottom. Past this
 * window it is dropped entirely so the snapshot does not grow without bound.
 */
const KEEP_FINISHED_HOURS = 18;

export interface CampusIngestOptions extends RequestOptions {
  now: string;
  /** How far ahead to pull events. */
  days?: number;
  log?: Logger;
  context?: Partial<CampusContext>;
  offline?: boolean;
}

export interface CampusIngestResult {
  items: RadarItem[];
  scanned: number;
  matched: number;
  reports: SourceReport[];
  warnings: string[];
}

/**
 * Participant-recruitment studies belong exclusively in harsh.bet/studies.
 * Keep academic talks, papers, symposia, sponsors, and research organizations
 * in Radar; remove invitations asking a person to become a study subject.
 */
export function isParticipantResearchStudy(item: RawItem): boolean {
  if (item.source === 'aggie-research-volunteers') return true;
  const text = `${item.title} ${item.summary} ${item.tags.join(' ')} ${item.campus?.compensation ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ');
  const recruitment = /\b(participants? needed|seeking participants?|recruiting participants?|volunteers? needed|take part in (?:a|our|this) study|participate in (?:a|our|this) study|study participants?|paid study|clinical trial participants?)\b/;
  const studyContext = /\b(research study|clinical trial|human subjects?|irb|compensation|paid|participant)\b/;
  return recruitment.test(text) && studyContext.test(text);
}

export async function ingestCampus(options: CampusIngestOptions): Promise<CampusIngestResult> {
  const log = options.log ?? consoleLogger;
  const days = options.days ?? 45;
  const reports: SourceReport[] = [];
  const warnings: string[] = [];

  if (options.offline === true) {
    log.warn('[campus] offline mode - no upstream reads');
    return { items: [], scanned: 0, matched: 0, reports, warnings: ['offline mode'] };
  }

  // --- 1. Fetch ----------------------------------------------------------
  const results: SourceResult<RawItem>[] = [];
  results.push(await fetchTamuCalendar({ ...options, days }));

  for (const result of results) {
    reports.push(reportFor(result));
    warnings.push(...result.warnings.map((w) => `${result.source}: ${w}`));
  }

  // Registered but deliberately not implemented - the Sources page explains why.
  reports.push(GET_INVOLVED_REPORT);

  const fetched = results.flatMap((result) => result.records);
  const raws = fetched.filter((item) => !isParticipantResearchStudy(item));
  const excludedStudies = fetched.length - raws.length;
  const scanned = fetched.length;
  if (excludedStudies > 0) {
    log.info(`[campus] excluded ${excludedStudies} participant-recruitment study record(s); Studies owns that vertical`);
  }
  log.info(`[campus] ${scanned} raw record(s) across ${results.length} source(s)`);

  // --- 2. Normalize ------------------------------------------------------
  const { items: normalized, skipped } = normalizeAll(raws, { now: options.now });
  if (skipped > 0) warnings.push(`campus: skipped ${skipped} unpublishable record(s)`);

  // --- 3. Dedupe ---------------------------------------------------------
  // Expect a lot of collapsing here: an event owned by 'College of Engineering'
  // also shows up in the main feed and often in a department feed, all sharing
  // one LiveWhale id, so pass 1 catches them exactly.
  const { items: deduped, collapsed, clusters } = dedupe(normalized);
  log.info(`[campus] dedupe collapsed ${collapsed} duplicate(s) into ${clusters.length} cluster(s)`);

  // --- 3b. Series --------------------------------------------------------
  // Separate step from dedupe on purpose: these are genuinely different events
  // (five days of one conference, five LiveWhale ids) that the user thinks of
  // as one thing. See src/campus/series.ts.
  const { items: series, collapsed: seriesCollapsed } = collapseSeries(deduped);
  log.info(`[campus] series collapsing folded ${seriesCollapsed} extra occurrence(s)`);

  // --- 4. Score ----------------------------------------------------------
  const context: CampusContext = {
    now: options.now,
    mutedInterests: options.context?.mutedInterests ?? new Set(),
    watchedCompanies: options.context?.watchedCompanies ?? new Set(),
  };
  const scored = scoreCampus(series, context);

  // --- 5. Drop what is over or irrelevant --------------------------------
  const cutoff = Date.parse(options.now) - KEEP_FINISHED_HOURS * 3_600_000;
  const survivors = scored.filter((item) => {
    const campus = item.campus;
    if (campus === undefined) return false;

    const end = campus.endsAt ?? campus.startsAt;
    if (end !== null) {
      const finishedAt = Date.parse(end);
      if (Number.isFinite(finishedAt) && finishedAt < cutoff) return false;
    }

    // Cancelled events are kept below the floor on purpose: the user may have
    // been planning to go, and "this got cancelled" is the single most useful
    // thing Radar can tell them that week.
    return item.relevance >= INGEST_THRESHOLD || campus.isCancelled;
  });

  log.info(`[campus] ${survivors.length}/${scored.length} kept after the floor and the past-events cut`);

  return {
    items: [...survivors].sort(byRelevance),
    scanned,
    matched: survivors.length,
    reports,
    warnings,
  };
}
