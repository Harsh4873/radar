/**
 * Aggie Research Volunteers - Texas A&M's paid-study registry.
 *
 * This is the "🧠 Brain study · $60 · ~3 hours · NEW" half of the Research &
 * Studies tab. It is a WordPress REST endpoint, and the useful data lives in a
 * `meta` bag of free-text fields written by study coordinators.
 *
 * TWO THINGS THIS MODULE IS CAREFUL ABOUT:
 *
 *   1. `meta.aux_study_item_contact_email` is a real address on most records.
 *      It is never read into a RawItem, for the same reason the calendar's
 *      registration email is not - this site is public.
 *
 *   2. COMPENSATION IS FREE TEXT AND OFTEN NOT A GUARANTEE. Values in the live
 *      feed include "Up to $30 <br>Paid as Amazon gift card", hourly rates,
 *      ranges, and raffle entries. A raffle is a CHANCE at money, not money,
 *      and flattening the two would misrepresent what a study pays. Anything
 *      lottery-shaped yields `compensationUsd: null` while keeping the original
 *      text, so the UI shows what was actually offered.
 *
 * API: https://research.tamu.edu/wp-json/wp/v2/study
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { collapse, htmlToText, toIso } from '@/core/text.ts';
import { detectFreebies } from '@/campus/freebies.ts';

const ENDPOINT = 'https://research.tamu.edu/wp-json/wp/v2/study';

/** The registry is ~86 records; 100 covers it in one request. */
const PER_PAGE = 100;
const MAX_PAGES = 10;

interface WpRendered {
  rendered?: string;
}

interface ArvStudy {
  id?: number;
  /** Local time, NO timezone suffix. Prefer the `_gmt` twin below. */
  date?: string;
  modified?: string;
  /** The same instants in UTC. Unambiguous, so these are what Radar reads. */
  date_gmt?: string;
  modified_gmt?: string;
  link?: string;
  title?: WpRendered;
  content?: WpRendered;
  excerpt?: WpRendered;
  meta?: {
    aux_study_item_irb_number?: string;
    aux_study_item_compensation?: string;
    aux_study_item_duration?: string;
    aux_study_item_minimum_age?: string;
    aux_study_item_maximum_age?: string;
    aux_study_item_expiration_date?: string | null;
    aux_study_item_pi_name?: string;
    /** A real address. Never read. */
    aux_study_item_contact_email?: string;
  };
}

/** Language that makes a payment a chance rather than a payment. */
const LOTTERY_TERMS = /\b(raffle|drawing|lottery|sweepstake|chance to win|enter to win|randomly selected)\b/i;

export interface ParsedCompensation {
  /** The original text, cleaned. Always shown. */
  text: string;
  /** A defensible dollar figure, or null when the text does not support one. */
  usd: number | null;
  /** True when payment is a lottery. `usd` is always null in that case. */
  isChance: boolean;
}

/**
 * Parse a compensation string into a sortable figure.
 *
 * Deliberately conservative. Returns null rather than guessing, because the
 * figure drives ranking and a wrong number sends someone to a three-hour study
 * for a fraction of what they expected.
 *
 * Handled: `$60`, `Up to $30`, `$10-$20` (takes the low end - the guaranteed
 * part), `$15/hour` (kept as the hourly figure), `$1,200`.
 * Refused: anything lottery-shaped, and anything with no dollar figure.
 */
export function parseCompensation(raw: string | null | undefined): ParsedCompensation {
  const text = collapse(htmlToText(raw ?? ''));
  if (text.length === 0) return { text: '', usd: null, isChance: false };

  if (LOTTERY_TERMS.test(text)) return { text, usd: null, isChance: true };

  const amounts = [...text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) => Number.parseFloat((match[1] ?? '').replace(/,/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 100_000);

  if (amounts.length === 0) return { text, usd: null, isChance: false };

  // A range pays the low end for certain; the high end is aspirational.
  // "Up to $30" is the same shape and gets the same treatment via the range
  // check falling through to the single value.
  const usd = amounts.length > 1 ? Math.min(...amounts) : (amounts[0] ?? null);
  return { text, usd, isChance: false };
}

export function mapStudy(study: ArvStudy): RawItem | null {
  const title = htmlToText(study.title?.rendered);
  const id = study.id;
  if (title.length === 0 || id === undefined) return null;

  const link = study.link;
  if (typeof link !== 'string' || link.length === 0) return null;

  const body = htmlToText(study.content?.rendered) || htmlToText(study.excerpt?.rendered);
  const meta = study.meta ?? {};
  const compensation = parseCompensation(meta.aux_study_item_compensation);
  const duration = collapse(htmlToText(meta.aux_study_item_duration ?? ''));

  const expiresAt = toIso(meta.aux_study_item_expiration_date ?? null);
  const freebies = detectFreebies(`${title} ${body}`, null);

  const tags = ['paid study'];
  if (compensation.isChance) tags.push('raffle');
  if (duration.length > 0) tags.push(duration);

  return {
    vertical: 'campus',
    source: 'aggie-research-volunteers',
    externalId: String(id),
    channel: 'Aggie Research Volunteers',
    url: link,
    title,
    summary: body,
    // A study listing has no start time - it is open until it expires. Using
    // the posting date keeps "new this week" meaningful without inventing an
    // event time that the imminence scorer would then treat as a schedule.
    //
    // `date_gmt` first: WordPress's `date` is local with no zone, so reading
    // it directly makes the parsed instant depend on the machine's timezone.
    occurredAt: toIso(study.date_gmt ?? study.date),
    endsAt: expiresAt,
    lastModified: toIso(study.modified_gmt ?? study.modified),
    tags,
    identity: [
      // IRB number is the true identity - the registry re-posts protocols - but
      // not every record has one, so fall back to the post id.
      meta.aux_study_item_irb_number !== undefined && meta.aux_study_item_irb_number.length > 0
        ? `event:arv-irb-${meta.aux_study_item_irb_number.toLowerCase()}`
        : `event:arv-${String(id)}`,
    ],
    campus: {
      category: 'research',
      startsAt: null,
      endsAt: expiresAt,
      isAllDay: false,
      isCancelled: false,
      isOnline: /online|virtual|remote|web based|web-based/i.test(`${title} ${body}`),
      onlineUrl: null,
      location: null,
      coordinates: null,
      organizer: collapse(meta.aux_study_item_pi_name ?? '') || 'Texas A&M Research',
      audience: [],
      eventTypes: ['Research Study'],
      companies: [],
      food: freebies.food,
      cost: null,
      hasRegistration: true,
      compensation: compensation.text.length > 0 ? compensation.text : null,
      compensationUsd: compensation.usd,
      deadlineAt: expiresAt,
      seriesCount: 1,
    },
  };
}

export interface ArvOptions extends RequestOptions {
  log?: Logger;
}

export async function fetchAggieResearchVolunteers(options: ArvOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = buildUrl(ENDPOINT, { per_page: PER_PAGE, page, orderby: 'date', order: 'desc' });
      const { data, headers } = await getJson<unknown>(url, options);

      if (!Array.isArray(data)) {
        warnings.push('response was not an array');
        break;
      }

      for (const study of data) {
        const mapped = mapStudy(study as ArvStudy);
        if (mapped !== null) records.push(mapped);
      }

      const totalPages = Number.parseInt(headers.get('x-wp-totalpages') ?? '1', 10);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }

    log.info(`[aggie-research-volunteers] ${records.length} study listing(s)`);

    return {
      source: 'aggie-research-volunteers',
      records,
      fetchSource: 'network',
      warnings,
      error: null,
      durationMs: Date.now() - startedAt,
      failedRequests: 0,
    };
  } catch (err) {
    const message = describeError(err);
    log.error(`[aggie-research-volunteers] read FAILED: ${message}`);
    return {
      source: 'aggie-research-volunteers',
      records: [],
      fetchSource: 'empty',
      warnings,
      error: message,
      durationMs: Date.now() - startedAt,
      failedRequests: 1,
    };
  }
}
