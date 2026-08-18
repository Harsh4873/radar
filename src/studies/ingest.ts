/**
 * Studies ingestion: Aggie Research Volunteers registry.
 *
 * The upstream API sends no CORS header, so this is the only place the
 * registry is read. Ranking is guaranteed $/hour, not Radar relevance, which
 * is why studies stay a parallel snapshot rather than RadarItems.
 *
 * This function does not throw. Network failure falls back to the committed
 * fixture; a stale index beats a broken deploy.
 */

import { readFile } from 'node:fs/promises';
import type { Logger } from '@/types.ts';
import { consoleLogger } from '@/core/http.ts';
import { fetchAllStudies, fetchTaxonomies } from '@/studies/fetch-studies.ts';
import { normalizeAndDedupe, unexpectedLifecycleValues } from '@/studies/normalize.ts';
import { diffSnapshots } from '@/studies/diff.ts';
import type { Snapshot, SnapshotDiff, StudyRecord, TaxonomyMaps } from '@/studies/types.ts';

const STUDIES_SNAPSHOT_URL = new URL('../data/studies.json', import.meta.url);

export interface StudiesIngestOptions {
  now: string;
  offline?: boolean;
  log?: Logger;
}

export interface StudiesIngestResult {
  snapshot: Snapshot;
  taxonomies: TaxonomyMaps;
  diff: SnapshotDiff & { generatedAt: string; previousFetchedAt: string | null };
  source: 'network' | 'fixture' | 'cache' | 'empty';
  warnings: string[];
}

function byId(a: StudyRecord, b: StudyRecord): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function loadPreviousSnapshot(): Promise<Snapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STUDIES_SNAPSHOT_URL, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Snapshot).studies)) {
      return parsed as Snapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export async function ingestStudies(options: StudiesIngestOptions): Promise<StudiesIngestResult> {
  const log = options.log ?? consoleLogger;
  const warnings: string[] = [];
  const previous = await loadPreviousSnapshot();
  const now = new Date(options.now);

  if (options.offline === true) {
    if (previous !== null && previous.studies.length > 0) {
      log.warn('[studies] offline mode - keeping the committed snapshot');
      return {
        snapshot: previous,
        taxonomies: { category: {}, location: {}, sessionType: {}, topic: {} },
        diff: {
          generatedAt: previous.fetchedAt,
          previousFetchedAt: previous.fetchedAt,
          added: [],
          removed: [],
          changed: [],
        },
        source: 'cache',
        warnings: ['offline mode'],
      };
    }
    log.warn('[studies] offline mode with no committed snapshot - normalizing the fixture');
  }

  const [studiesResult, taxonomyResult] = options.offline === true
    ? [
        await fetchAllStudies({ allowFallback: true, log, fetchImpl: async () => {
          throw new Error('offline');
        } }),
        await fetchTaxonomies({ allowFallback: true, log, fetchImpl: async () => {
          throw new Error('offline');
        } }),
      ]
    : [await fetchAllStudies({ log }), await fetchTaxonomies({ log })];

  warnings.push(...studiesResult.warnings, ...taxonomyResult.warnings);

  if (studiesResult.source === 'fixture' && previous !== null && previous.studies.length > 0) {
    warnings.push('network read failed; keeping the previous snapshot rather than overwriting it with fixture data');
    log.warn('[studies] SOURCE=cache - fixture fallback skipped because a real snapshot already exists');
    return {
      snapshot: previous,
      taxonomies: taxonomyResult.taxonomies,
      diff: {
        generatedAt: previous.fetchedAt,
        previousFetchedAt: previous.fetchedAt,
        added: [],
        removed: [],
        changed: [],
      },
      source: 'cache',
      warnings,
    };
  }

  if (studiesResult.studies.length === 0) {
    if (previous !== null && previous.studies.length > 0) {
      warnings.push('studies fetch returned nothing; keeping the previous snapshot');
      log.warn('[studies] SOURCE=cache - previous snapshot retained');
      return {
        snapshot: previous,
        taxonomies: taxonomyResult.taxonomies,
        diff: {
          generatedAt: previous.fetchedAt,
          previousFetchedAt: previous.fetchedAt,
          added: [],
          removed: [],
          changed: [],
        },
        source: 'cache',
        warnings,
      };
    }
    log.error('[studies] no records from network, fixture, or previous snapshot');
    return {
      snapshot: { fetchedAt: options.now, totalFromHeader: 0, studies: [] },
      taxonomies: taxonomyResult.taxonomies,
      diff: { generatedAt: options.now, previousFetchedAt: null, added: [], removed: [], changed: [] },
      source: 'empty',
      warnings,
    };
  }

  const { studies: deduped, dropped, groups, failures } = normalizeAndDedupe(studiesResult.studies, {
    taxonomies: taxonomyResult.taxonomies,
    now,
  });

  for (const failure of failures) {
    log.error(`[studies] skipped malformed record ${String(failure.id)}: ${failure.error}`);
    warnings.push(`skipped malformed record ${String(failure.id)}`);
  }

  const studies = [...deduped].sort(byId);
  const snapshot: Snapshot = {
    fetchedAt: studiesResult.fetchedAt,
    totalFromHeader: studiesResult.totalFromHeader,
    studies,
  };
  const diff = diffSnapshots(previous, snapshot);

  if (groups.length > 0) {
    log.info(`[studies] collapsed ${dropped.length} duplicate posting(s) across ${groups.length} IRB group(s)`);
  }
  const drift = unexpectedLifecycleValues();
  if (drift.length > 0) {
    warnings.push(`lifecycle values outside 3|6|12 observed: ${drift.join(', ')}`);
  }

  return {
    snapshot,
    taxonomies: taxonomyResult.taxonomies,
    diff: {
      generatedAt: snapshot.fetchedAt,
      previousFetchedAt: previous?.fetchedAt ?? null,
      ...diff,
    },
    source: studiesResult.source,
    warnings,
  };
}
