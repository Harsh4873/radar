import { describe, expect, it } from 'vitest';
import type { RadarItem } from '@/types.ts';
import {
  corroborationSignal,
  finalizeScore,
  imminenceSignal,
  reason,
  recencySignal,
  tidyReasons,
} from '@/core/rank.ts';
import { diffSnapshots, isEmptyDiff, itemsSince } from '@/core/change.ts';
import { weekOf, estimateReadingMinutes } from '@/core/digest.ts';
import { bandFor, hasProfileMatch, scoreResearchItem } from '@/research/score.ts';
import { matchProfile, searchable } from '@/research/profile.ts';

const NOW = '2026-08-10T00:00:00.000Z';

function paper(overrides: Partial<RadarItem> = {}, research: Record<string, unknown> = {}): RadarItem {
  return {
    id: 'research-1',
    vertical: 'research',
    title: 'A paper',
    summary: '',
    url: 'https://example.test/1',
    identity: [],
    sources: [
      { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: NOW, lastModified: null },
    ],
    sourceConfidence: 0.95,
    firstSeen: NOW,
    lastSeen: NOW,
    lastModified: null,
    occurredAt: NOW,
    endsAt: null,
    tags: [],
    relevance: 0,
    reasons: [],
    status: 'new',
    contentHash: 'a',
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
      publishedDate: NOW,
      citedByCount: null,
      isOpenAccess: false,
      openAccessUrl: null,
      topics: [],
      citesTracked: [],
      lifecycle: { preprintVersion: null, publishedDoi: null, publishedIn: null, isSuperseded: false },
      ...research,
    },
    ...overrides,
  } as RadarItem;
}

describe('finalizeScore', () => {
  it('sums reasons and clamps to 0..100', () => {
    expect(finalizeScore([reason('a', 'A', 60), reason('b', 'B', 60)]).relevance).toBe(100);
    expect(finalizeScore([reason('a', 'A', -60)]).relevance).toBe(0);
  });

  it('drops zero-point reasons and merges duplicates', () => {
    const tidied = tidyReasons([reason('a', 'A', 5), reason('a', 'A', 3), reason('b', 'B', 0)]);
    expect(tidied).toHaveLength(1);
    expect(tidied[0]?.points).toBe(8);
  });

  it('orders reasons by contribution so the card shows the strongest first', () => {
    const { reasons } = finalizeScore([reason('a', 'small', 2), reason('b', 'big', 30)]);
    expect(reasons[0]?.label).toBe('big');
  });
});

describe('recency and imminence', () => {
  it('rewards fresh papers and mildly penalises very old ones', () => {
    expect(recencySignal('2026-08-09T00:00:00Z', NOW)?.points).toBe(10);
    expect(recencySignal('2020-01-01T00:00:00Z', NOW)?.points).toBeLessThan(0);
  });

  it('returns null for an unknown date rather than treating it as now', () => {
    expect(recencySignal(null, NOW)).toBeNull();
  });

  it('pushes a finished event out of the feed', () => {
    const done = imminenceSignal('2026-08-01T00:00:00Z', NOW);
    expect(done?.points).toBeLessThan(-50);
  });

  it('ranks today above next month', () => {
    const today = imminenceSignal('2026-08-10T18:00:00Z', NOW)?.points ?? 0;
    const later = imminenceSignal('2026-09-20T18:00:00Z', NOW)?.points ?? 0;
    expect(today).toBeGreaterThan(later);
  });

  it('uses calendar days, so "tomorrow" means the next date', () => {
    // NOW is 2026-08-10T00:00Z = 2026-08-09 19:00 Central. An event at 9am on
    // 2026-08-10 Central is TOMORROW by the calendar even though it is only
    // 14 hours away; elapsed-hours arithmetic would call it "today".
    const tomorrow = imminenceSignal('2026-08-10T14:00:00Z', NOW);
    expect(tomorrow?.label).toBe('tomorrow');

    // And something later the same Central evening is still today.
    const tonight = imminenceSignal('2026-08-10T01:30:00Z', NOW);
    expect(tonight?.label).toBe('today');
  });

  it('is stable across two runs minutes apart', () => {
    // The churn this replaced: campus events cluster at round times, so a
    // dozen of them crossed an elapsed-hours band together and the snapshot
    // differed between ingests three minutes apart for no visible reason.
    const events = ['2026-08-17T14:00:00Z', '2026-08-31T14:00:00Z', '2026-10-09T14:00:00Z'];
    for (const event of events) {
      const a = imminenceSignal(event, '2026-08-10T09:00:00Z');
      const b = imminenceSignal(event, '2026-08-10T09:03:00Z');
      expect(a?.points).toBe(b?.points);
      expect(a?.label).toBe(b?.label);
    }
  });
});

describe('corroborationSignal', () => {
  it('does not fire for a single source', () => {
    expect(corroborationSignal(paper())).toBeNull();
  });

  it('fires once two distinct sources agree', () => {
    const item = paper({
      sources: [
        { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: NOW, lastModified: null },
        { source: 'crossref', externalId: '2', url: '', channel: null, firstSeen: NOW, lastModified: null },
      ],
    });
    expect(corroborationSignal(item)?.points).toBeGreaterThan(0);
  });
});

describe('bandFor', () => {
  it('requires the organism for the core band', () => {
    // A fish mitogenome paper firing `positive selection` + PAML is a methods
    // paper, not core TB work. 24 of 51 "core" papers were mis-banded this way.
    const noOrganism = matchProfile(searchable('Complete mitochondrial genome under positive selection using PAML codeml'));
    expect(bandFor(noOrganism)).not.toBe('core');

    const withOrganism = matchProfile(
      searchable('Positive selection in Mycobacterium tuberculosis clinical isolates'),
    );
    expect(bandFor(withOrganism)).toBe('core');
  });

  it('bands a pure methods paper as methods', () => {
    const matches = matchProfile(searchable('A new branch-site codon model implemented in HyPhy'));
    expect(bandFor(matches)).toBe('methods');
  });
});

describe('hasProfileMatch', () => {
  it('rejects a paper whose only merit is being recent and open access', () => {
    // 297 papers reached the feed on exactly this basis - coronary
    // intervention, insomnia therapy - before this gate existed.
    const scored = scoreResearchItem(
      paper({ title: 'Digital Behavioural Therapy for Insomnia' }, { isOpenAccess: true, openAccessUrl: 'https://x' }),
      { now: NOW },
    );
    expect(hasProfileMatch(scored)).toBe(false);
  });

  it('accepts a paper that matched on content', () => {
    const scored = scoreResearchItem(
      paper({ title: 'Positive selection in Mycobacterium tuberculosis' }),
      { now: NOW },
    );
    expect(hasProfileMatch(scored)).toBe(true);
    expect(scored.relevance).toBeGreaterThan(50);
  });
});

describe('scoreResearchItem', () => {
  it('itemizes every point it awards', () => {
    const scored = scoreResearchItem(
      paper({ title: 'Positive selection in M. tuberculosis using codeml' }),
      { now: NOW },
    );
    expect(scored.reasons.length).toBeGreaterThan(2);
    for (const r of scored.reasons) expect(r.label.length).toBeGreaterThan(0);
  });

  it('rewards citing tracked work', () => {
    const tracked = new Set(['W123']);
    const withCitation = scoreResearchItem(
      paper({ title: 'Selection in M. tuberculosis' }, { citesTracked: ['W123', 'W999'] }),
      { now: NOW, trackedWorkIds: tracked },
    );
    const without = scoreResearchItem(paper({ title: 'Selection in M. tuberculosis' }), { now: NOW });
    expect(withCitation.relevance).toBeGreaterThan(without.relevance);
    expect(withCitation.reasons.some((r) => r.signal === 'citation')).toBe(true);
  });

  it('flags a title-only match as weaker evidence', () => {
    const scored = scoreResearchItem(paper({ title: 'Selection in M. tuberculosis' }, { abstract: '' }), {
      now: NOW,
    });
    expect(scored.reasons.some((r) => r.signal === 'evidence' && r.points < 0)).toBe(true);
  });

  it('honours muted terms', () => {
    const muted = scoreResearchItem(paper({ title: 'Positive selection in M. tuberculosis' }), {
      now: NOW,
      mutedTerms: new Set(['mtb']),
    });
    expect(muted.reasons.some((r) => r.signal === 'organism')).toBe(false);
  });
});

describe('diffSnapshots', () => {
  it('reports everything as added on a first run', () => {
    const { items, diff } = diffSnapshots(null, [paper()]);
    expect(diff.added).toHaveLength(1);
    expect(items[0]?.status).toBe('new');
  });

  it('carries firstSeen forward so items do not look new forever', () => {
    // Without this, "since your last visit" reports the entire corpus.
    const before = paper({ firstSeen: '2026-01-01T00:00:00.000Z' });
    const after = paper({ firstSeen: '2026-08-10T00:00:00.000Z' });
    const { items } = diffSnapshots([before], [after]);
    expect(items[0]?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(items[0]?.status).toBe('unchanged');
  });

  it("carries each source's own firstSeen forward", () => {
    // Every ItemSource was being restamped with the current run's time, so all
    // 342 campus items' `sources` arrays rewrote on every ingest and the
    // "only commit on a real change" gate never held.
    const before = paper({
      sources: [
        { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: '2026-01-01T00:00:00.000Z', lastModified: null },
      ],
    });
    const after = paper({
      sources: [
        { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: '2026-08-10T00:00:00.000Z', lastModified: null },
      ],
    });

    const { items } = diffSnapshots([before], [after]);
    expect(items[0]?.sources[0]?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stamps a genuinely new source with this run', () => {
    const before = paper({
      sources: [
        { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: '2026-01-01T00:00:00.000Z', lastModified: null },
      ],
    });
    const after = paper({
      sources: [
        { source: 'europepmc', externalId: '1', url: '', channel: null, firstSeen: NOW, lastModified: null },
        { source: 'crossref', externalId: '2', url: '', channel: null, firstSeen: NOW, lastModified: null },
      ],
    });

    const { items } = diffSnapshots([before], [after]);
    expect(items[0]?.sources[0]?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(items[0]?.sources[1]?.firstSeen).toBe(NOW);
  });

  it('detects a preprint becoming published', () => {
    const before = paper({ id: 'p1' }, { lifecycle: { preprintVersion: 1, publishedDoi: null, publishedIn: null, isSuperseded: false } });
    const after = paper({ id: 'p1', contentHash: 'b' }, {
      lifecycle: { preprintVersion: 1, publishedDoi: '10.1111/eva.1', publishedIn: 'Evolutionary Applications', isSuperseded: true },
    });

    const { diff, items } = diffSnapshots([before], [after]);
    const change = diff.changes.find((c) => c.kind === 'preprint-published');
    expect(change?.after).toBe('Evolutionary Applications');
    expect(items[0]?.status).toBe('superseded');
  });

  it('detects a preprint revision', () => {
    const before = paper({ id: 'p1' }, { lifecycle: { preprintVersion: 1, publishedDoi: null, publishedIn: null, isSuperseded: false } });
    const after = paper({ id: 'p1', contentHash: 'b' }, { lifecycle: { preprintVersion: 2, publishedDoi: null, publishedIn: null, isSuperseded: false } });
    expect(diffSnapshots([before], [after]).diff.changes.some((c) => c.kind === 'preprint-revised')).toBe(true);
  });

  it('reports removals', () => {
    const { diff } = diffSnapshots([paper({ id: 'gone' })], []);
    expect(diff.removed).toEqual(['gone']);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});

describe('itemsSince', () => {
  it('returns everything when there is no stored last visit', () => {
    expect(itemsSince([paper()], null)).toHaveLength(1);
  });

  it('returns only items first seen after the last visit', () => {
    const old = paper({ id: 'a', firstSeen: '2026-01-01T00:00:00.000Z', status: 'unchanged' });
    const fresh = paper({ id: 'b', firstSeen: '2026-08-09T00:00:00.000Z' });
    const since = itemsSince([old, fresh], '2026-06-01T00:00:00.000Z');
    expect(since.map((i) => i.id)).toEqual(['b']);
  });

  it('includes updated items even if first seen long ago', () => {
    const changed = paper({ id: 'a', firstSeen: '2026-01-01T00:00:00.000Z', status: 'updated' });
    expect(itemsSince([changed], '2026-06-01T00:00:00.000Z')).toHaveLength(1);
  });
});

describe('digest helpers', () => {
  it('computes the Monday of a week', () => {
    // 2026-08-10 is a Monday; 2026-08-13 is the Thursday of the same week.
    expect(weekOf('2026-08-13T12:00:00.000Z')).toBe('2026-08-10');
    expect(weekOf('2026-08-10T00:00:00.000Z')).toBe('2026-08-10');
  });

  it('handles Sunday as the end of the prior week, not the start of a new one', () => {
    expect(weekOf('2026-08-09T12:00:00.000Z')).toBe('2026-08-03');
  });

  it('estimates reading time from abstract length', () => {
    expect(estimateReadingMinutes(paper({}, { abstract: 'word '.repeat(400) }))).toBeGreaterThan(10);
    expect(estimateReadingMinutes(paper({}, { abstract: '' }))).toBe(8);
  });
});
