/**
 * View helpers shared by every page.
 *
 * Pure formatting and selection. No fetching, no scoring - if something here
 * starts making a judgement about relevance, it belongs in a scorer instead.
 */

import type { CampusCategory, Digest, RadarItem, RadarSnapshot, ResearchBand } from '@/types.ts';

/** Everything on campus happens in Central time; render it that way. */
const TZ = 'America/Chicago';

export function formatDateTime(iso: string | null): string {
  if (iso === null) return 'Date TBD';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Date TBD';
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

export function formatDate(iso: string | null): string {
  if (iso === null) return 'Undated';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Undated';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
}

/** A date range for a collapsed series: "Aug 23 – Aug 27". */
export function formatRange(startIso: string | null, endIso: string | null): string {
  if (startIso === null) return 'Date TBD';
  if (endIso === null) return formatDateTime(startIso);
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return formatDateTime(startIso);
  // Same calendar day: a range would read as a duplicate.
  if (start.toDateString() === end.toDateString()) return formatDateTime(startIso);
  return `${formatDate(startIso)} – ${formatDate(endIso)}`;
}

/** "2 days ago", "in 3 hours". Relative to a caller-supplied now, for testability. */
export function relative(iso: string | null, now: string): string {
  if (iso === null) return '';
  const then = Date.parse(iso);
  const reference = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(reference)) return '';

  const diffMs = then - reference;
  const future = diffMs > 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);

  if (minutes < 60) return future ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return future ? `in ${days} day${days === 1 ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return future ? `in ${months} mo` : `${months} mo ago`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabDef {
  id: string;
  label: string;
  hint: string;
}

export const RESEARCH_TABS: readonly TabDef[] = [
  { id: 'for-you', label: 'For You', hint: 'The aggressive cut - 5 to 15 things' },
  { id: 'new', label: 'New', hint: 'Everything matching the research profile' },
  { id: 'preprints', label: 'Preprints', hint: 'bioRxiv, medRxiv, arXiv' },
  { id: 'methods', label: 'Methods', hint: 'Codon models, PAML, HyPhy, phylogenetics, tooling' },
  { id: 'mtb', label: 'Mtb', hint: 'Tuberculosis-specific' },
  { id: 'host', label: 'Host / Diabetes', hint: 'Metabolic effects, susceptibility, host-pathogen' },
  { id: 'tracked', label: 'Tracked', hint: 'Papers you are following' },
];

export const CAMPUS_TABS: readonly TabDef[] = [
  { id: 'for-you', label: 'For You', hint: 'Only what Radar thinks is worth seeing' },
  { id: 'campus', label: 'Campus', hint: 'Departments, seminars, workshops, research centres' },
  { id: 'companies', label: 'Companies', hint: 'Employers, info sessions, career fairs' },
  { id: 'sports', label: 'Sports', hint: 'Aggie athletics and rec sports' },
  { id: 'clubs', label: 'Clubs', hint: 'Student organizations and social events' },
  { id: 'studies', label: 'Research & Studies', hint: 'Paid studies and research events' },
  { id: 'free', label: 'Free Stuff', hint: 'Only where the source actually says so' },
  { id: 'deadlines', label: 'Deadlines', hint: 'Applications, registration, scholarships' },
  { id: 'bcs', label: 'B/CS', hint: 'Bryan/College Station, beyond campus' },
];

/** The For You cut. Matches `FOR_YOU_THRESHOLD` in `src/core/rank.ts`. */
export const FOR_YOU_MIN = 55;

/**
 * Which tabs an item belongs to.
 *
 * An item can be in several - a paid genomics study is both `studies` and
 * `for-you` - and the client filters on these, so this is the single place
 * that decides tab membership for both verticals.
 */
export function tabsFor(item: RadarItem): string[] {
  const tabs: string[] = [];

  if (item.relevance >= FOR_YOU_MIN) tabs.push('for-you');

  const research = item.research;
  if (research !== undefined) {
    tabs.push('new');
    if (research.kind === 'preprint') tabs.push('preprints');
    if (research.band === 'methods') tabs.push('methods');
    if (item.reasons.some((r) => r.signal === 'organism')) tabs.push('mtb');
    if (item.reasons.some((r) => r.signal === 'host')) tabs.push('host');
    return tabs;
  }

  const campus = item.campus;
  if (campus !== undefined) {
    const byCategory: Record<CampusCategory, string> = {
      academic: 'campus',
      companies: 'companies',
      sports: 'sports',
      clubs: 'clubs',
      research: 'studies',
      deadline: 'deadlines',
      community: 'bcs',
    };
    tabs.push(byCategory[campus.category]);

    // Free Stuff admits only evidenced offers. `mentioned` is displayed on the
    // card but never earns a place in the tab - see src/campus/freebies.ts.
    if (campus.food.confidence === 'confirmed' || campus.food.confidence === 'provided') tabs.push('free');
    if (campus.deadlineAt !== null && campus.category !== 'deadline') tabs.push('deadlines');
  }

  return tabs;
}

/** Reason signals, for the client re-ranker's data attribute. */
export function signalsOf(item: RadarItem): string {
  return [...new Set(item.reasons.filter((r) => r.points > 0).map((r) => r.signal))].join(',');
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function forYou(items: readonly RadarItem[], limit = 15): RadarItem[] {
  return items.filter((item) => item.relevance >= FOR_YOU_MIN).slice(0, limit);
}

export function byBand(items: readonly RadarItem[], band: ResearchBand): RadarItem[] {
  return items.filter((item) => item.research?.band === band);
}

export function byCategory(items: readonly RadarItem[], category: CampusCategory): RadarItem[] {
  return items.filter((item) => item.campus?.category === category);
}

/** Items first seen within the last `days`. */
export function recentlyAdded(items: readonly RadarItem[], now: string, days = 7): RadarItem[] {
  const cutoff = Date.parse(now) - days * 86_400_000;
  return items.filter((item) => Date.parse(item.firstSeen) >= cutoff);
}

export function findItem(snapshot: RadarSnapshot, id: string): RadarItem | null {
  return (
    snapshot.research.items.find((item) => item.id === id) ??
    snapshot.campus.items.find((item) => item.id === id) ??
    null
  );
}

export function latestDigest(digests: readonly Digest[], vertical: 'research' | 'campus'): Digest | null {
  return digests.filter((digest) => digest.vertical === vertical)[0] ?? null;
}

/** Total minutes of reading in a set, for the digest header. */
export function totalReadingMinutes(items: readonly RadarItem[]): number {
  return items.reduce((sum, item) => {
    if (item.research === undefined) return sum;
    const words = item.research.abstract.split(/\s+/).filter(Boolean).length;
    return sum + Math.min(45, words === 0 ? 8 : 10 + Math.round(words / 40));
  }, 0);
}

/** Human label for a band, used on the coloured counts. */
export const BAND_LABELS: Record<ResearchBand, string> = {
  core: 'highly relevant',
  adjacent: 'adjacent',
  methods: 'methods / tools',
};

/** Base-aware URL builder. Every internal link must go through this. */
export function url(base: string, path: string): string {
  const root = base.replace(/\/*$/, '/');
  return `${root}${path.replace(/^\/+/, '')}`;
}
