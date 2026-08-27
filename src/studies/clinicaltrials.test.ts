import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetThrottle } from '@/core/http.ts';
import {
  mergeClinicalTrialRecords,
  normalizeClinicalTrial,
  stabilizeClinicalTrialIdentities,
} from '@/studies/clinicaltrials-normalize.ts';
import { normalizeStudy } from '@/studies/normalize.ts';
import { fetchClinicalTrials, type ClinicalTrialStudy } from '@/studies/sources/clinicaltrials.ts';
import type { RawStudy } from '@/studies/types.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const ARV_RAW = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RawStudy[];
const NOW = new Date('2026-08-27T12:00:00.000Z');
const log = { info: () => {}, warn: () => {}, error: () => {} };

function trial(overrides: {
  nctId?: string;
  title?: string;
  sponsor?: string;
  orgId?: string;
  status?: string;
  facility?: string;
  facilityStatus?: string;
} = {}): ClinicalTrialStudy {
  const nctId = overrides.nctId ?? 'NCT01234567';
  return {
    protocolSection: {
      identificationModule: {
        nctId,
        briefTitle: overrides.title ?? `Brief ${nctId}`,
        officialTitle: overrides.title ?? `Official ${nctId}`,
        orgStudyIdInfo: { id: overrides.orgId ?? '2026-0001' },
      },
      statusModule: {
        overallStatus: overrides.status ?? 'RECRUITING',
        statusVerifiedDate: '2026-08',
        studyFirstPostDateStruct: { date: '2026-01-15' },
        lastUpdatePostDateStruct: { date: '2026-08-20' },
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: overrides.sponsor ?? 'Texas A&M University' },
      },
      descriptionModule: {
        briefSummary: 'A participant study about memory and movement.',
      },
      conditionsModule: { conditions: ['Memory'], keywords: ['movement'] },
      designModule: { studyType: 'INTERVENTIONAL' },
      eligibilityModule: {
        eligibilityCriteria: 'Adults age 18 and older may take part.',
        healthyVolunteers: true,
        sex: 'ALL',
        minimumAge: '18 Years',
      },
      contactsLocationsModule: {
        locations: [{
          facility: overrides.facility ?? 'Texas A&M University',
          status: overrides.facilityStatus ?? 'RECRUITING',
          city: 'College Station',
          state: 'Texas',
          country: 'United States',
        }],
      },
    },
  };
}

function response(studies: ClinicalTrialStudy[], totalCount = studies.length): Response {
  return new Response(JSON.stringify({ studies, totalCount }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => resetThrottle());

describe('ClinicalTrials.gov connector', () => {
  it('post-filters broad sponsor and location searches exactly', async () => {
    const sponsorExact = trial({ nctId: 'NCT00000001' });
    const collaboratorOnly = trial({ nctId: 'NCT00000002', sponsor: 'Other University' });
    const externalAtTamu = trial({ nctId: 'NCT00000003', sponsor: 'External Sponsor' });
    const closedTamuSite = trial({
      nctId: 'NCT00000004',
      sponsor: 'External Sponsor',
      facilityStatus: 'NOT_YET_RECRUITING',
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return url.includes('query.spons')
        ? response([sponsorExact, collaboratorOnly])
        : response([externalAtTamu, closedTamuSite]);
    });

    const result = await fetchClinicalTrials({ fetchImpl, attempts: 1, log });

    expect(result.complete).toBe(true);
    expect(result.studies.map((study) => study.protocolSection?.identificationModule?.nctId))
      .toEqual(['NCT00000001', 'NCT00000003']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('filter.overallStatus=RECRUITING');
    expect(calls[1]).toContain('query.locn=Texas+A%26M+University');
  });
});

describe('ClinicalTrials.gov normalization', () => {
  it('keeps pay, time, and every contact field unknown', () => {
    const withPrivateContact = trial({ nctId: 'NCT01234567' }) as ClinicalTrialStudy & {
      protocolSection: NonNullable<ClinicalTrialStudy['protocolSection']> & {
        contactsLocationsModule: Record<string, unknown>;
      };
    };
    withPrivateContact.protocolSection.contactsLocationsModule.centralContacts = [{
      name: 'Private Coordinator',
      email: 'coordinator@example.edu',
      phone: '555-0100',
    }];
    withPrivateContact.protocolSection.descriptionModule = {
      briefSummary: 'Ask coordinator@example.edu about this memory study.',
    };

    const record = normalizeClinicalTrial(withPrivateContact, { now: NOW });
    const serialized = JSON.stringify(record);

    expect(record).toMatchObject({
      id: 'ctgov:NCT01234567',
      slug: 'clinicaltrials-gov-nct01234567',
      effectiveHourly: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      irbNumber: null,
      expirationDate: null,
      isExpired: false,
    });
    expect(record.compensation.guaranteedMin).toBeNull();
    expect(record.duration.totalHoursMax).toBeNull();
    expect(record.locationLabels[0]).toContain('Texas A&M University');
    expect(record.sources[0]).toMatchObject({ source: 'clinicaltrials-gov', status: 'recruiting' });
    expect(serialized).not.toContain('Private Coordinator');
    expect(serialized).not.toContain('coordinator@example.edu');
    expect(serialized).not.toContain('555-0100');
  });
});

describe('cross-registry reconciliation', () => {
  function arv(): ReturnType<typeof normalizeStudy> {
    const record = normalizeStudy(ARV_RAW[0] as RawStudy, { now: NOW });
    record.isExpired = true;
    record.staleness = 'expired';
    record.expirationDate = '2025-01-01T00:00:00.000Z';
    record.sources[0]!.status = 'expired';
    return record;
  }

  it('merges an exact protocol, preserves ARV pay/id, and revives recruiting status', () => {
    const primary = arv();
    const registry = normalizeClinicalTrial(trial({
      nctId: 'NCT07654321',
      title: 'A deliberately different title',
      orgId: primary.irbNumber?.replace(/^STUDY/i, '') ?? '',
    }), { now: NOW });
    const merged = mergeClinicalTrialRecords([primary], [registry]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(primary.id);
    expect(merged[0]?.compensation).toEqual(primary.compensation);
    expect(merged[0]?.isExpired).toBe(false);
    expect(merged[0]?.expirationDate).toBeNull();
    expect(merged[0]?.sources.map((source) => source.source).sort())
      .toEqual(['aggie-research-volunteers', 'clinicaltrials-gov']);
  });

  it('merges exact normalized titles but never merely similar titles', () => {
    const primary = arv();
    primary.irbNumber = 'STUDY1999-9999';
    primary.sources[0]!.protocolIds = ['STUDY1999-9999'];
    const exact = normalizeClinicalTrial(trial({
      nctId: 'NCT01111111',
      title: primary.title.toUpperCase(),
      orgId: 'unrelated',
    }), { now: NOW });
    const similar = normalizeClinicalTrial(trial({
      nctId: 'NCT02222222',
      title: `${primary.title} follow-up`,
      orgId: 'also-unrelated',
    }), { now: NOW });

    expect(mergeClinicalTrialRecords([primary], [exact])).toHaveLength(1);
    expect(mergeClinicalTrialRecords([primary], [similar])).toHaveLength(2);
  });

  it('preserves a prior CTG identity when an ARV listing appears later', () => {
    const previous = normalizeClinicalTrial(trial({ nctId: 'NCT03333333', title: 'Same official title' }), { now: NOW });
    const newArv = arv();
    newArv.title = 'Same official title';
    newArv.sources[0]!.titleAliases = ['Same official title'];
    newArv.irbNumber = 'STUDY1999-1234';
    newArv.sources[0]!.protocolIds = ['STUDY1999-1234'];
    const merged = mergeClinicalTrialRecords([newArv], [previous]);
    const stable = stabilizeClinicalTrialIdentities(merged, [previous]);

    expect(stable).toHaveLength(1);
    expect(stable[0]?.id).toBe(previous.id);
    expect(stable[0]?.slug).toBe(previous.slug);
    expect(stable[0]?.url).toContain('research.tamu.edu');
  });
});
