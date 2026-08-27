/**
 * ClinicalTrials.gov -> StudyRecord and exact cross-registry reconciliation.
 *
 * The registry carries useful recruitment, eligibility, and location data but
 * does not state participant compensation. It also exposes coordinator contact
 * objects that Radar deliberately never reads. New registry-only records keep
 * pay, time, and contact fields unknown and link back to the official NCT page.
 */

import { normalizeStudy, type DedupedStudyRecord } from '@/studies/normalize.ts';
import { parseCompensation } from '@/studies/parse-compensation.ts';
import { parseDuration } from '@/studies/parse-duration.ts';
import { scrubEmails } from '@/studies/mailto.ts';
import { monthsBetween, parseStudyDate } from '@/studies/staleness.ts';
import type { ClinicalTrialStudy } from '@/studies/sources/clinicaltrials.ts';
import type {
  RawStudy,
  RawStudyMeta,
  Staleness,
  StudyRecord,
  StudySourceId,
  StudySourceReference,
} from '@/studies/types.ts';
import { htmlToText } from '@/core/text.ts';

const CTG_RECORD_ROOT = 'https://clinicaltrials.gov/study/';
const ARV_SOURCE: StudySourceId = 'aggie-research-volunteers';
const CTG_SOURCE: StudySourceId = 'clinicaltrials-gov';

function publicText(value: string | null | undefined): string {
  return scrubEmails(htmlToText(value), '').replace(/\s+/g, ' ').trim();
}

export interface NormalizeClinicalTrialsOptions {
  now?: Date;
}

export interface NormalizeClinicalTrialsResult {
  studies: DedupedStudyRecord[];
  failures: { id: unknown; error: string }[];
}

function unique(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim()))];
}

function sourceDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  const expanded = /^\d{4}$/.test(raw)
    ? `${raw}-01-01`
    : /^\d{4}-\d{2}$/.test(raw)
      ? `${raw}-01`
      : raw;
  const parsed = parseStudyDate(expanded);
  return parsed?.toISOString() ?? null;
}

function ageYears(value: unknown, maximum: boolean): number | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?)\s*$/i.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const years = unit.startsWith('year')
    ? amount
    : unit.startsWith('month')
      ? amount / 12
      : unit.startsWith('week')
        ? amount / 52.1429
        : amount / 365.2425;
  return Math.max(0, maximum ? Math.ceil(years) : Math.floor(years));
}

function locationLabel(location: {
  facility?: string;
  city?: string;
  state?: string;
  country?: string;
}): string {
  const facility = publicText(location.facility);
  const place = unique([publicText(location.city), publicText(location.state), publicText(location.country)])
    .join(', ');
  return facility && place ? `${facility} — ${place}` : facility || place;
}

function normalizedWords(value: unknown): string {
  return publicText(typeof value === 'string' ? value : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function recruitingLocationLabels(study: ClinicalTrialStudy): string[] {
  const recruiting = (study.protocolSection?.contactsLocationsModule?.locations ?? [])
    .filter((location) => location.status === 'RECRUITING');
  const tamu = recruiting.filter((location) => {
    const facility = normalizedWords(location.facility);
    return facility.includes('texas a m') || facility.includes('tamu');
  });
  const selected = tamu.length > 0 ? tamu : recruiting.slice(0, 3);
  return unique(selected.map(locationLabel));
}

function registryStaleness(verifiedAt: string | null, now: Date): Staleness {
  const verified = parseStudyDate(verifiedAt);
  if (verified === null) return 'stale';
  const age = monthsBetween(verified, now);
  if (age < 9) return 'fresh';
  if (age <= 18) return 'aging';
  return 'stale';
}

function emptyMeta(minAge: number, maxAge: number): RawStudyMeta {
  return {
    aux_study_item_compensation: '',
    aux_study_item_duration: '',
    aux_study_item_contact_email: '',
    aux_study_item_contact_name: '',
    aux_study_item_contact_phone_number: '',
    aux_study_item_pi_name: '',
    aux_study_item_irb_number: '',
    aux_study_item_irb_approval_date: '',
    aux_study_item_minimum_age: String(minAge),
    aux_study_item_maximum_age: String(maxAge),
    aux_study_item_expiration_date: null,
    aux_study_item_recruitment_start_date: null,
    aux_study_item_lifecycle: '',
    aux_study_item_button_link_object: { url: '' },
    aux_study_item_button_text: '',
    aux_is_internal: false,
  };
}

/** Normalize one recruiting registry record without reading its contact data. */
export function normalizeClinicalTrial(
  study: ClinicalTrialStudy,
  options: NormalizeClinicalTrialsOptions = {},
): DedupedStudyRecord {
  const section = study.protocolSection;
  const identification = section?.identificationModule;
  const status = section?.statusModule;
  const eligibility = section?.eligibilityModule;
  const nctId = identification?.nctId;
  if (identification === undefined || typeof nctId !== 'string' || !/^NCT\d{8}$/.test(nctId)) {
    throw new Error('missing or invalid NCT identifier');
  }
  if (status?.overallStatus !== 'RECRUITING') throw new Error(`${nctId} is not recruiting`);

  const officialTitle = publicText(identification.officialTitle);
  const briefTitle = publicText(identification.briefTitle);
  const title = officialTitle || briefTitle;
  if (title === '') throw new Error(`${nctId} has no title`);

  const briefSummary = publicText(section?.descriptionModule?.briefSummary);
  const detailedDescription = publicText(section?.descriptionModule?.detailedDescription);
  const criteria = publicText(eligibility?.eligibilityCriteria);
  const conditions = unique((section?.conditionsModule?.conditions ?? []).map(publicText));
  const keywords = unique((section?.conditionsModule?.keywords ?? []).map(publicText));
  const interventions = (section?.armsInterventionsModule?.interventions ?? []).flatMap((intervention) =>
    unique([
      publicText(intervention.type),
      publicText(intervention.name),
      publicText(intervention.description),
    ]));
  const studyType = publicText(section?.designModule?.studyType);
  const body = unique([
    briefSummary,
    detailedDescription,
    criteria,
    conditions.join('. '),
    keywords.join('. '),
    interventions.join('. '),
    studyType,
  ]).join('. ');

  const postedDate = sourceDate(status.studyFirstPostDateStruct?.date)
    ?? sourceDate(status.studyFirstSubmitDate)
    ?? new Date(0).toISOString();
  const modifiedDate = sourceDate(status.lastUpdatePostDateStruct?.date)
    ?? sourceDate(status.lastUpdateSubmitDate)
    ?? sourceDate(status.statusVerifiedDate)
    ?? postedDate;
  const verifiedAt = sourceDate(status.statusVerifiedDate) ?? modifiedDate;
  const minAge = ageYears(eligibility?.minimumAge, false) ?? 0;
  const maxAge = ageYears(eligibility?.maximumAge, true) ?? 125;
  const numericId = Number.parseInt(nctId.slice(3), 10);
  const url = `${CTG_RECORD_ROOT}${nctId}`;

  const synthetic: RawStudy = {
    id: Number.isFinite(numericId) ? numericId : 0,
    date: postedDate,
    date_gmt: postedDate,
    modified: modifiedDate,
    modified_gmt: modifiedDate,
    slug: `clinicaltrials-gov-${nctId.toLowerCase()}`,
    status: 'publish',
    type: 'study',
    link: url,
    guid: { rendered: url },
    title: { rendered: title },
    content: { rendered: body },
    excerpt: { rendered: briefSummary || detailedDescription || criteria },
    meta: emptyMeta(minAge, maxAge),
    aux_study_category: [],
    aux_study_location: [],
    aux_study_session_type: [],
    aux_study_topic: [],
  };

  const now = options.now ?? new Date();
  const record = normalizeStudy(synthetic, { now });
  const protocolIds = unique([
    nctId,
    identification.orgStudyIdInfo?.id,
    ...(identification.secondaryIdInfos ?? []).map((entry) => entry.id),
  ]);
  const labels = recruitingLocationLabels(study);
  const explicitTags = [
    ...(labels.length > 0 ? ['in-person'] : []),
    ...(studyType.toUpperCase() === 'INTERVENTIONAL' ? ['clinical'] : []),
  ];

  record.id = `ctgov:${nctId}`;
  record.slug = `clinicaltrials-gov-${nctId.toLowerCase()}`;
  record.title = title;
  record.url = url;
  record.sources = [{
    source: CTG_SOURCE,
    externalId: nctId,
    url,
    status: 'recruiting',
    verifiedAt,
    protocolIds,
    titleAliases: unique([officialTitle, briefTitle]),
  }];
  record.piName = null;
  record.contactName = null;
  record.contactEmail = null;
  record.contactPhone = null;
  record.irbNumber = null;
  record.irbApprovalDate = null;
  record.expirationDate = null;
  record.recruitmentStartDate = null;
  record.lifecycleMonths = null;
  record.locationLabels = labels;
  record.compensation = parseCompensation('');
  record.duration = parseDuration('');
  record.effectiveHourly = null;
  record.isExpired = false;
  record.staleness = registryStaleness(verifiedAt, now);
  record.tags = unique([...record.tags, ...explicitTags]);
  record.duplicateIds = [];
  record.duplicateOf = null;

  if (eligibility?.sex === 'FEMALE') record.eligibility.sexRestriction = 'female';
  else if (eligibility?.sex === 'MALE') record.eligibility.sexRestriction = 'male';
  else if (eligibility?.sex === 'ALL') record.eligibility.sexRestriction = null;

  return record;
}

/** Batch form that isolates malformed records, matching ARV normalization. */
export function normalizeClinicalTrials(
  studies: readonly ClinicalTrialStudy[],
  options: NormalizeClinicalTrialsOptions = {},
): NormalizeClinicalTrialsResult {
  const normalized: DedupedStudyRecord[] = [];
  const failures: NormalizeClinicalTrialsResult['failures'] = [];
  for (const study of studies) {
    try {
      normalized.push(normalizeClinicalTrial(study, options));
    } catch (error) {
      failures.push({
        id: study?.protocolSection?.identificationModule?.nctId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { studies: normalized, failures };
}

function inferredSource(record: StudyRecord): StudySourceReference {
  const nct = /^ctgov:(NCT\d{8})$/i.exec(record.id)?.[1]
    ?? /clinicaltrials\.gov\/study\/(NCT\d{8})/i.exec(record.url)?.[1];
  const source = nct === undefined ? ARV_SOURCE : CTG_SOURCE;
  return {
    source,
    externalId: nct?.toUpperCase() ?? record.id,
    url: record.url,
    status: source === CTG_SOURCE ? 'recruiting' : record.isExpired ? 'expired' : 'unknown',
    verifiedAt: record.modifiedDate ?? null,
    protocolIds: unique([record.irbNumber, nct]),
    titleAliases: unique([record.title]),
  };
}

/** Upgrade a pre-provenance committed record at the read boundary. */
export function hydrateStudyRecord(record: StudyRecord): DedupedStudyRecord {
  const rawSources = (record as Partial<StudyRecord>).sources;
  const sources = Array.isArray(rawSources) && rawSources.length > 0 ? rawSources : [inferredSource(record)];
  return {
    ...record,
    sources: sources.map((source) => ({
      ...source,
      protocolIds: Array.isArray(source.protocolIds) ? unique(source.protocolIds) : [],
      titleAliases: Array.isArray(source.titleAliases) ? unique(source.titleAliases) : unique([record.title]),
    })),
    locationLabels: Array.isArray((record as Partial<StudyRecord>).locationLabels)
      ? [...((record as Partial<StudyRecord>).locationLabels ?? [])]
      : [],
    duplicateIds: Array.isArray((record as Partial<DedupedStudyRecord>).duplicateIds)
      ? [...((record as Partial<DedupedStudyRecord>).duplicateIds ?? [])]
      : [],
    duplicateOf: (record as Partial<DedupedStudyRecord>).duplicateOf ?? null,
  };
}

export function studyHasSource(record: StudyRecord, source: StudySourceId): boolean {
  return hydrateStudyRecord(record).sources.some((reference) => reference.source === source);
}

function protocolKey(value: string): string | null {
  const decoded = htmlToText(value).toUpperCase();
  const nct = decoded.replace(/[^A-Z0-9]+/g, '');
  if (/^NCT\d{8}$/.test(nct)) return nct;
  const institutional = /(20\d{2})\D{0,12}0*(\d{1,6})/.exec(decoded);
  if (institutional?.[1] !== undefined && institutional[2] !== undefined) {
    return `${institutional[1]}-${Number.parseInt(institutional[2], 10)}`;
  }
  const exact = nct;
  return exact.length >= 4 ? exact : null;
}

function titleKey(value: string): string | null {
  const key = normalizedWords(value);
  return key === '' ? null : key;
}

function sourceKeys(record: StudyRecord): string[] {
  return hydrateStudyRecord(record).sources.map((source) => `${source.source}:${source.externalId}`);
}

function protocolKeys(record: StudyRecord): string[] {
  const hydrated = hydrateStudyRecord(record);
  return unique([
    hydrated.irbNumber,
    ...hydrated.sources.flatMap((source) => source.protocolIds),
  ]).map(protocolKey).filter((key): key is string => key !== null);
}

function titleKeys(record: StudyRecord): string[] {
  const hydrated = hydrateStudyRecord(record);
  return unique([
    hydrated.title,
    ...hydrated.sources.flatMap((source) => source.titleAliases),
  ]).map(titleKey).filter((key): key is string => key !== null);
}

function mergeSources(primary: StudyRecord, registry: StudyRecord): StudySourceReference[] {
  const preferred = new Map<string, StudySourceReference>();
  const primarySources = hydrateStudyRecord(primary).sources;
  const registrySources = hydrateStudyRecord(registry).sources;

  for (const source of [...primarySources, ...registrySources]) {
    const key = `${source.source}:${source.externalId}`;
    const existing = preferred.get(key);
    if (existing === undefined
      || source.source === CTG_SOURCE
      || (source.source === ARV_SOURCE && primarySources.includes(source))) {
      preferred.set(key, source);
    }
  }
  return [...preferred.values()];
}

const STALENESS_ORDER: Record<Staleness, number> = { fresh: 0, aging: 1, stale: 2, expired: 3 };

function fresher(a: Staleness, b: Staleness): Staleness {
  return STALENESS_ORDER[a] <= STALENESS_ORDER[b] ? a : b;
}

function latestDate(a: string, b: string): string {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isNaN(aTime)) return b;
  if (Number.isNaN(bTime)) return a;
  return aTime >= bTime ? a : b;
}

function mergePair(primaryInput: StudyRecord, registryInput: StudyRecord): DedupedStudyRecord {
  const primary = hydrateStudyRecord(primaryInput);
  const registry = hydrateStudyRecord(registryInput);
  const sources = mergeSources(primary, registry);
  const recruiting = sources.some((source) => source.status === 'recruiting');
  const hasArv = sources.some((source) => source.source === ARV_SOURCE);
  const arvUrl = sources.find((source) => source.source === ARV_SOURCE)?.url;

  return {
    ...primary,
    url: hasArv && arvUrl ? arvUrl : primary.url,
    sources,
    summary: primary.summary || registry.summary,
    modifiedDate: latestDate(primary.modifiedDate, registry.modifiedDate),
    locationLabels: unique([...primary.locationLabels, ...registry.locationLabels]),
    tags: unique([...primary.tags, ...registry.tags]),
    isExpired: recruiting ? false : primary.isExpired,
    expirationDate: recruiting ? null : primary.expirationDate,
    staleness: recruiting ? fresher(primary.staleness, registry.staleness) : primary.staleness,
    duplicateIds: unique([
      ...primary.duplicateIds,
      ...registry.duplicateIds,
      ...(registry.id === primary.id ? [] : [registry.id]),
    ]),
    duplicateOf: null,
  };
}

function indexRecord(
  record: StudyRecord,
  index: number,
  indexes: { source: Map<string, number>; protocol: Map<string, number>; title: Map<string, number> },
): void {
  for (const key of sourceKeys(record)) indexes.source.set(key, index);
  for (const key of protocolKeys(record)) if (!indexes.protocol.has(key)) indexes.protocol.set(key, index);
  for (const key of titleKeys(record)) if (!indexes.title.has(key)) indexes.title.set(key, index);
}

/**
 * Merge ClinicalTrials.gov into ARV on exact source id, protocol id, or title.
 * Protocol identity wins; titles are normalized but never fuzzy-matched.
 */
export function mergeClinicalTrialRecords(
  arvRecords: readonly StudyRecord[],
  clinicalRecords: readonly StudyRecord[],
): DedupedStudyRecord[] {
  const merged = arvRecords.map(hydrateStudyRecord);
  const indexes = {
    source: new Map<string, number>(),
    protocol: new Map<string, number>(),
    title: new Map<string, number>(),
  };
  merged.forEach((record, index) => indexRecord(record, index, indexes));

  for (const candidateInput of clinicalRecords) {
    const candidate = hydrateStudyRecord(candidateInput);
    const sourceMatch = sourceKeys(candidate).map((key) => indexes.source.get(key)).find((index) => index !== undefined);
    const protocolMatch = protocolKeys(candidate).map((key) => indexes.protocol.get(key)).find((index) => index !== undefined);
    const titleMatch = titleKeys(candidate).map((key) => indexes.title.get(key)).find((index) => index !== undefined);
    const match = sourceMatch ?? protocolMatch ?? titleMatch;

    if (match === undefined) {
      merged.push(candidate);
      indexRecord(candidate, merged.length - 1, indexes);
      continue;
    }

    const current = merged[match];
    if (current === undefined) continue;
    const combined = mergePair(current, candidate);
    merged[match] = combined;
    indexRecord(combined, match, indexes);
  }

  return merged;
}

/** Preserve saved-state ids/slugs when any exact source record existed before. */
export function stabilizeClinicalTrialIdentities(
  records: readonly StudyRecord[],
  previous: readonly StudyRecord[] = [],
): DedupedStudyRecord[] {
  const previousBySource = new Map<string, DedupedStudyRecord>();
  for (const record of previous.map(hydrateStudyRecord)) {
    for (const key of sourceKeys(record)) if (!previousBySource.has(key)) previousBySource.set(key, record);
  }

  const usedIds = new Set<string>();
  return records.map((input) => {
    const record = hydrateStudyRecord(input);
    const prior = sourceKeys(record).map((key) => previousBySource.get(key)).find((match) =>
      match !== undefined && !usedIds.has(match.id));
    if (prior === undefined) {
      usedIds.add(record.id);
      return record;
    }
    usedIds.add(prior.id);
    return {
      ...record,
      id: prior.id,
      slug: prior.slug,
      duplicateIds: unique([...record.duplicateIds, ...(record.id === prior.id ? [] : [record.id])]),
    };
  });
}
