/** Small, browser-safe presentation helpers for study provenance. */

import type { StudyRecord, StudySourceId, StudySourceReference } from '@/studies/types.ts';

const LABELS: Record<StudySourceId, string> = {
  'aggie-research-volunteers': 'Aggie Research Volunteers',
  'clinicaltrials-gov': 'ClinicalTrials.gov',
};

export function studySourceLabel(source: StudySourceId): string {
  return LABELS[source];
}

/** Accept committed snapshots created before source provenance was introduced. */
export function studySourceReferences(study: StudyRecord): StudySourceReference[] {
  const existing = (study as Partial<StudyRecord>).sources;
  if (Array.isArray(existing) && existing.length > 0) return existing;
  const nct = /^ctgov:(NCT\d{8})$/i.exec(study.id)?.[1]
    ?? /clinicaltrials\.gov\/study\/(NCT\d{8})/i.exec(study.url)?.[1];
  const source: StudySourceId = nct === undefined ? 'aggie-research-volunteers' : 'clinicaltrials-gov';
  return [{
    source,
    externalId: nct?.toUpperCase() ?? study.id,
    url: study.url,
    status: source === 'clinicaltrials-gov' ? 'recruiting' : study.isExpired ? 'expired' : 'unknown',
    verifiedAt: study.modifiedDate ?? null,
    protocolIds: study.irbNumber ? [study.irbNumber] : [],
    titleAliases: [study.title],
  }];
}

export function studyHasDisplaySource(study: StudyRecord, source: StudySourceId): boolean {
  return studySourceReferences(study).some((reference) => reference.source === source);
}

export function combinedStudyLocations(study: StudyRecord, taxonomyLocations: readonly string[]): string[] {
  const native = (study as Partial<StudyRecord>).locationLabels;
  return [...new Set([
    ...taxonomyLocations,
    ...(Array.isArray(native) ? native : []),
  ].filter((label) => typeof label === 'string' && label.trim() !== ''))];
}
