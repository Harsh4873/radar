/**
 * PubMed, via NCBI E-utilities.
 *
 * TWO-STEP, AND THE SECOND STEP IS `efetch`, NOT `esummary`.
 *
 * The obvious pipeline is esearch -> esummary, and it is wrong here. A live
 * esummary record carries 40+ fields and none of them is the abstract. Radar
 * scores on title AND abstract, so an esummary-only PubMed would contribute
 * title-only records that systematically under-score against Europe PMC's
 * full ones and lose every dedupe tiebreak for no reason. `efetch` returns the
 * abstract in the same single request, so it is strictly better here.
 *
 * Europe PMC mirrors most of PubMed, so this source's real value is coverage
 * at the margins - records Europe PMC has not indexed yet. Anything both
 * sources return is merged by DOI/PMID in `dedupe.ts` at no cost.
 *
 * RATE LIMIT: NCBI allows 3 requests/second per IP without an API key and 10
 * with one. Enforced centrally in `src/core/http.ts` by hostname, so it holds
 * across every NCBI caller in a run rather than per connector.
 *
 * API: https://www.ncbi.nlm.nih.gov/books/NBK25497/
 */

import type { Logger, RawItem, SourceResult, WorkKind } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getJson, getText, ncbiApiKey, type RequestOptions } from '@/core/http.ts';
import { extractAll, extractOne, textOf, textsOf, stripTags } from '@/core/xml.ts';
import { collapse, decodeEntities, normalizeDoi, toIso } from '@/core/text.ts';

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

/** PMIDs per efetch call. NCBI is comfortable with a few hundred via GET. */
const FETCH_BATCH = 100;

const MAX_PER_QUERY = 100;

interface ESearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    warninglist?: { phrasesignored?: string[]; outputmessages?: string[] };
  };
}

/**
 * Pull the abstract out of a `<Abstract>` block.
 *
 * Structured abstracts split into several `<AbstractText Label="METHODS">`
 * elements. Joining the bodies without their labels loses the structure but
 * keeps the prose, which is what the scorer reads. Labels are re-attached when
 * present so the paper page shows something closer to the published form.
 */
function abstractOf(article: string): string {
  const block = extractOne(article, 'Abstract');
  if (block === null) return '';

  const parts: string[] = [];
  for (const match of block.matchAll(/<AbstractText(\s[^>]*)?>([\s\S]*?)<\/AbstractText>/g)) {
    const attrs = match[1] ?? '';
    const body = collapse(decodeEntities(stripTags(match[2] ?? '')));
    if (body.length === 0) continue;
    const label = /Label="([^"]*)"/.exec(attrs)?.[1];
    parts.push(label === undefined || label.length === 0 ? body : `${label}: ${body}`);
  }

  if (parts.length > 0) return parts.join(' ');
  return collapse(decodeEntities(stripTags(block)));
}

function authorsOf(article: string): { name: string; orcid: string | null; affiliation: null }[] {
  const list = extractOne(article, 'AuthorList');
  if (list === null) return [];

  return extractAll(list, 'Author')
    .map((author) => {
      const last = textOf(author, 'LastName');
      const fore = textOf(author, 'ForeName') ?? textOf(author, 'Initials');
      const collective = textOf(author, 'CollectiveName');
      const name =
        last !== null ? [fore, last].filter((p) => p !== null && p.length > 0).join(' ') : collective;
      if (name === null || name.length === 0) return null;
      // ORCIDs appear as <Identifier Source="ORCID">.
      const orcid = /<Identifier Source="ORCID">([\s\S]*?)<\/Identifier>/.exec(author)?.[1];
      return {
        name,
        orcid: orcid === undefined ? null : collapse(stripTags(orcid)),
        affiliation: null,
      };
    })
    .filter((a): a is { name: string; orcid: string | null; affiliation: null } => a !== null);
}

/** `<PubDate><Year>2026</Year><Month>Apr</Month><Day>13</Day></PubDate>` */
function publishedDateOf(article: string): string | null {
  const pubDate = extractOne(article, 'PubDate');
  if (pubDate !== null) {
    const year = textOf(pubDate, 'Year');
    if (year !== null) {
      const month = textOf(pubDate, 'Month') ?? '';
      const day = textOf(pubDate, 'Day') ?? '';
      const parsed = toIso(collapse(`${year} ${month} ${day}`));
      if (parsed !== null) return parsed;
    }
    // Some records only have <MedlineDate>2026 Apr-Jun</MedlineDate>.
    const medline = textOf(pubDate, 'MedlineDate');
    if (medline !== null) {
      const yearOnly = /^(\d{4})/.exec(medline)?.[1];
      if (yearOnly !== undefined) return toIso(yearOnly);
    }
  }
  return null;
}

function kindOf(article: string): WorkKind {
  const types = textsOf(article, 'PublicationType').map((t) => t.toLowerCase());
  if (types.includes('review') || types.includes('systematic review')) return 'review';
  if (types.includes('preprint')) return 'preprint';
  if (types.includes('dataset')) return 'dataset';
  return 'journal-article';
}

export function mapArticle(article: string, query: string): RawItem | null {
  const pmid = textOf(article, 'PMID');
  const title = textOf(article, 'ArticleTitle');
  if (pmid === null || pmid.length === 0 || title === null || title.length === 0) return null;

  // <ArticleId IdType="doi">10.1038/...</ArticleId>
  const doiMatch = /<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/.exec(article)?.[1];
  const doi = normalizeDoi(doiMatch === undefined ? null : collapse(stripTags(doiMatch)));
  const pmcMatch = /<ArticleId IdType="pmc">([\s\S]*?)<\/ArticleId>/.exec(article)?.[1];
  const pmcid = pmcMatch === undefined ? null : collapse(stripTags(pmcMatch));

  const identity = [`pmid:${pmid}`];
  if (doi !== null) identity.push(`doi:${doi}`);
  if (pmcid !== null && pmcid.length > 0) identity.push(`pmcid:${pmcid.toLowerCase()}`);

  const abstract = abstractOf(article);
  const journal = textOf(article, 'Title') ?? textOf(article, 'ISOAbbreviation');
  const keywords = textsOf(article, 'Keyword').slice(0, 8);
  const mesh = textsOf(article, 'DescriptorName').slice(0, 10);

  return {
    vertical: 'research',
    source: 'pubmed',
    externalId: pmid,
    channel: query,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    title,
    summary: abstract,
    occurredAt: publishedDateOf(article),
    endsAt: null,
    lastModified: null,
    tags: [...keywords, ...mesh].slice(0, 12),
    identity,
    research: {
      doi,
      pmid,
      pmcid: pmcid === null || pmcid.length === 0 ? null : pmcid,
      arxivId: null,
      openAlexId: null,
      kind: kindOf(article),
      journal,
      authors: authorsOf(article),
      abstract,
      publishedDate: publishedDateOf(article),
      citedByCount: null,
      // PMC membership is not the same as open access, so this is left false
      // and Europe PMC's explicit `isOpenAccess` supplies the truth on merge.
      isOpenAccess: false,
      openAccessUrl: null,
      topics: mesh.slice(0, 8),
      citesTracked: [],
      lifecycle: { preprintVersion: null, publishedDoi: null, publishedIn: null, isSuperseded: false },
    },
  };
}

export interface PubmedOptions extends RequestOptions {
  queries?: readonly string[];
  maxPerQuery?: number;
  /** Restrict to the last N days via PubMed's `reldate`. */
  days?: number;
  log?: Logger;
}

export async function fetchPubmed(options: PubmedOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const queries = options.queries ?? [];
  const maxPerQuery = options.maxPerQuery ?? MAX_PER_QUERY;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  const apiKey = ncbiApiKey();
  let failures = 0;

  if (apiKey === null) {
    log.info('[pubmed] no NCBI_API_KEY set - limited to 3 requests/second');
  }

  for (const query of queries) {
    try {
      const searchUrl = buildUrl(ESEARCH, {
        db: 'pubmed',
        term: query,
        retmode: 'json',
        retmax: maxPerQuery,
        sort: 'date',
        // `reldate` + `datetype=edat` bounds the search to recently ENTERED
        // records, which is what "new to me" means. Filtering on publication
        // date would miss papers indexed late, which is most of them.
        ...(options.days === undefined ? {} : { reldate: options.days, datetype: 'edat' }),
        ...(apiKey === null ? {} : { api_key: apiKey }),
      });

      const { data } = await getJson<ESearchResponse>(searchUrl, options);
      const ids = data.esearchresult?.idlist ?? [];

      for (const ignored of data.esearchresult?.warninglist?.phrasesignored ?? []) {
        warnings.push(`PubMed ignored phrase "${ignored}" in: ${query.slice(0, 48)}`);
      }

      if (ids.length === 0) {
        log.info(`[pubmed] "${query.slice(0, 48)}" -> 0 hits`);
        continue;
      }

      for (let offset = 0; offset < ids.length; offset += FETCH_BATCH) {
        const batch = ids.slice(offset, offset + FETCH_BATCH);
        const fetchUrl = buildUrl(EFETCH, {
          db: 'pubmed',
          id: batch.join(','),
          retmode: 'xml',
          ...(apiKey === null ? {} : { api_key: apiKey }),
        });

        const xml = await getText(fetchUrl, { ...options, headers: { accept: 'application/xml' } });
        for (const article of extractAll(xml, 'PubmedArticle')) {
          const mapped = mapArticle(article, query);
          if (mapped !== null) records.push(mapped);
        }
      }

      log.info(`[pubmed] "${query.slice(0, 48)}" -> ${ids.length} record(s)`);
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`query failed (${query.slice(0, 48)}): ${message}`);
      log.warn(`[pubmed] query FAILED: ${message}`);
    }
  }

  const allFailed = queries.length > 0 && failures === queries.length;

  return {
    source: 'pubmed',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${failures} quer(ies) failed` : null,
    durationMs: Date.now() - startedAt,
    failedRequests: failures,
  };
}
