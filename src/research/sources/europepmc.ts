/**
 * Europe PMC - Radar's primary literature source.
 *
 * Chosen as primary over PubMed for one decisive reason: it returns the
 * ABSTRACT in the search response. PubMed's `esummary` does not (verified
 * against a live response - the record has 40+ fields and none of them is the
 * abstract), so a PubMed-first design would either rank on titles alone or
 * need a second efetch round trip per batch. Europe PMC also indexes preprint
 * servers alongside journal content (`source: 'PPR'`), which means one query
 * covers both halves of the feed.
 *
 * Paging uses `cursorMark`, not `page`. Deep paging with offsets is unstable
 * on a corpus this size - records shift between requests and you silently get
 * duplicates and gaps. The cursor is the documented way through.
 *
 * API: https://europepmc.org/RestfulWebService
 */

import type { Logger, RawItem, SourceResult, WorkKind } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { htmlToText, normalizeDoi, toIso } from '@/core/text.ts';

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/** Records per request. 100 is the documented maximum. */
const PAGE_SIZE = 100;

/**
 * Hard ceiling on records per query.
 *
 * Lowered from 300 after a first live run returned exactly 300 for all seven
 * queries - i.e. every query was truncated by the cap, not exhausted. That is
 * the signature of unbounded history being pulled: `hitCount` for the first
 * query alone is 2416, spanning two decades. Date-bounding (below) is the
 * actual fix; this now just bounds a pathological week.
 */
const MAX_PER_QUERY = 150;

// ---------------------------------------------------------------------------
// Upstream shapes (only the fields Radar reads)
// ---------------------------------------------------------------------------

interface EpmcAuthor {
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

interface EpmcFullTextUrl {
  availability?: string;
  /** 'OA' = open access, 'S' = subscription, 'F' = free. */
  availabilityCode?: string;
  documentStyle?: string;
  url?: string;
}

interface EpmcResult {
  id?: string;
  /** 'MED' journal article, 'PPR' preprint, 'PMC' full text. */
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: EpmcAuthor[] };
  journalInfo?: { journal?: { title?: string } };
  pubYear?: string;
  firstPublicationDate?: string;
  electronicPublicationDate?: string;
  abstractText?: string;
  /** 'Y' or 'N' - a string, not a boolean. */
  isOpenAccess?: string;
  citedByCount?: number;
  pubTypeList?: { pubType?: string[] };
  keywordList?: { keyword?: string[] };
  meshHeadingList?: { meshHeading?: { descriptorName?: string }[] };
  fullTextUrlList?: { fullTextUrl?: EpmcFullTextUrl[] };
}

interface EpmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: EpmcResult[] };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Landing page. Europe PMC's own view is stable and always resolvable. */
function landingUrl(record: EpmcResult): string | null {
  const source = record.source ?? 'MED';
  const id = record.id;
  if (typeof id === 'string' && id.length > 0) {
    return `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  }
  const doi = normalizeDoi(record.doi);
  return doi === null ? null : `https://doi.org/${doi}`;
}

/**
 * Open-access full text, only when the upstream declares it.
 *
 * `availabilityCode === 'OA'` is the only value that means "this is legitimately
 * free to read". 'F' means free-to-read at the publisher, 'S' means paywalled.
 * Radar never guesses at a PDF URL; linking someone to a paywall as "open
 * access" is worse than not offering the link.
 */
function openAccessUrl(record: EpmcResult): string | null {
  const urls = record.fullTextUrlList?.fullTextUrl ?? [];
  const pdf = urls.find((u) => u.availabilityCode === 'OA' && u.documentStyle === 'pdf');
  if (typeof pdf?.url === 'string') return pdf.url;
  const html = urls.find((u) => u.availabilityCode === 'OA');
  return typeof html?.url === 'string' ? html.url : null;
}

function authorsOf(record: EpmcResult): { name: string; orcid: null; affiliation: null }[] {
  const list = record.authorList?.author ?? [];
  if (list.length > 0) {
    return list
      .map((a) => a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(' '))
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
      .map((name) => ({ name, orcid: null, affiliation: null }));
  }
  // `authorString` is a comma-separated fallback, e.g. "Séraphin MN, Afriyie-Mensah JS."
  return (record.authorString ?? '')
    .split(',')
    .map((name) => name.replace(/\.$/, '').trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name, orcid: null, affiliation: null }));
}

function kindOf(record: EpmcResult): WorkKind {
  if (record.source === 'PPR') return 'preprint';
  const types = (record.pubTypeList?.pubType ?? []).map((t) => t.toLowerCase());
  if (types.includes('review')) return 'review';
  return 'journal-article';
}

export function mapRecord(record: EpmcResult, query: string): RawItem | null {
  const title = htmlToText(record.title);
  const url = landingUrl(record);
  if (title.length === 0 || url === null) return null;

  const doi = normalizeDoi(record.doi);
  const pmid = typeof record.pmid === 'string' && record.pmid.length > 0 ? record.pmid : null;
  const pmcid = typeof record.pmcid === 'string' && record.pmcid.length > 0 ? record.pmcid : null;

  const identity: string[] = [];
  if (doi !== null) identity.push(`doi:${doi}`);
  if (pmid !== null) identity.push(`pmid:${pmid}`);
  if (pmcid !== null) identity.push(`pmcid:${pmcid.toLowerCase()}`);

  const abstract = htmlToText(record.abstractText);
  const publishedDate =
    toIso(record.firstPublicationDate) ??
    toIso(record.electronicPublicationDate) ??
    toIso(record.pubYear);

  const keywords = record.keywordList?.keyword ?? [];
  const mesh = (record.meshHeadingList?.meshHeading ?? [])
    .map((m) => m.descriptorName)
    .filter((v): v is string => typeof v === 'string');

  return {
    vertical: 'research',
    source: 'europepmc',
    externalId: record.id ?? doi ?? pmid ?? title.slice(0, 64),
    channel: query,
    url,
    title,
    summary: abstract,
    occurredAt: publishedDate,
    endsAt: null,
    lastModified: null,
    tags: [...keywords, ...mesh].slice(0, 12),
    identity,
    research: {
      doi,
      pmid,
      pmcid,
      arxivId: null,
      openAlexId: null,
      kind: kindOf(record),
      journal: record.journalInfo?.journal?.title ?? null,
      authors: authorsOf(record),
      abstract,
      publishedDate,
      citedByCount: typeof record.citedByCount === 'number' ? record.citedByCount : null,
      isOpenAccess: record.isOpenAccess === 'Y',
      openAccessUrl: openAccessUrl(record),
      topics: mesh.slice(0, 8),
      citesTracked: [],
      lifecycle: {
        preprintVersion: record.source === 'PPR' ? 1 : null,
        publishedDoi: null,
        publishedIn: null,
        isSuperseded: false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface EuropePmcOptions extends RequestOptions {
  queries?: readonly string[];
  maxPerQuery?: number;
  /**
   * Only records first published on/after this `YYYY-MM-DD`.
   *
   * Radar is a discovery tool - "what came out since last week" - so an
   * unbounded query is the wrong shape regardless of how it is sorted. Without
   * this, every query returns its 150 most recent hits from a corpus going
   * back twenty years, and a quiet week silently backfills with old work that
   * the user has already seen or dismissed.
   */
  fromDate?: string;
  log?: Logger;
}

/**
 * Add a publication-date bound to a query.
 *
 * `FIRST_PDATE` is Europe PMC's first-publication date field and takes an
 * inclusive range. The open upper bound uses a far-future date rather than
 * today's, so records dated slightly ahead (journals do post "next issue")
 * are not silently excluded.
 */
export function withDateBound(query: string, fromDate: string | undefined): string {
  if (fromDate === undefined) return query;
  return `(${query}) AND (FIRST_PDATE:[${fromDate} TO 2100-01-01])`;
}

/**
 * Run every profile query and return the union.
 *
 * Never throws. A failing query is logged and skipped so one bad query string
 * cannot take out the whole research feed.
 */
export async function fetchEuropePmc(options: EuropePmcOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const queries = options.queries ?? [];
  const maxPerQuery = options.maxPerQuery ?? MAX_PER_QUERY;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  let failures = 0;

  for (const query of queries) {
    let cursorMark = '*';
    let collected = 0;

    try {
      while (collected < maxPerQuery) {
        const url = buildUrl(ENDPOINT, {
          query: withDateBound(query, options.fromDate),
          format: 'json',
          resultType: 'core',
          pageSize: Math.min(PAGE_SIZE, maxPerQuery - collected),
          cursorMark,
          // Newest first. Radar is a discovery tool; a 2004 paper that happens
          // to rank well is not what "what came out this week" means.
          sort: 'P_PDATE_D desc',
        });

        const { data } = await getJson<EpmcResponse>(url, options);
        const page = data.resultList?.result ?? [];
        if (page.length === 0) break;

        for (const record of page) {
          const mapped = mapRecord(record, query);
          if (mapped !== null) records.push(mapped);
        }
        collected += page.length;

        const next = data.nextCursorMark;
        // A cursor that stops advancing means the end of the result set;
        // continuing would loop forever on the last page.
        if (typeof next !== 'string' || next === cursorMark) break;
        cursorMark = next;
      }

      log.info(`[europepmc] "${query.slice(0, 48)}" -> ${collected} record(s)`);
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`query failed (${query.slice(0, 48)}): ${message}`);
      log.warn(`[europepmc] query FAILED "${query.slice(0, 48)}": ${message}`);
    }
  }

  const allFailed = queries.length > 0 && failures === queries.length;

  return {
    source: 'europepmc',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${failures} quer(ies) failed` : null,
    durationMs: Date.now() - startedAt,
  };
}
