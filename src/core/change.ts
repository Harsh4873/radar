/**
 * Change detection - the feature that makes Radar worth checking.
 *
 * "What's new?" is answerable by any RSS reader. "What CHANGED?" requires
 * keeping the previous snapshot and diffing field by field, which is what this
 * module does:
 *
 *   Google Tech Talk    Room changed: Zachry 297 -> Zachry 420
 *   Genomics seminar    CANCELLED
 *   That preprint       bioRxiv v1 -> v2
 *   That preprint       now published in Evolutionary Applications
 *
 * Two responsibilities, and the second is easy to overlook:
 *
 *   1. Produce `ChangeEvent`s and set each item's `status`.
 *   2. CARRY FORWARD `firstSeen`. Without this, every item looks brand new on
 *      every run, "since your last visit" reports the entire corpus, and the
 *      change feed is noise. The previous snapshot is the only place that
 *      history lives, which is also why refresh.yml force-commits it past
 *      .gitignore.
 */

import type { ChangeEvent, RadarItem, SnapshotDiff } from '@/types.ts';

/**
 * Fields that produce a user-visible change event.
 *
 * Everything here is something a person would want to be told about. Fields
 * that churn without meaning - thumbnail URLs with cache-busting segments,
 * `last_modified` bumps from an editor re-saving, view counts - are absent by
 * design and are also excluded from `contentHash`.
 */
function detectFieldChanges(before: RadarItem, after: RadarItem): ChangeEvent[] {
  const changes: ChangeEvent[] = [];
  const push = (kind: ChangeEvent['kind'], field: string, a: string | null, b: string | null): void => {
    changes.push({ itemId: after.id, kind, field, before: a, after: b });
  };

  if (before.title !== after.title) push('title', 'Title', before.title, after.title);

  const beforeCampus = before.campus;
  const afterCampus = after.campus;
  if (beforeCampus !== undefined && afterCampus !== undefined) {
    if (!beforeCampus.isCancelled && afterCampus.isCancelled) {
      push('cancelled', 'Status', 'scheduled', 'cancelled');
    } else if (beforeCampus.isCancelled && !afterCampus.isCancelled) {
      // Rare but real: feeds do un-cancel. Worth surfacing, because the user
      // may have already written the event off.
      push('uncancelled', 'Status', 'cancelled', 'back on');
    }

    if (beforeCampus.location !== afterCampus.location) {
      push('location', 'Location', beforeCampus.location, afterCampus.location);
    }

    if (beforeCampus.startsAt !== afterCampus.startsAt) {
      push('time', 'Start time', beforeCampus.startsAt, afterCampus.startsAt);
    }

    if (!beforeCampus.hasRegistration && afterCampus.hasRegistration) {
      push('registration-opened', 'Registration', 'not open', 'open');
    }
  }

  const beforeResearch = before.research;
  const afterResearch = after.research;
  if (beforeResearch !== undefined && afterResearch !== undefined) {
    const beforeVersion = beforeResearch.lifecycle.preprintVersion;
    const afterVersion = afterResearch.lifecycle.preprintVersion;
    if (beforeVersion !== null && afterVersion !== null && afterVersion > beforeVersion) {
      push('preprint-revised', 'Preprint version', `v${beforeVersion}`, `v${afterVersion}`);
    }

    // The one every literature tracker should have and almost none do.
    if (beforeResearch.lifecycle.publishedDoi === null && afterResearch.lifecycle.publishedDoi !== null) {
      push(
        'preprint-published',
        'Publication',
        'preprint',
        afterResearch.lifecycle.publishedIn ?? afterResearch.lifecycle.publishedDoi,
      );
    }
  }

  return changes;
}

export interface DiffResult {
  /** Items with `status` and `firstSeen` reconciled against the previous run. */
  items: RadarItem[];
  diff: SnapshotDiff;
}

/**
 * Reconcile a freshly-ingested item list against the previous snapshot.
 *
 * `previous` being null (first run, or an unreadable snapshot) is not an error:
 * everything is reported as added, which is exactly right for a first run.
 */
export function diffSnapshots(previous: readonly RadarItem[] | null, next: readonly RadarItem[]): DiffResult {
  if (previous === null) {
    return {
      items: next.map((item) => ({ ...item, status: 'new' as const })),
      diff: { added: next.map((i) => i.id), removed: [], changes: [] },
    };
  }

  const before = new Map(previous.map((item) => [item.id, item]));
  const added: string[] = [];
  const changes: ChangeEvent[] = [];
  const items: RadarItem[] = [];

  for (const item of next) {
    const prior = before.get(item.id);

    if (prior === undefined) {
      added.push(item.id);
      items.push({ ...item, status: 'new' });
      continue;
    }

    const fieldChanges = detectFieldChanges(prior, item);
    changes.push(...fieldChanges);

    // contentHash is the authority on "did anything material move". Field
    // changes are the human-readable explanation of it, and the two can
    // legitimately disagree: a summary edit moves the hash without producing
    // a change event worth naming.
    const materiallyChanged = prior.contentHash !== item.contentHash;
    const cancelled = item.campus?.isCancelled === true;
    const superseded = item.research?.lifecycle.isSuperseded === true;

    items.push({
      ...item,
      // The whole point: preserve when Radar FIRST saw this, not when this
      // run saw it. Drives "since your last visit" and the NEW badge.
      firstSeen: prior.firstSeen,
      status: cancelled
        ? 'cancelled'
        : superseded
          ? 'superseded'
          : materiallyChanged || fieldChanges.length > 0
            ? 'updated'
            : 'unchanged',
    });
  }

  const nextIds = new Set(next.map((i) => i.id));
  const removed = previous.filter((item) => !nextIds.has(item.id)).map((item) => item.id);

  return { items, diff: { added, removed, changes } };
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changes.length === 0;
}

export function summarizeDiff(diff: SnapshotDiff): string {
  const parts = [
    `${diff.added.length} added`,
    `${diff.removed.length} removed`,
    `${diff.changes.length} change(s)`,
  ];
  const cancelled = diff.changes.filter((c) => c.kind === 'cancelled').length;
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  const published = diff.changes.filter((c) => c.kind === 'preprint-published').length;
  if (published > 0) parts.push(`${published} preprint(s) published`);
  return parts.join(', ');
}

/**
 * Items the user has not seen, given when they last visited.
 *
 * Compares against `firstSeen`, which only survives because `diffSnapshots`
 * carries it forward. A visitor with no stored timestamp (first ever visit,
 * cleared storage) gets the whole current feed rather than an empty page.
 */
export function itemsSince(items: readonly RadarItem[], lastVisitIso: string | null): RadarItem[] {
  if (lastVisitIso === null) return [...items];
  const cutoff = Date.parse(lastVisitIso);
  if (Number.isNaN(cutoff)) return [...items];
  return items.filter((item) => Date.parse(item.firstSeen) > cutoff || item.status === 'updated');
}
