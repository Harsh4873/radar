/**
 * Get Involved — Texas A&M's official student-organization event directory.
 *
 * This connector used to be an intentional refusal. In August 2026 the site
 * changed: `/events` began rendering the complete upcoming-event list in the
 * initial HTML response, including stable event URLs, organizers, dates, and
 * locations. That makes it a bounded, server-rendered source instead of a
 * headless-browser scrape. The parser deliberately reads only those visible
 * fields; it never visits the individual event pages and therefore makes one
 * request on an ordinary run rather than one request per club.
 *
 * The directory is a Laravel Livewire page, but Radar does not depend on the
 * private Livewire protocol or serialized component state. It parses the
 * human-facing event cards that are present without JavaScript. If those cards
 * disappear, zero records is treated as a failed read rather than a quiet week.
 *
 * Source: https://getinvolved.tamu.edu/events
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getText, type RequestOptions } from '@/core/http.ts';
import { calendarDaysUntil, collapse, htmlToText } from '@/core/text.ts';
import { classify, extractCompanies } from '@/campus/classify.ts';

const ENDPOINT = 'https://getinvolved.tamu.edu/events';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const CENTRAL = 'America/Chicago';

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  isAllDay: boolean;
}

export interface ParsedGetInvolvedEvent {
  eventId: string;
  occurrenceId: string | null;
  url: string;
  title: string;
  organizer: string;
  startsAt: string;
  endsAt: string | null;
  isAllDay: boolean;
  location: string | null;
}

/** Convert a wall-clock time in College Station to an unambiguous instant. */
function centralInstant(value: LocalDateTime): string {
  const desired = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
  let stamp = desired;

  // Two passes are enough to resolve the Central offset on either side of a
  // DST boundary. Formatting the guess in-zone tells us how far its wall time
  // is from the wall time the source named; applying that delta yields the
  // corresponding instant without depending on the machine's own timezone.
  for (let pass = 0; pass < 2; pass += 1) {
    const fields = new Intl.DateTimeFormat('en-US', {
      timeZone: CENTRAL,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(stamp));
    const field = (type: Intl.DateTimeFormatPartTypes): number =>
      Number.parseInt(fields.find((part) => part.type === type)?.value ?? '0', 10);
    const rendered = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
    );
    stamp += desired - rendered;
  }

  return new Date(stamp).toISOString();
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (match === null) return null;
  const rawHour = Number.parseInt(match[1] ?? '', 10);
  const minute = Number.parseInt(match[2] ?? '0', 10);
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;
  const pm = (match[3] ?? '').toLowerCase() === 'pm';
  return { hour: rawHour % 12 + (pm ? 12 : 0), minute };
}

function parseDatePart(value: string, fallbackYear: number): LocalDateTime | null {
  const match = collapse(value).match(
    /^(?:[A-Za-z]{3},\s*)?([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+(\d{1,2}(?::\d{2})?\s*[ap]m))?$/i,
  );
  if (match === null) return null;

  const month = MONTHS[(match[1] ?? '').toLowerCase()];
  const day = Number.parseInt(match[2] ?? '', 10);
  const year = Number.parseInt(match[3] ?? String(fallbackYear), 10);
  const clock = match[4] === undefined ? { hour: 0, minute: 0 } : parseClock(match[4]);
  if (month === undefined || day < 1 || day > 31 || year < 2000 || year > 2100 || clock === null) return null;

  return { year, month, day, ...clock, isAllDay: match[4] === undefined };
}

/** Parse Get Involved's rendered date label in US Central time. */
export function parseGetInvolvedDate(
  label: string,
  referenceNow: string,
): { startsAt: string; endsAt: string | null; isAllDay: boolean } | null {
  const clean = collapse(label);
  const referenceYear = Number.parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, year: 'numeric' }).format(new Date(referenceNow)),
    10,
  );
  if (!Number.isFinite(referenceYear)) return null;

  const pieces = clean.split(/\s+-\s+/, 2);
  const startText = pieces[0] ?? '';
  const endText = pieces[1] ?? null;

  // Ranges sometimes omit the year on the start because the end supplies it:
  // "Mon, Aug 10 2:39 pm - Wed, Sep 9, 2026 2:39 pm".
  const endWithDate = endText === null ? null : parseDatePart(endText, referenceYear);
  const start = parseDatePart(startText, endWithDate?.year ?? referenceYear);
  if (start === null) return null;

  let end: LocalDateTime | null = endWithDate;
  if (end === null && endText !== null) {
    const clock = parseClock(endText);
    if (clock !== null) end = { ...start, ...clock, isAllDay: false };
  }

  return {
    startsAt: centralInstant(start),
    endsAt: end === null ? null : centralInstant(end),
    isAllDay: start.isAllDay,
  };
}

/**
 * Read the visible event cards from one server-rendered directory page.
 *
 * Cards contain nested divs, so matching an entire card with one HTML regex is
 * fragile. Stable event anchors are used as boundaries instead: the text
 * between one event anchor and the next contains that event's organizer, date,
 * and location paragraphs.
 */
export function parseGetInvolvedHtml(html: string, referenceNow: string): ParsedGetInvolvedEvent[] {
  const anchor = /<a\b[^>]*href="(https:\/\/getinvolved\.tamu\.edu\/org\/[^"/]+\/events\/(\d+)(?:\/(\d+))?)"[^>]*title="([^"]+)"[^>]*>/gi;
  const matches = [...html.matchAll(anchor)];
  const events: ParsedGetInvolvedEvent[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    if (match === undefined || match.index === undefined) continue;

    const url = match[1];
    const eventId = match[2];
    if (url === undefined || eventId === undefined) continue;

    const segmentStart = match.index + match[0].length;
    const segmentEnd = next?.index ?? html.length;
    const segment = html.slice(segmentStart, segmentEnd);
    const paragraphs = [...segment.matchAll(/<p\b[^>]*\btext-sm2\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .slice(0, 3)
      .map((entry) => htmlToText(entry[1]));

    const organizer = paragraphs[0] ?? '';
    const dateLabel = paragraphs[1] ?? '';
    const date = parseGetInvolvedDate(dateLabel, referenceNow);
    const title = htmlToText(match[4]);
    if (title.length === 0 || organizer.length === 0 || date === null) continue;

    events.push({
      eventId,
      occurrenceId: match[3] ?? null,
      url,
      title,
      organizer,
      ...date,
      location: collapse(paragraphs[2] ?? '') || null,
    });
  }

  return events;
}

function mapEvent(event: ParsedGetInvolvedEvent): RawItem {
  const category = classify({
    title: event.title,
    description: '',
    // Every record is posted by a recognized organization in Student
    // Activities. Sports/recruiting terms still win earlier in classification.
    group: 'Department of Student Activities',
    eventTypes: ['Student organization'],
  });
  const externalId = `${event.eventId}:${event.occurrenceId ?? 'primary'}`;

  return {
    vertical: 'campus',
    source: 'getinvolved',
    externalId,
    channel: event.organizer,
    url: event.url,
    title: event.title,
    summary: '',
    occurredAt: event.startsAt,
    endsAt: event.endsAt,
    lastModified: null,
    // Organizer tags survive a fuzzy merge of co-marketed events such as Club
    // Crawl, keeping every participating club searchable and followable.
    tags: ['Student organization', event.organizer],
    identity: [`event:getinvolved-${externalId}`],
    campus: {
      category,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      isAllDay: event.isAllDay,
      isCancelled: false,
      isOnline: false,
      onlineUrl: null,
      location: event.location,
      coordinates: null,
      organizer: event.organizer,
      audience: ['Students'],
      eventTypes: ['Student organization'],
      companies: extractCompanies(event.title, ''),
      food: { confidence: 'none', items: [], evidence: null },
      cost: null,
      hasRegistration: false,
      compensation: null,
      compensationUsd: null,
      deadlineAt: category === 'deadline' ? event.startsAt : null,
      seriesCount: 1,
    },
  };
}

export interface GetInvolvedOptions extends RequestOptions {
  now: string;
  days?: number;
  maxPages?: number;
  log?: Logger;
}

/** Read the official student-org directory. Never throws across the boundary. */
export async function fetchGetInvolved(options: GetInvolvedOptions): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const days = options.days ?? 45;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES));
  const startedAt = Date.now();
  const warnings: string[] = [];
  const parsed: ParsedGetInvolvedEvent[] = [];
  let failures = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const url = buildUrl(ENDPOINT, { limit: PAGE_SIZE, page });
      const html = await getText(url, { ...options, headers: { accept: 'text/html,application/xhtml+xml' } });
      const events = parseGetInvolvedHtml(html, options.now);

      // A successful 200 containing no event anchors is much more likely to be
      // a markup/login/maintenance response than an empty campus. Fail loudly
      // so retention keeps yesterday's student-org events.
      if (page === 1 && events.length === 0) {
        throw new Error('Get Involved returned no parseable event cards');
      }

      parsed.push(...events);
      log.info(`[getinvolved] page ${page}: ${events.length} event(s)`);
      if (events.length < PAGE_SIZE) break;
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`page ${page} failed: ${message}`);
      log.warn(`[getinvolved] page ${page} FAILED: ${message}`);
      break;
    }
  }

  const seen = new Set<string>();
  const records = parsed
    .filter((event) => {
      const key = `${event.eventId}:${event.occurrenceId ?? 'primary'}`;
      if (seen.has(key)) return false;
      seen.add(key);

      const startsIn = calendarDaysUntil(event.startsAt, options.now);
      const endsIn = calendarDaysUntil(event.endsAt, options.now);
      const stillHappening = endsIn !== null && endsIn >= 0;
      return stillHappening || (startsIn !== null && startsIn >= 0 && startsIn <= days);
    })
    .map(mapEvent);

  const failedCompletely = failures > 0 && records.length === 0;
  return {
    source: 'getinvolved',
    records,
    fetchSource: failedCompletely ? 'empty' : 'network',
    warnings,
    error: failedCompletely ? warnings[0] ?? 'Get Involved read failed' : null,
    durationMs: Date.now() - startedAt,
    failedRequests: failures,
  };
}
