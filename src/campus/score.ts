/**
 * CampusRadar ranking.
 *
 * Same additive, explainable model as the research side, but the value
 * function is genuinely different: a paper is worth reading whenever you get
 * to it, while an event is worthless the moment it ends. So timing is not a
 * tiebreak here - it is one of the largest terms, and a finished event scores
 * far enough below zero to leave the feed without a separate filter.
 *
 *   Relevance = interest match
 *             + event value (paid studies, free food, named employers)
 *             + timing (today > this week > next month > over)
 *             + source corroboration
 *             - cancelled / already happened
 */

import type { RadarItem, RelevanceReason } from '@/types.ts';
import { cancellationSignal, corroborationSignal, imminenceSignal, reason, scoreItem } from '@/core/rank.ts';
import { CAMPUS_INTERESTS } from '@/campus/profile.ts';
import { calendarDaysUntil } from '@/core/text.ts';
import { searchable } from '@/research/profile.ts';

export interface CampusContext {
  now: string;
  /** Interest ids the user muted via "not relevant". */
  mutedInterests?: ReadonlySet<string>;
  /** Employers the user is actively tracking. */
  watchedCompanies?: ReadonlySet<string>;
  /** Below this, a paid study is not worth the trip. */
  minStudyPayUsd?: number;
}

/**
 * Points for the money a study pays.
 *
 * Banded rather than proportional. A linear term would let a single $500
 * study dominate the entire feed, and the real decision ("is this worth a few
 * hours?") is a threshold question, not a linear one.
 */
function compensationSignal(usd: number | null, minimum: number): RelevanceReason | null {
  if (usd === null) return null;
  if (usd < minimum) return reason('pay', `pays $${usd} - below your floor`, -4);
  if (usd >= 100) return reason('pay', `pays $${usd}`, 20);
  if (usd >= 50) return reason('pay', `pays $${usd}`, 15);
  if (usd >= 25) return reason('pay', `pays $${usd}`, 10);
  return reason('pay', `pays $${usd}`, 5);
}

/**
 * Points for food, strictly by evidence tier.
 *
 * `mentioned` earns ZERO. It is displayed (so the user can judge) but it must
 * never lift an event up the feed, because "Coffee Chat with the Dean"
 * mentions coffee and is not a free meal. See `src/campus/freebies.ts`.
 */
function foodSignal(item: RadarItem): RelevanceReason | null {
  const food = item.campus?.food;
  if (food === undefined) return null;
  switch (food.confidence) {
    case 'confirmed':
      return reason('food', `free food: ${food.items.slice(0, 2).join(', ')}`, 8);
    case 'provided':
      return reason('food', 'food provided', 5);
    default:
      return null;
  }
}

export function scoreCampusItem(item: RadarItem, context: CampusContext): RadarItem {
  const campus = item.campus;
  if (campus === undefined) return scoreItem(item, []);

  const reasons: RelevanceReason[] = [];
  const haystack = searchable(item.title, item.summary, campus.organizer, campus.eventTypes.join(' '));
  const muted = context.mutedInterests ?? new Set<string>();

  // --- 1. Interests -------------------------------------------------------
  for (const interest of CAMPUS_INTERESTS) {
    if (muted.has(interest.id)) continue;
    // One hit per interest, same rule as the research profile.
    if (interest.patterns.some((pattern) => haystack.includes(` ${pattern} `))) {
      reasons.push(reason(interest.signal, interest.label, interest.weight));
    }
  }

  // --- 2. Named employers -------------------------------------------------
  if (campus.companies.length > 0) {
    const watched = context.watchedCompanies ?? new Set<string>();
    const tracked = campus.companies.filter((company) => watched.has(company.toLowerCase()));
    if (tracked.length > 0) {
      reasons.push(reason('company', `tracking ${tracked.join(', ')}`, 18));
    } else {
      reasons.push(reason('company', `employer: ${campus.companies.slice(0, 2).join(', ')}`, 10));
    }
  }

  // --- 3. Money and food --------------------------------------------------
  const pay = compensationSignal(campus.compensationUsd, context.minStudyPayUsd ?? 15);
  if (pay !== null) reasons.push(pay);

  const food = foodSignal(item);
  if (food !== null) reasons.push(food);

  // --- 4. Timing ----------------------------------------------------------
  // Study listings have no start time - they are open until they expire - so
  // scoring them on imminence would bury them all as "far out". They are
  // judged on their deadline instead.
  if (campus.startsAt !== null) {
    const imminence = imminenceSignal(campus.startsAt, context.now);
    if (imminence !== null) reasons.push(imminence);
  } else if (campus.deadlineAt !== null) {
    // Calendar days, matching `imminenceSignal` - a deadline "closes this
    // week" by the calendar, not by elapsed hours.
    const untilDeadline = calendarDaysUntil(campus.deadlineAt, context.now);
    if (untilDeadline !== null) {
      if (untilDeadline < 0) reasons.push(reason('timing', 'closed', -60));
      else if (untilDeadline <= 7) reasons.push(reason('timing', 'closes within a week', 10));
      else if (untilDeadline <= 30) reasons.push(reason('timing', 'closes this month', 4));
    }
  }

  // --- 5. Convenience -----------------------------------------------------
  // Small, and small on purpose: online is convenient, not more interesting.
  if (campus.isOnline) reasons.push(reason('format', 'online', 2));

  // --- 6. Status ----------------------------------------------------------
  const cancelled = cancellationSignal(item);
  if (cancelled !== null) reasons.push(cancelled);

  const corroboration = corroborationSignal(item);
  if (corroboration !== null) reasons.push(corroboration);

  return scoreItem(item, reasons);
}

export function scoreCampus(items: readonly RadarItem[], context: CampusContext): RadarItem[] {
  return items.map((item) => scoreCampusItem(item, context));
}
