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

import {
  GROUP_FEEDS,
  isUsefulRecSportsListing,
  mapEvent,
} from '@/campus/sources/tamu-calendar.ts';
import {
  fetchGetInvolved,
  parseGetInvolvedDate,
  parseGetInvolvedHtml,
} from '@/campus/sources/getinvolved.ts';
import { isParticipantResearchStudy } from '@/campus/ingest.ts';
import { classify, extractCompanies, isIntramuralListing } from '@/campus/classify.ts';
import { collapseCoMarketedEvents, collapseSeries } from '@/campus/series.ts';
import { normalizeItem } from '@/core/normalize.ts';
import type { RadarItem } from '@/types.ts';

const NOW = '2026-08-10T00:00:00.000Z';
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function json<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8'),
  ) as T;
}

function text(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8');
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

  it('pulls both official Rec Sports feeds for fuller intramural coverage', () => {
    expect(GROUP_FEEDS).toContain('Department of Rec Sports');
    expect(GROUP_FEEDS).toContain('Rec Sports');
  });

  it('drops routine facility schedules but keeps an explicit Student Rec closure', () => {
    const group = 'Department of Rec Sports';
    for (const title of [
      '50 Meter',
      'Lap Pool',
      'Polo Road Hours',
      'Southside Rec Center Hours',
      'Operating Hours',
      'RC Open',
      'CLOSED',
      'Student Rec Center',
    ]) {
      expect(isUsefulRecSportsListing(title, '', group, null), title).toBe(false);
      expect(mapEvent({ id: title, title, group_title: group }, 'Rec Sports'), title).toBeNull();
    }

    expect(isUsefulRecSportsListing('Student Rec Center Closed', '', group, null)).toBe(true);
    expect(mapEvent({ id: 900, title: 'Student Rec Center Closed', group_title: group }, 'Rec Sports')).not.toBeNull();
    expect(mapEvent({ id: 901, title: 'Intramural Basketball Tournament', group_title: group }, 'Rec Sports')).not.toBeNull();
    expect(mapEvent({ id: 902, title: 'Aggie UX Office Hours', group_title: 'Marketing' }, 'Main')).not.toBeNull();
  });
});

describe('Get Involved connector', () => {
  const html = text('getinvolved.html');

  it('parses Central-time points, ranges, entities, organizers, and locations', () => {
    const events = parseGetInvolvedHtml(html, NOW);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      organizer: 'First Aggie Connections Team',
      startsAt: '2026-08-10T19:39:00.000Z',
      endsAt: '2026-09-09T19:39:00.000Z',
    });
    expect(events[1]).toMatchObject({
      title: 'Club Crawl Fall 2026 - TAMU Badminton Club: The Official Involvement Festival at Texas A&M',
      organizer: 'TAMU Badminton Club',
      startsAt: '2026-09-06T18:00:00.000Z',
      location: 'Memorial Student Center',
    });
    expect(events[2]).toMatchObject({
      organizer: 'Texas A&M Spikeball',
      startsAt: '2026-09-12T14:00:00.000Z',
      endsAt: '2026-09-12T19:00:00.000Z',
    });
  });

  it('does not let the machine timezone reinterpret a bare campus datetime', () => {
    expect(parseGetInvolvedDate('Sun, Nov 1, 2026 1:30 pm', NOW)).toEqual({
      startsAt: '2026-11-01T19:30:00.000Z',
      endsAt: null,
      isAllDay: false,
    });
  });

  it('maps a frozen directory page without touching event detail pages', async () => {
    const calls: string[] = [];
    const result = await fetchGetInvolved({
      now: NOW,
      days: 45,
      attempts: 1,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });

    expect(calls).toHaveLength(1);
    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(3);
    expect(result.records[1]).toMatchObject({
      source: 'getinvolved',
      channel: 'TAMU Badminton Club',
      tags: ['Student organization', 'TAMU Badminton Club'],
      campus: { category: 'sports' },
    });
  });

  it('fails loudly when a successful response has no event cards', async () => {
    const result = await fetchGetInvolved({
      now: NOW,
      attempts: 1,
      fetchImpl: async () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    expect(result.error).toContain('no parseable event cards');
    expect(result.failedRequests).toBe(1);
  });
});

describe('Studies/Radar product boundary', () => {
  const event = (title: string, summary = '', source = 'tamu-calendar') => ({
    vertical: 'campus' as const,
    source: source as 'tamu-calendar',
    externalId: 'test',
    channel: 'test',
    url: 'https://calendar.tamu.edu/event/test',
    title,
    summary,
    occurredAt: null,
    endsAt: null,
    lastModified: null,
    tags: [],
    identity: ['event:test'],
  });

  it('excludes participant recruitment and the retired ARV source', () => {
    expect(isParticipantResearchStudy(event('Participants needed for a paid research study'))).toBe(true);
    expect(isParticipantResearchStudy(event('Anything', '', 'aggie-research-volunteers'))).toBe(true);
  });

  it('keeps academic papers, seminars, organizations, and sponsor events', () => {
    expect(isParticipantResearchStudy(event('Genomics research seminar'))).toBe(false);
    expect(isParticipantResearchStudy(event('Graduate Research Society sponsor showcase'))).toBe(false);
    expect(isParticipantResearchStudy(event('New paper discussion: phylogenetic methods'))).toBe(false);
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

  it('falls back to community', () => {
    expect(classify({ ...base, title: 'Farmers Market' })).toBe('community');
  });

  it('recognizes intramural sports and club-sport names', () => {
    expect(classify({ ...base, title: 'Spikeball tournament registration' })).toBe('sports');
    expect(classify({ ...base, title: 'Badminton club open play' })).toBe('sports');
    expect(isIntramuralListing('Flag Football registration', '', 'Rec Sports')).toBe(true);
    expect(isIntramuralListing('Officials orientation', '', 'Rec Sports', ['IM'])).toBe(true);
    expect(isIntramuralListing('Badminton club open play', '', 'TAMU Badminton Club')).toBe(false);
    expect(isIntramuralListing('Spikeball tournament', '', 'Texas A&M Spikeball')).toBe(false);
    expect(isIntramuralListing('Intramural Spikeball tournament', '', 'Student Life')).toBe(true);
    expect(isIntramuralListing('General interest meeting', '', 'Career Center', ['IM'])).toBe(false);
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

  it('folds Club Crawl organization copies into one searchable festival card', () => {
    const startsAt = '2026-09-06T13:00:00-05:00';
    const official = event(
      '400',
      'Club Crawl Fall 2026: The Official Involvement Festival at Texas A&M',
      startsAt,
      'Club Crawl',
    );
    const badminton = event(
      '401',
      'Club Crawl Fall 2026 - TAMU Badminton Club',
      startsAt,
      'Department of Student Activities',
    );
    const visualArts = event(
      '402',
      'Club Crawl Fall 2026 - MSC Visual Arts Committee',
      startsAt,
      'MSC Student Programs',
    );

    const result = collapseCoMarketedEvents([badminton, visualArts, official]);
    expect(result.collapsed).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: official.id,
      title: 'Club Crawl Fall 2026: The Official Involvement Festival at Texas A&M',
      campus: { category: 'clubs', organizer: 'Club Crawl', seriesCount: 1 },
    });
    expect(result.items[0]?.tags).toEqual(expect.arrayContaining([
      'Organization: TAMU Badminton Club',
      'Organization: MSC Visual Arts Committee',
    ]));
    expect(result.items[0]?.summary).toContain('2 participating organizations');
    expect(result.items[0]?.sources).toHaveLength(3);
  });

  it('does not merge Club Crawl records on different dates', () => {
    const first = event('410', 'Club Crawl Fall 2026 - Club A', '2026-09-06T13:00:00-05:00');
    const second = event('411', 'Club Crawl Fall 2026 - Club B', '2026-09-07T13:00:00-05:00');
    expect(collapseCoMarketedEvents([first, second]).items).toHaveLength(2);
  });

});
