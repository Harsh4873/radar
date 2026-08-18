/**
 * Build-time ingestion.  `npm run ingest`
 *
 *   fetch research, campus, and studies (network)
 *     -> normalize -> dedupe -> enrich -> rank
 *     -> diff against the previous snapshot
 *     -> build this week's digests
 *     -> write src/data/{radar,digests,studies}.json
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
 *   --only=research|campus|studies   run one vertical
 *   --offline                        skip the network; rebuild from the existing snapshot
 *   --days=N                         lookback/lookahead window (default 14 research, 45 campus)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Digest, RadarItem, RadarSnapshot, SourceReport, VerticalSnapshot } from '../src/types.ts';
import type { Snapshot as StudiesSnapshot } from '../src/studies/types.ts';

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
const STUDIES_PATH = join(OUT_DIR, 'studies.json');
const STUDIES_TAXONOMY_PATH = join(OUT_DIR, 'studies-taxonomies.json');
const STUDIES_DIFF_PATH = join(OUT_DIR, 'studies-diff.json');

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

function excludesParticipantStudies(item: RadarItem): boolean {
  return !item.sources.some((source) => source.source === 'aggie-research-volunteers')
    && !/\b(participants? needed|seeking participants?|recruiting participants?|volunteers? needed|paid study|take part in (?:a|our|this) study|participate in (?:a|our|this) study)\b/i
      .test(`${item.title} ${item.summary}`);
}

function sanitizeCampusSnapshot(snapshot: VerticalSnapshot | undefined): VerticalSnapshot | undefined {
  if (!snapshot) return undefined;
  const items = snapshot.items.filter(excludesParticipantStudies);
  const kept = new Set(items.map((item) => item.id));
  const excluded = new Set(snapshot.items.filter((item) => !excludesParticipantStudies(item)).map((item) => item.id));
  const excludedId = (id: string) => excluded.has(id) || /(?:^|:)arv(?:-|:|$)/i.test(id);
  return {
    ...snapshot,
    matched: items.length,
    items,
    sources: snapshot.sources.filter((source) => source.id !== 'aggie-research-volunteers'),
    diff: {
      added: snapshot.diff.added.filter((id) => kept.has(id)),
      removed: snapshot.diff.removed.filter((id) => !excludedId(id)),
      changes: snapshot.diff.changes.filter((change) => !excludedId(change.itemId)),
    },
  };
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

async function loadPreviousStudies(): Promise<StudiesSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STUDIES_PATH, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as StudiesSnapshot).studies)) {
      return parsed as StudiesSnapshot;
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
  const { ingestStudies } = await import('../src/studies/ingest.ts');
  const { isKnownRate } = await import('../src/studies/effective-rate.ts');
  const { diffSnapshots, summarizeDiff } = await import('../src/core/change.ts');
  const { retainUnfetched } = await import('../src/core/retain.ts');
  const { buildDigest, mergeDigests } = await import('../src/core/digest.ts');

  const only = arg('only');
  const offline = hasFlag('offline');
  const daysArg = arg('days');
  const days = daysArg === null ? null : Number.parseInt(daysArg, 10);

  log('='.repeat(74));
  log(`Radar ingest  ${now}${offline ? '   [OFFLINE]' : ''}`);
  log('='.repeat(74));

  const previous = await loadPrevious();
  const previousCampus = sanitizeCampusSnapshot(previous?.campus);
  const excludedCampusIds = new Set(
    (previous?.campus.items ?? []).filter((item) => !excludesParticipantStudies(item)).map((item) => item.id),
  );

  // --- 1. Ingest ---------------------------------------------------------
  const runResearch = only === null || only === 'research';
  const runCampus = only === null || only === 'campus';
  const runStudies = only === null || only === 'studies';

  const research = runResearch
    ? await ingestResearch({ now, offline, ...(days === null ? {} : { days }) })
    : { items: [], scanned: 0, matched: 0, reports: [], warnings: [] };

  const campus = runCampus
    ? await ingestCampus({ now, offline, ...(days === null ? {} : { days }) })
    : { items: [], scanned: 0, matched: 0, reports: [], warnings: [] };

  const previousStudies = await loadPreviousStudies();
  const studiesResult = runStudies
    ? await ingestStudies({ now, offline })
    : null;

  // A vertical that was skipped this run keeps its PREVIOUS RESULT WHOLESALE -
  // items, statuses, and diff. Re-running the diff over an unchanged list is
  // not a no-op: it would mark everything 'unchanged' and produce an empty
  // diff, silently erasing the change list and every NEW badge. `--only=campus`
  // and `--offline` must leave the other vertical exactly as it was.
  const freshResearch = runResearch && !offline;
  const freshCampus = runCampus && !offline;

  // Carry forward items whose sources could not be reached this run, so a
  // transient upstream timeout does not delete them from the feed and then
  // re-announce them as NEW next time. See src/core/retain.ts.
  const researchRetain = freshResearch
    ? retainUnfetched(previous?.research.items ?? null, research.items, research.reports)
    : { items: previous?.research.items ?? [], retained: [], impaired: [] };

  const campusRetain = freshCampus
    ? retainUnfetched(previousCampus?.items ?? null, campus.items, campus.reports)
    : { items: previousCampus?.items ?? [], retained: [], impaired: [] };

  for (const [vertical, result] of [['research', researchRetain], ['campus', campusRetain]] as const) {
    if (result.retained.length === 0) continue;
    const message =
      `${vertical}: kept ${result.retained.length} item(s) that ${result.impaired.join(', ')} ` +
      `could not deliver this run - they are not gone, the source was unreachable`;
    log(`WARNING ${message}`);
    if (vertical === 'research') research.warnings.push(message);
    else campus.warnings.push(message);
  }

  const researchItems = researchRetain.items;
  // Apply the product boundary after retention too. Otherwise an old ARV
  // record would survive forever when the source is intentionally removed.
  const campusItems = campusRetain.items.filter(excludesParticipantStudies);

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
  const storedDigests = (await loadDigests()).map((digest) => {
    if (digest.vertical !== 'campus' || excludedCampusIds.size === 0) return digest;
    const keptIndexes = digest.recommended
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !excludedCampusIds.has(id));
    return {
      ...digest,
      recommended: keptIndexes.map(({ id }) => id),
      headlines: keptIndexes.map(({ index }) => digest.headlines[index] ?? '').filter(Boolean),
      changes: digest.changes.filter((change) => !excludedCampusIds.has(change.itemId)),
    };
  });
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
    : (previousCampus ?? {
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

  const studiesSnapshot = studiesResult?.snapshot ?? previousStudies;
  const studiesWarnings = studiesResult?.warnings ?? [];

  // --- 5. Write ----------------------------------------------------------
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(RADAR_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(DIGESTS_PATH, `${JSON.stringify(digests, null, 2)}\n`, 'utf8');
  if (studiesResult !== null) {
    await writeFile(STUDIES_PATH, `${JSON.stringify(studiesResult.snapshot, null, 2)}\n`, 'utf8');
    await writeFile(STUDIES_TAXONOMY_PATH, `${JSON.stringify(studiesResult.taxonomies, null, 2)}\n`, 'utf8');
    await writeFile(STUDIES_DIFF_PATH, `${JSON.stringify(studiesResult.diff, null, 2)}\n`, 'utf8');
  }

  // --- 6. Summary --------------------------------------------------------
  const allWarnings = [...research.warnings, ...campus.warnings, ...studiesWarnings];

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
  log(`  free food: ${freeFood} confirmed, ${provided} provided  |  recruitment listings live in Studies`);
  log(`  diff: ${summarizeDiff(campusSnapshot.diff)}${freshCampus ? '' : '   [carried forward - vertical did not run]'}`);

  log();
  log('STUDIES');
  if (studiesSnapshot === null || studiesSnapshot.studies.length === 0) {
    log('  no snapshot');
  } else {
    const live = studiesSnapshot.studies.filter((s) => !s.isExpired);
    const rated = studiesSnapshot.studies.filter((s) => isKnownRate(s.effectiveHourly));
    log(`  source ${studiesResult?.source.toUpperCase() ?? 'CACHE'}  published ${studiesSnapshot.studies.length}  live ${live.length}  ranked ${rated.length}`);
    log(`  diff: +${studiesResult?.diff.added.length ?? 0}  -${studiesResult?.diff.removed.length ?? 0}  ~${studiesResult?.diff.changed.length ?? 0}${runStudies ? '' : '   [carried forward - vertical did not run]'}`);
  }
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

  if (studiesSnapshot !== null && studiesSnapshot.studies.length > 0) {
    log();
    log('TOP 5 STUDIES');
    const ranked = [...studiesSnapshot.studies]
      .filter((s) => isKnownRate(s.effectiveHourly) && (s.effectiveHourly ?? 0) > 0)
      .sort((a, b) => (b.effectiveHourly ?? 0) - (a.effectiveHourly ?? 0))
      .slice(0, 5);
    for (const study of ranked) {
      log(`  $${(study.effectiveHourly ?? 0).toFixed(0).padStart(4)}/hr  ${study.title.slice(0, 58)}`);
    }
  }

  log();
  log(`Wrote ${RADAR_PATH}`);
  log(`Wrote ${DIGESTS_PATH} (${digests.length} digest(s))`);
  if (studiesResult !== null) log(`Wrote ${STUDIES_PATH} (${studiesResult.snapshot.studies.length} studies)`);
  log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  // Every connector is non-throwing, so reaching here means something genuinely
  // unexpected (disk full, permissions, a bug) went wrong.
  console.error('[ingest] unexpected failure:', err);
  process.exitCode = 1;
});
