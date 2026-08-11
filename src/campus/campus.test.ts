/**
 * Campus connectors and classifiers, against frozen live captures.
 *
 * The privacy assertions here are not stylistic. `calendar.tamu.edu` publishes
 * a real staff email on most events with registration, and this site deploys
 * publicly, so a regression that lets one through republishes staff addresses
 * as scrapeable plaintext.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { mapEvent } from '@/campus/sources/tamu-calendar.ts';
import { mapStudy, parseCompensation } from '@/campus/sources/arv.ts';
import { classify, extractCompanies } from '@/campus/classify.ts';
import { collapseSeries } from '@/campus/series.ts';
import { normalizeItem } from '@/core/normalize.ts';
import type { RadarItem } from '@/types.ts';

const NOW = '2026-08-10T00:00:00.000Z';
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function json<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8'),
  ) as T;
}

describe('TAMU calendar connector', () => {
  const events = json<Record<string, unknown>[]>('tamu-calendar.json');

  it('maps a real event', () => {
    const item = mapEvent(events[0]!, 'Main University Calendar')!;
    expect(item.vertical).toBe('campus');
    expect(item.identity[0]).toMatch(/^event:tamu-/);
    expect(item.campus?.category).toBeTruthy();
    expect(item.campus?.seriesCount).toBe(1);
  });

  it('NEVER carries a registration email into a published item', () => {
    const withEmail = events.filter((e) => typeof e['registration_owner_email'] === 'string' && e['registration_owner_email'] !== '');
    expect(withEmail.length).toBeGreaterThan(0);

    for (const event of withEmail) {
      const raw = mapEvent(event, 'Main University Calendar');
      if (raw === null) continue;
      const item = normalizeItem(raw, { now: NOW });
      const serialized = JSON.stringify(item);
      expect(serialized).not.toMatch(EMAIL_PATTERN);
    }
  });

  it('strips any address pasted into a description', () => {
    const raw = mapEvent(
      { id: 1, title: 'Workshop', url: 'https://calendar.tamu.edu/event/1', description: 'RSVP to staff@tamu.edu now' },
      'test',
    )!;
    const item = normalizeItem(raw, { now: NOW })!;
    expect(item.summary).not.toMatch(EMAIL_PATTERN);
    expect(item.summary).toContain('[email removed]');
  });

  it('reads 1|null booleans correctly', () => {
    const allDay = mapEvent({ id: 2, title: 'X', url: 'https://x.test/1', is_all_day: 1 }, 't')!;
    expect(allDay.campus?.isAllDay).toBe(true);

    const notAllDay = mapEvent({ id: 3, title: 'X', url: 'https://x.test/1', is_all_day: null }, 't')!;
    expect(notAllDay.campus?.isAllDay).toBe(false);
  });

  it('parses coordinates despite latitude being a number and longitude a string', () => {
    const item = mapEvent(
      { id: 4, title: 'X', url: 'https://x.test/1', location_latitude: 30.61, location_longitude: '-96.34' },
      't',
    )!;
    expect(item.campus?.coordinates).toEqual([30.61, -96.34]);
  });

  it('treats 0,0 coordinates as absent rather than the Gulf of Guinea', () => {
    const item = mapEvent(
      { id: 5, title: 'X', url: 'https://x.test/1', location_latitude: 0, location_longitude: '0' },
      't',
    )!;
    expect(item.campus?.coordinates).toBeNull();
  });

  it('produces plain-text summaries from HTML descriptions', () => {
    for (const event of events) {
      const item = mapEvent(event, 't');
      expect(item?.summary ?? '').not.toMatch(/<\/?[a-zA-Z][^>]*>/);
    }
  });
});

describe('Aggie Research Volunteers connector', () => {
  const studies = json<Record<string, unknown>[]>('arv-studies.json');

  it('maps a study listing with no start time', () => {
    const item = mapStudy(studies[0]!)!;
    expect(item.campus?.category).toBe('research');
    // Open until it expires - it is not an event with a start time. Giving it
    // one made the past-events cut delete all 86 listings.
    expect(item.campus?.startsAt).toBeNull();
  });

  it('never carries the contact email through', () => {
    for (const study of studies) {
      const raw = mapStudy(study);
      if (raw === null) continue;
      const item = normalizeItem(raw, { now: NOW });
      expect(JSON.stringify(item)).not.toMatch(EMAIL_PATTERN);
    }
  });

  it('survives the past-events cut once normalized', () => {
    // The regression test for the bug that silently dropped every study.
    const item = normalizeItem(mapStudy(studies[0]!)!, { now: NOW })!;
    expect(item.campus?.startsAt).toBeNull();
    expect(item.campus?.endsAt ?? null).not.toBe(undefined);
  });
});

describe('parseCompensation', () => {
  it('parses the real "Up to $30" shape', () => {
    const parsed = parseCompensation('Up to $30 <br>Paid as Amazon gift card');
    expect(parsed.usd).toBe(30);
    expect(parsed.isChance).toBe(false);
    expect(parsed.text).not.toContain('<br>');
  });

  it('takes the guaranteed low end of a range', () => {
    expect(parseCompensation('$10-$20 per session').usd).toBe(10);
  });

  it('refuses to price a raffle', () => {
    // A chance at $100 is not $100.
    const parsed = parseCompensation('Enter a raffle to win $100');
    expect(parsed.usd).toBeNull();
    expect(parsed.isChance).toBe(true);
  });

  it('returns null rather than guessing when no figure is given', () => {
    expect(parseCompensation('Compensation available').usd).toBeNull();
    expect(parseCompensation('').usd).toBeNull();
    expect(parseCompensation(null).usd).toBeNull();
  });

  it('handles thousands separators', () => {
    expect(parseCompensation('$1,200 total').usd).toBe(1200);
  });
});

describe('classify', () => {
  const base = { description: '', group: null, eventTypes: [] as string[] };

  it('routes a named employer to companies', () => {
    expect(classify({ ...base, title: 'NVIDIA Technical Information Session' })).toBe('companies');
  });

  it('lets athletics ownership beat everything else', () => {
    // A "Career Night" run by Aggie Athletics is still a sports event.
    expect(classify({ ...base, title: 'Career Night', group: 'Aggie Athletics' })).toBe('sports');
  });

  it('routes deadlines ahead of the generic academic bucket', () => {
    expect(classify({ ...base, title: 'Scholarship applications due Friday' })).toBe('deadline');
  });

  it('marks study listings as research without reading the text', () => {
    expect(classify({ ...base, title: 'anything', isStudy: true })).toBe('research');
  });

  it('falls back to community', () => {
    expect(classify({ ...base, title: 'Farmers Market' })).toBe('community');
  });
});

describe('extractCompanies', () => {
  it('finds curated employers', () => {
    expect(extractCompanies('Google Tech Talk', '')).toContain('google');
  });

  it('prefers the longest match on overlapping names', () => {
    expect(extractCompanies('ExxonMobil recruiting', '')).toEqual(['exxonmobil']);
  });

  it('does not match a short name inside a longer word', () => {
    // 'ge' and 'ti' are real recruiters and also fragments of common words.
    expect(extractCompanies('General interest meeting', '')).not.toContain('ge');
    expect(extractCompanies('Continental drift seminar', '')).not.toContain('ti');
  });

  it('does not invent a company from a building name', () => {
    // 'Zachry' is a TAMU building AND a real engineering firm.
    expect(extractCompanies('Seminar in Zachry 297', '')).toEqual([]);
  });
});

describe('collapseSeries', () => {
  function event(id: string, title: string, startsAt: string, organizer = 'Chemistry'): RadarItem {
    const raw = mapEvent(
      { id, title, url: `https://calendar.tamu.edu/event/${id}`, date_iso: startsAt, group_title: organizer },
      'test',
    )!;
    return normalizeItem(raw, { now: NOW })!;
  }

  it('folds a multi-day conference into one card', () => {
    // Verified live: LiveWhale publishes the ACS Fall Meeting as five separate
    // events with five ids across five days.
    const days = ['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'].map((d, i) =>
      event(String(100 + i), 'ACS Fall 2026 Meeting', `${d}T09:00:00-05:00`),
    );

    const { items, collapsed } = collapseSeries(days);
    expect(items).toHaveLength(1);
    expect(collapsed).toBe(4);
    expect(items[0]?.campus?.seriesCount).toBe(5);
    // The card spans the series.
    expect(items[0]?.campus?.startsAt).toContain('2026-08-23');
    expect(items[0]?.campus?.endsAt).toContain('2026-08-27');
  });

  it('keeps a term-long seminar series as separate sessions', () => {
    // "There is a seminar sometime in the next four months" is not useful.
    const sessions = [
      event('200', 'Undergraduate Research Cafe', '2026-09-02T14:00:00-05:00'),
      event('201', 'Undergraduate Research Cafe', '2026-11-05T14:00:00-05:00'),
    ];
    expect(collapseSeries(sessions).items).toHaveLength(2);
  });

  it('keeps same-titled events from different organizers apart', () => {
    const a = event('300', 'General Meeting', '2026-08-20T14:00:00-05:00', 'Chemistry');
    const b = event('301', 'General Meeting', '2026-08-21T14:00:00-05:00', 'Biology');
    expect(collapseSeries([a, b]).items).toHaveLength(2);
  });

  it('leaves undated items untouched', () => {
    const undated = normalizeItem(mapStudy(json<Record<string, unknown>[]>('arv-studies.json')[0]!)!, {
      now: NOW,
    })!;
    expect(collapseSeries([undated]).items).toHaveLength(1);
  });
});
