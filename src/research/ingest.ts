/**
 * ResearchRadar ingestion.
 *
 * Implements the funnel from the brief, which exists to keep the expensive
 * work off the wide end of the pipe:
 *
 *   ~400 candidates across 6 sources
 *        -> normalize                 clean text, stable ids
 *        -> dedupe                    ~ -25%, one card per paper
 *        -> lifecycle linking         preprint <-> published
 *        -> Crossref enrichment       ONLY for survivors, by DOI
 *        -> profile scoring           explainable, additive
 *        -> relevance floor           what actually reaches the site
 *
 * Enrichment sits AFTER the floor on purpose. Crossref is a per-DOI lookup;
 * running it across 400 candidates to enrich the 40 that survive would be
 * ten times the requests for the same result.
 */

import type { Logger, RadarItem, RawItem, SourceReport, SourceResult } from '@/types.ts';
import { consoleLogger, type RequestOptions } from '@/core/http.ts';
import { dedupe } from '@/core/dedupe.ts';
import { normalizeAll } from '@/core/normalize.ts';
import { INGEST_THRESHOLD, byRelevance } from '@/core/rank.ts';
import { fetchArxiv } from '@/research/sources/arxiv.ts';
import { fetchCrossrefMetadata } from '@/research/sources/crossref.ts';
import { fetchEuropePmc } from '@/research/sources/europepmc.ts';
import { fetchOpenAlex } from '@/research/sources/openalex.ts';
import { fetchPreprints } from '@/research/sources/biorxiv.ts';
import { fetchPubmed } from '@/research/sources/pubmed.ts';
import { ARXIV_QUERIES, RESEARCH_QUERIES } from '@/research/profile.ts';
import { hasProfileMatch, linkPreprintLifecycles, scoreResearch, type ResearchContext } from '@/research/score.ts';

/**
 * Relevance floor for adjacent-band papers.
 *
 * Higher than the global floor because an adjacent-only match is, by
 * definition, peripheral - it fired `computational biology` or `genome
 * evolution` and nothing closer. Those are worth seeing when several stack up,
 * not when one squeaks past.
 */
const ADJACENT_THRESHOLD = 30;

/** Public documentation for each source, linked from the Sources page. */
const DOCS: Record<string, string> = {
  europepmc: 'https://europepmc.org/RestfulWebService',
  pubmed: 'https://www.ncbi.nlm.nih.gov/books/NBK25497/',
  biorxiv: 'https://api.biorxiv.org/',
  medrxiv: 'https://api.biorxiv.org/',
  openalex: 'https://developers.openalex.org/',
  arxiv: 'https://info.arxiv.org/help/api/user-manual.html',
  crossref: 'https://api.crossref.org/',
};

const LABELS: Record<string, string> = {
  europepmc: 'Europe PMC',
  pubmed: 'PubMed / NCBI',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  crossref: 'Crossref',
};

function reportFor(result: SourceResult<unknown>, note: string | null = null): SourceReport {
  return {
    id: result.source,
    label: LABELS[result.source] ?? result.source,
    vertical: 'research',
    status: result.error !== null ? 'failed' : result.warnings.length > 0 ? 'degraded' : 'ok',
    itemCount: result.records.length,
    fetchSource: result.fetchSource,
    durationMs: result.durationMs,
    note: note ?? (result.error ?? (result.warnings[0] ?? null)),
    docsUrl: DOCS[result.source] ?? '',
  };
}

export interface ResearchIngestOptions extends RequestOptions {
  now: string;
  /** Lookback for the preprint servers and PubMed's entry-date filter. */
  days?: number;
  log?: Logger;
  context?: Partial<ResearchContext>;
  /** Skip the network entirely. Used by `--offline`. */
  offline?: boolean;
}

export interface ResearchIngestResult {
  items: RadarItem[];
  scanned: number;
  matched: number;
  reports: SourceReport[];
  warnings: string[];
}

export async function ingestResearch(options: ResearchIngestOptions): Promise<ResearchIngestResult> {
  const log = options.log ?? consoleLogger;
  const days = options.days ?? 14;
  const reports: SourceReport[] = [];
  const warnings: string[] = [];

  if (options.offline === true) {
    log.warn('[research] offline mode - no upstream reads');
    return { items: [], scanned: 0, matched: 0, reports, warnings: ['offline mode'] };
  }

  // --- 1. Fetch ----------------------------------------------------------
  // Sequential rather than Promise.all. These are five different institutions'
  // servers and the per-host throttle already serialises same-host traffic;
  // firing everything at once mostly just makes the log unreadable and the
  // failure modes harder to attribute.
  const fromDate = new Date(Date.parse(options.now) - days * 86_400_000).toISOString().slice(0, 10);

  const results: SourceResult<RawItem>[] = [];
  results.push(await fetchEuropePmc({ ...options, queries: RESEARCH_QUERIES, fromDate }));
  results.push(await fetchPubmed({ ...options, queries: RESEARCH_QUERIES, days }));
  results.push(await fetchPreprints({ ...options, server: 'biorxiv', days }));
  results.push(await fetchPreprints({ ...options, server: 'medrxiv', days }));
  results.push(await fetchOpenAlex({ ...options, queries: RESEARCH_QUERIES, fromDate }));
  results.push(await fetchArxiv({ ...options, queries: ARXIV_QUERIES }));

  for (const result of results) {
    reports.push(reportFor(result));
    warnings.push(...result.warnings.map((w) => `${result.source}: ${w}`));
  }

  const raws = results.flatMap((result) => result.records);
  const scanned = raws.length;
  log.info(`[research] ${scanned} raw record(s) across ${results.length} source(s)`);

  // --- 2. Normalize ------------------------------------------------------
  const { items: normalized, skipped } = normalizeAll(raws, { now: options.now });
  if (skipped > 0) warnings.push(`research: skipped ${skipped} unpublishable record(s)`);

  // --- 3. Dedupe ---------------------------------------------------------
  const { items: deduped, collapsed, clusters } = dedupe(normalized);
  log.info(`[research] dedupe collapsed ${collapsed} duplicate(s) into ${clusters.length} cluster(s)`);

  // --- 4. Lifecycle ------------------------------------------------------
  const linked = linkPreprintLifecycles(deduped);

  // --- 5. Score ----------------------------------------------------------
  const context: ResearchContext = {
    now: options.now,
    trackedWorkIds: options.context?.trackedWorkIds ?? new Set(),
    watchedAuthors: options.context?.watchedAuthors ?? new Set(),
    watchedInstitutions: options.context?.watchedInstitutions ?? new Set(),
    mutedTerms: options.context?.mutedTerms ?? new Set(),
  };
  const scored = scoreResearch(linked, context);

  // --- 6. Floor ----------------------------------------------------------
  // Two gates, and the first matters more than the second. Something about the
  // paper's CONTENT has to have matched, or it is not a discovery - it is a
  // recent open-access paper, which describes hundreds per day. See
  // `hasProfileMatch`.
  const matched = scored.filter(hasProfileMatch);
  const survivors = matched.filter((item) => {
    // Adjacent-band papers carry a higher bar. By construction they fired only
    // peripheral terms, so at low scores they are one loose keyword away from
    // noise, while a core or methods hit is a genuine signal even when weak.
    const floor = item.research?.band === 'adjacent' ? ADJACENT_THRESHOLD : INGEST_THRESHOLD;
    return item.relevance >= floor;
  });

  log.info(
    `[research] ${matched.length}/${scored.length} matched the profile; ` +
      `${survivors.length} cleared the floor (${INGEST_THRESHOLD}, adjacent ${ADJACENT_THRESHOLD})`,
  );

  // --- 7. Enrich survivors only -----------------------------------------
  const dois = survivors
    .map((item) => item.research?.doi)
    .filter((doi): doi is string => typeof doi === 'string');

  const enrichment = await fetchCrossrefMetadata({ ...options, dois, now: options.now });
  reports.push(
    reportFor(enrichment, enrichment.error ?? `enriched ${enrichment.records.length}/${dois.length} DOI(s)`),
  );

  const byDoi = new Map(enrichment.records.map((record) => [record.doi, record]));
  const enriched = survivors.map((item) => {
    const research = item.research;
    const extra = research?.doi === undefined || research.doi === null ? undefined : byDoi.get(research.doi);
    if (research === undefined || extra === undefined) return item;

    return {
      ...item,
      research: {
        ...research,
        // Crossref is the registry of record for these three, so it wins where
        // it has an answer. Everything else keeps whatever the richer source gave.
        journal: extra.journal ?? research.journal,
        publishedDate: research.publishedDate ?? extra.publishedDate,
        citedByCount: extra.citedByCount ?? research.citedByCount,
        isOpenAccess: research.isOpenAccess || extra.isOpenAccess,
        openAccessUrl: research.openAccessUrl ?? extra.openAccessUrl,
        abstract: research.abstract.length >= extra.abstract.length ? research.abstract : extra.abstract,
      },
    };
  });

  return {
    items: [...enriched].sort(byRelevance),
    scanned,
    matched: enriched.length,
    reports,
    warnings,
  };
}
