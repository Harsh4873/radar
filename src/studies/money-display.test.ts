import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeStudy } from '@/studies/normalize.ts';
import { rateIsUpTo, scaledStudyTotal, studyTotalLabel, usd } from '@/studies/money-display.ts';
import type { ParsedCompensation, RawStudy } from '@/studies/types.ts';

const records = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url)), 'utf8'),
) as RawStudy[];
const NOW = new Date('2026-08-09T12:00:00Z');

function study(id: number) {
  const raw = records.find((row) => row.id === id);
  if (raw === undefined) throw new Error(`fixture record ${id} is missing`);
  return normalizeStudy(raw, { now: NOW });
}

function comp(overrides: Partial<ParsedCompensation>): ParsedCompensation {
  return {
    guaranteedMin: null,
    guaranteedMax: null,
    raffleMax: null,
    raffleOnly: false,
    isHourlyRate: false,
    hourlyMin: null,
    hourlyMax: null,
    currencyKind: 'unknown',
    perVisit: null,
    visitCount: null,
    completionBonus: null,
    hasNonCashPerk: false,
    sonaCreditOption: false,
    raw: '',
    confidence: 'high',
    notes: [],
    ...overrides,
  };
}

describe('money display', () => {
  it('formats cents only when they are not zero', () => {
    expect(usd(60)).toBe('$60');
    expect(usd(137.5)).toBe('$137.50');
    expect(usd(33.25)).toBe('$33.25');
  });

  it('shows the scaled whole-study total without rewriting compensation', () => {
    for (const [id, stored, honest] of [
      [12766, 70, 120],
      [8874, 30, 60],
    ] as const) {
      const row = study(id);
      const shown = row.compensation.guaranteedMax ?? row.compensation.guaranteedMin;
      expect(shown, `record ${id}`).toBe(stored);
      expect(scaledStudyTotal(row.compensation, row.duration), `record ${id}`).toBe(honest);
      expect(rateIsUpTo(row.compensation), `record ${id}`).toBe(false);
    }
  });

  it('does not replace a ceiling that is already the whole-study total', () => {
    const row = study(9821);
    expect(row.compensation.guaranteedMax).toBe(550);
    expect(scaledStudyTotal(row.compensation, row.duration)).toBeNull();
    expect(rateIsUpTo(row.compensation)).toBe(true);
  });

  it('labels a ceiling total as up to, and a scaled whole-study total as firm', () => {
    expect(studyTotalLabel(comp({ guaranteedMin: null, guaranteedMax: 550 }), 550, false)).toBe('up to $550');
    expect(studyTotalLabel(comp({ guaranteedMin: 70, guaranteedMax: null }), 120, true)).toBe('$120');
    expect(studyTotalLabel(comp({ guaranteedMin: 40, guaranteedMax: 50 }), 50, false)).toBe('$50');
  });

  it('labels a stated hourly range as up to, and a single stated rate as firm', () => {
    expect(rateIsUpTo(study(7660).compensation)).toBe(true);
    expect(rateIsUpTo(comp({ isHourlyRate: true, hourlyMin: 20, hourlyMax: 20 }))).toBe(false);
    expect(rateIsUpTo(comp({ isHourlyRate: true, hourlyMin: 19, hourlyMax: 33.25 }))).toBe(true);
    expect(rateIsUpTo(comp({ guaranteedMin: 40, guaranteedMax: 50 }))).toBe(false);
  });
});
