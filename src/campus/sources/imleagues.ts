/**
 * Texas A&M Intramural Sports on IMLeagues.
 *
 * IMLeagues does not expose Texas A&M's schedule through a public, supported
 * build-time API. This connector therefore publishes a checked-in snapshot of
 * the PUBLIC Fall 2026 registration page rather than calling the private SPA
 * endpoints. The snapshot was compared with the public page on 2026-08-16.
 *
 * One Radar item represents one sport. Every division remains searchable and
 * every distinct registration/season schedule is retained in the summary, so
 * the agenda stays readable without hiding any of the 106 published options.
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { consoleLogger } from '@/core/http.ts';

const YEAR = 2026;
const VERIFIED_AT = '2026-08-16T00:00:00.000Z';
const ROOT = 'https://www.imleagues.com';
const MEMBERSHIP = 'Membership Required Player';

interface Schedule {
  registration: string;
  join: string;
  season: string;
  divisions: readonly string[];
  payment: string | null;
}

interface Sport {
  name: string;
  id: string;
  schedules: readonly Schedule[];
}

function schedule(
  registration: string,
  join: string,
  season: string,
  divisions: readonly string[],
  payment: string | null = MEMBERSHIP,
): Schedule {
  return { registration, join, season, divisions, payment };
}

/** Public Fall 2026 sport/division schedule, verified against IMLeagues. */
export const IMLEAGUES_FALL_2026: readonly Sport[] = [
  {
    name: 'Indoor Soccer League (7v7)',
    id: '629e03eda94c40e39873d9b00561955f',
    schedules: [schedule('Aug 24 12:00PM - Aug 24 6:00PM', 'Until: 11/12/26 4:00 PM', 'Aug 30 - Oct 11', [
      'Coed Competitive', 'Coed Recreational', "Men's Competitive", "Men's Recreational", "Women's",
    ])],
  },
  {
    name: 'Battleship Tournament',
    id: 'c5f10cdeee15449ca0edc51cf52bafdc',
    schedules: [schedule('Aug 24 12:00PM - Aug 26 12:00PM', 'Until: 09/21/26 4:00 PM', 'Aug 30 - Sep 21', [
      'Battleship League #1',
    ])],
  },
  {
    name: 'Kickball League',
    id: '0f62877a74714510aa785711603063c2',
    schedules: [schedule('Aug 24 12:00PM - Aug 26 12:00PM', 'Until: 09/22/26 4:00 PM', 'Sep 01 - Sep 10', [
      'Competitive', 'Recreational',
    ])],
  },
  {
    name: 'Fantasy Football Super-League',
    id: 'eafe1f4c235441eeaf3b6f8fb0f9a925',
    schedules: [schedule('Aug 31 12:00PM - Aug 31 6:00PM', 'Until: 12/14/26 Midnight', 'Sep 09 - Dec 14', [
      'Fantasy Football Super-League',
    ])],
  },
  {
    name: 'Badminton Tournament',
    id: 'f006df1a51944145a4ed32c336504007',
    schedules: [
      schedule('Aug 31 12:00PM - Sep 2 6:00PM', 'Until: 09/04/26 Midnight', 'Sep 04 - Sep 04', [
        "Men's Singles Competitive", "Women's Singles",
      ]),
      schedule('Aug 31 12:00PM - Sep 2 12:00PM', 'Until: 09/04/26 Midnight', 'Sep 04 - Sep 04', [
        "Men's Singles Recreational",
      ]),
      schedule('Oct 12 12:00PM - Oct 14 6:00PM', 'Until: 10/16/26 Midnight', 'Oct 16 - Oct 16', [
        'Doubles Competitive', 'Doubles Recreational',
      ]),
    ],
  },
  {
    name: 'Pickleball League (2v2)',
    id: '998c73a700e2413387c4d704e9fbfae7',
    schedules: [
      schedule('Aug 31 12:00PM - Sep 3 12:00PM', 'Anytime', 'Sep 08 - Sep 17', ['Doubles Competitive']),
      schedule('Aug 31 12:00PM - Sep 3 12:00PM', 'Anytime', 'Sep 08 - Sep 24', ['Doubles Recreational']),
    ],
  },
  {
    name: 'Flag Football League (7v7)',
    id: '79dbe9e2fcdb4a68a0a66ce6abeb6d17',
    schedules: [
      schedule('Sep 3 12:00PM - Sep 3 6:00PM', 'Until: 11/19/26 4:00 PM', 'Sep 13 - Oct 22', [
        'Coed Competitive', 'Coed Recreational', 'Fraternity Competitive', 'Fraternity Recreational',
        "Men's Competitive", "Men's Recreational", "Women's Competitive", "Women's Recreational",
      ]),
      schedule('Sep 3 12:00PM - Sep 3 6:00PM', 'Until: 11/19/26 4:00 PM', 'Sep 13 - Oct 22', [
        'Corps', 'Fish (Corps Only)',
      ], null),
      schedule('Sep 3 12:00PM - Sep 3 6:00PM', 'Until: 11/19/26 2:00 PM', 'Sep 13 - Oct 22', ['Open']),
      schedule('Sep 3 12:00PM - Sep 3 12:01PM', 'Until: 11/19/26 4:00 PM', 'Sep 21 - Nov 02', ['Unified'], null),
    ],
  },
  {
    name: 'Basketball League (5v5)',
    id: 'f0caa8d4a6da419bbe284d6a8e0cdd75',
    schedules: [schedule('Sep 3 12:00PM - Sep 8 12:00PM', 'Until: 10/19/26 4:00 PM', 'Sep 13 - Oct 15', [
      'Coed Competitive', 'Coed Recreational', 'Fraternity', "Men's Competitive", "Men's Recreational",
      "Women's Competitive", "Women's Recreational",
    ])],
  },
  {
    name: 'Esports Tournaments',
    id: '6703ac5a6a034213ba86e54af7a2e3a0',
    schedules: [
      schedule('Sep 3 12:00PM - Sep 8 12:00PM', 'Until: 09/11/26 Midnight', 'Sep 11 - Sep 11', ['Rocket League (3v3) - 9/11']),
      schedule('Sep 21 12:00PM - Sep 23 12:00PM', 'Until: 09/25/26 Midnight', 'Sep 25 - Sep 25', ['Smash Bros Singles Tournament - 9/25']),
      schedule('Nov 2 12:00PM - Nov 4 12:00PM', 'Until: 11/06/26 Midnight', 'Nov 06 - Nov 06', ['Rocket League (2v2) - 11/6']),
    ],
  },
  {
    name: 'Sand Volleyball League (4v4)',
    id: 'f71142fc39ef44f88d08e6d961b35055',
    schedules: [
      schedule('Sep 3 12:00PM - Sep 8 12:00PM', 'Anytime', 'Sep 13 - Oct 01', [
        'Coed Competitive', 'Coed Recreational', 'Corps', 'Fish (Corps Only)', 'Fraternity',
        "Men's Competitive", "Men's Recreational", "Women's Competitive", "Women's Recreational",
      ]),
      schedule('Sep 3 12:00PM - Sep 8 12:00PM', 'Anytime', 'Sep 13 - Oct 15', ['Open']),
    ],
  },
  {
    name: 'Outdoor Soccer League (8v8)',
    id: '9f5e2cb55d534cc0b2df6073bda32744',
    schedules: [schedule('Sep 3 12:00PM - Sep 8 5:00PM', 'Anytime', 'Sep 13 - Oct 22', [
      'Coed Competitive', 'Coed Recreational', "Men's Competitive", "Men's Recreational", "Women's",
    ])],
  },
  {
    name: 'Cornhole League',
    id: 'f22322a056474cec85896c36e2020041',
    schedules: [
      schedule('Sep 8 12:00PM - Sep 10 12:00PM', 'Anytime', 'Sep 14 - Sep 21', ['Competitive']),
      schedule('Sep 8 12:00PM - Sep 10 12:00PM', 'Until: 09/21/26 4:00 PM', 'Sep 14 - Sep 21', ['Recreational']),
    ],
  },
  {
    name: 'Spikeball League',
    id: '29c5689448ab49c597203209aa02f4ab',
    schedules: [schedule('Sep 8 12:00PM - Sep 10 12:00PM', 'Until: 09/29/26 4:00 PM', 'Sep 14 - Sep 21', [
      'Competitive', 'Recreational',
    ])],
  },
  {
    name: 'Table Tennis Tournament',
    id: '2891ae1a896f43bdab9bf64d0ce17e80',
    schedules: [
      schedule('Sep 14 12:00PM - Sep 14 6:00PM', 'Until: 09/18/26 2:00 PM', 'Sep 18 - Sep 18', [
        'Doubles Competitive', 'Doubles Recreational',
      ]),
      schedule('Nov 9 12:00PM - Nov 11 6:00PM', 'Anytime', 'Nov 13 - Nov 13', [
        'Singles Competitive', 'Singles Recreational',
      ]),
    ],
  },
  {
    name: 'Rock Climbing League',
    id: '70a38e2a9fd1443b9c4b90c46531864d',
    schedules: [schedule('Sep 14 12:00PM - Sep 16 10:00AM', 'Until: 10/05/26 Midnight', 'Sep 21 - Oct 05', [
      'Bouldering League - Advanced', 'Bouldering League - Beginner', 'Bouldering League - Intermediate',
    ])],
  },
  {
    name: 'Softball League (10v10)',
    id: '0cc87215d7ff49c389ca769d965a6348',
    schedules: [schedule('Sep 21 12:00PM - Sep 23 12:00PM', 'Until: 11/15/26 3:00 PM', 'Sep 27 - Oct 22', [
      'Coed Competitive', 'Coed Recreational', 'Fraternity', "Men's Competitive", "Men's Recreational", 'Open', "Women's",
    ])],
  },
  {
    name: 'Regional Flag Football Qualifier Tournament',
    id: '23a9144a4e514c249c9c027eccde8e55',
    schedules: [schedule('Sep 28 12:00PM - Sep 28 1:00PM', 'Until: 10/09/26 2:00 PM', 'Oct 09 - Oct 11', [
      'Coed', "Men's", "Women's",
    ], '$50.00 Team')],
  },
  {
    name: 'Cricket League (8v8)',
    id: 'bf65702aa84147a79ad23c1566676920',
    schedules: [schedule('Sep 28 12:00PM - Sep 28 6:00PM', 'Until: 11/15/26 2:00 PM', 'Oct 04 - Oct 29', [
      'Competitive', 'Recreational',
    ])],
  },
  {
    name: 'Dodgeball Tournament (4v4)',
    id: '16b3d6082317476192c848e39c78886d',
    schedules: [schedule('Sep 28 12:00PM - Sep 30 12:00PM', 'Until: 10/02/26 Midnight', 'Oct 02 - Oct 02', ['Open'])],
  },
  {
    name: 'Action Ball',
    id: 'f54c4b26796145119326c7f7fb8fa69b',
    schedules: [schedule('Oct 5 12:00PM - Oct 7 12:00PM', 'Anytime', 'Oct 11 - Oct 11', ['Open'])],
  },
  {
    name: 'Ultimate League (7v7)',
    id: '674449bbbba84190b1a173f86f94e597',
    schedules: [schedule('Oct 5 12:00PM - Oct 7 12:00PM', 'Anytime', 'Oct 12 - Oct 27', ['Competitive', 'Recreational'])],
  },
  {
    name: 'Pickleball Mini-League',
    id: '31c65b6dc03f4e65a005abbbcad72815',
    schedules: [schedule('Oct 12 12:00PM - Oct 12 6:00PM', 'Until: 12/03/26 Midnight', 'Oct 22 - Dec 03', [
      'Competitive', 'Recreational',
    ])],
  },
  {
    name: 'Tennis League',
    id: 'e62c87a8ad0c4868ad24336258ea8c90',
    schedules: [
      schedule('Oct 12 12:00PM - Oct 14 12:00PM', 'Until: 10/21/26 4:00 PM', 'Oct 20 - Nov 04', ['Doubles']),
      schedule('Oct 12 12:00PM - Oct 14 12:00PM', 'Until: 10/28/26 4:00 PM', 'Oct 20 - Oct 28', ["Men's Singles Competitive"]),
      schedule('Oct 12 12:00PM - Oct 14 12:00PM', 'Until: 11/04/26 4:00 PM', 'Oct 20 - Nov 04', [
        "Men's Singles Recreational", 'Mixed Doubles', "Women's Singles Recreational",
      ]),
      schedule('Oct 12 12:00PM - Oct 14 12:00PM', 'Until: 11/04/26 4:00 PM', 'Oct 20 - Oct 28', ["Women's Singles Competitive"]),
    ],
  },
  {
    name: 'Handball Tournament',
    id: '6b84641fe7fb4ba6bf7c58b536a5d0f8',
    schedules: [schedule('Oct 19 12:00PM - Oct 19 6:00PM', 'Anytime', 'Oct 23 - Oct 23', [
      'Singles Competitive', 'Singles Recreational',
    ])],
  },
  {
    name: 'Indoor Volleyball Mini-League (6v6)',
    id: '97a9a74cde0e4d58b07f1ede878a91a1',
    schedules: [schedule('Oct 26 12:00PM - Oct 26 6:00PM', 'Until: 11/30/26 4:00 PM', 'Nov 01 - Nov 15', [
      'Coed Competitive', 'Coed Recreational', "Men's", "Women's",
    ])],
  },
  {
    name: '"Wheel of Sportune" Tournament',
    id: '50a06127b3c646518b1feb79488f06c1',
    schedules: [schedule('Oct 26 12:00PM - Oct 29 12:00PM', 'Anytime', 'Oct 30 - Oct 30', ['Spooky Sportune Tournament'])],
  },
  {
    name: 'Basketball Mini-League (3v3 Outdoors)',
    id: 'df5b4af5b9f240359ea5fdb74ee3ff41',
    schedules: [schedule('Oct 26 12:00PM - Oct 29 12:00PM', 'Anytime', 'Nov 02 - Nov 12', [
      'Coed Competitive', 'Coed Recreational', "Men's Competitive", "Men's Recreational", "Women's",
    ])],
  },
  {
    name: 'Racquetball League',
    id: '313d19305f1b4baca7df3b500c245c35',
    schedules: [schedule('Nov 2 12:00PM - Nov 4 12:00PM', 'Anytime', 'Nov 10 - Nov 17', [
      'Doubles', 'Singles Competitive', 'Singles Recreational',
    ])],
  },
  {
    name: 'Outdoor Soccer Mini-League (4v4)',
    id: '01a9991c6ddc4be3a5e0e9a3237ae992',
    schedules: [schedule('Nov 9 12:00PM - Nov 9 6:00PM', 'Until: 11/30/26 4:00 PM', 'Nov 15 - Nov 18', [
      'Coed Competitive', "Men's Competitive", "Women's",
    ])],
  },
] as const;

export const IMLEAGUES_FALL_2026_DIVISION_COUNT = IMLEAGUES_FALL_2026.reduce(
  (sum, sport) => sum + sport.schedules.reduce((sportSum, entry) => sportSum + entry.divisions.length, 0),
  0,
);

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** America/Chicago's 2026 Fall transition occurs at 02:00 on November 1. */
function centralOffset(month: number, day: number, hour: number): '-05:00' | '-06:00' {
  if (month < 11) return '-05:00';
  if (month > 11 || day > 1 || hour >= 2) return '-06:00';
  return '-05:00';
}

function iso(month: number, day: number, hour: number, minute: number): string {
  const offset = centralOffset(month, day, hour);
  return new Date(`${YEAR}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`).toISOString();
}

function dateParts(value: string): { month: number; day: number } {
  const match = value.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
  const month = match?.[1] === undefined ? undefined : MONTHS[match[1]];
  const day = match?.[2] === undefined ? Number.NaN : Number.parseInt(match[2], 10);
  if (month === undefined || !Number.isFinite(day)) throw new Error(`Invalid IMLeagues date: ${value}`);
  return { month, day };
}

function dateTimeParts(value: string): { month: number; day: number; hour: number; minute: number } {
  const match = value.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(.+)$/);
  const month = match?.[1] === undefined ? undefined : MONTHS[match[1]];
  const day = match?.[2] === undefined ? Number.NaN : Number.parseInt(match[2], 10);
  const clock = match?.[3];
  if (month === undefined || !Number.isFinite(day) || clock === undefined) {
    throw new Error(`Invalid IMLeagues date/time: ${value}`);
  }
  if (clock.toLowerCase() === 'midnight') return { month, day, hour: 0, minute: 0 };

  const time = clock.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (time === null) throw new Error(`Invalid IMLeagues time: ${value}`);
  let hour = Number.parseInt(time[1] ?? '', 10) % 12;
  if ((time[3] ?? '').toUpperCase() === 'PM') hour += 12;
  return { month, day, hour, minute: Number.parseInt(time[2] ?? '', 10) };
}

function seasonRange(value: string): { start: string; end: string } {
  const [rawStart, rawEnd] = value.split(' - ');
  if (rawStart === undefined || rawEnd === undefined) throw new Error(`Invalid IMLeagues season: ${value}`);
  const start = dateParts(rawStart);
  const end = dateParts(rawEnd);
  return {
    start: iso(start.month, start.day, 0, 0),
    // An all-day season remains active through the final published date.
    end: new Date(Date.parse(iso(end.month, end.day, 23, 59)) + 59_000).toISOString(),
  };
}

function registrationEnd(value: string): string {
  const rawEnd = value.split(' - ')[1];
  if (rawEnd === undefined) throw new Error(`Invalid IMLeagues registration: ${value}`);
  const end = dateTimeParts(rawEnd);
  return iso(end.month, end.day, end.hour, end.minute);
}

function nextDeadline(schedules: readonly Schedule[], now: string): string | null {
  const deadlines = schedules.map((entry) => registrationEnd(entry.registration)).sort();
  return deadlines.find((deadline) => Date.parse(deadline) >= Date.parse(now)) ?? deadlines.at(-1) ?? null;
}

function readableCost(payment: string): string {
  if (payment === MEMBERSHIP) return 'Membership required per player';
  if (payment === '$50.00 Team') return '$50 per team';
  return payment;
}

function summaryOf(sport: Sport): string {
  return sport.schedules.map((entry) => {
    const cost = entry.payment === null ? '' : ` ${readableCost(entry.payment)}.`;
    return `Divisions: ${entry.divisions.join(', ')}. Registration: ${entry.registration}. Join teams: ${entry.join}. Season: ${entry.season}.${cost}`;
  }).join(' ');
}

function mapSport(sport: Sport, now: string): RawItem {
  const ranges = sport.schedules.map((entry) => seasonRange(entry.season));
  const startsAt = ranges.map((range) => range.start).sort()[0] ?? null;
  const endsAt = ranges.map((range) => range.end).sort().at(-1) ?? null;
  const divisions = sport.schedules.flatMap((entry) => entry.divisions);
  const payments = [...new Set(
    sport.schedules.map((entry) => entry.payment).filter((payment): payment is string => payment !== null),
  )];
  const cost = payments.length === 0
    ? null
    : payments.length === 1 && payments[0] !== undefined
      ? readableCost(payments[0])
      : 'Varies by division';
  const url = `${ROOT}/spa/sport/${sport.id}/home`;

  return {
    vertical: 'campus',
    source: 'imleagues',
    externalId: sport.id,
    channel: 'Fall 2026 public schedule',
    url,
    title: sport.name,
    summary: summaryOf(sport),
    occurredAt: startsAt,
    endsAt,
    lastModified: VERIFIED_AT,
    tags: ['IM', 'Intramural', 'Fall 2026', 'IMLeagues', ...divisions],
    identity: [`event:imleagues-${sport.id}`],
    campus: {
      category: 'sports',
      startsAt,
      endsAt,
      isAllDay: true,
      isCancelled: false,
      isOnline: false,
      onlineUrl: null,
      location: null,
      coordinates: null,
      organizer: 'Texas A&M Rec Sports',
      audience: [],
      eventTypes: ['Intramural', 'Registration', 'League or tournament'],
      companies: [],
      food: { confidence: 'none', items: [], evidence: null },
      cost,
      hasRegistration: true,
      compensation: null,
      compensationUsd: null,
      deadlineAt: nextDeadline(sport.schedules, now),
      seriesCount: 1,
    },
  };
}

export interface ImleaguesOptions {
  now: string;
  log?: Logger;
}

/** Return the reviewed snapshot without making any live or authenticated request. */
export function fetchImleaguesSchedule(options: ImleaguesOptions): SourceResult<RawItem> {
  const startedAt = Date.now();
  const records = IMLEAGUES_FALL_2026.map((sport) => mapSport(sport, options.now));
  const log = options.log ?? consoleLogger;
  log.info(
    `[imleagues] ${records.length} Fall 2026 sport(s), ${IMLEAGUES_FALL_2026_DIVISION_COUNT} division(s) from reviewed public schedule`,
  );
  return {
    source: 'imleagues',
    records,
    fetchSource: 'fixture',
    warnings: [],
    error: null,
    durationMs: Date.now() - startedAt,
    failedRequests: 0,
  };
}
