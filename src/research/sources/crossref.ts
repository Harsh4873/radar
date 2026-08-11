/**
 * Crossref - ENRICHMENT ONLY. This is not a discovery source, by design.
 *
 * The brief already framed Crossref as "canonical metadata + deduplication +
 * publication status rather than primary discovery", and a live check backs
 * that up hard. `?query=tuberculosis+positive+selection&sort=published` returns
 * as its top hit a paper about teacher efficacy in Kenyan secondary schools,
 * dated `"issued": {"date-parts": [[2106]]}` - a publisher typo for 2016 that
 * Crossref faithfully republishes. Free-text search over Crossref is a metadata
 * index, not a relevance engine, and wiring it to discovery would inject junk
 * with impossible dates straight into a recency-weighted ranker.
 *
 * So this module takes DOIs that other sources already found and fills in what
 * they left blank:
 *
 *   - the canonical journal title and issue metadata
 *   - the licence, which is the only defensible basis for an "open access" claim
 *   - `is-referenced-by-count`
 *   - the publication date a preprint's journal version was issued, which
 *     completes the preprint -> published lifecycle
 *
 * DATE SANITY IS ENFORCED HERE. `assertPlausibleDate` drops anything more than
 * a year in the future, because the 2106 record above would otherwise score as
 * "just posted" and pin itself to the top of the feed forever.
 *
 * API: https://api.crossref.org/
 */

import type { Logger, SourceResult } from '@/types.ts';
import { buildUrl, consoleLogger, contactEmail, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { htmlToText, normalizeDoi, toIso } from '@/core/text.ts';

const ENDPOINT = 'https://api.crossref.org/works';

/** DOIs per request. Crossref's filter accepts a comma list; keep URLs sane. */
const BATCH_SIZE = 40;

/**
 * How far into the future a publication date may plausibly sit.
 *
 * Journals legitimately post ahead ("issue dated next month"), so this is not
 * zero. A year is generous enough for that and tight enough to reject the
 * year-2106 class of typo.
 */
const MAX_FUTURE_DAYS = 400;

interface CrossrefItem {
  DOI?: string;
  type?: string;
  title?: string[];
  'container-title'?: string[];
  abstract?: string;
  author?: { given?: string; family?: string; ORCID?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  published?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  'is-referenced-by-count'?: number;
  license?: { URL?: string; 'content-version'?: string }[];
  link?: { URL?: string; 'content-type'?: string }[];
  URL?: string;
  subject?: string[];
  relation?: Record<string, { 'id-type'?: string; id?: string }[]>;
}

interface CrossrefResponse {
  message?: { items?: CrossrefItem[] };
}

/**
 * Reject dates that cannot be real.
 *
 * Returns null for anything more than `MAX_FUTURE_DAYS` ahead of `now`. A null
 * date costs a small recency bonus; a bogus future date wins the feed.
 */
export function assertPlausibleDate(iso: string | null, now: string): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  const reference = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(reference)) return null;
  if (then - reference > MAX_FUTURE_DAYS * 86_400_000) return null;
  return iso;
}

/** Metadata Crossref can add to an item another source already found. */
export interface CrossrefEnrichment {
  doi: string;
  journal: string | null;
  publishedDate: string | null;
  citedByCount: number | null;
  /** True only when Crossref records an actual licence. Never inferred. */
  isOpenAccess: boolean;
  openAccessUrl: string | null;
  abstract: string;
  type: string | null;
  subjects: string[];
}

export function mapItem(item: CrossrefItem, now: string): CrossrefEnrichment | null {
  const doi = normalizeDoi(item.DOI);
  if (doi === null) return null;

  const dateParts =
    item.issued?.['date-parts'] ??
    item['published-online']?.['date-parts'] ??
    item['published-print']?.['date-parts'] ??
    item.published?.['date-parts'];

  const licenses = item.license ?? [];
  // A licence URL is evidence of a declared reuse right. Radar treats only the
  // recognisable open families as open access rather than any licence at all,
  // because publishers also register restrictive licences here.
  const openLicense = licenses.find((license) => {
    const url = (license.URL ?? '').toLowerCase();
    return url.includes('creativecommons.org') || url.includes('/by/') || url.includes('publicdomain');
  });

  const pdfLink = (item.link ?? []).find((link) => link['content-type'] === 'application/pdf');

  return {
    doi,
    journal: item['container-title']?.[0] ?? null,
    publishedDate: assertPlausibleDate(toIso(dateParts ?? null), now),
    citedByCount: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : null,
    isOpenAccess: openLicense !== undefined,
    openAccessUrl: openLicense === undefined ? null : (pdfLink?.URL ?? item.URL ?? null),
    // Crossref abstracts are JATS XML when present at all.
    abstract: htmlToText(item.abstract),
    type: item.type ?? null,
    subjects: item.subject ?? [],
  };
}

export interface CrossrefOptions extends RequestOptions {
  /** DOIs to enrich. Anything not a valid DOI is skipped. */
  dois: readonly string[];
  now: string;
  log?: Logger;
}

/**
 * Look up metadata for a known DOI set.
 *
 * Never throws. A failed batch is warned about and skipped - enrichment is
 * strictly additive, so losing it degrades detail, never the feed itself.
 */
export async function fetchCrossrefMetadata(
  options: CrossrefOptions,
): Promise<SourceResult<CrossrefEnrichment>> {
  const log = options.log ?? consoleLogger;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: CrossrefEnrichment[] = [];
  const mailto = contactEmail();

  const dois = [...new Set(options.dois.map((doi) => normalizeDoi(doi)).filter((d): d is string => d !== null))];

  if (dois.length === 0) {
    return {
      source: 'crossref',
      records: [],
      fetchSource: 'empty',
      warnings: [],
      error: null,
      durationMs: Date.now() - startedAt,
    };
  }

  let failures = 0;
  const batches = Math.ceil(dois.length / BATCH_SIZE);

  for (let offset = 0; offset < dois.length; offset += BATCH_SIZE) {
    const batch = dois.slice(offset, offset + BATCH_SIZE);
    try {
      const url = buildUrl(ENDPOINT, {
        filter: batch.map((doi) => `doi:${doi}`).join(','),
        rows: batch.length,
        mailto,
      });

      const { data } = await getJson<CrossrefResponse>(url, options);
      for (const item of data.message?.items ?? []) {
        const mapped = mapItem(item, options.now);
        if (mapped !== null) records.push(mapped);
      }
    } catch (err) {
      failures += 1;
      const message = describeError(err);
      warnings.push(`batch failed: ${message}`);
      log.warn(`[crossref] batch FAILED: ${message}`);
    }
  }

  log.info(`[crossref] enriched ${records.length}/${dois.length} DOI(s) in ${batches} batch(es)`);

  return {
    source: 'crossref',
    records,
    fetchSource: failures === batches ? 'empty' : 'network',
    warnings,
    error: failures === batches ? `all ${failures} batch(es) failed` : null,
    durationMs: Date.now() - startedAt,
  };
}
