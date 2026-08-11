/**
 * bioRxiv and medRxiv preprints.
 *
 * One connector, two servers - the API is identical apart from the path
 * segment, so `server` is a parameter rather than a copied file.
 *
 * WHY THIS SOURCE MATTERS MORE THAN ITS SIZE SUGGESTS: it is the only upstream
 * that reports the preprint -> journal transition. Each record carries a
 * `version` and a `published` field which is the literal string `'NA'` until
 * the preprint appears in a journal, at which point it becomes the published
 * DOI. That is what lets Radar collapse
 *
 *   NEW PREPRINT -> REVISED PREPRINT -> PEER-REVIEWED PUBLICATION
 *
 * into one tracked item with a history instead of three separate discoveries,
 * and it is the input to the `preprint-revised` / `preprint-published` change
 * events in `src/core/change.ts`.
 *
 * Verified against live responses: `version` and `total` arrive as STRINGS
 * ('2', '873') while `count` and `cursor` arrive as numbers. Do not assume.
 *
 * API: https://api.biorxiv.org/
 */

import type { Logger, RawItem, SourceId, SourceResult } from '@/types.ts';
import { consoleLogger, describeError, getJson, type RequestOptions } from '@/core/http.ts';
import { htmlToText, normalizeDoi, toIso } from '@/core/text.ts';

export type PreprintServer = 'biorxiv' | 'medrxiv';

/** The API returns 100 records per cursor step, and the cursor counts records. */
const PAGE_STEP = 100;

/** Ceiling per run. These servers publish ~600 new preprints on a busy day. */
const MAX_RECORDS = 600;

interface BiorxivRecord {
  title?: string;
  authors?: string;
  author_corresponding?: string;
  author_corresponding_institution?: string;
  doi?: string;
  date?: string;
  /** A STRING, e.g. '2'. */
  version?: string | number;
  type?: string;
  category?: string;
  abstract?: string;
  /** Published DOI, or the literal 'NA' while unpublished. */
  published?: string;
  server?: string;
}

interface BiorxivResponse {
  messages?: { status?: string; count?: number; total?: string | number; cursor?: number }[];
  collection?: BiorxivRecord[];
}

/** `YYYY-MM-DD` in UTC, the format the interval endpoint expects. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function mapRecord(record: BiorxivRecord, server: PreprintServer): RawItem | null {
  const title = htmlToText(record.title);
  const doi = normalizeDoi(record.doi);
  if (title.length === 0 || doi === null) return null;

  // `published` is 'NA' until a journal picks it up. normalizeDoi rejects 'NA'
  // by shape, so this is null exactly when the preprint is still unpublished.
  const publishedDoi = normalizeDoi(record.published);

  const version = Number.parseInt(String(record.version ?? '1'), 10);
  const abstract = htmlToText(record.abstract);
  const date = toIso(record.date);

  // Authors are a single '; '-separated string: "Loconsole, M.; Xue, C."
  const authors = (record.authors ?? '')
    .split(';')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name, orcid: null, affiliation: null }));

  const identity = [`doi:${doi}`];
  // Deliberately NOT adding the published DOI as an identity key. Doing so
  // would fuse the preprint and the journal article into one item, and the
  // product wants them linked-but-distinct so "this preprint is now published"
  // is a change event with a before and an after.

  return {
    vertical: 'research',
    source: server satisfies SourceId,
    externalId: `${doi}v${Number.isFinite(version) ? version : 1}`,
    channel: record.category ?? null,
    url: `https://www.${server}.org/content/${doi}v${Number.isFinite(version) ? version : 1}`,
    title,
    summary: abstract,
    occurredAt: date,
    endsAt: null,
    lastModified: date,
    tags: record.category === undefined ? [] : [record.category],
    identity,
    research: {
      doi,
      pmid: null,
      pmcid: null,
      arxivId: null,
      openAlexId: null,
      kind: 'preprint',
      journal: null,
      authors,
      abstract,
      publishedDate: date,
      citedByCount: null,
      // Preprints on these servers are free to read by definition, and the
      // content URL above is the full text.
      isOpenAccess: true,
      openAccessUrl: `https://www.${server}.org/content/${doi}v${Number.isFinite(version) ? version : 1}.full`,
      topics: record.category === undefined ? [] : [record.category],
      citesTracked: [],
      lifecycle: {
        preprintVersion: Number.isFinite(version) ? version : 1,
        publishedDoi,
        publishedIn: null,
        isSuperseded: publishedDoi !== null,
      },
    },
  };
}

export interface BiorxivOptions extends RequestOptions {
  server?: PreprintServer;
  /** How far back to walk. The interval endpoint takes a date range. */
  days?: number;
  maxRecords?: number;
  /**
   * Injected so a run is reproducible and tests are not clock-dependent.
   *
   * Accepts a string because the ingest options object carries `now` as an ISO
   * string and is spread into every connector. Typing this as `Date` alone
   * meant the spread silently handed a string to `getTime()` at runtime.
   */
  now?: Date | string;
  log?: Logger;
}

/**
 * Walk the date-interval endpoint for one server.
 *
 * Never throws; a failure returns an empty result with the reason attached.
 */
export async function fetchPreprints(options: BiorxivOptions = {}): Promise<SourceResult<RawItem>> {
  const server: PreprintServer = options.server ?? 'biorxiv';
  const log = options.log ?? consoleLogger;
  const days = options.days ?? 14;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const now = options.now === undefined ? new Date() : new Date(options.now);
  const startedAt = Date.now();
  const warnings: string[] = [];
  const records: RawItem[] = [];

  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const interval = `${isoDate(from)}/${isoDate(now)}`;

  try {
    let cursor = 0;
    let total = Number.POSITIVE_INFINITY;

    while (records.length < maxRecords && cursor < total) {
      const url = `https://api.biorxiv.org/details/${server}/${interval}/${cursor}`;
      const { data } = await getJson<BiorxivResponse>(url, options);

      const message = data.messages?.[0];
      if (message?.status !== undefined && message.status !== 'ok') {
        warnings.push(`${server} reported status "${message.status}" for ${interval}`);
        break;
      }

      // `total` is a string in live responses. Parse, do not trust the type.
      const reportedTotal = Number.parseInt(String(message?.total ?? '0'), 10);
      if (Number.isFinite(reportedTotal) && reportedTotal > 0) total = reportedTotal;

      const page = data.collection ?? [];
      if (page.length === 0) break;

      for (const record of page) {
        const mapped = mapRecord(record, server);
        if (mapped !== null) records.push(mapped);
      }

      cursor += PAGE_STEP;
    }

    log.info(`[${server}] ${interval} -> ${records.length} preprint(s)`);

    return {
      source: server,
      records: records.slice(0, maxRecords),
      fetchSource: 'network',
      warnings,
      error: null,
      durationMs: Date.now() - startedAt,
      failedRequests: 0,
    };
  } catch (err) {
    const message = describeError(err);
    log.error(`[${server}] read FAILED: ${message}`);
    return {
      source: server,
      records: [],
      fetchSource: 'empty',
      warnings,
      error: message,
      durationMs: Date.now() - startedAt,
      failedRequests: 1,
    };
  }
}
