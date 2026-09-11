import { describe, expect, it } from 'vitest';
import { mapEvent } from '@/campus/sources/tamu-calendar.ts';
import { normalizeItem } from '@/core/normalize.ts';
import {
  CAMPUS_TABS,
  ENDED_AGENDA_SUFFIX,
  IN_PROGRESS_AGENDA_SUFFIX,
  STUDIES_TABS,
  byCampusDate,
  campusAgendaGroup,
  campusDayKey,
  compareCampusAgenda,
  tabsFor,
} from '@/lib/view.ts';
import type { RadarItem } from '@/types.ts';

const NOW = '2026-08-12T16:00:00.000Z';

function event(id: string, title: string, startsAt: string, tags: string[] = []): RadarItem {
  return normalizeItem(mapEvent({
    id,
    title,
    url: `https://calendar.tamu.edu/event/${id}`,
    date_iso: startsAt,
    group_title: 'Rec Sports',
    tags,
  }, 'Rec Sports')!, { now: NOW })!;
}

describe('campus agenda view', () => {
  it('puts All first and exposes the requested discovery filters', () => {
    expect(CAMPUS_TABS[0]?.id).toBe('all');
    expect(CAMPUS_TABS.map((tab) => tab.id)).toEqual(expect.arrayContaining([
      'today', 'this-week', 'intramurals', 'online', 'interested', 'going',
    ]));
  });

  it('exposes studies listing tabs that match the campus filter chrome', () => {
    expect(STUDIES_TABS.map((tab) => tab.id)).toEqual([
      'all', 'ranked', 'online', 'inperson', 'saved',
    ]);
  });

  it('sorts campus events strictly by start time before relevance', () => {
    const later = event('later', 'Highly relevant later event', '2026-08-14T09:00:00-05:00');
    const sooner = event('sooner', 'Sooner event', '2026-08-13T09:00:00-05:00');
    later.relevance = 100;
    sooner.relevance = 1;
    expect([later, sooner].sort(byCampusDate).map((item) => item.id)).toEqual([sooner.id, later.id]);
  });

  it('groups in Central time and tags intramural/timing membership', () => {
    const item = event('im', 'Intramural Spikeball Tournament', '2026-08-12T23:30:00-05:00', ['IM']);
    expect(campusDayKey(item.campus?.startsAt ?? null)).toBe('2026-08-12');
    expect(tabsFor(item, false, NOW)).toEqual(expect.arrayContaining(['today', 'this-week', 'intramurals']));
  });

  it('lets a Get Involved sport-club event belong to both Sports and Clubs', () => {
    const item = event('club-sport', 'TAMU Badminton Club Tournament', '2026-08-13T18:00:00-05:00');
    const firstSource = item.sources[0]!;
    item.sources = [{ ...firstSource, source: 'getinvolved', channel: 'TAMU Badminton Club' }];
    expect(item.campus?.category).toBe('sports');
    expect(tabsFor(item, false, NOW)).toEqual(expect.arrayContaining(['sports', 'clubs']));
  });

  it('buckets a mid-season intramural as in-progress instead of its stale start date', () => {
    const now = '2026-09-11T17:00:00.000Z';
    const indoor = event('indoor', 'Indoor Soccer League (7v7)', '2026-08-30T00:00:00-05:00');
    indoor.campus = {
      ...indoor.campus!,
      startsAt: '2026-08-30T05:00:00.000Z',
      endsAt: '2026-10-12T04:59:59.000Z',
    };
    indoor.occurredAt = '2026-08-30T05:00:00.000Z';
    indoor.endsAt = '2026-10-12T04:59:59.000Z';

    const group = campusAgendaGroup(indoor, now);
    expect(group.inProgress).toBe(true);
    expect(group.key).toBe(`2026-09-11${IN_PROGRESS_AGENDA_SUFFIX}`);

    const todayTalk = event('today', 'Today lecture', '2026-09-11T18:00:00-05:00');
    const tomorrowTalk = event('tomorrow', 'Tomorrow lecture', '2026-09-12T09:00:00-05:00');
    const yesterdayTalk = event('yesterday', 'Yesterday leftover', '2026-09-10T18:00:00-05:00');
    yesterdayTalk.campus = {
      ...yesterdayTalk.campus!,
      startsAt: '2026-09-10T23:00:00.000Z',
      endsAt: '2026-09-11T23:00:00.000Z',
    };

    const kickball = event('kickball', 'Kickball League', '2026-09-01T00:00:00-05:00');
    kickball.campus = {
      ...kickball.campus!,
      startsAt: '2026-09-01T05:00:00.000Z',
      endsAt: '2026-09-11T04:59:59.000Z',
    };
    kickball.occurredAt = '2026-09-01T05:00:00.000Z';
    kickball.endsAt = '2026-09-11T04:59:59.000Z';

    const ended = campusAgendaGroup(kickball, now);
    expect(ended.inProgress).toBe(false);
    expect(ended.ended).toBe(true);
    expect(ended.key).toBe(`2026-09-11${ENDED_AGENDA_SUFFIX}`);

    const ordered = [indoor, kickball, tomorrowTalk, todayTalk].sort((a, b) => compareCampusAgenda(a, b, now));
    expect(ordered.map((item) => item.id)).toEqual([todayTalk.id, indoor.id, kickball.id, tomorrowTalk.id]);
    expect(campusAgendaGroup(yesterdayTalk, now).inProgress).toBe(false);
    expect(campusAgendaGroup(yesterdayTalk, now).ended).toBe(false);
    expect(campusAgendaGroup(yesterdayTalk, now).key).toBe('2026-09-10');
  });
});
