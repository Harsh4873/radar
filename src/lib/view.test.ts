import { describe, expect, it } from 'vitest';
import { mapEvent } from '@/campus/sources/tamu-calendar.ts';
import { normalizeItem } from '@/core/normalize.ts';
import {
  CAMPUS_TABS,
  byCampusDate,
  campusDayKey,
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

  it('sorts campus events strictly by start time before relevance', () => {
    const later = event('later', 'Highly relevant later event', '2026-08-14T09:00:00-05:00');
    const sooner = event('sooner', 'Sooner event', '2026-08-13T09:00:00-05:00');
    later.relevance = 100;
    sooner.relevance = 1;
    expect([later, sooner].sort(byCampusDate).map((item) => item.id)).toEqual([sooner.id, later.id]);
  });

  it('groups in Central time and tags intramural/timing membership', () => {
    const item = event('im', 'Intramural Spikeball', '2026-08-12T23:30:00-05:00', ['IM']);
    expect(campusDayKey(item.campus?.startsAt ?? null)).toBe('2026-08-12');
    expect(tabsFor(item, false, NOW)).toEqual(expect.arrayContaining(['today', 'this-week', 'intramurals']));
  });
});
