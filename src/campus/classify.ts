/**
 * Campus event classification: which tab does this belong in, and who is behind it?
 *
 * The tabs are the product, so this is where an event becomes useful or
 * useless. Classification is rule-based and ordered, not scored, because the
 * categories are genuinely a priority list: a Google recruiting session hosted
 * by the Career Center is a COMPANIES event first and a career event second,
 * and an athletics game is a SPORTS event no matter what else the title says.
 *
 * Signals available per event, in rough order of reliability:
 *
 *   group_title        the owning LiveWhale group, e.g. 'Career Center'. The
 *                      single most reliable signal - it is structured data
 *                      maintained by the university, not free text.
 *   event_types        curated labels, e.g. ['Campus Life']. Present on ~50%.
 *   title/description  free text. Always present, least reliable.
 */

import type { CampusCategory } from '@/types.ts';

/**
 * Employers that actually recruit at Texas A&M.
 *
 * A curated list beats named-entity extraction here: the failure mode of NER
 * on short event titles is inventing companies out of building names ("Zachry"
 * is a building AND a real engineering firm), and a wrong company tag routes
 * an event into the wrong tab. Adding a name is one line.
 */
const COMPANIES: readonly string[] = [
  // tech
  'google', 'microsoft', 'amazon', 'meta', 'apple', 'nvidia', 'intel', 'ibm', 'oracle',
  'salesforce', 'adobe', 'cisco', 'qualcomm', 'texas instruments', 'ti', 'dell', 'hp',
  'palantir', 'stripe', 'databricks', 'snowflake', 'datadog', 'atlassian', 'vmware',
  'spacex', 'blue origin', 'anduril', 'tesla', 'rivian', 'garmin', 'zoox', 'waymo',
  // finance / consulting
  'jane street', 'citadel', 'two sigma', 'jp morgan', 'jpmorgan', 'goldman sachs',
  'morgan stanley', 'capital one', 'american express', 'charles schwab', 'fidelity',
  'deloitte', 'pwc', 'ey', 'kpmg', 'mckinsey', 'bain', 'accenture', 'bcg',
  // energy / industrial - the big TAMU recruiters
  'exxonmobil', 'exxon', 'chevron', 'shell', 'bp', 'conocophillips', 'phillips 66',
  'halliburton', 'schlumberger', 'slb', 'baker hughes', 'valero', 'marathon',
  'lockheed martin', 'northrop grumman', 'raytheon', 'boeing', 'general dynamics',
  'l3harris', 'honeywell', 'ge', 'siemens', 'abb', 'emerson', 'caterpillar', 'john deere',
  'bechtel', 'fluor', 'kiewit', 'jacobs', 'aecom', 'hdr', 'burns mcdonnell',
  // bio / pharma / health
  'illumina', 'thermo fisher', 'pacific biosciences', 'oxford nanopore', '10x genomics',
  'pfizer', 'merck', 'moderna', 'genentech', 'amgen', 'regeneron', 'novartis',
  'astrazeneca', 'johnson johnson', 'abbott', 'medtronic', 'bd', 'baxter',
  // labs / government
  'sandia', 'los alamos', 'lawrence livermore', 'oak ridge', 'argonne', 'nasa', 'jpl',
  'nsa', 'mitre', 'aerospace corporation', 'idaho national laboratory',
  // retail / other large recruiters
  'walmart', 'target', 'heb', 'h e b', 'pepsico', 'frito lay', 'general mills',
  'procter gamble', 'unilever', 'usaa', 'state farm', 'geico', 'aig',
];

/** Recruiting-shaped language. Any hit routes an event to Companies. */
const RECRUITING_TERMS: readonly string[] = [
  'info session', 'information session', 'infosession', 'tech talk', 'techtalk',
  'career fair', 'careerfair', 'job fair', 'recruiting', 'recruitment', 'recruiter',
  'employer', 'hiring', 'internship', 'internships', 'co op', 'coop',
  'networking night', 'industry night', 'corporate', 'company visit', 'on campus interview',
  'meet the firms', 'mock interview', 'resume review', 'career expo', 'office hours with',
];

const SPORTS_TERMS: readonly string[] = [
  'football', 'basketball', 'baseball', 'softball', 'soccer', 'volleyball', 'tennis',
  'golf', 'track and field', 'cross country', 'swimming', 'diving', 'equestrian',
  'gymnastics', 'wrestling', 'aggies vs', 'vs texas', 'game day', 'kyle field',
  'reed arena', 'olsen field', 'intramural', 'intramurals', 'club sports',
  'spikeball', 'roundnet', 'badminton', 'flag football', 'pickleball',
  'ultimate frisbee', 'sand volleyball', 'dodgeball',
];

const EXPLICIT_INTRAMURAL_TERMS: readonly string[] = [
  'intramural', 'intramurals', 'intramural sports',
];

const INTRAMURAL_ACTIVITY_TERMS: readonly string[] = [
  'spikeball', 'roundnet', 'badminton', 'flag football', 'pickleball',
  'ultimate frisbee', 'sand volleyball', 'dodgeball', 'battleship',
  'basketball', 'soccer', 'softball', 'volleyball', 'cornhole', 'kickball',
];

const INTRAMURAL_EVENT_TERMS: readonly string[] = [
  'tournament', 'registration', 'register', 'league',
  'free agent', 'captains meeting', 'captain meeting', 'orientation', 'playoffs',
  'championship', 'competition', 'challenge', 'officials training',
];

const RESEARCH_TERMS: readonly string[] = [
  'seminar', 'colloquium', 'symposium', 'research', 'dissertation', 'thesis defense',
  'defense', 'lecture series', 'distinguished lecture', 'guest lecture', 'journal club',
  'poster session', 'lab tour',
];

const ACADEMIC_TERMS: readonly string[] = [
  'workshop', 'training', 'bootcamp', 'short course', 'tutorial', 'advising',
  'orientation', 'registration', 'exam', 'review session', 'study abroad',
  'graduate school', 'grad school', 'thesis', 'writing', 'library', 'hprc',
  'high performance computing', 'software carpentry', 'data science',
];

const DEADLINE_TERMS: readonly string[] = [
  'deadline', 'due date', 'applications due', 'apply by', 'last day to',
  'closes', 'closing', 'submission deadline', 'priority date', 'final day',
  'scholarship', 'fellowship application', 'call for', 'nominations',
];

const CLUB_TERMS: readonly string[] = [
  'club', 'student organization', 'org fair', 'msc', 'general meeting', 'gbm',
  'interest meeting', 'callout', 'social', 'mixer', 'game night', 'movie night',
  'intramurals', 'greek', 'fraternity', 'sorority', 'residence life', 'howdy week',
];

/**
 * Groups whose events are, by ownership, a given category.
 *
 * Matched as a case-insensitive substring of `group_title`, so
 * 'College of Engineering - Computer Science and Engineering' matches
 * 'college of engineering'.
 */
const GROUP_CATEGORY: readonly { match: string; category: CampusCategory }[] = [
  { match: 'aggie athletics', category: 'sports' },
  { match: 'rec sports', category: 'sports' },
  { match: 'career center', category: 'companies' },
  { match: 'msc ', category: 'clubs' },
  { match: 'student activities', category: 'clubs' },
  { match: 'residence life', category: 'clubs' },
  { match: 'corps of cadets', category: 'clubs' },
  { match: 'kamu', category: 'community' },
  { match: 'office of undergraduate research', category: 'research' },
  { match: 'graduate and professional school', category: 'academic' },
  { match: 'high performance research computing', category: 'academic' },
];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function hasAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystack.includes(` ${term} `));
}

/** Whether a published listing belongs in the dedicated Intramurals filter. */
export function isIntramuralListing(
  title: string,
  description: string,
  organizer: string | null,
  tags: readonly string[] = [],
): boolean {
  const haystack = normalize(`${title} ${description}`);
  const isConcreteEvent = hasAny(haystack, INTRAMURAL_EVENT_TERMS);

  // The word "intramural" also appears in jobs and Play Pass promotions.
  // Keep this tab scoped to a concrete registration, league, tournament, or
  // scheduled program instead of treating every mention as an event.
  if (hasAny(haystack, EXPLICIT_INTRAMURAL_TERMS)) return isConcreteEvent;

  // A sport name alone is not an intramural signal: a Badminton Club social,
  // a Spikeball club tournament, and a pickleball meet-and-greet belong in
  // Sports/Clubs. Without the explicit word "intramural", require Rec Sports
  // ownership plus concrete league/registration/competition language.
  const recSports = (organizer ?? '').toLowerCase().includes('rec sports');
  if (!recSports || !isConcreteEvent) return false;

  // The university calendar uses the exact short tag `IM` for some official
  // listings. Restrict it to Rec Sports so the common word "I'm" can never
  // become a match after punctuation normalization.
  const tagged = tags.some((tag) => tag.trim().toLowerCase() === 'im');
  return tagged || hasAny(haystack, INTRAMURAL_ACTIVITY_TERMS);
}

export interface ClassifyInput {
  title: string;
  description: string;
  group: string | null;
  eventTypes: readonly string[];
}

/**
 * Named employers in the text.
 *
 * Matched against the curated list only. Short entries ('ti', 'bp', 'ge',
 * 'ey', 'bd', 'hp') are real recruiters but also common words or initials, so
 * the space-padded normalization is what keeps 'ge' from matching inside
 * 'general' and tagging half the calendar as a General Electric event.
 */
export function extractCompanies(title: string, description: string): string[] {
  const haystack = normalize(`${title} ${description}`);
  const found: string[] = [];
  for (const company of COMPANIES) {
    if (haystack.includes(` ${company} `)) found.push(company);
  }
  // Longest match wins within an overlapping pair ('exxonmobil' beats 'exxon').
  const filtered = found.filter(
    (company) => !found.some((other) => other !== company && other.includes(company)),
  );
  return [...new Set(filtered)].slice(0, 5);
}

/**
 * Assign a category. ORDER IS THE POLICY.
 *
 * Sports and companies - the two tabs a user opens on purpose - then
 * deadlines, then the softer academic/research/club buckets.
 */
export function classify(input: ClassifyInput): CampusCategory {
  const haystack = normalize(`${input.title} ${input.description}`);
  const group = (input.group ?? '').toLowerCase();
  const types = normalize(input.eventTypes.join(' '));

  // Athletics is owner-determined and beats everything: a "Career Night" run
  // by Aggie Athletics is still a sports event on the calendar.
  if (group.includes('aggie athletics') || types.includes(' athletics ')) return 'sports';

  // A named employer is the strongest possible Companies signal.
  if (extractCompanies(input.title, input.description).length > 0) return 'companies';
  if (hasAny(haystack, RECRUITING_TERMS)) return 'companies';

  if (hasAny(haystack, SPORTS_TERMS)) return 'sports';

  // Deadlines before the general buckets - "Scholarship applications due" is a
  // deadline first and an academic item second.
  if (hasAny(haystack, DEADLINE_TERMS)) return 'deadline';

  if (hasAny(haystack, RESEARCH_TERMS)) return 'research';

  for (const rule of GROUP_CATEGORY) {
    if (group.includes(rule.match)) return rule.category;
  }

  if (hasAny(haystack, ACADEMIC_TERMS)) return 'academic';
  if (hasAny(haystack, CLUB_TERMS)) return 'clubs';

  return 'community';
}

/** Category labels, used for tab headings and chips. */
export const CATEGORY_LABELS: Record<CampusCategory, string> = {
  companies: 'Companies',
  sports: 'Sports',
  clubs: 'Clubs',
  research: 'Research Events',
  academic: 'Campus',
  deadline: 'Deadlines',
  community: 'B/CS',
};
