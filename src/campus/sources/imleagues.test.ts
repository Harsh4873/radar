import { describe, expect, it } from 'vitest';

import {
  fetchImleaguesSchedule,
  IMLEAGUES_FALL_2026,
  IMLEAGUES_FALL_2026_DIVISION_COUNT,
} from '@/campus/sources/imleagues.ts';

const NOW = '2026-08-16T17:00:00.000Z';

describe('IMLeagues Fall 2026 schedule', () => {
  it('covers every published sport and division', () => {
    expect(IMLEAGUES_FALL_2026).toHaveLength(29);
    expect(IMLEAGUES_FALL_2026_DIVISION_COUNT).toBe(106);

    const result = fetchImleaguesSchedule({ now: NOW });
    expect(result.error).toBeNull();
    expect(result.failedRequests).toBe(0);
    expect(result.fetchSource).toBe('fixture');
    expect(result.records).toHaveLength(29);

    const flagFootball = result.records.find((item) => item.title === 'Flag Football League (7v7)');
    expect(flagFootball?.tags).toEqual(expect.arrayContaining([
      'Coed Competitive', 'Corps', 'Fish (Corps Only)', 'Fraternity Recreational', 'Open', 'Unified',
      "Women's Recreational",
    ]));
  });

  it('maps Central-time season ranges across daylight saving time', () => {
    const result = fetchImleaguesSchedule({ now: NOW });
    const indoorSoccer = result.records.find((item) => item.title === 'Indoor Soccer League (7v7)');
    expect(indoorSoccer).toMatchObject({
      occurredAt: '2026-08-30T05:00:00.000Z',
      endsAt: '2026-10-12T04:59:59.000Z',
      campus: {
        startsAt: '2026-08-30T05:00:00.000Z',
        endsAt: '2026-10-12T04:59:59.000Z',
        category: 'sports',
        hasRegistration: true,
      },
    });

    const racquetball = result.records.find((item) => item.title === 'Racquetball League');
    expect(racquetball).toMatchObject({
      occurredAt: '2026-11-10T06:00:00.000Z',
      endsAt: '2026-11-18T05:59:59.000Z',
    });
  });

  it('retains distinct schedules, join rules, and team pricing', () => {
    const result = fetchImleaguesSchedule({ now: NOW });
    const badminton = result.records.find((item) => item.title === 'Badminton Tournament');
    expect(badminton?.summary).toContain('Doubles Competitive');
    expect(badminton?.summary).toContain('Oct 12 12:00PM - Oct 14 6:00PM');

    const qualifier = result.records.find((item) => item.title === 'Regional Flag Football Qualifier Tournament');
    expect(qualifier?.campus?.cost).toBe('$50 per team');
    expect(qualifier?.summary).toContain('$50 per team');
  });

  it('on 11 Sep 2026 does not open the slate on a past season start', () => {
    // Live CampusRadar opened on Sun 30 Aug because every sport used its
    // earliest season start (Indoor Soccer / Battleship) and the agenda sorts
    // oldest-first. Remaining sports must not lead with a date before today.
    const now = '2026-09-11T17:00:00.000Z';
    const todayStart = '2026-09-11T05:00:00.000Z';
    const result = fetchImleaguesSchedule({ now });

    expect(result.records.find((item) => item.title === 'Kickball League')).toBeUndefined();
    expect(result.records.length).toBeLessThan(IMLEAGUES_FALL_2026.length);

    const indoorSoccer = result.records.find((item) => item.title === 'Indoor Soccer League (7v7)');
    expect(indoorSoccer?.campus?.startsAt).toBe(todayStart);
    expect(indoorSoccer?.summary).toContain('Aug 30 - Oct 11');

    const badminton = result.records.find((item) => item.title === 'Badminton Tournament');
    expect(badminton?.campus?.startsAt).toBe('2026-10-16T05:00:00.000Z');
    expect(badminton?.summary).toContain('Oct 12 12:00PM - Oct 14 6:00PM');

    for (const item of result.records) {
      const startsAt = item.campus?.startsAt ?? item.occurredAt;
      expect(startsAt, item.title).not.toBeNull();
      expect(Date.parse(startsAt!), item.title).toBeGreaterThanOrEqual(Date.parse(todayStart));
    }
  });
});
