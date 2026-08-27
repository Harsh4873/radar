/**
 * Studies ingestion: Aggie Research Volunteers + ClinicalTrials.gov.
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
import {
  hydrateStudyRecord,
  mergeClinicalTrialRecords,
  normalizeClinicalTrials,
  stabilizeClinicalTrialIdentities,
  studyHasSource,
} from '@/studies/clinicaltrials-normalize.ts';
import { fetchClinicalTrials } from '@/studies/sources/clinicaltrials.ts';
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

function unchanged(previous: Snapshot): StudiesIngestResult['diff'] {
  return {
    generatedAt: previous.fetchedAt,
    previousFetchedAt: previous.fetchedAt,
    added: [],
    removed: [],
    changed: [],
  };
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
        diff: unchanged(previous),
        source: 'cache',
        warnings: ['offline mode'],
      };
    }
    log.warn('[studies] offline mode with no committed snapshot - normalizing the fixture');
  }

  const offlineFetch = async (): Promise<Response> => {
    throw new Error('offline');
  };
  const arvOptions = options.offline === true
    ? { allowFallback: true, log, fetchImpl: offlineFetch }
    : { log };
  const taxonomyOptions = options.offline === true
    ? { allowFallback: true, log, fetchImpl: offlineFetch }
    : { log };
  const clinicalOptions = options.offline === true
    ? { log, attempts: 1, fetchImpl: offlineFetch }
    : { log };

  const [studiesResult, taxonomyResult, clinicalResult] = await Promise.all([
    fetchAllStudies(arvOptions),
    fetchTaxonomies(taxonomyOptions),
    fetchClinicalTrials(clinicalOptions),
  ]);

  warnings.push(...studiesResult.warnings, ...taxonomyResult.warnings, ...clinicalResult.warnings);

  const { studies: deduped, dropped, groups, failures } = normalizeAndDedupe(studiesResult.studies, {
    taxonomies: taxonomyResult.taxonomies,
    now,
  });

  for (const failure of failures) {
    log.error(`[studies] skipped malformed record ${String(failure.id)}: ${failure.error}`);
    warnings.push(`skipped malformed record ${String(failure.id)}`);
  }

  const clinicalNormalized = normalizeClinicalTrials(clinicalResult.studies, { now });
  for (const failure of clinicalNormalized.failures) {
    log.error(`[studies] skipped malformed ClinicalTrials.gov record ${String(failure.id)}: ${failure.error}`);
    warnings.push(`skipped malformed ClinicalTrials.gov record ${String(failure.id)}`);
  }

  const previousStudies = (previous?.studies ?? []).map(hydrateStudyRecord);
  const previousArv = previousStudies.filter((study) => studyHasSource(study, 'aggie-research-volunteers'));
  const previousClinical = previousStudies.filter((study) => studyHasSource(study, 'clinicaltrials-gov'));

  const arvTrusted = studiesResult.source === 'network'
    && studiesResult.complete
    && failures.length === 0
    && deduped.length > 0;
  const clinicalTrusted = clinicalResult.source === 'network'
    && clinicalResult.complete
    && clinicalNormalized.failures.length === 0;

  const arvReason = arvTrusted
    ? null
    : studiesResult.source !== 'network'
      ? `source=${studiesResult.source}`
      : !studiesResult.complete
        ? 'the WordPress read was incomplete'
        : `${failures.length} normalization failure(s)`;
  const clinicalReason = clinicalTrusted
    ? null
    : clinicalResult.source !== 'network'
      ? `source=${clinicalResult.source}`
      : !clinicalResult.complete
        ? 'one or more registry queries were incomplete'
        : `${clinicalNormalized.failures.length} normalization failure(s)`;

  let retainedArv = false;
  let retainedClinical = false;
  const arvRecords = arvTrusted || previousArv.length === 0
    ? deduped
    : (retainedArv = true, previousArv);

  let clinicalRecords = clinicalNormalized.studies;
  if (!clinicalTrusted && previousClinical.length > 0) {
    retainedClinical = true;
    const currentIds = new Set(clinicalNormalized.studies.flatMap((study) =>
      study.sources.filter((source) => source.source === 'clinicaltrials-gov').map((source) => source.externalId)));
    clinicalRecords = [
      ...clinicalNormalized.studies,
      ...previousClinical.filter((study) => !study.sources.some((source) =>
        source.source === 'clinicaltrials-gov' && currentIds.has(source.externalId))),
    ];
  }

  if (!arvTrusted) {
    if (retainedArv) warnings.push(`Aggie Research Volunteers: kept ${previousArv.length} prior record(s) because ${arvReason}`);
    else warnings.push(`Aggie Research Volunteers: publishing available fallback data because ${arvReason}`);
  }
  if (!clinicalTrusted) {
    if (retainedClinical) warnings.push(`ClinicalTrials.gov: kept ${previousClinical.length} prior record(s) because ${clinicalReason}`);
    else warnings.push(`ClinicalTrials.gov: no prior records were available while ${clinicalReason}`);
  }

  const merged = mergeClinicalTrialRecords(arvRecords, clinicalRecords);
  const studies = stabilizeClinicalTrialIdentities(merged, previousStudies).sort(byId);
  const arvCount = studies.filter((study) => studyHasSource(study, 'aggie-research-volunteers')).length;
  const clinicalCount = studies.filter((study) => studyHasSource(study, 'clinicaltrials-gov')).length;
  const sourceReports: NonNullable<Snapshot['sourceReports']> = [
    {
      id: 'aggie-research-volunteers',
      label: 'Aggie Research Volunteers',
      vertical: 'studies',
      status: arvTrusted ? 'ok' : arvCount > 0 ? 'degraded' : 'failed',
      itemCount: arvCount,
      fetchSource: retainedArv ? 'cache' : studiesResult.source,
      durationMs: studiesResult.durationMs,
      failedRequests: studiesResult.source === 'network' && studiesResult.complete ? 0 : 1,
      complete: arvTrusted,
      note: arvReason,
      docsUrl: 'https://research.tamu.edu/resources/aggie-research-volunteers/',
    },
    {
      id: 'clinicaltrials-gov',
      label: 'ClinicalTrials.gov',
      vertical: 'studies',
      status: clinicalTrusted ? 'ok' : clinicalCount > 0 ? 'degraded' : 'failed',
      itemCount: clinicalCount,
      fetchSource: retainedClinical ? 'cache' : clinicalResult.source,
      durationMs: clinicalResult.durationMs,
      failedRequests: clinicalResult.failedRequests,
      complete: clinicalTrusted,
      note: clinicalReason,
      docsUrl: 'https://clinicaltrials.gov/data-api/api',
    },
  ];

  if (studies.length === 0) {
    log.error('[studies] no records from either registry or the previous snapshot');
    return {
      snapshot: { fetchedAt: options.now, totalFromHeader: 0, studies: [], sourceReports },
      taxonomies: taxonomyResult.taxonomies,
      diff: { generatedAt: options.now, previousFetchedAt: null, added: [], removed: [], changed: [] },
      source: 'empty',
      warnings,
    };
  }

  const snapshot: Snapshot = {
    fetchedAt: arvTrusted || clinicalTrusted ? options.now : previous?.fetchedAt ?? studiesResult.fetchedAt,
    totalFromHeader: arvTrusted ? studiesResult.totalFromHeader : previous?.totalFromHeader ?? studiesResult.totalFromHeader,
    studies,
    sourceReports,
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
    source: retainedArv || retainedClinical
      ? 'cache'
      : arvTrusted || clinicalTrusted
        ? 'network'
        : studiesResult.source,
    warnings,
  };
}
