/**
 * What a study card is allowed to claim about money.
 *
 * Ranking stays on `effectiveHourly`. Nothing here writes back onto
 * `compensation`: normalize tests require that object to match the parser.
 * Callers use these helpers at render time only.
 */
import { reconcileEffectiveHourly } from '@/studies/effective-rate.ts';
import type { ParsedCompensation, ParsedDuration } from '@/studies/types.ts';

/** Whole dollars unless the cents actually carry information. */
export function usd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? `$${rounded.toLocaleString('en-US')}`
    : `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * True when the published hourly figure is a ceiling or a rising stated rate.
 *
 * A null pay floor with a positive ceiling, or a stated hourly range, is not
 * one firm rate. A single stated hourly number, or a reconciled per-visit
 * total, is not labeled "up to".
 */
export function rateIsUpTo(comp: ParsedCompensation): boolean {
  if (comp.isHourlyRate) {
    const hi = comp.hourlyMax;
    const lo = comp.hourlyMin;
    if (typeof hi === 'number' && Number.isFinite(hi) && hi > 0) {
      return lo === null || hi > lo;
    }
    return false;
  }
  return (
    comp.guaranteedMin === null
    && typeof comp.guaranteedMax === 'number'
    && Number.isFinite(comp.guaranteedMax)
    && comp.guaranteedMax > 0
  );
}

/**
 * Label for a dollar total that sits next to an hourly figure.
 *
 * A missing floor is a ceiling ("up to $550"). A scaled whole-study total is
 * the amount the rate was divided into, so it stays a firm figure.
 */
export function studyTotalLabel(comp: ParsedCompensation, total: number, scaled: boolean): string {
  if (!scaled && comp.guaranteedMin === null) return `up to ${usd(total)}`;
  return usd(total);
}

/**
 * Whole-study guaranteed pay when per-visit pay was scaled up before dividing.
 *
 * Null when the parsed min/max are already the figure the rate used. That
 * keeps ceiling studies ("up to $550") on the parser's own total.
 */
export function scaledStudyTotal(
  comp: ParsedCompensation | null | undefined,
  dur: ParsedDuration | null | undefined,
): number | null {
  const reconciled = reconcileEffectiveHourly(comp, dur);
  if (reconciled.basis !== 'per-visit-pay-scaled' || reconciled.guaranteedTotal === null) return null;
  return reconciled.guaranteedTotal;
}
