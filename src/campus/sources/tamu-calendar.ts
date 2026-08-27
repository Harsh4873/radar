/**
 * The Texas A&M events calendar (LiveWhale).
 *
 * This is CampusRadar's backbone. `calendar.tamu.edu` exposes a JSON feed for
 * the main calendar and for each of ~165 university groups, and the records
 * are far richer than a typical event feed: coordinates, cancellation state,
 * cost, registration state, audience labels, and a last-modified timestamp -
 * which is what makes change detection possible without diffing HTML.
 *
 * FOUR THINGS VERIFIED AGAINST LIVE DATA, each of which breaks a naive parser:
 *
 *   1. `registration_owner_email` IS A REAL STAFF EMAIL ADDRESS, present on
 *      594 of 1000 records in a single pull, and `contact_info` often holds
 *      more. This site deploys publicly, so republishing them would turn a
 *      personal tool into a scrapeable staff directory. They are dropped here
 *      and never enter a RawItem; `stripEmails` in normalize.ts is the second
 *      line of defence and the CI guard on dist/ is the third.
 *
 *   2. BOOLEANS ARE `1 | null`, NOT `true | false`. `is_all_day`, `is_online`,
 *      `has_registration`, and `is_canceled` all arrive this way, so `?? false`
 *      is not enough - a truthiness check is required.
 *
 *   3. `location_latitude` IS A NUMBER BUT `location_longitude` IS A STRING.
 *      Verified across the whole feed. Parsing both defensively is the only
 *      safe read.
 *
 *   4. THE MAIN FEED CAPS AT 1000 RECORDS, AND QUERY-STRING DATE ARGUMENTS ARE
 *      IGNORED. In August 2026, `?days=1` and `?days=180` returned the same
 *      1000 records. LiveWhale's documented path arguments do work, so Radar
 *      walks non-overlapping seven-day ranges and bisects any range that still
 *      reaches the cap. That covers the site-wide calendar without pulling all
 *      165 group feeds.
 *
 * Feed index: https://calendar.tamu.edu/feeds/
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { collapse, htmlToText, toIso } from '@/core/text.ts';
import { classify, extractCompanies } from '@/campus/classify.ts';
import { detectFreebies } from '@/campus/freebies.ts';

const MAIN_FEED = 'https://calendar.tamu.edu/live/json/events';
const GROUP_FEED = 'https://calendar.tamu.edu/live/json/events/group';
export const DEFAULT_CAMPUS_DAYS = 90;
export const CALENDAR_WINDOW_DAYS = 7;
export const CALENDAR_FEED_CAP = 1000;
const MAX_LOOKAHEAD_DAYS = 180;
const CENTRAL = 'America/Chicago';

/**
 * Group feeds worth pulling in addition to the complete site-wide windows.
 *
 * LiveWhale lets a group opt out of site-wide results, so these focused feeds
 * remain useful even after the main feed is date-sharded. Pulling all 165 would
 * be ~165 requests per run and still would not solve groups that independently
 * hit LiveWhale's 1000-record cap.
 *
 * The names must match LiveWhale's group titles EXACTLY - a near-miss returns
 * HTTP 200 with an empty array rather than an error, so a typo here is silent.
 * ('Computer Science and Engineering' returns 0; the real title is
 * 'College of Engineering - Computer Science and Engineering'.)
 */
export const GROUP_FEEDS: readonly string[] = [
  'Career Center',
  'Aggie Athletics',
  'College of Engineering',
  'College of Engineering - Computer Science and Engineering',
  'College of Engineering - Biomedical Engineering',
  'College of Engineering - Electrical and Computer Engineering',
  'College of Arts & Sciences',
  'Department of Biology',
  'Department of Statistics',
  'Ecology & Evolutionary Biology',
  'Graduate and Professional School',
  'High Performance Research Computing',
  'Office of Undergraduate Research',
  'Institute of Biosciences and Technology',
  'College of Medicine',
  'Department of Student Activities',
  'Student Life',
  'Student Affairs',
  'Department of Residence Life',
  'MSC Student Programs',
  'Music Activities',
  'Corps of Cadets',
  'Department of Rec Sports',
  'Rec Sports',
  'GRAD Aggies',
  'Office for Student Success',
  'National Labs Office',
  'KAMU Community Calendar',
  '*Student Interest',
];

/** Upstream record. Only the fields Radar reads are declared. */
interface LiveWhaleEvent {
  id?: number | string;
  gid?: number;
  group_title?: string;
  title?: string;
  url?: string;
  date_iso?: string;
  date_utc?: string;
  date_ts?: number;
  date2_iso?: string;
  date2_utc?: string;
  /** `1` or `null`. Never a boolean. */
  is_all_day?: number | null;
  is_canceled?: number | null;
  is_online?: number | null;
  online_url?: string | null;
  description?: string | null;
  cost?: string | null;
  location?: string | null;
  location_title?: string | null;
  /** A NUMBER. */
  location_latitude?: number | string | null;
  /** A STRING. Yes, really - different type from latitude. */
  location_longitude?: number | string | null;
  has_registration?: number | null;
  /** A real staff email. Deliberately never read. */
  registration_owner_email?: string | null;
  contact_info?: string | null;
  event_types?: string[] | null;
  event_types_audience?: string[] | null;
  tags?: string[] | null;
  /** Unix seconds. */
  last_modified?: number | null;
}

/** LiveWhale's `1 | null` convention. */
function truthy(value: number | null | undefined): boolean {
  return value === 1 || (typeof value === 'number' && value > 0);
}

/** Coordinates, tolerating the latitude/longitude type mismatch. */
function coordinatesOf(event: LiveWhaleEvent): [number, number] | null {
  const lat = typeof event.location_latitude === 'string'
    ? Number.parseFloat(event.location_latitude)
    : event.location_latitude;
  const lon = typeof event.location_longitude === 'string'
    ? Number.parseFloat(event.location_longitude)
    : event.location_longitude;

  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return [lat, lon];
}

const BARE_REC_FACILITIES = new Set([
  '50 meter',
  '50 meter pool',
  'indoor climbing tower',
  'lap pool',
  'outdoor pool',
  'peap',
  'polo road',
  'rc',
  'southside rec center',
  'student rec center',
  'student recreation center',
]);

function normalizedWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Keep event discovery free of routine Rec Sports facility schedules.
 *
 * Daily cards such as "Lap Pool", "Polo Road Hours", and "RC Open" are
 * operating data, not events. The one exception that belongs in a personal
 * agenda is an explicit closure of the main Student Recreation Center. A bare
 * "CLOSED" record is not enough: without a named facility it cannot honestly
 * claim that the Student Rec is affected.
 */
export function isUsefulRecSportsListing(
  title: string,
  description: string,
  group: string | null,
  location: string | null,
): boolean {
  if (!(group ?? '').toLowerCase().includes('rec sports')) return true;

  const normalizedTitle = normalizedWords(title);
  const context = normalizedWords(`${title} ${description} ${location ?? ''}`);
  const routineHours =
    /\b(hours?|operating hours?|adjusted facility hours?)\b/.test(normalizedTitle)
    || /\b(open|closed|closure)\b$/.test(normalizedTitle)
    || BARE_REC_FACILITIES.has(normalizedTitle)
    || (/\bfacilit(?:y|ies) (?:update|notice)\b/.test(normalizedTitle)
      && /\b(hours?|open|closed|closure)\b/.test(context));

  if (!routineHours) return true;

  const studentRec = /\bstudent rec(?:reation)? center\b/.test(context);
  const closure = /\b(closed|closure)\b/.test(context);
  return studentRec && closure;
}

export function mapEvent(event: LiveWhaleEvent, channel: string): RawItem | null {
  const title = htmlToText(event.title);
  const id = event.id;
  if (title.length === 0 || id === undefined) return null;

  // NOTE: `registration_owner_email` and `contact_info` are intentionally NOT
  // read into the description. See the header.
  const description = htmlToText(event.description);
  const group = event.group_title ?? null;
  const location = collapse(event.location_title ?? event.location ?? '') || null;
  if (!isUsefulRecSportsListing(title, description, group, location)) return null;

  const url =
    typeof event.url === 'string' && event.url.length > 0
      ? event.url
      : `https://calendar.tamu.edu/event/${String(id)}`;

  const eventTypes = event.event_types ?? [];

  const startsAt = toIso(event.date_iso) ?? toIso(event.date_utc) ?? toIso(event.date_ts);
  const endsAt = toIso(event.date2_iso) ?? toIso(event.date2_utc);

  const freebies = detectFreebies(`${title} ${description}`, event.cost ?? null);
  const companies = extractCompanies(title, description);
  const category = classify({ title, description, group, eventTypes });

  return {
    vertical: 'campus',
    source: 'tamu-calendar',
    externalId: String(id),
    channel,
    url,
    title,
    summary: description,
    occurredAt: startsAt,
    endsAt,
    lastModified: toIso(event.last_modified),
    tags: [...(event.tags ?? []), ...eventTypes].slice(0, 10),
    // The LiveWhale id is stable and globally unique across group feeds, so
    // the same event pulled from three feeds collapses in dedupe pass 1
    // without ever needing a fuzzy title comparison.
    identity: [`event:tamu-${String(id)}`],
    campus: {
      category,
      startsAt,
      endsAt,
      isAllDay: truthy(event.is_all_day),
      isCancelled: truthy(event.is_canceled),
      isOnline: truthy(event.is_online),
      onlineUrl: event.online_url ?? null,
      location,
      coordinates: coordinatesOf(event),
      organizer: group,
      audience: event.event_types_audience ?? [],
      eventTypes,
      companies,
      food: freebies.food,
      cost: event.cost ?? null,
      hasRegistration: truthy(event.has_registration),
      compensation: null,
      compensationUsd: null,
      deadlineAt: category === 'deadline' ? startsAt : null,
      seriesCount: 1,
    },
  };
}

export interface TamuCalendarOptions extends RequestOptions {
  /** Ingest timestamp; used to create America/Chicago date windows. */
  now?: string;
  /** How far ahead to look. */
  days?: number;
  /** Group titles to pull in addition to the main feed. */
  groups?: readonly string[];
  log?: Logger;
}

export interface CalendarWindow {
  start: string;
  end: string;
}

function centralDate(value: string): string {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(safe);
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** Inclusive, non-overlapping date shards for LiveWhale's path API. */
export function buildCalendarWindows(
  now: string,
  days: number,
  windowDays = CALENDAR_WINDOW_DAYS,
): CalendarWindow[] {
  const first = centralDate(now);
  const last = shiftDate(first, Math.max(0, Math.trunc(days)));
  const width = Math.max(1, Math.trunc(windowDays));
  const windows: CalendarWindow[] = [];

  for (let start = first; start <= last; start = shiftDate(start, width)) {
    const candidateEnd = shiftDate(start, width - 1);
    windows.push({ start, end: candidateEnd <= last ? candidateEnd : last });
  }
  return windows;
}

/** LiveWhale API arguments are path segments, not query parameters. */
export function calendarRangeUrl(root: string, range: CalendarWindow): string {
  return `${root}/start_date/${encodeURIComponent(range.start)}/end_date/${encodeURIComponent(range.end)}/max/${CALENDAR_FEED_CAP}`;
}

function splitWindow(range: CalendarWindow): [CalendarWindow, CalendarWindow] | null {
  const span = daysBetween(range.start, range.end);
  if (span <= 0) return null;
  const firstSpan = Math.floor(span / 2);
  const first = { start: range.start, end: shiftDate(range.start, firstSpan) };
  return [first, { start: shiftDate(first.end, 1), end: range.end }];
}

/**
 * Read the main feed plus each configured group feed.
 *
 * Never throws. A failed group is warned about and skipped; the rest of the
 * calendar still publishes.
 */
export async function fetchTamuCalendar(options: TamuCalendarOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const requestedDays = options.days ?? DEFAULT_CAMPUS_DAYS;
  const finiteDays = Number.isFinite(requestedDays) ? requestedDays : DEFAULT_CAMPUS_DAYS;
  const days = Math.max(0, Math.min(Math.trunc(finiteDays), MAX_LOOKAHEAD_DAYS));
  const groups = options.groups ?? GROUP_FEEDS;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  const failedChannels = new Set<string>();
  const succeededChannels = new Set<string>();
  let failures = 0;
  const now = options.now ?? new Date().toISOString();
  const mainWindows = buildCalendarWindows(now, days);
  const fullRange = { start: mainWindows[0]?.start ?? centralDate(now), end: mainWindows.at(-1)?.end ?? centralDate(now) };

  if (!Number.isFinite(requestedDays)) {
    warnings.push(`requested an invalid calendar horizon; using ${DEFAULT_CAMPUS_DAYS} days`);
  } else if (requestedDays !== days) {
    warnings.push(`requested ${requestedDays} days; capped the calendar horizon at ${MAX_LOOKAHEAD_DAYS}`);
  }

  const readRange = async (root: string, channel: string, range: CalendarWindow): Promise<void> => {
    const url = calendarRangeUrl(root, range);
    try {
      const { data } = await getJson<unknown>(url, options);
      if (!Array.isArray(data)) {
        failures += 1;
        failedChannels.add(channel);
        warnings.push(`${channel} ${range.start}..${range.end}: response was not an array`);
        return;
      }

      const structurallyValid = data.some((event) => {
        if (typeof event !== 'object' || event === null) return false;
        const value = event as LiveWhaleEvent;
        return value.id !== undefined && htmlToText(value.title).length > 0;
      });
      if (data.length > 0 && !structurallyValid) {
        failures += 1;
        failedChannels.add(channel);
        warnings.push(`${channel} ${range.start}..${range.end}: records no longer match the event schema`);
        return;
      }

      // A range at the cap is incomplete. Split it until every successful leaf
      // is below the ceiling; a one-day leaf cannot be split any further.
      if (data.length >= CALENDAR_FEED_CAP) {
        const halves = splitWindow(range);
        if (halves !== null) {
          log.info(`[tamu-calendar] ${channel}: splitting capped ${range.start}..${range.end}`);
          await readRange(root, channel, halves[0]);
          await readRange(root, channel, halves[1]);
          return;
        }
        failures += 1;
        failedChannels.add(channel);
        warnings.push(`${channel} ${range.start}: hit the ${CALENDAR_FEED_CAP}-record cap on a single day`);
      }

      let mapped = 0;
      for (const event of data) {
        const item = mapEvent(event as LiveWhaleEvent, channel);
        if (item !== null) {
          records.push(item);
          mapped += 1;
        }
      }

      if (data.length === 0 && channel !== 'Main University Calendar') {
        warnings.push(
          `${channel}: 0 events - group is not posting, or the title no longer matches calendar.tamu.edu/feeds/`,
        );
      }

      succeededChannels.add(channel);
      log.info(`[tamu-calendar] ${channel} ${range.start}..${range.end}: ${mapped} event(s)`);
    } catch (err) {
      failures += 1;
      failedChannels.add(channel);
      const message = describeError(err);
      warnings.push(`${channel} ${range.start}..${range.end}: ${message}`);
      log.warn(`[tamu-calendar] ${channel} ${range.start}..${range.end} FAILED: ${message}`);
    }
  };

  for (const range of mainWindows) {
    await readRange(MAIN_FEED, 'Main University Calendar', range);
  }

  for (const group of groups) {
    const root = `${GROUP_FEED}/${encodeURIComponent(group)}`;
    await readRange(root, group, fullRange);
  }

  const allFailed = succeededChannels.size === 0;

  return {
    source: 'tamu-calendar',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${groups.length + 1} calendar channel(s) failed` : null,
    durationMs: Date.now() - startedAt,
    failedRequests: failures,
    failedChannels: [...failedChannels].sort(),
  };
}
