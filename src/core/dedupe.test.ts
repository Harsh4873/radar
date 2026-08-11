import { describe, expect, it } from 'vitest';
import type { RadarItem, SourceId } from '@/types.ts';
import { dedupe, mergedConfidence, shouldFuzzyMerge } from '@/core/dedupe.ts';

const NOW = '2026-08-10T00:00:00.000Z';

function campusItem(overrides: Partial<RadarItem> & { id: string }): RadarItem {
  return {
    vertical: 'campus',
    title: 'Event',
    summary: '',
    url: 'https://calendar.tamu.edu/event/1',
    identity: [],
    sources: [
      {
        source: 'tamu-calendar',
        externalId: overrides.id,
        url: 'https://calendar.tamu.edu/event/1',
        channel: 'Main University Calendar',
        firstSeen: NOW,
        lastModified: null,
      },
    ],
    sourceConfidence: 0.9,
    firstSeen: NOW,
    lastSeen: NOW,
    lastModified: null,
    occurredAt: null,
    endsAt: null,
    tags: [],
    relevance: 0,
    reasons: [],
    status: 'new',
    contentHash: 'x',
    campus: {
      category: 'community',
      startsAt: null,
      endsAt: null,
      isAllDay: false,
      isCancelled: false,
      isOnline: false,
      onlineUrl: null,
      location: null,
      coordinates: null,
      organizer: null,
      audience: [],
      eventTypes: [],
      companies: [],
      food: { confidence: 'none', items: [], evidence: null },
      cost: null,
      hasRegistration: false,
      compensation: null,
      compensationUsd: null,
      deadlineAt: null,
      seriesCount: 1,
    },
    ...overrides,
  } as RadarItem;
}

function paperItem(id: string, identity: string[], title: string, date: string | null): RadarItem {
  return {
    id,
    vertical: 'research',
    title,
    summary: '',
    url: `https://doi.org/${id}`,
    identity,
    sources: [
      {
        source: 'europepmc' as SourceId,
        externalId: id,
        url: `https://doi.org/${id}`,
        channel: null,
        firstSeen: NOW,
        lastModified: null,
      },
    ],
    sourceConfidence: 0.95,
    firstSeen: NOW,
    lastSeen: NOW,
    lastModified: null,
    occurredAt: date,
    endsAt: null,
    tags: [],
    relevance: 0,
    reasons: [],
    status: 'new',
    contentHash: 'x',
    research: {
      doi: null,
      pmid: null,
      pmcid: null,
      arxivId: null,
      openAlexId: null,
      kind: 'journal-article',
      band: 'adjacent',
      journal: null,
      authors: [],
      abstract: '',
      publishedDate: date,
      citedByCount: null,
      isOpenAccess: false,
      openAccessUrl: null,
      topics: [],
      citesTracked: [],
      lifecycle: { preprintVersion: null, publishedDoi: null, publishedIn: null, isSuperseded: false },
    },
  };
}

describe('dedupe - exact pass', () => {
  it('is transitive across partially-overlapping identity keys', () => {
    // The case a pairwise scan misses: A knows only the DOI, B knows only the
    // PMID, C knows both and therefore welds A and B together.
    const a = paperItem('a', ['doi:10.1/x'], 'Paper A', NOW);
    const b = paperItem('b', ['pmid:123'], 'Completely Different Words Here', NOW);
    const c = paperItem('c', ['doi:10.1/x', 'pmid:123'], 'Paper C', NOW);

    const result = dedupe([a, b, c]);
    expect(result.items).toHaveLength(1);
    expect(result.collapsed).toBe(2);
    expect(result.items[0]?.identity).toEqual(['doi:10.1/x', 'pmid:123']);
  });

  it('keeps papers with different DOIs apart however similar the titles', () => {
    const a = paperItem('a', ['doi:10.1/x'], 'Chromosome-level genome assembly for Macrostemum floridum', NOW);
    const b = paperItem('b', ['doi:10.1/y'], 'Chromosome-level genome assembly for Macrostemum floridum', NOW);
    expect(dedupe([a, b]).items).toHaveLength(2);
  });
});

describe('shouldFuzzyMerge - campus', () => {
  it('merges one event carried by two group feeds under different ids', () => {
    // Verified in live data: "Women's Soccer Pre-Season Practice" appears
    // under both 'Rec Sports' and 'Department of Rec Sports' with the same
    // start time and two different LiveWhale ids.
    const a = campusItem({
      id: 'a',
      title: "Women's Soccer Pre-Season Practice",
      identity: ['event:tamu-1'],
      campus: { ...campusItem({ id: 'a' }).campus!, startsAt: '2026-08-11T13:00:00.000Z' },
    });
    const b = campusItem({
      id: 'b',
      title: "Women's Soccer Pre-Season Practice",
      identity: ['event:tamu-2'],
      campus: { ...campusItem({ id: 'b' }).campus!, startsAt: '2026-08-11T13:00:00.000Z' },
    });

    expect(shouldFuzzyMerge(a, b)).toBe(true);
  });

  it('does not merge the same seminar title a week apart', () => {
    const a = campusItem({
      id: 'a',
      title: 'Weekly Genomics Seminar',
      campus: { ...campusItem({ id: 'a' }).campus!, startsAt: '2026-08-11T13:00:00.000Z' },
    });
    const b = campusItem({
      id: 'b',
      title: 'Weekly Genomics Seminar',
      campus: { ...campusItem({ id: 'b' }).campus!, startsAt: '2026-08-18T13:00:00.000Z' },
    });

    expect(shouldFuzzyMerge(a, b)).toBe(false);
  });

  it('merges undated study listings only on a near-exact title and same organizer', () => {
    // ARV listings have no start time, so the time comparison can never fire.
    const base = campusItem({ id: 'a' }).campus!;
    const a = campusItem({
      id: 'a',
      title: 'Understanding employee retention and job satisfaction',
      campus: { ...base, organizer: 'PI: Someone' },
    });
    const b = campusItem({
      id: 'b',
      title: 'Understanding employee retention and job satisfaction',
      campus: { ...base, organizer: 'PI: Someone' },
    });
    const differentPi = campusItem({
      id: 'c',
      title: 'Understanding employee retention and job satisfaction',
      campus: { ...base, organizer: 'PI: Someone Else' },
    });

    expect(shouldFuzzyMerge(a, b)).toBe(true);
    expect(shouldFuzzyMerge(a, differentPi)).toBe(false);
  });

  it('refuses to merge a dated event with an undated one', () => {
    const a = campusItem({
      id: 'a',
      title: 'Research Symposium',
      campus: { ...campusItem({ id: 'a' }).campus!, startsAt: '2026-08-11T13:00:00.000Z' },
    });
    const b = campusItem({ id: 'b', title: 'Research Symposium' });
    expect(shouldFuzzyMerge(a, b)).toBe(false);
  });
});

describe('mergedConfidence', () => {
  it('counts distinct sources, not repeated ones', () => {
    // Two feeds inside calendar.tamu.edu are one publisher agreeing with
    // itself, not independent corroboration.
    const single = mergedConfidence([
      { source: 'tamu-calendar', externalId: '1', url: '', channel: 'a', firstSeen: NOW, lastModified: null },
      { source: 'tamu-calendar', externalId: '2', url: '', channel: 'b', firstSeen: NOW, lastModified: null },
    ]);
    expect(single).toBeCloseTo(0.9);
  });

  it('rises with independent confirmation but never reaches 1', () => {
    const many = mergedConfidence([
      { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: NOW, lastModified: null },
      { source: 'crossref', externalId: '2', url: '', channel: null, firstSeen: NOW, lastModified: null },
      { source: 'openalex', externalId: '3', url: '', channel: null, firstSeen: NOW, lastModified: null },
    ]);
    expect(many).toBeGreaterThan(0.95);
    expect(many).toBeLessThan(1);
  });
});

describe('mergeCluster via dedupe', () => {
  it('keeps the richest data and the earliest firstSeen', () => {
    const older = paperItem('a', ['doi:10.1/x'], 'Paper', NOW);
    older.firstSeen = '2026-01-01T00:00:00.000Z';
    older.summary = 'short';

    const richer = paperItem('b', ['doi:10.1/x'], 'Paper', NOW);
    richer.summary = 'a considerably longer and more informative abstract';

    const merged = dedupe([older, richer]).items[0];
    expect(merged?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(merged?.summary).toBe('a considerably longer and more informative abstract');
    expect(merged?.sources).toHaveLength(2);
  });
});
