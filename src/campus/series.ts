/**
 * Series collapsing: many calendar entries, one card.
 *
 * Distinct from deduplication, and the distinction is the whole point.
 * `dedupe.ts` merges records that are THE SAME THING seen through different
 * feeds. This merges records that are DIFFERENT THINGS the user thinks of as
 * one thing:
 *
 *   ACS Fall 2026 Meeting   Aug 23   event 350521
 *   ACS Fall 2026 Meeting   Aug 24   event 350526
 *   ACS Fall 2026 Meeting   Aug 25   event 350527
 *   ACS Fall 2026 Meeting   Aug 26   event 350528
 *   ACS Fall 2026 Meeting   Aug 27   event 350529
 *
 * Those are five legitimately separate LiveWhale events with five ids and five
 * different days, so dedupe is right to leave them alone - merging on a two
 * hour window would also collapse a weekly seminar series into a single talk.
 * But five identical cards is precisely the noise Radar exists to remove, so
 * they collapse here instead, into one card spanning Aug 23-27.
 *
 * The rule is deliberately tight: identical canonical title AND the same
 * organizer AND the same location. Two different groups running events with
 * the same generic name ("Closed", "General Meeting") stay separate, because
 * they are separate.
 */

import type { RadarItem } from '@/types.ts';
import { mergeCluster } from '@/core/dedupe.ts';
import { contentHashOf } from '@/core/normalize.ts';
import { canonicalTitle, clamp } from '@/core/text.ts';

const CLUB_CRAWL = /^club crawl\s+((?:fall|spring)\s+\d{4})(?:\s*[-:]\s*(.*))?$/i;

function clubCrawlParts(title: string): { term: string; organization: string | null } | null {
  const match = title.match(CLUB_CRAWL);
  if (match === null) return null;
  const term = match[1];
  if (term === undefined) return null;
  const rawOrganization = (match[2] ?? '')
    .replace(/:\s*the official involvement festival at texas a&m\s*$/i, '')
    .trim();
  const organization = rawOrganization.length === 0
    || /^the official involvement festival at texas a&m$/i.test(rawOrganization)
    ? null
    : rawOrganization;
  return { term, organization };
}

/**
 * Fold per-organization copies of Club Crawl into the one real-world event.
 *
 * Get Involved and LiveWhale publish a separate card for many participating
 * organizations. Showing 30 adjacent cards for one festival destroys the
 * chronological agenda, while dropping them loses club discovery. The merged
 * card therefore keeps every source and adds each named organization as a
 * non-rendered search tag; profile suggestions can read those tags too.
 */
export function collapseCoMarketedEvents(
  items: readonly RadarItem[],
): { items: RadarItem[]; collapsed: number } {
  const groups = new Map<string, RadarItem[]>();
  const passthrough: RadarItem[] = [];

  for (const item of items) {
    const parts = clubCrawlParts(item.title);
    const startsAt = item.campus?.startsAt ?? null;
    if (parts === null || startsAt === null) {
      passthrough.push(item);
      continue;
    }
    const key = `${parts.term.toLowerCase()}|${startsAt}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }

  const out = [...passthrough];
  let collapsed = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only !== undefined) out.push(only);
      continue;
    }

    // Put the official umbrella record first so the aggregate keeps the same
    // stable item id as participating organizations come and go.
    const ordered = [...group].sort((a, b) => {
      const official = (item: RadarItem): number =>
        item.campus?.organizer?.toLowerCase() === 'club crawl' ? 1 : 0;
      return official(b) - official(a);
    });
    const merged = mergeCluster(ordered);
    const term = clubCrawlParts(merged.title)?.term ?? clubCrawlParts(ordered[0]?.title ?? '')?.term;
    if (term === undefined) {
      out.push(...group);
      continue;
    }

    const organizations = [...new Set(
      group
        .map((item) => clubCrawlParts(item.title)?.organization ?? null)
        .filter((name): name is string => name !== null),
    )].sort((a, b) => a.localeCompare(b));
    const tags = [...merged.tags];
    const seenTags = new Set(tags.map((tag) => tag.toLowerCase()));
    for (const organization of organizations) {
      const tag = `Organization: ${organization}`;
      if (!seenTags.has(tag.toLowerCase())) tags.push(tag);
    }

    const aggregate: RadarItem = {
      ...merged,
      title: `Club Crawl ${term}: The Official Involvement Festival at Texas A&M`,
      summary: organizations.length === 0
        ? merged.summary
        : clamp(`${organizations.length} participating organizations: ${organizations.join(', ')}.`, 400),
      tags,
      campus: merged.campus === undefined
        ? undefined
        : { ...merged.campus, category: 'clubs', organizer: 'Club Crawl', seriesCount: 1 },
    };
    aggregate.contentHash = contentHashOf(aggregate);
    out.push(aggregate);
    collapsed += group.length - 1;
  }

  return { items: out, collapsed };
}

/**
 * Longest span that still reads as one series, in days.
 *
 * A conference runs a week; a semester-long weekly seminar does not belong on
 * one card, because "there is a seminar sometime in the next four months" is
 * not useful. 45 days is past any single event and short of a term.
 */
const MAX_SERIES_SPAN_DAYS = 45;

function seriesKey(item: RadarItem): string | null {
  const campus = item.campus;
  if (campus === undefined || campus.startsAt === null) return null;
  const title = canonicalTitle(item.title);
  if (title.length === 0) return null;
  return `${title}|${campus.organizer ?? ''}|${campus.location ?? ''}`;
}

/**
 * Fold multi-occurrence events into one card each.
 *
 * The survivor is the EARLIEST UPCOMING occurrence, not the first in the
 * array: the useful question is "when is the next one", and its `endsAt`
 * carries the end of the series so the UI can render a range. Every
 * occurrence's sources are preserved, so provenance is not lost.
 */
export function collapseSeries(items: readonly RadarItem[]): { items: RadarItem[]; collapsed: number } {
  const groups = new Map<string, RadarItem[]>();
  const passthrough: RadarItem[] = [];

  for (const item of items) {
    const key = seriesKey(item);
    if (key === null) {
      passthrough.push(item);
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }

  const out: RadarItem[] = [...passthrough];
  let collapsed = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only !== undefined) out.push(only);
      continue;
    }

    const sorted = [...group].sort(
      (a, b) => Date.parse(a.campus?.startsAt ?? '') - Date.parse(b.campus?.startsAt ?? ''),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue;

    const spanDays =
      (Date.parse(last.campus?.startsAt ?? '') - Date.parse(first.campus?.startsAt ?? '')) / 86_400_000;

    // Too spread out to be one thing. Keep them separate.
    if (!Number.isFinite(spanDays) || spanDays > MAX_SERIES_SPAN_DAYS) {
      out.push(...group);
      continue;
    }

    const sources = first.sources.slice();
    const seen = new Set(sources.map((s) => `${s.source}:${s.externalId}`));
    for (const item of sorted.slice(1)) {
      for (const source of item.sources) {
        const key = `${source.source}:${source.externalId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(source);
      }
    }

    const firstCampus = first.campus;
    if (firstCampus === undefined) {
      out.push(...group);
      continue;
    }

    out.push({
      ...first,
      sources,
      // The series ends when its last occurrence ends.
      endsAt: last.campus?.endsAt ?? last.campus?.startsAt ?? first.endsAt,
      campus: {
        ...firstCampus,
        endsAt: last.campus?.endsAt ?? last.campus?.startsAt ?? firstCampus.endsAt,
        seriesCount: group.length,
        // If any occurrence is cancelled the card must say so; which one is a
        // detail the detail page can carry later.
        isCancelled: group.some((item) => item.campus?.isCancelled === true),
      },
    });
    collapsed += group.length - 1;
  }

  return { items: out, collapsed };
}
