/**
 * Browser-side state: saved, dismissed, tracked, watchlists, and last visit.
 *
 * WHY THIS IS IN THE BROWSER AT ALL. Radar is a static site - there is no
 * server and no account - so anything personal has to live in the visitor's
 * own storage. That is a genuine feature, not a workaround: the reading
 * history of someone's research and the campus events they are interested in
 * are exactly the sort of thing that should not be sitting in someone else's
 * database. Nothing here is ever transmitted anywhere.
 *
 * The one thing this design has to get right is that item ids are STABLE
 * across ingests. They are derived from an item's identity (DOI, LiveWhale
 * event id) rather than its content, so an event that changes rooms keeps its
 * id and keeps whatever the user did with it. See `src/core/normalize.ts`.
 *
 * Everything here is defensive. localStorage can be disabled, full, or hold
 * data written by an older version of this file, and none of those are worth
 * an exception in a page's critical path.
 */

const STORAGE_KEY = 'radar:v1';

/** Feedback on a single item. */
export type Feedback = 'more' | 'less';

export interface RadarState {
  /** ISO timestamp of the previous visit, read on load and rewritten on unload. */
  lastVisit: string | null;
  /** Item ids the user saved. */
  saved: string[];
  /** Item ids the user dismissed. Hidden from feeds but not forgotten. */
  dismissed: string[];
  /** Item ids to watch for changes (tracked papers, events). */
  tracked: string[];
  /** Per-item feedback, keyed by item id. */
  feedback: Record<string, Feedback>;
  /** Lowercased author names to watch. */
  authors: string[];
  /** Lowercased employer names to watch. */
  companies: string[];
  /**
   * Learned per-signal adjustments, keyed by reason signal (e.g. 'organism').
   *
   * This is the interest model actually evolving. Marking things "more like
   * this" nudges the signals that made them score, so the next ingest's feed
   * reorders in the browser without a rebuild.
   */
  signalBias: Record<string, number>;
}

function emptyState(): RadarState {
  return {
    lastVisit: null,
    saved: [],
    dismissed: [],
    tracked: [],
    feedback: {},
    authors: [],
    companies: [],
    signalBias: {},
  };
}

/** Coerce whatever is in storage into a valid state, field by field. */
function coerce(raw: unknown): RadarState {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Partial<RadarState>;

  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((v): v is string => typeof v === 'string') : [];

  const feedback: Record<string, Feedback> = {};
  if (typeof value.feedback === 'object' && value.feedback !== null) {
    for (const [key, entry] of Object.entries(value.feedback)) {
      if (entry === 'more' || entry === 'less') feedback[key] = entry;
    }
  }

  const signalBias: Record<string, number> = {};
  if (typeof value.signalBias === 'object' && value.signalBias !== null) {
    for (const [key, entry] of Object.entries(value.signalBias)) {
      // Clamp on read as well as on write: a corrupted or hand-edited value
      // must not be able to pin one signal to the top of every feed forever.
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        signalBias[key] = Math.max(-20, Math.min(20, entry));
      }
    }
  }

  return {
    lastVisit: typeof value.lastVisit === 'string' ? value.lastVisit : null,
    saved: strings(value.saved),
    dismissed: strings(value.dismissed),
    tracked: strings(value.tracked),
    feedback,
    authors: strings(value.authors).map((a) => a.toLowerCase()),
    companies: strings(value.companies).map((c) => c.toLowerCase()),
    signalBias,
  };
}

export function loadState(): RadarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? emptyState() : coerce(JSON.parse(raw));
  } catch {
    // Private browsing, disabled storage, or malformed JSON. A fresh state is
    // a fine outcome; a thrown exception on page load is not.
    return emptyState();
  }
}

export function saveState(state: RadarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled. The UI has already updated
    // optimistically; losing persistence is better than losing the page.
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

export function toggleSaved(state: RadarState, id: string): RadarState {
  // Saving something you previously dismissed should un-dismiss it - the two
  // are contradictory and the newer action is the one that means something.
  return { ...state, saved: toggle(state.saved, id), dismissed: state.dismissed.filter((d) => d !== id) };
}

export function toggleDismissed(state: RadarState, id: string): RadarState {
  return { ...state, dismissed: toggle(state.dismissed, id), saved: state.saved.filter((s) => s !== id) };
}

export function toggleTracked(state: RadarState, id: string): RadarState {
  return { ...state, tracked: toggle(state.tracked, id) };
}

/** How much one feedback event moves a signal's bias. */
const BIAS_STEP = 2;
const BIAS_LIMIT = 20;

/**
 * Record feedback and nudge the signals responsible.
 *
 * The signals come from the item's own `reasons`, so the model can only ever
 * learn about things the ranker actually credited - it cannot invent a
 * preference the user never expressed through an item.
 */
export function applyFeedback(
  state: RadarState,
  id: string,
  verdict: Feedback,
  signals: readonly string[],
): RadarState {
  const direction = verdict === 'more' ? BIAS_STEP : -BIAS_STEP;
  const signalBias = { ...state.signalBias };

  for (const signal of signals) {
    const next = (signalBias[signal] ?? 0) + direction;
    signalBias[signal] = Math.max(-BIAS_LIMIT, Math.min(BIAS_LIMIT, next));
  }

  const feedback = { ...state.feedback, [id]: verdict };
  // "Less like this" implies dismissal of the item in front of you.
  const dismissed = verdict === 'less' && !state.dismissed.includes(id) ? [...state.dismissed, id] : state.dismissed;

  return { ...state, feedback, signalBias, dismissed };
}

export function watchAuthor(state: RadarState, name: string): RadarState {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return state;
  return { ...state, authors: toggle(state.authors, key) };
}

export function watchCompany(state: RadarState, name: string): RadarState {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return state;
  return { ...state, companies: toggle(state.companies, key) };
}

/**
 * Read the previous visit and stamp the current one.
 *
 * Returns the PREVIOUS value, because "since your last visit" means since the
 * one before this one. Stamping on load rather than unload is deliberate:
 * unload handlers are unreliable on mobile, and the failure mode of stamping
 * early (a reload shows nothing new) is much milder than never stamping at all
 * (every visit reports the whole corpus as new, forever).
 */
export function touchVisit(state: RadarState): { previous: string | null; state: RadarState } {
  const previous = state.lastVisit;
  return { previous, state: { ...state, lastVisit: new Date().toISOString() } };
}

export function clearAll(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the page will behave as a fresh visitor.
  }
}

/** Export state as a downloadable blob, so it is the user's to keep. */
export function exportState(state: RadarState): string {
  return JSON.stringify(state, null, 2);
}

export function importState(json: string): RadarState | null {
  try {
    return coerce(JSON.parse(json));
  } catch {
    return null;
  }
}
