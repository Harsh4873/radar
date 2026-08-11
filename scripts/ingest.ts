/**
 * Build-time ingestion.  `npm run ingest`
 *
 *   fetch both verticals (network)
 *     -> normalize -> dedupe -> enrich -> rank
 *     -> diff against the previous src/data/radar.json
 *     -> build this week's digests
 *     -> write src/data/{radar,research,campus,sources,digests}.json
 *     -> print a human summary
 *
 * None of Radar's upstreams send CORS headers, so this is the only place they
 * are ever read; the browser gets static JSON. See astro.config.mjs.
 *
 * DETERMINISM: apart from `fetchedAt`, two runs over unchanged upstream data
 * produce byte-identical output. Items are sorted, object keys are emitted in
 * a fixed order, and `firstSeen` is carried forward from the previous snapshot
 * - so `git diff` on the snapshot shows real changes, not serialization churn.
 *
 * EXIT CODES: 0 on success, including partial failure (a stale-but-present
 * site beats a broken deploy). 1 only when there is nothing at all to publish.
 *
 * FLAGS:
 *   --only=research|campus   run one vertical
 *   --offline                skip the network; rebuild from the existing snapshot
 *   --days=N                 lookback/lookahead window (default 14 research, 45 campus)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Digest, RadarItem, RadarSnapshot, SourceReport, VerticalSnapshot } from '../src/types.ts';

/**
 * Teach bare Node the `@/*` -> `src/*` alias from tsconfig.json.
 *
 * Vite/Astro read tsconfig `paths`; `node --experimental-strip-types` does
 * not, and every module under src/ imports its siblings as `@/core/...`.
 * Without this the CLI dies on ERR_MODULE_NOT_FOUND while the site build is
 * fine - the most confusing possible failure mode.
 *
 * Hooks must be installed before the aliased modules load, which is why every
 * `src/` import below is dynamic rather than static (static imports hoist
 * above this call).
 */
const SRC_URL = new URL('../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(specifier.slice(2), SRC_URL).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'data');
const RADAR_PATH = join(OUT_DIR, 'radar.json');
const DIGESTS_PATH = join(OUT_DIR, 'digests.json');

function log(msg = ''): void {
  console.log(msg);
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Numeric-aware, id-stable ordering so the snapshot never churns. */
function byId(a: RadarItem, b: RadarItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function loadPrevious(): Promise<RadarSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(RADAR_PATH, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'research' in parsed && 'campus' in parsed) {
      return parsed as RadarSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadDigests(): Promise<Digest[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(DIGESTS_PATH, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Digest[]) : [];
  } catch {
    return [];
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

function summarizeSources(reports: readonly SourceReport[]): void {
  for (const report of reports) {
    const status = report.status.toUpperCase().padEnd(11);
    const count = String(report.itemCount).padStart(5);
    const ms = `${(report.durationMs / 1000).toFixed(1)}s`.padStart(7);
    log(`  ${status} ${count}  ${ms}  ${report.label}`);
    if (report.note !== null) log(`              ${report.note.slice(0, 110)}`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const now = new Date().toISOString();

  // Dynamic so the alias hook above is already installed. See registerHooks().
  const { ingestResearch } = await import('../src/research/ingest.ts');
  const { ingestCampus } = await import('../src/campus/ingest.ts');
  const { diffSnapshots, summarizeDiff } = await import('../src/core/change.ts');
  const { buildDigest, mergeDigests } = await import('../src/core/digest.ts');

  const only = arg('only');
  const offline = hasFlag('offline');
  const daysArg = arg('days');
  const days = daysArg === null ? null : Number.parseInt(daysArg, 10);

  log('='.repeat(74));
  log(`Radar ingest  ${now}${offline ? '   [OFFLINE]' : ''}`);
  log('='.repeat(74));

  const previous = await loadPrevious();

  // --- 1. Ingest ---------------------------------------------------------
  const runResearch = only === null || only === 'research';
  const runCampus = only === null || only === 'campus';

  const research = runResearch
    ? await ingestResearch({ now, offline, ...(days === null ? {} : { days }) })
    : { items: [], scanned: 0, matched: 0, reports: [], warnings: [] };

  const campus = runCampus
    ? await ingestCampus({ now, offline, ...(days === null ? {} : { days }) })
    : { items: [], scanned: 0, matched: 0, reports: [], warnings: [] };

  // A vertical that was skipped this run keeps its PREVIOUS RESULT WHOLESALE -
  // items, statuses, and diff. Re-running the diff over an unchanged list is
  // not a no-op: it would mark everything 'unchanged' and produce an empty
  // diff, silently erasing the change list and every NEW badge. `--only=campus`
  // and `--offline` must leave the other vertical exactly as it was.
  const freshResearch = runResearch && !offline;
  const freshCampus = runCampus && !offline;

  const researchItems = freshResearch ? research.items : (previous?.research.items ?? []);
  const campusItems = freshCampus ? campus.items : (previous?.campus.items ?? []);

  if (researchItems.length === 0 && campusItems.length === 0) {
    console.error('[ingest] FATAL: no items from any source and no previous snapshot. Nothing to publish.');
    process.exitCode = 1;
    return;
  }

  // --- 2. Diff -----------------------------------------------------------
  const researchDiff = freshResearch
    ? diffSnapshots(previous?.research.items ?? null, researchItems)
    : { items: researchItems, diff: previous?.research.diff ?? { added: [], removed: [], changes: [] } };

  const campusDiff = freshCampus
    ? diffSnapshots(previous?.campus.items ?? null, campusItems)
    : { items: campusItems, diff: previous?.campus.diff ?? { added: [], removed: [], changes: [] } };

  // --- 3. Digests --------------------------------------------------------
  const storedDigests = await loadDigests();
  // Only rebuild a digest for a vertical that actually ran. Rebuilding from a
  // carried-forward list would recompute the same week from stale inputs and
  // could overwrite a real digest with a thinner one.
  const digests = mergeDigests(storedDigests, [
    ...(freshResearch
      ? [
          buildDigest('research', researchDiff.items, {
            now,
            scanned: research.scanned,
            candidates: research.matched,
            changes: researchDiff.diff.changes,
          }),
        ]
      : []),
    ...(freshCampus
      ? [
          buildDigest('campus', campusDiff.items, {
            now,
            scanned: campus.scanned,
            candidates: campus.matched,
            changes: campusDiff.diff.changes,
          }),
        ]
      : []),
  ]);

  // --- 4. Assemble -------------------------------------------------------
  // A carried-forward vertical keeps its previous `scanned` count, `fetchedAt`,
  // and source reports. Publishing "0 scanned" for a vertical that simply did
  // not run this pass would make the site claim the feed came back empty, and
  // stamping it with this run's timestamp would date stale data as fresh.
  const researchSnapshot: VerticalSnapshot = freshResearch
    ? {
        vertical: 'research',
        fetchedAt: now,
        scanned: research.scanned,
        matched: researchDiff.items.length,
        items: [...researchDiff.items].sort(byId),
        diff: researchDiff.diff,
        sources: research.reports,
      }
    : (previous?.research ?? {
        vertical: 'research',
        fetchedAt: now,
        scanned: 0,
        matched: 0,
        items: [],
        diff: { added: [], removed: [], changes: [] },
        sources: [],
      });

  const campusSnapshot: VerticalSnapshot = freshCampus
    ? {
        vertical: 'campus',
        fetchedAt: now,
        scanned: campus.scanned,
        matched: campusDiff.items.length,
        items: [...campusDiff.items].sort(byId),
        diff: campusDiff.diff,
        sources: campus.reports,
      }
    : (previous?.campus ?? {
        vertical: 'campus',
        fetchedAt: now,
        scanned: 0,
        matched: 0,
        items: [],
        diff: { added: [], removed: [], changes: [] },
        sources: [],
      });

  const snapshot: RadarSnapshot = {
    fetchedAt: now,
    research: researchSnapshot,
    campus: campusSnapshot,
    digests,
  };

  // --- 5. Write ----------------------------------------------------------
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(RADAR_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(DIGESTS_PATH, `${JSON.stringify(digests, null, 2)}\n`, 'utf8');

  // --- 6. Summary --------------------------------------------------------
  const allWarnings = [...research.warnings, ...campus.warnings];

  log();
  log('-'.repeat(74));
  log('RESEARCH');
  log(`  scanned ${researchSnapshot.scanned}  ->  published ${researchSnapshot.items.length} (${pct(researchSnapshot.items.length, researchSnapshot.scanned)})`);
  summarizeSources(researchSnapshot.sources);

  const bands = researchSnapshot.items.reduce<Record<string, number>>((acc, item) => {
    const band = item.research?.band ?? 'adjacent';
    acc[band] = (acc[band] ?? 0) + 1;
    return acc;
  }, {});
  log(`  bands: core ${bands['core'] ?? 0}  adjacent ${bands['adjacent'] ?? 0}  methods ${bands['methods'] ?? 0}`);
  log(`  diff: ${summarizeDiff(researchSnapshot.diff)}${freshResearch ? '' : '   [carried forward - vertical did not run]'}`);

  log();
  log('CAMPUS');
  log(`  scanned ${campusSnapshot.scanned}  ->  published ${campusSnapshot.items.length} (${pct(campusSnapshot.items.length, campusSnapshot.scanned)})`);
  summarizeSources(campusSnapshot.sources);

  const categories = campusSnapshot.items.reduce<Record<string, number>>((acc, item) => {
    const category = item.campus?.category ?? 'community';
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});
  log(`  categories: ${Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || 'none'}`);

  const freeFood = campusSnapshot.items.filter((i) => i.campus?.food.confidence === 'confirmed').length;
  const provided = campusSnapshot.items.filter((i) => i.campus?.food.confidence === 'provided').length;
  const paid = campusSnapshot.items.filter((i) => (i.campus?.compensationUsd ?? 0) > 0).length;
  log(`  free food: ${freeFood} confirmed, ${provided} provided  |  paid studies: ${paid}`);
  log(`  diff: ${summarizeDiff(campusSnapshot.diff)}${freshCampus ? '' : '   [carried forward - vertical did not run]'}`);
  log('-'.repeat(74));

  if (allWarnings.length > 0) {
    log();
    log(`WARNINGS (${allWarnings.length}):`);
    for (const warning of allWarnings.slice(0, 20)) log(`  - ${warning.slice(0, 140)}`);
    if (allWarnings.length > 20) log(`  ... and ${allWarnings.length - 20} more`);
  }

  log();
  log('TOP 5 RESEARCH');
  for (const item of [...researchSnapshot.items].sort((a, b) => b.relevance - a.relevance).slice(0, 5)) {
    log(`  ${String(item.relevance).padStart(3)}  ${item.title.slice(0, 62)}`);
    log(`       ${item.reasons.slice(0, 4).map((r) => `${r.points > 0 ? '+' : ''}${r.points} ${r.label}`).join('  ')}`);
  }

  log();
  log('TOP 5 CAMPUS');
  for (const item of [...campusSnapshot.items].sort((a, b) => b.relevance - a.relevance).slice(0, 5)) {
    log(`  ${String(item.relevance).padStart(3)}  ${item.title.slice(0, 62)}`);
    log(`       ${item.reasons.slice(0, 4).map((r) => `${r.points > 0 ? '+' : ''}${r.points} ${r.label}`).join('  ')}`);
  }

  log();
  log(`Wrote ${RADAR_PATH}`);
  log(`Wrote ${DIGESTS_PATH} (${digests.length} digest(s))`);
  log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  // Every connector is non-throwing, so reaching here means something genuinely
  // unexpected (disk full, permissions, a bug) went wrong.
  console.error('[ingest] unexpected failure:', err);
  process.exitCode = 1;
});
