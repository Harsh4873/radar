/**
 * THE CENTRAL CONTRACT.
 *
 * Every connector, ranker, and page in this project codes against the types in
 * this file. Treat changes here as breaking changes.
 *
 * The design premise: ResearchRadar and CampusRadar are the same machine
 * pointed at different data. Both produce `RadarItem`s and both go through one
 * pipeline - normalize, dedupe, enrich, rank, diff. Anything vertical-specific
 * hangs off the optional `research` / `campus` facet rather than forking the
 * pipeline. If you find yourself writing `if (vertical === ...)` inside
 * `src/core/`, the abstraction has sprung a leak; push the difference down
 * into the vertical's scorer instead.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type Vertical = 'research' | 'campus';

export const VERTICALS: readonly Vertical[] = ['research', 'campus'] as const;

/**
 * What happened to this item between the previous snapshot and this one.
 *
 * This is the whole point of Radar. "What's new?" is answerable by any RSS
 * reader; "what CHANGED?" requires keeping the previous snapshot and diffing
 * against it, which is what `src/core/change.ts` does.
 *
 *   new         not present in the previous snapshot
 *   updated     present, but a watched field moved (see ChangeEvent)
 *   unchanged   present and materially identical
 *   cancelled   upstream flagged it cancelled (campus) or withdrawn (research)
 *   superseded  replaced by a newer canonical item - a preprint that has since
 *               been published, or a duplicate event folded into a canonical one
 */
export type ItemStatus = 'new' | 'updated' | 'unchanged' | 'cancelled' | 'superseded';

/** Every upstream Radar knows how to read. Also the Source Manager's key space. */
export type SourceId =
  // research
  | 'pubmed'
  | 'europepmc'
  | 'biorxiv'
  | 'medrxiv'
  | 'crossref'
  | 'openalex'
  | 'arxiv'
  // campus
  | 'tamu-calendar'
  | 'aggie-research-volunteers'
  | 'getinvolved';

/** Where the data in a given run actually came from. Always report this. */
export type FetchSource = 'network' | 'fixture' | 'cache' | 'empty';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * One upstream's view of an item.
 *
 * An item deduped across four feeds keeps four of these. That is deliberate:
 * "3 sources confirm this event" is a ranking signal AND the thing the UI
 * shows instead of four near-identical cards.
 */
export interface ItemSource {
  source: SourceId;
  /** Upstream's own identifier, as a string. PMID, DOI, LiveWhale event id. */
  externalId: string;
  /** Human-facing link back to the canonical page on the upstream. */
  url: string;
  /** Feed / group / query this came through, e.g. 'College of Engineering'. */
  channel: string | null;
  /** ISO 8601. When Radar first saw the item through THIS source. */
  firstSeen: string;
  /** Upstream's own last-modified, when it publishes one. */
  lastModified: string | null;
}

/**
 * A single scoring signal with its contribution, ready to render verbatim.
 *
 * The product requirement is that ranking is interpretable: the card shows
 * `+28 M. tuberculosis`, not a bare 92%. Scorers must therefore emit a reason
 * for every point they award. `src/core/rank.ts` asserts that the reasons sum
 * to the score, so a silent unexplained bonus is a test failure.
 */
export interface RelevanceReason {
  /** Machine-readable signal family, e.g. 'organism', 'method', 'food'. */
  signal: string;
  /** Rendered label, e.g. 'M. tuberculosis' or 'cites tracked literature'. */
  label: string;
  /** Points contributed. May be negative (dismissed topics, stale events). */
  points: number;
}

// ---------------------------------------------------------------------------
// The shared item
// ---------------------------------------------------------------------------

export interface RadarItem {
  /**
   * Stable across runs: `${vertical}-${12 hex of identityHash}`. Derived from
   * the item's identity (DOI / event key), NOT from its content, so an event
   * that changes rooms keeps its id and its saved/dismissed state.
   */
  id: string;
  vertical: Vertical;

  title: string;
  /** Plain text. HTML stripped, entities decoded, whitespace collapsed. */
  summary: string;
  /** Canonical destination for "open this". */
  url: string;

  /**
   * Every strong identity key this item is known by, e.g.
   * `['doi:10.1038/ng.2747', 'pmid:23995135']`. Carried on the item rather
   * than kept in a side table because `dedupe.ts` unions across the whole set
   * (source A has the DOI, source B only the PMID, a third links them), and
   * the paper page renders them as cross-references.
   */
  identity: string[];

  /** Every upstream that confirmed this item. Never empty. */
  sources: ItemSource[];
  /**
   * 0..1. Rises with independent confirmations and with how authoritative the
   * confirming sources are. A single scraped mention is not a fact.
   */
  sourceConfidence: number;

  firstSeen: string;
  lastSeen: string;
  lastModified: string | null;

  /**
   * The date the item is ABOUT: publication date for a paper, start time for
   * an event. Null when upstream gives nothing trustworthy. Ranking treats
   * null as "unknown", never as "now".
   */
  occurredAt: string | null;
  /** End of an event's window. Null for papers and point-in-time events. */
  endsAt: string | null;

  tags: string[];

  /** 0..100. */
  relevance: number;
  reasons: RelevanceReason[];

  status: ItemStatus;
  /**
   * Hash of the fields that, if they move, mean "this item changed".
   * Deliberately excludes volatile decoration (thumbnails, view counts).
   */
  contentHash: string;

  research?: ResearchFacet;
  campus?: CampusFacet;
}

// ---------------------------------------------------------------------------
// Research facet
// ---------------------------------------------------------------------------

export type WorkKind = 'journal-article' | 'preprint' | 'review' | 'dataset' | 'other';

/** Radar's three-band verdict. Drives the red/amber/green counts on the home page. */
export type ResearchBand = 'core' | 'adjacent' | 'methods';

export interface ResearchAuthor {
  name: string;
  /** ORCID iD when the upstream supplies one. */
  orcid: string | null;
  affiliation: string | null;
}

/**
 * Where a work sits on the preprint -> published track.
 *
 * bioRxiv's API reports `published` as a DOI once a preprint reaches a
 * journal, which is what lets Radar collapse
 *   NEW PREPRINT -> REVISED PREPRINT -> PEER-REVIEWED PUBLICATION
 * into one tracked item with a history, instead of three discoveries.
 */
export interface WorkLifecycle {
  /** Highest preprint version seen, e.g. 2 for v2. Null for non-preprints. */
  preprintVersion: number | null;
  /** DOI of the peer-reviewed version, once one exists. */
  publishedDoi: string | null;
  /** Journal name of the published version. */
  publishedIn: string | null;
  /** True once Radar has linked a preprint to its published counterpart. */
  isSuperseded: boolean;
}

export interface ResearchFacet {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  openAlexId: string | null;

  kind: WorkKind;
  band: ResearchBand;

  journal: string | null;
  authors: ResearchAuthor[];
  /** Papers can be long; the full abstract lives here, `summary` is clamped. */
  abstract: string;

  publishedDate: string | null;
  citedByCount: number | null;
  isOpenAccess: boolean;
  /** Only set when the upstream declares an OA licence. Never guessed. */
  openAccessUrl: string | null;

  /** Concept/topic labels, mostly from OpenAlex. */
  topics: string[];
  /** DOIs this work cites that the user has saved or tracked. */
  citesTracked: string[];

  lifecycle: WorkLifecycle;
}

// ---------------------------------------------------------------------------
// Campus facet
// ---------------------------------------------------------------------------

export type CampusCategory =
  | 'companies'
  | 'sports'
  | 'clubs'
  | 'research'
  | 'academic'
  | 'deadline'
  | 'community';

/**
 * Free-food confidence. THIS DISTINCTION IS LOAD-BEARING.
 *
 * Telling someone there is free pizza when the flyer only said "pizza" sends
 * them across campus for nothing. The tiers map to what the source text
 * actually supports, and the UI must never flatten them into "FREE FOOD":
 *
 *   confirmed  explicit: "free pizza", "free food", "lunch provided at no cost"
 *   provided   food is stated as provided, cost unstated: "lunch provided"
 *   mentioned  a food word appears, provision unclear: "coffee chat"
 *   none       no food signal
 */
export type FoodConfidence = 'confirmed' | 'provided' | 'mentioned' | 'none';

export interface FoodSignal {
  confidence: FoodConfidence;
  /** The specific foods named, e.g. ['kolaches']. */
  items: string[];
  /** The exact source phrase that triggered the classification. Auditable. */
  evidence: string | null;
}

export interface CampusFacet {
  category: CampusCategory;

  startsAt: string | null;
  endsAt: string | null;
  isAllDay: boolean;
  /** Upstream said this was cancelled. Radar keeps it, struck through. */
  isCancelled: boolean;

  isOnline: boolean;
  onlineUrl: string | null;
  location: string | null;
  /** [lat, lon] when upstream geocodes it. */
  coordinates: [number, number] | null;

  /** Owning group, e.g. 'Career Center'. */
  organizer: string | null;
  /** Upstream's own audience labels, e.g. ['Students', 'Graduate Students']. */
  audience: string[];
  eventTypes: string[];

  /** Employers named in the title/description, e.g. ['NVIDIA']. */
  companies: string[];

  food: FoodSignal;

  /** Free-text cost as published. Null when upstream said nothing. */
  cost: string | null;
  hasRegistration: boolean;

  /** Legacy compatibility only. Participant-study records are filtered before publish. */
  compensation: string | null;
  /** Parsed dollar figure when the text yields one unambiguously. */
  compensationUsd: number | null;

  /** A registration/application cutoff, when the item is a deadline. */
  deadlineAt: string | null;

  /**
   * How many calendar entries this card represents.
   *
   * 1 for an ordinary event. Higher when Radar folded a multi-day or recurring
   * series into one card - a five-day conference that LiveWhale publishes as
   * five separate events with five ids, or a weekly seminar. `startsAt` is
   * then the first occurrence and `endsAt` the last. See `collapseSeries`.
   */
  seriesCount: number;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export type ChangeKind =
  | 'added'
  | 'removed'
  | 'title'
  | 'time'
  | 'location'
  | 'cancelled'
  | 'uncancelled'
  | 'registration-opened'
  | 'preprint-revised'
  | 'preprint-published'
  | 'summary';

/** One field-level difference, rendered as "Room changed: Zachry 297 -> 420". */
export interface ChangeEvent {
  itemId: string;
  kind: ChangeKind;
  /** Human label for the field, e.g. 'Room'. */
  field: string;
  before: string | null;
  after: string | null;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changes: ChangeEvent[];
}

// ---------------------------------------------------------------------------
// Source health
// ---------------------------------------------------------------------------

export type SourceStatus = 'ok' | 'degraded' | 'failed' | 'unavailable';

/**
 * One row of the Source Manager at /radar/campus/sources/.
 *
 * `unavailable` is not a failure - it means Radar knows about the source and
 * has determined there is no stable programmatic way in. IMLeagues is the
 * current campus example: it documents a useful API, but Texas A&M's network
 * data requires approved OAuth partner credentials. Saying so on the page is
 * more useful than a green light backed by private SPA calls.
 */
export interface SourceReport {
  id: SourceId;
  label: string;
  vertical: Vertical;
  status: SourceStatus;
  /** Items this source contributed, before dedupe. */
  itemCount: number;
  fetchSource: FetchSource;
  /** Wall-clock ms for the whole read, including retries. */
  durationMs: number;
  /**
   * Requests (queries, feeds, pages) that failed this run.
   *
   * Distinct from `status`, and the distinction is load-bearing: a source can
   * be `degraded` for reasons that are not a fetch failure at all - the TAMU
   * calendar reports a coverage note about its 1000-record cap on every
   * healthy run. Only a NON-ZERO count here means "this source did not deliver
   * everything it has", which is what `retainUnfetched` keys off.
   */
  failedRequests: number;

  /** Why it is degraded/failed/unavailable. Shown verbatim in the UI. */
  note: string | null;
  /** Public documentation, so the page can link out. */
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Snapshots - what ingest writes and pages import
// ---------------------------------------------------------------------------

export interface VerticalSnapshot {
  vertical: Vertical;
  /** ISO 8601 of the ingest run. */
  fetchedAt: string;
  /** Candidates seen across all sources before any filtering. */
  scanned: number;
  /** Survivors of the relevance floor. */
  matched: number;
  items: RadarItem[];
  diff: SnapshotDiff;
  sources: SourceReport[];
}

/**
 * The weekly ritual. Built at ingest time from the last 7 days of items so the
 * digest is a stable artifact rather than something recomputed per page view.
 */
export interface Digest {
  /** ISO date of the Monday this digest covers. */
  weekOf: string;
  vertical: Vertical;
  scanned: number;
  candidates: number;
  /** Item ids, highest relevance first. */
  recommended: string[];
  /** One-line hooks, index-aligned with `recommended`. */
  headlines: string[];
  /** Notable changes during the week. */
  changes: ChangeEvent[];
  /** Sum of per-item reading estimates, minutes. Research only. */
  estimatedMinutes: number;
}

/** The root snapshot: everything the site is built from. */
export interface RadarSnapshot {
  fetchedAt: string;
  research: VerticalSnapshot;
  campus: VerticalSnapshot;
  digests: Digest[];
}

// ---------------------------------------------------------------------------
// Ingest plumbing
// ---------------------------------------------------------------------------

/** What a connector hands back. Connectors never throw; they report. */
export interface SourceResult<T> {
  source: SourceId;
  records: T[];
  fetchSource: FetchSource;
  warnings: string[];
  error: string | null;
  durationMs: number;
  /** Requests that failed. 0 on a clean run. See `SourceReport.failedRequests`. */
  failedRequests: number;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * A normalized item before dedupe/rank. Connectors produce these; the core
 * pipeline turns them into `RadarItem`s.
 *
 * `identity` is the dedupe key material - see `src/core/dedupe.ts`. A connector
 * that cannot supply at least one strong identity key still works, it just
 * falls back to fuzzy title+time matching.
 */
export interface RawItem {
  vertical: Vertical;
  source: SourceId;
  externalId: string;
  channel: string | null;
  url: string;
  title: string;
  summary: string;
  occurredAt: string | null;
  endsAt: string | null;
  lastModified: string | null;
  tags: string[];
  /** Strong identity keys, e.g. ['doi:10.1101/2026.07.31.741992']. */
  identity: string[];
  research?: RawResearchFacet;
  campus?: RawCampusFacet;
}

/**
 * Facets as connectors emit them.
 *
 * Mostly `Partial` - a connector fills in whatever its upstream knows and
 * `normalize.ts` supplies defaults for the rest - EXCEPT the fields every
 * connector genuinely always sets. Marking those required is not pedantry: as
 * plain `Partial`, `lifecycle` and `food` are optional everywhere downstream,
 * so every read needs a `?.` that can never actually be null, and the real
 * optional fields stop standing out.
 *
 * `band` is excluded because it is a verdict, not source data: the scorer
 * assigns it after matching, so a connector has no business setting it.
 */
export type RawResearchFacet = Partial<Omit<ResearchFacet, 'lifecycle' | 'band'>> & {
  lifecycle: WorkLifecycle;
};

export type RawCampusFacet = Partial<Omit<CampusFacet, 'food'>> & {
  food: FoodSignal;
};
