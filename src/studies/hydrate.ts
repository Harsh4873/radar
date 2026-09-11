/**
 * Re-apply current rate math to a committed studies snapshot.
 *
 * Study pages read precomputed `effectiveHourly` out of `src/data/studies.json`.
 * A parser fix would otherwise wait for the next live ingest to become visible.
 * The snapshot already carries `compensation.raw` and `duration.raw`, so a
 * build can re-derive hours and $/hr without inventing listings.
 *
 * Content-fallback pay (audit F3) is left on the stored compensation object:
 * those figures came from `content.rendered`, which this snapshot does not
 * keep. Only a missing visit count is filled in from a re-parse of `raw`.
 */

import { computeEffectiveHourly } from '@/studies/effective-rate.ts';
import { parseCompensation } from '@/studies/parse-compensation.ts';
import { parseDurationWithCompensation } from '@/studies/parse-duration.ts';
import type { Snapshot, StudyRecord } from '@/studies/types.ts';

export function hydrateStudyRecord(study: StudyRecord): StudyRecord {
  const fromRaw = parseCompensation(study.compensation.raw);
  const compensation = {
    ...study.compensation,
    visitCount: study.compensation.visitCount ?? fromRaw.visitCount,
  };
  const duration = parseDurationWithCompensation(study.duration.raw, compensation);
  const effectiveHourly = computeEffectiveHourly(compensation, duration);

  if (
    duration.totalHoursMin === study.duration.totalHoursMin &&
    duration.totalHoursMax === study.duration.totalHoursMax &&
    duration.sessionCount === study.duration.sessionCount &&
    compensation.visitCount === study.compensation.visitCount &&
    effectiveHourly === study.effectiveHourly
  ) {
    return study;
  }

  return { ...study, compensation, duration, effectiveHourly };
}

export function hydrateStudiesSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    studies: snapshot.studies.map(hydrateStudyRecord),
  };
}
