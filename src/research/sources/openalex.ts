/**
 * OpenAlex - the graph layer.
 *
 * The other literature sources answer "what came out?". OpenAlex is what lets
 * Radar answer "why should you care?", because it ships the edges:
 *
 *   referenced_works[]  what this paper cites -> "cites 3 papers you saved"
 *   authorships[]       authors with ORCIDs   -> author/lab watchlists
 *   topics[]            classified concepts   -> topic proximity
 *
 * Those three fields are the input to the reasons that make the ranking
 * explainable, and no other free API supplies all three together.
 *
 * TWO UPSTREAM QUIRKS, both verified against a live response:
 *
 *   1. Abstracts arrive as `abstract_inverted_index` - a {word: [positions]}
 *      map, not a string - and must be reconstructed. See `reconstructAbstract`.
 *   2. `sort=publication_date:desc` alone returns junk (a Zenodo
 *      pre-registration outranking real work). OpenAlex's own relevance is
 *      more useful as a pre-filter, and Radar's profile scorer does the real
 *      cutting afterwards.
 *
 * API: https://developers.openalex.org/
 */

import type { Logger, RawItem, SourceResult, WorkKind } from '@/types.ts';
import { buildUrl, consoleLogger, contactEmail, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { collapse, htmlToText, normalizeDoi, normalizeOpenAlexId, toIso } from '@/core/text.ts';

const ENDPOINT = 'https://api.openalex.org/works';

const PAGE_SIZE = 50;
const MAX_PER_QUERY = 150;

interface OpenAlexAuthorship {
  author?: { id?: string; display_name?: string; orcid?: string | null };
  institutions?: { display_name?: string }[];
  raw_affiliation_strings?: string[];
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_date?: string;
  publication_year?: number;
  type?: string;
  cited_by_count?: number;
  /** Front matter, errata, indexes - not research. */
  is_paratext?: boolean;
  is_retracted?: boolean;
  ids?: { pmid?: string; pmcid?: string; doi?: string };
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null };
  primary_location?: { source?: { display_name?: string | null } | null; landing_page_url?: string | null };
  authorships?: OpenAlexAuthorship[];
  topics?: { display_name?: string }[];
  referenced_works?: string[];
  /** Genuinely null for works with no abstract, not merely absent. */
  abstract_inverted_index?: Record<string, number[]> | null;
}

interface OpenAlexResponse {
  meta?: { count?: number; next_cursor?: string | null };
  results?: OpenAlexWork[];
}

/**
 * Rebuild prose from OpenAlex's inverted index.
 *
 * The index maps each word to every position it occupies, so the abstract is
 * recovered by scattering words into a sparse array and joining. Bounded at
 * 4000 positions: a malformed index with an enormous position would otherwise
 * allocate an array of that size.
 */
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  // `null`, not just `undefined`. OpenAlex genuinely returns
  // `"abstract_inverted_index": null` for works without an abstract, and
  // `Object.entries(null)` throws "Cannot convert undefined or null to object"
  // - which took out three of six queries on the first live run.
  if (index === null || index === undefined) return '';

  const slots: string[] = [];
  let maxPosition = 0;

  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position > 4000) continue;
      slots[position] = word;
      if (position > maxPosition) maxPosition = position;
    }
  }

  if (maxPosition === 0 && slots.length === 0) return '';
  // Gaps are real when the index is truncated; filtering keeps them from
  // becoming double spaces.
  return collapse(slots.slice(0, maxPosition + 1).filter((w) => typeof w === 'string').join(' '));
}

function kindOf(type: string | undefined): WorkKind {
  switch (type) {
    case 'preprint':
      return 'preprint';
    case 'review':
      return 'review';
    case 'dataset':
      return 'dataset';
    case 'article':
      return 'journal-article';
    default:
      return 'other';
  }
}

/**
 * Work types worth surfacing as literature.
 *
 * OpenAlex indexes far more than papers, and the excluded types are not
 * hypothetical noise - a live run surfaced Zenodo code deposits at the top of
 * the feed ("amesclir/carex-speciation-genomics: code for...", "g4 paradox v2
 * reproducibility package"). Each new version of a deposit gets its own DOI,
 * so they are correctly NOT deduped against each other and pile up as
 * near-identical cards. They are useful artifacts and they are not reading.
 */
const INCLUDED_TYPES = new Set(['article', 'preprint', 'review', 'book-chapter', 'book', 'dissertation']);

export function mapWork(work: OpenAlexWork, query: string): RawItem | null {
  const title = htmlToText(work.title ?? work.display_name ?? '');
  const openAlexId = normalizeOpenAlexId(work.id);
  if (title.length === 0 || openAlexId === null) return null;

  // Paratext is front matter, indexes, and errata - metadata about a journal
  // rather than research in it.
  if (work.is_paratext === true) return null;
  if (work.type !== undefined && !INCLUDED_TYPES.has(work.type)) return null;

  const doi = normalizeDoi(work.doi ?? work.ids?.doi ?? null);
  // OpenAlex reports PMIDs as full URLs: https://pubmed.ncbi.nlm.nih.gov/12345
  const pmid = /(\d+)\s*$/.exec(work.ids?.pmid ?? '')?.[1] ?? null;
  const pmcid = work.ids?.pmcid ?? null;

  const identity = [`openalex:${openAlexId.toLowerCase()}`];
  if (doi !== null) identity.push(`doi:${doi}`);
  if (pmid !== null) identity.push(`pmid:${pmid}`);

  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const publishedDate = toIso(work.publication_date) ?? toIso(work.publication_year);

  const authors = (work.authorships ?? [])
    .map((authorship) => ({
      name: authorship.author?.display_name ?? '',
      orcid: authorship.author?.orcid ?? null,
      affiliation:
        authorship.institutions?.[0]?.display_name ?? authorship.raw_affiliation_strings?.[0] ?? null,
    }))
    .filter((a) => a.name.length > 0);

  const topics = (work.topics ?? [])
    .map((t) => t.display_name)
    .filter((t): t is string => typeof t === 'string');

  const url =
    work.primary_location?.landing_page_url ??
    (doi === null ? `https://openalex.org/${openAlexId}` : `https://doi.org/${doi}`);

  // Referenced works are OpenAlex ids; kept in that namespace so the
  // "cites something you saved" check is an id-set intersection, not a join.
  const references = (work.referenced_works ?? [])
    .map((ref) => normalizeOpenAlexId(ref))
    .filter((ref): ref is string => ref !== null)
    .slice(0, 200);

  return {
    vertical: 'research',
    source: 'openalex',
    externalId: openAlexId,
    channel: query,
    url,
    title,
    summary: abstract,
    occurredAt: publishedDate,
    endsAt: null,
    lastModified: null,
    tags: topics.slice(0, 8),
    identity,
    research: {
      doi,
      pmid,
      pmcid,
      arxivId: null,
      openAlexId,
      kind: kindOf(work.type),
      journal: work.primary_location?.source?.display_name ?? null,
      authors,
      abstract,
      publishedDate,
      citedByCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : null,
      isOpenAccess: work.open_access?.is_oa === true,
      openAccessUrl: work.best_oa_location?.pdf_url ?? work.open_access?.oa_url ?? null,
      topics: topics.slice(0, 8),
      // Filled in by `citation-graph.ts` once the user's tracked set is known.
      citesTracked: references,
      lifecycle: { preprintVersion: null, publishedDoi: null, publishedIn: null, isSuperseded: false },
    },
  };
}

export interface OpenAlexOptions extends RequestOptions {
  queries?: readonly string[];
  maxPerQuery?: number;
  /** Only works published on/after this `YYYY-MM-DD`. */
  fromDate?: string;
  log?: Logger;
}

export async function fetchOpenAlex(options: OpenAlexOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const queries = options.queries ?? [];
  const maxPerQuery = options.maxPerQuery ?? MAX_PER_QUERY;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  const mailto = contactEmail();
  let failures = 0;

  for (const query of queries) {
    try {
      let cursor = '*';
      let collected = 0;

      while (collected < maxPerQuery) {
        const filters = [`title_and_abstract.search:${query}`];
        if (options.fromDate !== undefined) filters.push(`from_publication_date:${options.fromDate}`);

        const url = buildUrl(ENDPOINT, {
          filter: filters.join(','),
          'per-page': Math.min(PAGE_SIZE, maxPerQuery - collected),
          cursor,
          // The polite pool. Anonymous callers share a slower pool.
          mailto,
        });

        const { data } = await getJson<OpenAlexResponse>(url, options);
        const page = data.results ?? [];
        if (page.length === 0) break;

        for (const work of page) {
          const mapped = mapWork(work, query);
          if (mapped !== null) records.push(mapped);
        }
        collected += page.length;

        const next = data.meta?.next_cursor;
        if (typeof next !== 'string' || next.length === 0 || next === cursor) break;
        cursor = next;
      }

      log.info(`[openalex] "${query.slice(0, 48)}" -> ${collected} work(s)`);
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`query failed (${query.slice(0, 48)}): ${message}`);
      log.warn(`[openalex] query FAILED: ${message}`);
    }
  }

  const allFailed = queries.length > 0 && failures === queries.length;

  return {
    source: 'openalex',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${failures} quer(ies) failed` : null,
    durationMs: Date.now() - startedAt,
    failedRequests: failures,
  };
}
