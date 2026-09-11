/**
 * Build-time rate re-derivation from a committed studies snapshot.
 *
 * The live listing reads `effectiveHourly` out of `src/data/studies.json`.
 * Parser fixes would otherwise wait for the next ingest. Hydration re-reads
 * `compensation.raw` / `duration.raw` and must not invent listings or pay.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeEffectiveHourly } from '@/studies/effective-rate.ts';
import { hydrateStudiesSnapshot, hydrateStudyRecord } from '@/studies/hydrate.ts';
import { normalizeAndDedupe } from '@/studies/normalize.ts';
import { parseCompensation } from '@/studies/parse-compensation.ts';
import { parseDuration } from '@/studies/parse-duration.ts';
import type { RawStudy } from '@/studies/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url)), 'utf8'),
) as RawStudy[];

const { studies } = normalizeAndDedupe(fixture, { now: new Date('2026-08-09T12:00:00Z') });

function byId(id: string) {
  const study = studies.find((row) => row.id === id);
  if (study === undefined) throw new Error(`normalized record ${id} is missing`);
  return study;
}

describe('hydrateStudyRecord', () => {
  it('re-derives #8331 at $48/hr from a stale $96 snapshot row', () => {
    const honest = byId('8331');
    expect(honest.effectiveHourly).toBe(48);

    const stale = {
      ...honest,
      compensation: { ...honest.compensation, visitCount: null as number | null },
      duration: parseDuration(honest.duration.raw),
      effectiveHourly: 96,
    };
    expect(stale.duration.sessionCount).toBeNull();
    expect(stale.duration.totalHoursMax).toBeCloseTo(0.8333, 4);

    const hydrated = hydrateStudyRecord(stale);
    expect(hydrated.compensation.visitCount).toBe(2);
    expect(hydrated.duration.sessionCount).toBe(2);
    expect(hydrated.duration.totalHoursMax).toBe(1.6666);
    expect(hydrated.effectiveHourly).toBe(48);
  });

  it('does not re-break F2 on #4618 while fixing F9', () => {
    const honest = byId('4618');
    expect(honest.effectiveHourly).toBeCloseTo(21.43, 2);

    const hydrated = hydrateStudyRecord({
      ...honest,
      compensation: { ...honest.compensation, visitCount: null },
      duration: parseDuration(honest.duration.raw),
      effectiveHourly: 64.29,
    });
    expect(hydrated.compensation.visitCount).toBe(3);
    expect(hydrated.duration.totalHoursMax).toBe(3.5);
    expect(hydrated.effectiveHourly).toBeCloseTo(21.43, 2);
  });

  it('is a no-op when the snapshot already matches current math', () => {
    const honest = byId('8331');
    expect(hydrateStudyRecord(honest)).toBe(honest);
  });
});

describe('hydrateStudiesSnapshot', () => {
  it('rewrites only the studies array', () => {
    const snapshot = {
      fetchedAt: '2026-08-09T12:00:00.000Z',
      totalFromHeader: studies.length,
      studies: studies.map((study) => (
        study.id === '8331'
          ? {
              ...study,
              compensation: { ...study.compensation, visitCount: null },
              duration: parseDuration(study.duration.raw),
              effectiveHourly: 96,
            }
          : study
      )),
    };
    const hydrated = hydrateStudiesSnapshot(snapshot);
    expect(hydrated.fetchedAt).toBe(snapshot.fetchedAt);
    expect(hydrated.studies).toHaveLength(snapshot.studies.length);
    expect(hydrated.studies.find((row) => row.id === '8331')?.effectiveHourly).toBe(48);
  });

  it('agrees with computeEffectiveHourly on every fixture-normalized row', () => {
    for (const study of hydrateStudiesSnapshot({
      fetchedAt: '2026-08-09T12:00:00.000Z',
      totalFromHeader: studies.length,
      studies,
    }).studies) {
      const compensation = {
        ...study.compensation,
        visitCount: study.compensation.visitCount ?? parseCompensation(study.compensation.raw).visitCount,
      };
      expect(study.effectiveHourly, `record ${study.id}`).toBe(
        computeEffectiveHourly(compensation, study.duration),
      );
    }
  });
});
