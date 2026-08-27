import { describe, expect, it } from 'vitest';

import { decideRefresh, type RefreshGateInput } from './refresh-gate.ts';

function radar(researchCount = 4, campusCount = 4, fetchedAt = '2026-08-18T00:00:00Z') {
  const items = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    lastSeen: fetchedAt,
  }));
  return {
    fetchedAt,
    research: { fetchedAt, items: items('research', researchCount), diff: { added: ['old'] } },
    campus: { fetchedAt, items: items('campus', campusCount), diff: { added: ['old'] } },
  };
}

function studies(count = 4, fetchedAt = '2026-08-18T00:00:00Z') {
  return {
    fetchedAt,
    totalFromHeader: count,
    studies: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      title: `Study ${index}`,
      staleness: 'fresh',
    })),
    sourceReports: [
      {
        id: 'aggie-research-volunteers',
        status: 'ok',
        itemCount: count,
        fetchSource: 'network',
        failedRequests: 0,
        complete: true,
        durationMs: 120,
        note: null as string | null,
      },
      {
        id: 'clinicaltrials-gov',
        status: 'ok',
        itemCount: 2,
        fetchSource: 'network',
        failedRequests: 0,
        complete: true,
        durationMs: 220,
        note: null as string | null,
      },
    ],
  };
}

function taxonomies() {
  const term = (id: number, name: string) => ({ id, name, slug: name.toLowerCase() });
  return {
    category: { 1: term(1, 'Health') },
    location: { 2: term(2, 'Online') },
    sessionType: { 3: term(3, 'Survey') },
    topic: { 4: term(4, 'Wellness') },
  };
}

function input(): RefreshGateInput {
  return {
    previousRadar: radar(),
    nextRadar: radar(),
    previousStudies: studies(),
    nextStudies: studies(),
    previousTaxonomies: structuredClone(taxonomies()),
    nextTaxonomies: structuredClone(taxonomies()),
  };
}

describe('decideRefresh', () => {
  it('ignores polling timestamps, lastSeen, and stored diff churn', () => {
    const value = input();
    value.nextRadar = radar(4, 4, '2026-08-25T00:00:00Z');
    value.nextStudies = studies(4, '2026-08-25T00:00:00Z');
    (value.nextRadar as { research: { diff: unknown } }).research.diff = { added: [] };

    expect(decideRefresh(value)).toBe('unchanged');
  });

  it('publishes a Studies-only record change', () => {
    const value = input();
    ((value.nextStudies as ReturnType<typeof studies>).studies[0] as { title: string }).title = 'Updated';

    expect(decideRefresh(value)).toBe('changed');
  });

  it('publishes an upstream study-count change even if deduped records match', () => {
    const value = input();
    (value.nextStudies as ReturnType<typeof studies>).totalFromHeader += 1;

    expect(decideRefresh(value)).toBe('changed');
  });

  it('publishes a Studies source failure or recovery even when retained records match', () => {
    const value = input();
    const next = value.nextStudies as ReturnType<typeof studies>;
    next.sourceReports[1] = {
      ...next.sourceReports[1]!,
      status: 'degraded',
      fetchSource: 'cache',
      failedRequests: 1,
      complete: false,
      note: 'temporary timeout',
    };

    expect(decideRefresh(value)).toBe('changed');
  });

  it('ignores Studies request duration and diagnostic wording churn', () => {
    const value = input();
    const next = value.nextStudies as ReturnType<typeof studies>;
    next.sourceReports[0] = {
      ...next.sourceReports[0]!,
      durationMs: 9_999,
      note: 'same health, different diagnostic wording',
    };

    expect(decideRefresh(value)).toBe('unchanged');
  });

  it('publishes a taxonomy-only change', () => {
    const value = input();
    const next = taxonomies();
    next.category[1] = { id: 1, name: 'Fitness', slug: 'fitness' };
    value.nextTaxonomies = next;

    expect(decideRefresh(value)).toBe('changed');
  });

  it('ignores taxonomy metadata the site does not publish', () => {
    const value = input();
    const next = taxonomies();
    const categories = next.category as unknown as Record<number, Record<string, unknown>>;
    categories[1] = {
      ...categories[1],
      count: 999,
      description: 'Changed upstream decoration',
      _links: { self: [{ href: 'https://example.test/term/1' }] },
    };
    value.nextTaxonomies = next;

    expect(decideRefresh(value)).toBe('unchanged');
  });

  it.each([
    ['research', radar(1, 4), studies()],
    ['campus', radar(4, 1), studies()],
    ['studies', radar(), studies(1)],
  ])('rejects a %s collapse independently', (_engine, nextRadar, nextStudies) => {
    const value = input();
    value.nextRadar = nextRadar;
    value.nextStudies = nextStudies;

    expect(decideRefresh(value)).toBe('suspect');
  });

  it('rejects a taxonomy collapse independently', () => {
    const value = input();
    const previous = taxonomies();
    previous.category = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        index + 1,
        { id: index + 1, name: `Term ${index}`, slug: `term-${index}` },
      ]),
    ) as typeof previous.category;
    value.previousTaxonomies = previous;

    expect(decideRefresh(value)).toBe('suspect');
  });

  it.each([
    ['Radar', { nextRadar: radar(0, 0) }],
    ['Studies', { nextStudies: studies(0) }],
    ['taxonomies', { nextTaxonomies: null }],
    ['taxonomy map', { nextTaxonomies: { ...taxonomies(), topic: {} } }],
  ])('rejects an empty or invalid %s result', (_label, override) => {
    expect(decideRefresh({ ...input(), ...override })).toBe('empty');
  });

  it('publishes when there is no previous baseline', () => {
    const value = input();
    value.previousRadar = null;
    value.previousStudies = null;
    value.previousTaxonomies = null;

    expect(decideRefresh(value)).toBe('changed');
  });
});
