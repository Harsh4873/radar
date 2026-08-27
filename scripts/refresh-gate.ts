/**
 * Decide whether a scheduled ingest produced material data worth publishing.
 *
 * Snapshot timestamps move on every successful poll, so comparing raw files
 * would create two no-op commits and deploys per day. This gate compares the
 * reader-visible content while retaining independent collapse guards for each
 * engine. It is a script, rather than inline workflow JavaScript, so the cases
 * that previously left Studies frozen are covered by unit tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RefreshVerdict = 'empty' | 'suspect' | 'unchanged' | 'changed';

export interface RefreshGateInput {
  previousRadar: unknown;
  nextRadar: unknown;
  previousStudies: unknown;
  nextStudies: unknown;
  previousTaxonomies: unknown;
  nextTaxonomies: unknown;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestedObject(value: unknown, key: string): JsonObject | null {
  if (!isObject(value)) return null;
  const nested = value[key];
  return isObject(nested) ? nested : null;
}

function verticalItems(snapshot: unknown, vertical: 'research' | 'campus'): unknown[] | null {
  const items = nestedObject(snapshot, vertical)?.items;
  return Array.isArray(items) ? items : null;
}

function studyItems(snapshot: unknown): unknown[] | null {
  if (!isObject(snapshot)) return null;
  return Array.isArray(snapshot.studies) ? snapshot.studies : null;
}

function withoutLastSeen(item: unknown): unknown {
  if (!isObject(item)) return item;
  const { lastSeen: _lastSeen, ...material } = item;
  return material;
}

function radarMaterial(research: unknown[], campus: unknown[]): unknown {
  return {
    research: research.map(withoutLastSeen),
    campus: campus.map(withoutLastSeen),
  };
}

function studiesMaterial(snapshot: JsonObject, studies: unknown[]): unknown {
  const reports = Array.isArray(snapshot.sourceReports)
    ? snapshot.sourceReports
        .filter(isObject)
        .map((report) => ({
          id: typeof report.id === 'string' ? report.id : '',
          status: typeof report.status === 'string' ? report.status : '',
          itemCount: typeof report.itemCount === 'number' ? report.itemCount : 0,
          fetchSource: typeof report.fetchSource === 'string' ? report.fetchSource : '',
          failedRequests: typeof report.failedRequests === 'number' ? report.failedRequests : 0,
          complete: report.complete === true,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  return {
    // This is published in /studies/api/studies.json and can change when the
    // upstream adds a duplicate that normalization deliberately collapses.
    totalFromHeader: snapshot.totalFromHeader ?? null,
    studies,
    // Persist failure/recovery and per-registry coverage changes, but ignore
    // request duration, timestamps, and diagnostic wording that can churn.
    sourceReports: reports,
  };
}

const TAXONOMY_KEYS = ['category', 'location', 'sessionType', 'topic'] as const;
type TaxonomyKey = (typeof TAXONOMY_KEYS)[number];

interface TaxonomyTermMaterial {
  id: number;
  name: string;
  slug: string;
}

type TaxonomyMaterial = Record<TaxonomyKey, TaxonomyTermMaterial[]>;

/**
 * Keep only taxonomy fields the site and public API consume. WordPress term
 * counts, descriptions, links, and `_links` churn without changing a label.
 */
function taxonomyTerms(taxonomies: JsonObject, key: TaxonomyKey): TaxonomyTermMaterial[] {
  const raw = taxonomies[key];
  const terms = Array.isArray(raw) ? raw : isObject(raw) ? Object.values(raw) : [];
  return terms
    .filter(isObject)
    .filter((term) => typeof term.id === 'number')
    .map((term) => ({
      id: term.id as number,
      name: typeof term.name === 'string' ? term.name : '',
      slug: typeof term.slug === 'string' ? term.slug : '',
    }))
    .sort((a, b) => a.id - b.id);
}

function taxonomiesMaterial(taxonomies: JsonObject): TaxonomyMaterial {
  return {
    category: taxonomyTerms(taxonomies, 'category'),
    location: taxonomyTerms(taxonomies, 'location'),
    sessionType: taxonomyTerms(taxonomies, 'sessionType'),
    topic: taxonomyTerms(taxonomies, 'topic'),
  };
}

function collapsed(previousCount: number, nextCount: number): boolean {
  return previousCount > 0 && nextCount < previousCount * 0.5;
}

/** Return a workflow verdict without reading the network or filesystem. */
export function decideRefresh(input: RefreshGateInput): RefreshVerdict {
  const nextResearch = verticalItems(input.nextRadar, 'research');
  const nextCampus = verticalItems(input.nextRadar, 'campus');
  const nextStudyItems = studyItems(input.nextStudies);
  const nextTaxonomies = isObject(input.nextTaxonomies)
    ? taxonomiesMaterial(input.nextTaxonomies)
    : null;

  if (
    nextResearch === null
    || nextCampus === null
    || nextResearch.length + nextCampus.length === 0
    || nextStudyItems === null
    || nextStudyItems.length === 0
    || !isObject(input.nextStudies)
    || nextTaxonomies === null
    || TAXONOMY_KEYS.some((key) => nextTaxonomies[key].length === 0)
  ) {
    return 'empty';
  }

  const previousResearch = verticalItems(input.previousRadar, 'research');
  const previousCampus = verticalItems(input.previousRadar, 'campus');
  const previousStudyItems = studyItems(input.previousStudies);
  const previousTaxonomies = isObject(input.previousTaxonomies)
    ? taxonomiesMaterial(input.previousTaxonomies)
    : null;

  // A missing baseline is a first publish, not an error.
  if (
    previousResearch === null
    || previousCampus === null
    || previousStudyItems === null
    || !isObject(input.previousStudies)
    || previousTaxonomies === null
  ) {
    return 'changed';
  }

  if (
    collapsed(previousResearch.length, nextResearch.length)
    || collapsed(previousCampus.length, nextCampus.length)
    || collapsed(previousStudyItems.length, nextStudyItems.length)
    || TAXONOMY_KEYS.some((key) => collapsed(previousTaxonomies[key].length, nextTaxonomies[key].length))
  ) {
    return 'suspect';
  }

  const radarSame = JSON.stringify(radarMaterial(previousResearch, previousCampus))
    === JSON.stringify(radarMaterial(nextResearch, nextCampus));
  const studiesSame = JSON.stringify(studiesMaterial(input.previousStudies, previousStudyItems))
    === JSON.stringify(studiesMaterial(input.nextStudies, nextStudyItems));
  const taxonomiesSame = JSON.stringify(previousTaxonomies) === JSON.stringify(nextTaxonomies);

  return radarSame && studiesSame && taxonomiesSame ? 'unchanged' : 'changed';
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function runCli(paths: string[]): void {
  if (paths.length !== 6) {
    console.error(
      'usage: refresh-gate.ts PREV_RADAR NEXT_RADAR PREV_STUDIES NEXT_STUDIES PREV_TAXONOMIES NEXT_TAXONOMIES',
    );
    process.exitCode = 2;
    return;
  }

  const [
    previousRadarPath,
    nextRadarPath,
    previousStudiesPath,
    nextStudiesPath,
    previousTaxonomiesPath,
    nextTaxonomiesPath,
  ] = paths;

  process.stdout.write(decideRefresh({
    previousRadar: readJson(previousRadarPath as string),
    nextRadar: readJson(nextRadarPath as string),
    previousStudies: readJson(previousStudiesPath as string),
    nextStudies: readJson(nextStudiesPath as string),
    previousTaxonomies: readJson(previousTaxonomiesPath as string),
    nextTaxonomies: readJson(nextTaxonomiesPath as string),
  }));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2));
}
