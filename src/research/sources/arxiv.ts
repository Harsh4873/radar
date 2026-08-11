/**
 * arXiv - the methods and computational half of the feed.
 *
 * Scoped deliberately narrowly. arXiv is not where this project's biology
 * lives, so querying it for tuberculosis returns noise; it is queried for
 * codon models, phylogenetic inference, and computational methods, where a
 * good paper is worth reading regardless of the organism it was demonstrated
 * on. `ARXIV_QUERIES` in the profile is separate from `RESEARCH_QUERIES` for
 * exactly this reason.
 *
 * Two operational notes, both verified live:
 *
 *   - The `http://export.arxiv.org` URL 301-redirects. Use https directly;
 *     following the redirect wastes a request against a 1-per-3-second budget.
 *   - arXiv's API manual asks for roughly one request every three seconds.
 *     That is enforced in `src/core/http.ts` via the per-host interval table,
 *     not here, so it holds no matter who calls.
 *
 * API: https://info.arxiv.org/help/api/user-manual.html
 */

import type { Logger, RawItem, SourceResult } from '@/types.ts';
import { buildUrl, consoleLogger, describeError, getText, type RequestOptions } from '@/core/http.ts';
import { attrOf, attrsOf, extractAll, textOf, textsOf } from '@/core/xml.ts';
import { collapse, normalizeArxivId, toIso, versionOf } from '@/core/text.ts';

const ENDPOINT = 'https://export.arxiv.org/api/query';

const MAX_PER_QUERY = 60;

/**
 * Map one Atom `<entry>` body.
 *
 * arXiv's `<id>` is `http://arxiv.org/abs/2606.27607v1` - the version is part
 * of the id, which is why `versionOf` is read before `normalizeArxivId` strips it.
 */
export function mapEntry(entry: string, query: string): RawItem | null {
  const rawId = textOf(entry, 'id');
  const title = textOf(entry, 'title');
  if (rawId === null || title === null || title.length === 0) return null;

  const arxivId = normalizeArxivId(rawId);
  if (arxivId === null) return null;

  const version = versionOf(rawId) ?? 1;
  const summary = collapse(textOf(entry, 'summary') ?? '');
  const published = toIso(textOf(entry, 'published'));
  const updated = toIso(textOf(entry, 'updated'));

  const authors = textsOf(entry, 'name').map((name) => ({ name, orcid: null, affiliation: null }));
  const categories = attrsOf(entry, 'category', 'term');

  // The abs page is the human destination; the pdf link is the full text.
  const absUrl =
    attrOf(entry, 'link', 'href', (attrs) => attrs['rel'] === 'alternate') ??
    `https://arxiv.org/abs/${arxivId}`;
  const pdfUrl = attrOf(entry, 'link', 'href', (attrs) => attrs['title'] === 'pdf');

  // arXiv publishes a DOI only once the work is journal-published.
  const doi = textOf(entry, 'arxiv:doi');

  const identity = [`arxiv:${arxivId}`];
  if (doi !== null && doi.length > 0) identity.push(`doi:${doi.toLowerCase()}`);

  return {
    vertical: 'research',
    source: 'arxiv',
    externalId: `${arxivId}v${version}`,
    channel: query,
    url: absUrl,
    title,
    summary,
    occurredAt: published,
    endsAt: null,
    lastModified: updated,
    tags: categories.slice(0, 6),
    identity,
    research: {
      doi: doi === null || doi.length === 0 ? null : doi.toLowerCase(),
      pmid: null,
      pmcid: null,
      arxivId,
      openAlexId: null,
      kind: 'preprint',
      journal: textOf(entry, 'arxiv:journal_ref'),
      authors,
      abstract: summary,
      publishedDate: published,
      citedByCount: null,
      isOpenAccess: true,
      openAccessUrl: pdfUrl ?? `https://arxiv.org/pdf/${arxivId}`,
      topics: categories.slice(0, 6),
      citesTracked: [],
      lifecycle: {
        preprintVersion: version,
        publishedDoi: doi === null || doi.length === 0 ? null : doi.toLowerCase(),
        publishedIn: textOf(entry, 'arxiv:journal_ref'),
        isSuperseded: doi !== null && doi.length > 0,
      },
    },
  };
}

export interface ArxivOptions extends RequestOptions {
  queries?: readonly string[];
  maxPerQuery?: number;
  log?: Logger;
}

export async function fetchArxiv(options: ArxivOptions = {}): Promise<SourceResult<RawItem>> {
  const log = options.log ?? consoleLogger;
  const queries = options.queries ?? [];
  const maxPerQuery = options.maxPerQuery ?? MAX_PER_QUERY;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];
  let failures = 0;

  for (const query of queries) {
    try {
      const url = buildUrl(ENDPOINT, {
        search_query: query,
        max_results: maxPerQuery,
        sortBy: 'submittedDate',
        sortOrder: 'descending',
      });

      const xml = await getText(url, options);
      const entries = extractAll(xml, 'entry');

      for (const entry of entries) {
        const mapped = mapEntry(entry, query);
        if (mapped !== null) records.push(mapped);
      }

      log.info(`[arxiv] "${query.slice(0, 48)}" -> ${entries.length} entr(ies)`);
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`query failed (${query.slice(0, 48)}): ${message}`);
      log.warn(`[arxiv] query FAILED: ${message}`);
    }
  }

  const allFailed = queries.length > 0 && failures === queries.length;

  return {
    source: 'arxiv',
    records,
    fetchSource: allFailed ? 'empty' : 'network',
    warnings,
    error: allFailed ? `all ${failures} quer(ies) failed` : null,
    durationMs: Date.now() - startedAt,
  };
}
