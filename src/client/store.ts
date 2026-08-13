/**
 * Browser + private owner-vault state: saved, attending, dismissed, tracked,
 * profile preferences, watchlists, and last visit.
 *
 * The browser copy keeps Radar instant and offline-capable. When one of the
 * two provisioned Google accounts is signed in, the same validated record is
 * synchronized to the private harsh.bet owner vault so it follows the owner
 * across devices. Public feed data and ingest jobs never receive this state.
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

export const RADAR_STORAGE_KEY = 'radar:v1';
const CLIENT_ID_KEY = 'harsh.bet/owner-vault:client-id';

/** Feedback on a single item. */
export type Feedback = 'more' | 'less';

export interface RadarState {
  /** ISO timestamp of the previous visit, read on load and rewritten on unload. */
  lastVisit: string | null;
  /** Item ids the user saved. */
  saved: string[];
  /** Campus event ids the user marked as attending. */
  attending: string[];
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
  /** Campus category ids explicitly selected in the Radar profile. */
  preferredCategories: string[];
  /** Interest ids from src/campus/profile.ts selected in the Radar profile. */
  campusInterests: string[];
  /** Lowercased club or organizer names the user follows. */
  followedOrganizers: string[];
  /**
   * Learned per-signal adjustments, keyed by reason signal (e.g. 'organism').
   *
   * This is the interest model actually evolving. Marking things "more like
   * this" nudges the signals that made them score, so the next ingest's feed
   * reorders in the browser without a rebuild.
   */
  signalBias: Record<string, number>;
}

export interface RadarVaultRecord {
  schemaVersion: 1;
  state: RadarState;
  updatedAtMs: number;
  clientId: string;
}

type StateListener = (state: RadarState, record: RadarVaultRecord) => void;
const listeners = new Set<StateListener>();
let observedStamp = 0;

export function emptyState(): RadarState {
  return {
    lastVisit: null,
    saved: [],
    attending: [],
    dismissed: [],
    tracked: [],
    feedback: {},
    authors: [],
    companies: [],
    preferredCategories: [],
    campusInterests: [],
    followedOrganizers: [],
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
    attending: strings(value.attending),
    dismissed: strings(value.dismissed),
    tracked: strings(value.tracked),
    feedback,
    authors: strings(value.authors).map((a) => a.toLowerCase()),
    companies: strings(value.companies).map((c) => c.toLowerCase()),
    preferredCategories: strings(value.preferredCategories),
    campusInterests: strings(value.campusInterests),
    followedOrganizers: strings(value.followedOrganizers).map((name) => name.toLowerCase()),
    signalBias,
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function getClientId(): string {
  const store = storage();
  if (!store) return 'browser-unavailable';
  try {
    const existing = store.getItem(CLIENT_ID_KEY);
    if (existing && existing.length <= 128) return existing;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const next = `radar-${random}`.slice(0, 128);
    store.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return 'browser-storage-blocked';
  }
}

function hasPersonalContent(state: RadarState): boolean {
  return state.saved.length > 0
    || state.attending.length > 0
    || state.dismissed.length > 0
    || state.tracked.length > 0
    || Object.keys(state.feedback).length > 0
    || state.authors.length > 0
    || state.companies.length > 0
    || state.preferredCategories.length > 0
    || state.campusInterests.length > 0
    || state.followedOrganizers.length > 0
    || Object.keys(state.signalBias).length > 0;
}

export function parseRadarVaultRecord(raw: unknown): RadarVaultRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.updatedAtMs) || (value.updatedAtMs as number) < 0) {
    return null;
  }
  const clientId = typeof value.clientId === 'string' && value.clientId.length > 0
    ? value.clientId.slice(0, 128)
    : getClientId();
  return {
    schemaVersion: 1,
    state: coerce(value.state),
    updatedAtMs: value.updatedAtMs as number,
    clientId,
  };
}

function freshRecord(): RadarVaultRecord {
  return { schemaVersion: 1, state: emptyState(), updatedAtMs: 0, clientId: getClientId() };
}

function readRecord(): RadarVaultRecord {
  const store = storage();
  if (!store) return freshRecord();
  try {
    const raw = store.getItem(RADAR_STORAGE_KEY);
    if (raw === null) return freshRecord();
    const parsed: unknown = JSON.parse(raw);
    const current = parseRadarVaultRecord(parsed);
    if (current) return current;
    // v1 stored the bare RadarState. Preserve meaningful lists and interests
    // during the one-time owner-vault migration.
    const state = coerce(parsed);
    return {
      schemaVersion: 1,
      state,
      updatedAtMs: hasPersonalContent(state) ? Date.now() : 0,
      clientId: getClientId(),
    };
  } catch {
    return freshRecord();
  }
}

function writeRecord(record: RadarVaultRecord, notify = true): void {
  observedStamp = Math.max(observedStamp, record.updatedAtMs);
  try {
    storage()?.setItem(RADAR_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The in-memory UI still works when persistence is blocked.
  }
  if (notify) for (const listener of [...listeners]) listener(record.state, record);
}

function mintStamp(): number {
  const next = Math.max(Date.now(), observedStamp + 1);
  observedStamp = next;
  return next;
}

export function loadRadarVaultRecord(): RadarVaultRecord {
  const record = readRecord();
  observedStamp = Math.max(observedStamp, record.updatedAtMs);
  return structuredClone(record);
}

export function loadState(): RadarState {
  return loadRadarVaultRecord().state;
}

export function saveState(state: RadarState, options: { visitOnly?: boolean } = {}): void {
  const previous = readRecord();
  const record: RadarVaultRecord = {
    schemaVersion: 1,
    state: coerce(state),
    updatedAtMs: options.visitOnly === true ? previous.updatedAtMs : mintStamp(),
    clientId: previous.clientId || getClientId(),
  };
  writeRecord(record);
}

export function applyRemoteRadarRecord(raw: unknown): RadarVaultRecord | null {
  const record = parseRadarVaultRecord(raw);
  if (!record) return null;
  writeRecord(record);
  return structuredClone(record);
}

export function subscribeRadarState(listener: StateListener): () => void {
  listeners.add(listener);
  const record = loadRadarVaultRecord();
  listener(record.state, record);
  return () => listeners.delete(listener);
}

export function hasMeaningfulRadarRecord(record: RadarVaultRecord): boolean {
  return record.state.lastVisit !== null || hasPersonalContent(record.state);
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

export function toggleAttending(state: RadarState, id: string): RadarState {
  // Attendance and interest are separate choices. Both restore a dismissed
  // event, but neither silently changes the other status.
  const attending = toggle(state.attending, id);
  const going = attending.includes(id);
  return {
    ...state,
    attending,
    dismissed: going ? state.dismissed.filter((entry) => entry !== id) : state.dismissed,
  };
}

export function toggleDismissed(state: RadarState, id: string): RadarState {
  const dismissed = toggle(state.dismissed, id);
  const hiding = dismissed.includes(id);
  return {
    ...state,
    dismissed,
    saved: hiding ? state.saved.filter((entry) => entry !== id) : state.saved,
    attending: hiding ? state.attending.filter((entry) => entry !== id) : state.attending,
  };
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

  return {
    ...state,
    feedback,
    signalBias,
    dismissed,
    saved: verdict === 'less' ? state.saved.filter((entry) => entry !== id) : state.saved,
    attending: verdict === 'less' ? state.attending.filter((entry) => entry !== id) : state.attending,
  };
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

export function togglePreferredCategory(state: RadarState, category: string): RadarState {
  return { ...state, preferredCategories: toggle(state.preferredCategories, category) };
}

export function toggleCampusInterest(state: RadarState, interest: string): RadarState {
  return { ...state, campusInterests: toggle(state.campusInterests, interest) };
}

export function followOrganizer(state: RadarState, name: string): RadarState {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return state;
  return { ...state, followedOrganizers: toggle(state.followedOrganizers, key) };
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
  const previous = readRecord();
  writeRecord({
    schemaVersion: 1,
    state: emptyState(),
    updatedAtMs: mintStamp(),
    clientId: previous.clientId || getClientId(),
  });
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
