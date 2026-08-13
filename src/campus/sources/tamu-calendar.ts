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
 *   4. THE MAIN FEED CAPS AT 1000 RECORDS. A `?days=60` pull returns exactly
 *      1000, which is a ceiling, not a coincidence. Group feeds are therefore
 *      not an optimization but a correctness requirement: without them, busy
 *      windows silently drop events off the end.
 *
 * Feed index: https://calendar.tamu.edu/feeds/
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { collapse, htmlToText, toIso } from '@/core/text.ts';
import { classify, extractCompanies } from '@/campus/classify.ts';
import { detectFreebies } from '@/campus/freebies.ts';

const MAIN_FEED = 'https://calendar.tamu.edu/live/json/events';
const GROUP_FEED = 'https://calendar.tamu.edu/live/json/events/group';

/**
 * Group feeds worth pulling, selected from the ~165 published.
 *
 * Chosen for signal density against this user's interests rather than
 * completeness: the CS/engineering/data-science units, the two research
 * offices, the career center, athletics, and the student-life groups that
 * actually post events. Pulling all 165 would be ~165 requests per run against
 * a university server for a large amount of content nobody will read.
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

export function mapEvent(event: LiveWhaleEvent, channel: string): RawItem | null {
  const title = htmlToText(event.title);
  const id = event.id;
  if (title.length === 0 || id === undefined) return null;

  const url =
    typeof event.url === 'string' && event.url.length > 0
      ? event.url
      : `https://calendar.tamu.edu/event/${String(id)}`;

  // NOTE: `registration_owner_email` and `contact_info` are intentionally NOT
  // read into the description. See the header.
  const description = htmlToText(event.description);
  const group = event.group_title ?? null;
  const eventTypes = event.event_types ?? [];

  const startsAt = toIso(event.date_iso) ?? toIso(event.date_utc) ?? toIso(event.date_ts);
  const endsAt = toIso(event.date2_iso) ?? toIso(event.date2_utc);

  const freebies = detectFreebies(`${title} ${description}`, event.cost ?? null);
  const companies = extractCompanies(title, description);
  const category = classify({ title, description, group, eventTypes });

  const location = collapse(event.location_title ?? event.location ?? '') || null;

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
  /** How far ahead to look. */
  days?: number;
  /** Group titles to pull in addition to the main feed. */
  groups?: readonly string[];
  log?: Logger;
}

/**
 * Read the main feed plus each configured group feed.
 *
 * Never throws. A failed group is warned about and skipped; the rest of the
 * calendar still publishes.
 */
export async function fetchTamuCalendar(options: TamuCalendarOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const days = options.days ?? 45;
  const groups = options.groups ?? GROUP_FEEDS;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  let failures = 0;
  let attempts = 0;

  const feeds: { url: string; channel: string }[] = [
    { url: buildUrl(MAIN_FEED, { days }), channel: 'Main University Calendar' },
    ...groups.map((group) => ({
      url: buildUrl(`${GROUP_FEED}/${encodeURIComponent(group)}`, { days }),
      channel: group,
    })),
  ];

  for (const feed of feeds) {
    attempts += 1;
    try {
      const { data } = await getJson<unknown>(feed.url, options);
      if (!Array.isArray(data)) {
        warnings.push(`${feed.channel}: response was not an array`);
        continue;
      }

      let mapped = 0;
      for (const event of data) {
        const item = mapEvent(event as LiveWhaleEvent, feed.channel);
        if (item !== null) {
          records.push(item);
          mapped += 1;
        }
      }

      // The main feed's 1000-record ceiling. If a pull comes back exactly at
      // the cap, coverage is incomplete and the group feeds are carrying it.
      if (data.length >= 1000) {
        warnings.push(`${feed.channel}: hit the 1000-record feed cap - coverage relies on group feeds`);
      }
      // An empty feed is ambiguous and both readings are common: a group that
      // is listed but not posting (verified - several return 0 even at
      // days=365), or a group title that does not match LiveWhale exactly,
      // which soft-200s with `[]` rather than 404ing. Report the fact, not a
      // guess at the cause.
      if (data.length === 0 && feed.channel !== 'Main University Calendar') {
        warnings.push(
          `${feed.channel}: 0 events - group is not posting, or the title no longer matches calendar.tamu.edu/feeds/`,
        );
      }

      log.info(`[tamu-calendar] ${feed.channel}: ${mapped} event(s)`);
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`${feed.channel}: ${message}`);
      log.warn(`[tamu-calendar] ${feed.channel} FAILED: ${message}`);
    }
  }

  const allFailed = failures === attempts;

  return {
    source: 'tamu-calendar',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${failures} feed(s) failed` : null,
    durationMs: Date.now() - startedAt,
    failedRequests: failures,
  };
}
