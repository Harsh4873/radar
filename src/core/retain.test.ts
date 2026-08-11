import { describe, expect, it } from 'vitest';
import type { RadarItem, SourceId, SourceReport } from '@/types.ts';
import { retainUnfetched } from '@/core/retain.ts';

const NOW = '2026-08-11T00:00:00.000Z';

function item(id: string, sources: SourceId[]): RadarItem {
  return {
    id,
    vertical: 'research',
    title: id,
    summary: '',
    url: 'https://example.test/1',
    identity: [],
    sources: sources.map((source, index) => ({
      source,
      externalId: `${id}-${index}`,
      url: '',
      channel: null,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastModified: null,
    })),
    sourceConfidence: 0.9,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: NOW,
    lastModified: null,
    occurredAt: NOW,
    endsAt: null,
    tags: [],
    relevance: 50,
    reasons: [],
    status: 'unchanged',
    contentHash: 'a',
  };
}

function report(id: SourceId, failedRequests: number, status: SourceReport['status'] = 'ok'): SourceReport {
  return {
    id,
    label: id,
    vertical: 'research',
    status,
    itemCount: 0,
    fetchSource: 'network',
    durationMs: 0,
    failedRequests,
    note: null,
    docsUrl: '',
  };
}

describe('retainUnfetched', () => {
  it('carries forward items whose only source failed', () => {
    // The live incident: arXiv timed out on 2 of 3 queries, ten papers dropped
    // out of the feed, and the next run announced them as NEW.
    const previous = [item('a', ['arxiv']), item('b', ['arxiv'])];
    const next = [item('a', ['arxiv'])];

    const result = retainUnfetched(previous, next, [report('arxiv', 2, 'degraded')]);

    expect(result.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(result.retained.map((i) => i.id)).toEqual(['b']);
    expect(result.impaired).toEqual(['arxiv']);
  });

  it('marks a carried-forward item unchanged, never new', () => {
    const previous = [item('b', ['arxiv'])];
    const result = retainUnfetched(previous, [], [report('arxiv', 1)]);
    expect(result.retained[0]?.status).toBe('unchanged');
  });

  it('drops items a HEALTHY source stopped returning', () => {
    // An event that passed or a listing withdrawn must actually disappear.
    const previous = [item('a', ['tamu-calendar'])];
    const result = retainUnfetched(previous, [], [report('tamu-calendar', 0)]);
    expect(result.items).toHaveLength(0);
    expect(result.retained).toHaveLength(0);
  });

  it('does NOT retain on degraded status alone', () => {
    // The TAMU calendar reports its 1000-record cap as a warning on every
    // healthy run. Keying off `degraded` would retain every past event forever.
    const previous = [item('a', ['tamu-calendar'])];
    const result = retainUnfetched(previous, [], [report('tamu-calendar', 0, 'degraded')]);
    expect(result.retained).toHaveLength(0);
  });

  it('drops an item when any of its sources was healthy', () => {
    // A healthy source could have returned it and did not, so it is really gone.
    const previous = [item('a', ['arxiv', 'europepmc'])];
    const result = retainUnfetched(previous, [], [report('arxiv', 1), report('europepmc', 0)]);
    expect(result.retained).toHaveLength(0);
  });

  it('prefers the fresh copy when a source did answer', () => {
    const previous = [{ ...item('a', ['arxiv']), title: 'stale' }];
    const next = [{ ...item('a', ['arxiv']), title: 'fresh' }];
    const result = retainUnfetched(previous, next, [report('arxiv', 1)]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('fresh');
  });

  it('is a no-op when nothing failed', () => {
    const previous = [item('a', ['arxiv'])];
    const result = retainUnfetched(previous, [], [report('arxiv', 0)]);
    expect(result.items).toHaveLength(0);
    expect(result.impaired).toEqual([]);
  });

  it('handles a first run with no previous snapshot', () => {
    const result = retainUnfetched(null, [item('a', ['arxiv'])], [report('arxiv', 1)]);
    expect(result.items).toHaveLength(1);
    expect(result.retained).toHaveLength(0);
  });
});
