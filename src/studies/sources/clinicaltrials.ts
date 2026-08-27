/**
 * Recruiting Texas A&M studies from ClinicalTrials.gov API v2.
 *
 * Two bounded searches are necessary. `query.spons` finds trials led by Texas
 * A&M, including remote and non-College-Station opportunities. `query.locn`
 * finds the small number led by another sponsor but recruiting at a named Texas
 * A&M facility. Both searches are deliberately post-filtered: the API's text
 * search also matches collaborators, officials, and similarly named places.
 *
 * Contact objects are intentionally absent from the declared/read shape. Radar
 * links to the official NCT record instead of copying names, phone numbers, or
 * email addresses into its committed public snapshot.
 */

import type { Logger } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { htmlToText } from '@/core/text.ts';

export const CLINICAL_TRIALS_API_URL = 'https://clinicaltrials.gov/api/v2/studies';
export const CLINICAL_TRIALS_PAGE_SIZE = 100;
export const CLINICAL_TRIALS_MAX_PAGES = 10;

interface IdentificationModule {
  nctId?: string;
  briefTitle?: string;
  officialTitle?: string;
  orgStudyIdInfo?: { id?: string };
  secondaryIdInfos?: { id?: string; type?: string }[];
}

interface StatusModule {
  statusVerifiedDate?: string;
  overallStatus?: string;
  startDateStruct?: { date?: string; type?: string };
  studyFirstPostDateStruct?: { date?: string; type?: string };
  studyFirstSubmitDate?: string;
  lastUpdatePostDateStruct?: { date?: string; type?: string };
  lastUpdateSubmitDate?: string;
}

interface ClinicalLocation {
  facility?: string;
  status?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface ClinicalTrialStudy {
  protocolSection?: {
    identificationModule?: IdentificationModule;
    statusModule?: StatusModule;
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string };
    };
    descriptionModule?: {
      briefSummary?: string;
      detailedDescription?: string;
    };
    conditionsModule?: {
      conditions?: string[];
      keywords?: string[];
    };
    designModule?: {
      studyType?: string;
    };
    armsInterventionsModule?: {
      interventions?: { type?: string; name?: string; description?: string }[];
    };
    eligibilityModule?: {
      eligibilityCriteria?: string;
      healthyVolunteers?: boolean;
      sex?: string;
      minimumAge?: string;
      maximumAge?: string;
    };
    contactsLocationsModule?: {
      locations?: ClinicalLocation[];
    };
  };
}

interface ApiPage {
  studies?: ClinicalTrialStudy[];
  nextPageToken?: string;
  totalCount?: number;
}

export interface FetchClinicalTrialsResult {
  studies: ClinicalTrialStudy[];
  source: 'network' | 'empty';
  complete: boolean;
  warnings: string[];
  error: string | null;
  failedRequests: number;
  durationMs: number;
}

export interface ClinicalTrialsOptions extends RequestOptions {
  log?: Logger;
  maxPages?: number;
}

type QueryKind = 'sponsor' | 'location';

const QUERIES: readonly { kind: QueryKind; parameter: 'query.spons' | 'query.locn' }[] = [
  { kind: 'sponsor', parameter: 'query.spons' },
  { kind: 'location', parameter: 'query.locn' },
];

function normalized(value: unknown): string {
  return htmlToText(typeof value === 'string' ? value : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function exactTamuSponsor(study: ClinicalTrialStudy): boolean {
  return normalized(study.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name) === 'texas a m university';
}

function isRecruitingTamuLocation(location: ClinicalLocation): boolean {
  const facility = normalized(location.facility);
  return location.status === 'RECRUITING'
    && (facility.includes('texas a m') || facility.includes('tamu'));
}

function hasRecruitingTamuLocation(study: ClinicalTrialStudy): boolean {
  return (study.protocolSection?.contactsLocationsModule?.locations ?? []).some(isRecruitingTamuLocation);
}

function isUsable(study: ClinicalTrialStudy, kind: QueryKind): boolean {
  const section = study.protocolSection;
  const nctId = section?.identificationModule?.nctId;
  if (typeof nctId !== 'string' || !/^NCT\d{8}$/.test(nctId)) return false;
  if (section?.statusModule?.overallStatus !== 'RECRUITING') return false;
  return kind === 'sponsor' ? exactTamuSponsor(study) : hasRecruitingTamuLocation(study);
}

function queryUrl(parameter: 'query.spons' | 'query.locn', pageToken?: string): string {
  return buildUrl(CLINICAL_TRIALS_API_URL, {
    [parameter]: 'Texas A&M University',
    'filter.overallStatus': 'RECRUITING',
    pageSize: CLINICAL_TRIALS_PAGE_SIZE,
    countTotal: 'true',
    format: 'json',
    pageToken,
  });
}

/** Fetch the two official registry views. Never throws across the boundary. */
export async function fetchClinicalTrials(options: ClinicalTrialsOptions = {}): Promise<FetchClinicalTrialsResult> {
  const log = options.log ?? consoleLogger;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? CLINICAL_TRIALS_MAX_PAGES, CLINICAL_TRIALS_MAX_PAGES));
  const startedAt = Date.now();
  const warnings: string[] = [];
  const collected: ClinicalTrialStudy[] = [];
  let failedRequests = 0;
  let complete = true;
  let successfulQueries = 0;

  for (const query of QUERIES) {
    let pageToken: string | undefined;
    let rawCount = 0;
    let reportedTotal: number | null = null;
    let querySucceeded = false;

    for (let page = 1; page <= maxPages; page += 1) {
      const url = queryUrl(query.parameter, pageToken);
      try {
        const { data } = await getJson<unknown>(url, options);
        if (typeof data !== 'object' || data === null || !Array.isArray((data as ApiPage).studies)) {
          throw new Error('response did not contain a studies array');
        }

        const body = data as ApiPage;
        const studies = body.studies ?? [];
        if (page === 1 && typeof body.totalCount === 'number') reportedTotal = body.totalCount;
        rawCount += studies.length;
        collected.push(...studies.filter((study) => isUsable(study, query.kind)));
        querySucceeded = true;
        log.info(`[clinicaltrials] ${query.kind} page ${page}: ${studies.length} raw record(s)`);

        pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0
          ? body.nextPageToken
          : undefined;
        if (pageToken === undefined) break;
        if (page === maxPages) {
          complete = false;
          warnings.push(`${query.kind}: reached the ${maxPages}-page safety cap`);
        }
      } catch (err) {
        failedRequests += 1;
        complete = false;
        const message = describeError(err);
        warnings.push(`${query.kind} page ${page} failed: ${message}`);
        log.warn(`[clinicaltrials] ${query.kind} page ${page} FAILED: ${message}`);
        break;
      }
    }

    if (querySucceeded) successfulQueries += 1;
    if (reportedTotal !== null && rawCount !== reportedTotal) {
      complete = false;
      warnings.push(`${query.kind}: API reported ${reportedTotal} records but ${rawCount} were read`);
    }
  }

  const seen = new Set<string>();
  const studies = collected.filter((study) => {
    const id = study.protocolSection?.identificationModule?.nctId;
    if (id === undefined || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const error = successfulQueries === 0 ? warnings[0] ?? 'both ClinicalTrials.gov queries failed' : null;
  log.info(`[clinicaltrials] SOURCE=${error === null ? 'network' : 'empty'} - ${studies.length} recruiting record(s)`);
  return {
    studies,
    source: error === null ? 'network' : 'empty',
    complete: complete && successfulQueries === QUERIES.length,
    warnings,
    error,
    failedRequests,
    durationMs: Date.now() - startedAt,
  };
}
