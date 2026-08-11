/**
 * Text normalization and similarity.
 *
 * Every upstream hands Radar dirty text and each is dirty differently:
 *
 *   Europe PMC   titles carry inline markup - `Within-host diversity of
 *                <i>Mycobacterium tuberculosis</i> : weak host association`
 *                including a space before the colon once the tag is gone.
 *   Europe PMC   abstracts use `<h4>Background</h4>` as section headers, so
 *                naive tag-stripping welds "BackgroundWithin host..." together.
 *   LiveWhale    descriptions are HTML with `<br />` and `&amp;` entities.
 *   Crossref     titles arrive as a one-element array.
 *   arXiv        summaries are hard-wrapped at ~80 columns with real newlines.
 *
 * So: strip to plain text ONCE, at the connector boundary, and let everything
 * downstream assume plain text. Nothing below this line should ever see a tag.
 */

// ---------------------------------------------------------------------------
// HTML -> text
// ---------------------------------------------------------------------------

/** The entities that actually show up in these feeds, plus numeric forms. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  middot: '·',
  bull: '•',
  deg: '°',
  times: '×',
  minus: '−',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  omega: 'ω',
  micro: 'µ',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  reg: '®',
  copy: '©',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Reject non-characters and anything outside the Unicode range rather
      // than throwing from String.fromCodePoint on malformed input.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * HTML -> single-line plain text.
 *
 * Block-level tags become spaces rather than vanishing, which is what keeps
 * Europe PMC's `<h4>Background</h4>Within host...` from becoming one word.
 * `<script>`/`<style>` bodies are dropped entirely.
 */
export function htmlToText(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  const withoutScripts = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Block boundaries first, so words on either side stay separated.
  const spaced = withoutScripts
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/?\s*(p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi, ' ');

  const stripped = spaced.replace(/<[^>]*>/g, '');

  return collapse(decodeEntities(stripped));
}

/** Collapse all whitespace runs (including newlines) to single spaces, trim. */
export function collapse(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Tidy punctuation that tag-stripping leaves stranded.
 *
 * `<i>M. tuberculosis</i> : weak` becomes `M. tuberculosis : weak`; this pulls
 * the orphaned colon back onto the preceding word. Cosmetic, but these strings
 * are the product's headlines.
 */
export function tidyPunctuation(input: string): string {
  return collapse(input)
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');
}

/** Clamp to a length on a word boundary, appending an ellipsis when cut. */
export function clamp(input: string, max: number): string {
  const text = collapse(input);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Stop words. Deliberately short: this is a domain corpus, and aggressive
 * stopping throws away signal ("host", "new", "high" all matter here).
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'their', 'they', 'this', 'to', 'was', 'were', 'which', 'with', 'we',
  'our', 'using', 'used', 'can', 'may', 'these', 'those', 'than', 'then',
]);

/**
 * Lowercase, strip diacritics, split on non-alphanumerics.
 *
 * Hyphens and slashes split (`host-pathogen` -> `host`, `pathogen`) so that a
 * profile term written either way still matches. Numbers are kept: `dN/dS`
 * survives as `dn`,`ds`, and `M1` in a room name matters.
 */
export function tokenize(input: string): string[] {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // Single-character tokens are dropped as noise EXCEPT digits. That
    // exception is load-bearing: without it "Engineering Career Fair - Day 1"
    // and "... Day 2" tokenize identically, score 1.0 on similarity, and the
    // deduper folds a two-day career fair into one card - silently deleting a
    // day. Single letters stay filtered; they are almost always initials.
    .filter((t) => (t.length > 1 || /^[0-9]$/.test(t)) && !STOP_WORDS.has(t));
}

/** Adjacent token pairs. Phrase-ish matching without a real phrase index. */
export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** |A n B| / |A u B|. Empty-vs-empty is 0, not 1 - two blanks are not a match. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const value of setA) if (setB.has(value)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Title similarity in [0,1], tuned for dedupe.
 *
 * Unigram Jaccard alone says "Google Tech Talk" and "Google Info Talk" are 0.5
 * - too close for comfort when the decision is whether to merge two cards.
 * Blending in bigram overlap punishes reorderings and substitutions, which is
 * exactly the failure mode that matters. Weighted 60/40 toward unigrams so
 * short titles (2-3 words, no bigrams to speak of) still score sensibly.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const uni = jaccard(tokensA, tokensB);
  const bi = jaccard(bigrams(tokensA), bigrams(tokensB));
  return uni * 0.6 + bi * 0.4;
}

/**
 * Canonical form of a title, for exact-match bucketing before fuzzy compare.
 *
 * Drops a leading ordinal/registration prefix that campus feeds love
 * ("2026 Fall Career Fair" vs "Fall Career Fair") and normalizes ampersands.
 */
export function canonicalTitle(input: string): string {
  return tokenize(
    collapse(input)
      .replace(/&/g, ' and ')
      .replace(/^\s*(19|20)\d{2}\s+/, '')
      .replace(/\bv\d+\b/gi, ' '),
  ).join(' ');
}

// ---------------------------------------------------------------------------
// Identifier normalization
// ---------------------------------------------------------------------------

/**
 * Reduce a DOI to a comparable form.
 *
 * DOIs arrive as bare (`10.1038/ng.2747`), as URLs (OpenAlex:
 * `https://doi.org/10.1038/ng.2747`), and with mixed case. The DOI handbook
 * makes them case-insensitive for ASCII, so lowercasing is safe and is what
 * makes cross-source matching work at all.
 */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  const stripped = trimmed
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/^info:doi\//, '');

  // A DOI is `10.<registrant>/<suffix>`. Anything else is not one, and
  // bioRxiv's literal "NA" for "not yet published" must not become an id.
  return /^10\.\d{4,9}\/\S+$/.test(stripped) ? stripped : null;
}

/** OpenAlex ids arrive as full URLs; the bare `W2110150994` is the useful part. */
export function normalizeOpenAlexId(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const match = /([WASIPCFT]\d{4,})\s*$/.exec(input.trim());
  return match?.[1] ?? null;
}

/**
 * arXiv ids: strip the URL and any trailing version.
 * `http://arxiv.org/abs/2401.01234v2` -> `2401.01234`
 */
export function normalizeArxivId(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input.trim().replace(/^https?:\/\/arxiv\.org\/abs\//i, '');
  const match = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.exec(stripped);
  return match?.[1] ?? null;
}

/** Version suffix on an arXiv/bioRxiv id, e.g. `v2` -> 2. */
export function versionOf(input: string | null | undefined): number | null {
  if (typeof input !== 'string') return null;
  const match = /v(\d+)\s*$/i.exec(input.trim());
  if (match?.[1] === undefined) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Parse the date shapes these feeds actually emit into an ISO string.
 *
 * Handles: ISO 8601, `YYYY-MM-DD`, unix seconds (LiveWhale `last_modified`),
 * unix milliseconds, PubMed's `2024 Mar 15` / `2024 Mar` / `2024`, and
 * Crossref's `date-parts` `[[2024,3,15]]`.
 *
 * Returns null rather than guessing. A wrong date is worse than no date here:
 * ranking rewards recency, so a bad parse promotes garbage to the top.
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic split: anything below 1e11 is seconds (that boundary is the
    // year 5138 in seconds and 1973 in milliseconds, so no real feed straddles it).
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (Array.isArray(value)) {
    // Crossref `date-parts`: [[2024, 3, 15]] or [[2024]].
    const parts = (Array.isArray(value[0]) ? value[0] : value).filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n),
    );
    if (parts.length === 0) return null;
    const [year, month = 1, day = 1] = parts;
    if (year === undefined || year < 1000 || year > 3000) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text === 'NA' || text === 'null') return null;

  // Pure numeric string = epoch. LiveWhale sends `last_modified` this way.
  if (/^\d{9,13}$/.test(text)) return toIso(Number.parseInt(text, 10));

  /*
   * A bare datetime with NO timezone is UTC, not local.
   *
   * This is not a nicety - it was a real bug. WordPress (Aggie Research
   * Volunteers) returns `date` as `2025-02-17T15:53:22` with no zone, and
   * `new Date()` parses that as LOCAL time per the spec. The same input then
   * produced different output on different machines: 62 items came out seven
   * hours apart between a laptop in US Central and a CI runner in UTC, which
   * flipped them all to "Updated" on every alternation and quietly broke the
   * promise that two runs over unchanged data produce identical output.
   *
   * Strings that DO carry a zone (LiveWhale's `2026-08-10T08:00:00-05:00`,
   * anything ending in Z) do not match this and are left alone.
   */
  const bareDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
  if (bareDateTime.test(text)) return toIso(`${text.replace(' ', 'T')}Z`);

  // `2024 Mar 15`, `2024 Mar`, `2024` - PubMed's esummary `pubdate`.
  const pubmed = /^(\d{4})(?:\s+([A-Za-z]{3,9}))?(?:\s+(\d{1,2}))?/.exec(text);
  if (pubmed?.[1] !== undefined && !text.includes('-') && !text.includes('/')) {
    const year = Number.parseInt(pubmed[1], 10);
    const monthName = pubmed[2];
    const month =
      monthName === undefined
        ? 0
        : [
            'jan', 'feb', 'mar', 'apr', 'may', 'jun',
            'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
          ].indexOf(monthName.slice(0, 3).toLowerCase());
    if (year >= 1000 && year <= 3000 && month >= 0) {
      const day = pubmed[3] === undefined ? 1 : Number.parseInt(pubmed[3], 10);
      const date = new Date(Date.UTC(year, month, Number.isFinite(day) ? day : 1));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject dates outside a plausible window - a mis-parse usually lands in
  // 1970 or the year 30000, and both would poison recency scoring.
  const year = parsed.getUTCFullYear();
  return year >= 1900 && year <= 2200 ? parsed.toISOString() : null;
}

/** Whole days between two ISO timestamps. Negative when `then` is in the future. */
export function daysBetween(then: string | null, now: string): number | null {
  if (then === null) return null;
  const a = Date.parse(then);
  const b = Date.parse(now);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The timezone every date on this site is reasoned and rendered in.
 *
 * Campus events are in College Station and the literature feed is read by
 * someone there, so "today" means today in Central time, not in UTC.
 */
export const DISPLAY_TZ = 'America/Chicago';

/** Civil date (`YYYY-MM-DD`) of an instant, in the display timezone. */
export function civilDate(iso: string, timeZone: string = DISPLAY_TZ): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // 'en-CA' formats as YYYY-MM-DD, which sorts and parses cleanly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * CALENDAR days from `now` until `then`. 0 = today, 1 = tomorrow, -1 = yesterday.
 *
 * Deliberately different from `daysBetween`, which counts elapsed 24-hour
 * periods. Two reasons this one exists:
 *
 *   1. IT IS WHAT THE WORDS MEAN. An event at 9am tomorrow is "tomorrow" even
 *      when it is 26 hours away, and an event tonight is "today" even when it
 *      is 30 minutes away. Elapsed-hours arithmetic gets both wrong.
 *
 *   2. IT IS STABLE WITHIN A DAY. Elapsed-hours thresholds are crossed at
 *      whatever time of day each event happens to start, and campus events
 *      cluster at round times - so a dozen of them flip bands together at
 *      9:00am. Measured: 12 items changed relevance between two ingests three
 *      minutes apart, which made the snapshot differ for no reason a reader
 *      would recognise. Calendar days change once, at midnight.
 */
export function calendarDaysUntil(then: string | null, now: string, timeZone: string = DISPLAY_TZ): number | null {
  if (then === null) return null;
  const thenDate = civilDate(then, timeZone);
  const nowDate = civilDate(now, timeZone);
  if (thenDate === null || nowDate === null) return null;

  // Both are civil dates with no time component, so comparing them as UTC
  // midnights is exact - no DST arithmetic involved.
  const a = Date.parse(`${thenDate}T00:00:00.000Z`);
  const b = Date.parse(`${nowDate}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * Remove email addresses from text bound for the published site.
 *
 * NOT cosmetic. `calendar.tamu.edu` publishes `registration_owner_email` on
 * every event with registration, and event descriptions routinely paste
 * coordinator addresses inline. Radar deploys publicly to GitHub Pages, so
 * shipping those would republish staff addresses as scrapeable plaintext for
 * no product benefit. Applied in `normalize.ts` to every text field, and
 * enforced again on `dist/` by the CI email guard.
 */
export function stripEmails(input: string): string {
  return collapse(input.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]'));
}
