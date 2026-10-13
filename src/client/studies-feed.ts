/**
 * Filtering, sorting and eligibility. Plain DOM, no framework.
 *
 * Two deliberate choices:
 *
 *  - Eligibility verdicts are computed by importing the project's own
 *    `checkEligibility`, not by reimplementing it here. A second copy of
 *    those rules would drift, and drift in this particular function means
 *    telling someone they cannot do a study they can do.
 *
 *  - The pay and time filters exclude studies whose figures are unknown,
 *    because an unknown value cannot be shown to clear a threshold. That
 *    silently hides real opportunities, so the page counts them and says so
 *    out loud instead of letting them vanish.
 */
import { checkEligibility } from '@/studies/parse-eligibility.ts';
import {
  DEFAULT_STUDIES_FILTERS,
  loadStudiesState,
  subscribeStudiesState,
  toggleStudyDismissed,
  toggleStudySaved,
  updateStudiesFilters,
  type StudiesFilters,
  type StudiesPersonalState,
} from '@/studies/personal-state.ts';
import * as profileModule from '@/studies/profile.ts';
import type { ParsedEligibility, UserProfile } from '@/studies/types.ts';

type ProfileApi = {
  getProfile?: () => UserProfile;
  subscribe?: (cb: (p: UserProfile) => void) => (() => void) | void;
};
// Namespace import + duck typing: the profile module is owned by another
// part of the project, and a renamed export should degrade to "no
// eligibility filtering", not a blank page.
const profileApi = profileModule as ProfileApi;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const form = $<HTMLFormElement>('filters');
const qInput = $<HTMLInputElement>('f-q');
const formatSel = $<HTMLSelectElement>('f-format');
const rateSel = $<HTMLSelectElement>('f-rate');
const totalSel = $<HTMLSelectElement>('f-total');
const hoursSel = $<HTMLSelectElement>('f-hours');
const sortSel = $<HTMLSelectElement>('f-sort');
const eligibleBox = $<HTMLInputElement>('f-eligible');
const eligibleHint = $<HTMLElement>('f-eligible-hint');
const tagBox = $<HTMLElement>('f-tags');
const summary = $<HTMLElement>('f-summary');
const unknownNote = $<HTMLElement>('unknown-note');
const emptyState = $<HTMLElement>('empty-state');
const sectionRanked = $<HTMLElement>('section-ranked');
const sectionUnrated = $<HTMLElement>('section-unrated');
const expiredBlock = $<HTMLDetailsElement>('expired-block');
const dismissedToggle = document.querySelector<HTMLElement>('[data-show-dismissed]');
const TAB_IDS = new Set(['all', 'ranked', 'online', 'inperson', 'saved']);
let studyTab = 'all';
let showDismissed = false;

const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-study]'));
const liveCards = cards.filter((c) => c.dataset.expired !== '1');
const deadCards = cards.filter((c) => c.dataset.expired === '1');

let eligibility: Record<string, ParsedEligibility> = {};
try {
  const blob = document.getElementById('elig-data')?.textContent ?? '{}';
  eligibility = JSON.parse(blob) as Record<string, ParsedEligibility>;
} catch {
  eligibility = {};
}

const selectedTags = new Set<string>();
let personalState = loadStudiesState();

function paintPersonalState(state: StudiesPersonalState): void {
  for (const card of cards) {
    const id = card.dataset.id ?? '';
    const saved = state.saved.includes(id);
    const dismissed = state.dismissed.includes(id);
    card.classList.toggle('is-saved', saved);
    card.classList.toggle('is-dismissed', dismissed);
    card.querySelector<HTMLElement>('[data-study-action="save"]')
      ?.setAttribute('aria-pressed', saved ? 'true' : 'false');
    card.querySelector<HTMLElement>('[data-study-action="dismiss"]')
      ?.setAttribute('aria-pressed', dismissed ? 'true' : 'false');
  }
}

/** '' for an absent numeric data attribute, so `Number('')` is never used. */
const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// -- sorting --------------------------------------------------------------

type Key = (c: HTMLElement) => number | null;
const KEYS: Record<string, { key: Key; dir: 1 | -1 }> = {
  rate: { key: (c) => num(c.dataset.rate), dir: -1 },
  total: { key: (c) => num(c.dataset.total), dir: -1 },
  time: { key: (c) => num(c.dataset.hours), dir: 1 },
  new: { key: (c) => num(c.dataset.posted), dir: -1 },
};

function sortList(list: HTMLElement | null, mode: string): void {
  if (list === null) return;
  const spec = KEYS[mode] ?? KEYS.rate!;
  const items = Array.from(list.children) as HTMLElement[];
  // Unknown values always sink, in both directions. An unmeasured study is
  // not a cheap one, a quick one, or a new one.
  items.sort((a, b) => {
    const av = spec.key(a);
    const bv = spec.key(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * spec.dir;
  });
  for (const item of items) list.appendChild(item);
}

// -- eligibility ----------------------------------------------------------

let profileAnswered = false;

function applyProfile(profile: UserProfile | null): void {
  profileAnswered =
    profile !== null && Object.values(profile).some((v) => v !== null && v !== undefined);

  for (const card of cards) {
    const parsed = eligibility[card.dataset.id ?? ''];
    const target = card.querySelector<HTMLElement>('[data-verdict]');
    if (parsed === undefined || profile === null || !profileAnswered) {
      card.dataset.eligibility = 'unknown';
      if (target !== null) {
        target.hidden = true;
        target.textContent = '';
      }
      continue;
    }

    let status = 'unknown';
    let reason = '';
    try {
      const verdict = checkEligibility(parsed, profile);
      status = verdict.status;
      reason = verdict.reasons[0] ?? '';
    } catch {
      status = 'unknown';
    }
    card.dataset.eligibility = status;

    if (target !== null) {
      // Only a hard conflict is worth interrupting the card for. 'unknown'
      // is the normal state of a partly-filled profile and saying so on
      // every card would train the eye to ignore the message.
      if (status === 'ineligible') {
        target.className = 'verdict verdict-ineligible';
        target.textContent = `Probably not eligible: ${reason}`;
        target.hidden = false;
      } else {
        target.hidden = true;
        target.textContent = '';
      }
    }
  }

  if (eligibleBox !== null) {
    eligibleBox.disabled = !profileAnswered;
    eligibleBox.checked = profileAnswered && personalState.filters.eligibleOnly;
  }
  if (eligibleHint !== null) {
    eligibleHint.textContent = profileAnswered
      ? 'Based on the screening profile saved in this browser. Studies that cannot be checked stay visible.'
      : 'Answer the screening questions on the Profile tab first. They stay local unless you sign in to the private owner vault.';
  }
  apply();
}

// -- filtering ------------------------------------------------------------

let hiddenForUnknown = 0;
let advancedFiltersWereActive = false;

function matches(card: HTMLElement, words: string[], count: boolean): boolean {
  if (personalState.dismissed.includes(card.dataset.id ?? '') && !showDismissed) {
    return false;
  }
  const haystack = card.dataset.search ?? '';
  for (const w of words) if (!haystack.includes(w)) return false;

  if (studyTab === 'ranked' && card.dataset.rate === '') return false;
  if (formatSel?.value === 'online' && card.dataset.online !== '1') return false;
  if (formatSel?.value === 'inperson' && card.dataset.inperson !== '1') return false;
  if (studyTab === 'saved' && !personalState.saved.includes(card.dataset.id ?? '')) return false;

  if (selectedTags.size > 0) {
    const tags = (card.dataset.tags ?? '').split(' ');
    if (!tags.some((t) => selectedTags.has(t))) return false;
  }

  if (eligibleBox?.checked === true && card.dataset.eligibility === 'ineligible') return false;

  // Numeric thresholds last, so "hidden only because a figure is unknown"
  // is a claim we can actually make about this card.
  const minRate = Number(rateSel?.value ?? '0') || 0;
  const minTotal = Number(totalSel?.value ?? '0') || 0;
  const maxHours = num(hoursSel?.value);

  const rate = num(card.dataset.rate);
  const total = num(card.dataset.total);
  const hrs = num(card.dataset.hours);

  let unknownBlocked = false;
  if (minRate > 0) {
    if (rate === null) unknownBlocked = true;
    else if (rate < minRate) return false;
  }
  if (minTotal > 0) {
    if (total === null) unknownBlocked = true;
    else if (total < minTotal) return false;
  }
  if (maxHours !== null) {
    if (hrs === null) unknownBlocked = true;
    else if (hrs > maxHours) return false;
  }
  if (unknownBlocked) {
    // Only live studies are counted: the expired block is collapsed by
    // default, so counting them would inflate a number nobody can act on.
    if (count) hiddenForUnknown += 1;
    return false;
  }

  return true;
}

function apply(): void {
  const words = (qInput?.value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w !== '');

  hiddenForUnknown = 0;

  let visibleLive = 0;
  for (const card of liveCards) {
    const ok = matches(card, words, true);
    card.hidden = !ok;
    if (ok) visibleLive += 1;
  }

  let visibleDead = 0;
  for (const card of deadCards) {
    const ok = matches(card, words, false);
    card.hidden = !ok;
    if (ok) visibleDead += 1;
  }

  const rankedVisible = liveCards.filter((c) => !c.hidden && c.dataset.rate !== '').length;
  const unratedVisible = visibleLive - rankedVisible;

  if (sectionRanked !== null) sectionRanked.hidden = rankedVisible === 0;
  if (sectionUnrated !== null) sectionUnrated.hidden = unratedVisible === 0;
  if (emptyState !== null) emptyState.hidden = visibleLive > 0;

  for (const counter of document.querySelectorAll<HTMLElement>('[data-count-for="visible"]')) {
    counter.textContent = String(visibleLive);
  }
  const noun = visibleLive === 1 ? 'study' : 'studies';
  const query = (qInput?.value ?? '').trim();
  document.querySelector('[data-clear-search]')?.toggleAttribute('hidden', query.length === 0);
  for (const status of document.querySelectorAll<HTMLElement>('[data-search-summary]')) {
    status.textContent = query.length > 0
      ? `${visibleLive} ${noun} match “${query}”.`
      : `${visibleLive} ${noun} shown.`;
  }
  if (summary !== null) summary.textContent = `${visibleLive} shown`;
  const activeFilters = [
    Number(rateSel?.value ?? 0) > 0, Number(totalSel?.value ?? 0) > 0,
    Boolean(hoursSel?.value), (sortSel?.value ?? 'rate') !== 'rate',
    selectedTags.size > 0, eligibleBox?.checked === true,
  ].filter(Boolean).length;
  const filterCount = document.querySelector<HTMLElement>('[data-active-study-filters]');
  if (filterCount !== null) filterCount.textContent = activeFilters > 0 ? `· ${activeFilters} active` : '';
  const advanced = document.querySelector<HTMLDetailsElement>('[data-study-filters]');
  // Open when a pay, time, or study-type filter turns on. Later updates
  // (search, save, tab) must not pop the disclosure back open.
  if (advanced !== null && activeFilters > 0 && !advancedFiltersWereActive) advanced.open = true;
  advancedFiltersWereActive = activeFilters > 0;
  writeFiltersToUrl();


  if (unknownNote !== null) {
    if (hiddenForUnknown > 0) {
      unknownNote.hidden = false;
      unknownNote.textContent =
        `${hiddenForUnknown} ${hiddenForUnknown === 1 ? 'study is' : 'studies are'} hidden ` +
        'only because the listing never stated a figure the pay or time filter could check. ' +
        'They are not necessarily bad deals. Clear those filters to see them.';
    } else {
      unknownNote.hidden = true;
    }
  }

  if (expiredBlock !== null) {
    const label = expiredBlock.querySelector('summary');
    if (label !== null) {
      label.textContent =
        visibleDead === deadCards.length
          ? `Show ${deadCards.length} expired postings`
          : `Show ${visibleDead} of ${deadCards.length} expired postings (filtered)`;
    }
    expiredBlock.hidden = deadCards.length === 0;
  }
}

function resort(): void {
  const mode = sortSel?.value ?? 'rate';
  sortList($('list-ranked'), mode);
  sortList($('list-unrated'), mode);
  sortList($('list-expired'), mode);
}

function optionOr(select: HTMLSelectElement | null, value: string | null, fallback: string): string {
  if (value === null || select === null) return fallback;
  return [...select.options].some((option) => option.value === value) ? value : fallback;
}

/** Shared-link params. Absent means this URL is not trying to reproduce a filter set. */
function filtersFromSearch(params: URLSearchParams): StudiesFilters | null {
  const keys = ['q', 'rate', 'total', 'hours', 'sort', 'tags', 'eligible', 'dismissed', 'format'];
  if (!keys.some((key) => params.has(key))) return null;
  const sort = params.get('sort');
  const format = params.get('format');
  const tags = (params.get('tags') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tagBox?.querySelector(`[data-tag="${CSS.escape(tag)}"]`) != null);
  return {
    query: (params.get('q') ?? '').slice(0, 300),
    minRate: optionOr(rateSel, params.get('rate'), '0'),
    minTotal: optionOr(totalSel, params.get('total'), '0'),
    maxHours: optionOr(hoursSel, params.get('hours'), ''),
    mode: format === 'online' || format === 'inperson' ? format : 'any',
    sort: sort === 'total' || sort === 'time' || sort === 'new' ? sort : 'rate',
    tags,
    eligibleOnly: params.get('eligible') === '1',
    showDismissed: params.get('dismissed') === '1',
  };
}

function writeFiltersToUrl(): void {
  const filters = readFilters();
  const nextUrl = new URL(window.location.href);
  const set = (key: string, value: string | null): void => {
    if (value === null || value === '') nextUrl.searchParams.delete(key);
    else nextUrl.searchParams.set(key, value);
  };
  set('q', filters.query.trim());
  set('rate', filters.minRate !== '0' ? filters.minRate : null);
  set('total', filters.minTotal !== '0' ? filters.minTotal : null);
  set('hours', filters.maxHours !== '' ? filters.maxHours : null);
  set('sort', filters.sort !== 'rate' ? filters.sort : null);
  set('tags', filters.tags.length > 0 ? [...filters.tags].sort().join(',') : null);
  set('eligible', filters.eligibleOnly ? '1' : null);
  set('dismissed', filters.showDismissed ? '1' : null);
  set('format', filters.mode !== 'any' ? filters.mode : null);
  if (nextUrl.search !== window.location.search) window.history.replaceState({}, '', nextUrl);
}

function readFilters(): StudiesFilters {
  return {
    query: qInput?.value ?? '',
    minRate: rateSel?.value ?? '0',
    minTotal: totalSel?.value ?? '0',
    maxHours: hoursSel?.value ?? '',
    mode: formatSel?.value === 'online' || formatSel?.value === 'inperson' ? formatSel.value : 'any',
    sort: (sortSel?.value === 'total' || sortSel?.value === 'time' || sortSel?.value === 'new')
      ? sortSel.value
      : 'rate',
    tags: [...selectedTags].sort(),
    eligibleOnly: eligibleBox?.checked === true,
    showDismissed,
  };
}

function persistFilters(): void {
  personalState = updateStudiesFilters(readFilters());
}

function revealTab(button: HTMLElement): void {
  const scroller = button.parentElement;
  if (scroller === null || scroller.scrollWidth <= scroller.clientWidth) return;
  const start = button.offsetLeft;
  const end = start + button.offsetWidth;
  if (start < scroller.scrollLeft) scroller.scrollLeft = start;
  else if (end > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = end - scroller.clientWidth;
}

function setStudyTab(next: string): void {
  if (next === 'online' || next === 'inperson') {
    if (formatSel !== null) formatSel.value = next;
    next = 'all';
  }
  studyTab = TAB_IDS.has(next) ? next : 'all';
  for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
    const on = button.dataset['tab'] === studyTab;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) revealTab(button);
  }
  const nextUrl = new URL(window.location.href);
  if (studyTab === 'all') nextUrl.searchParams.delete('tab');
  else nextUrl.searchParams.set('tab', studyTab);
  window.history.replaceState({}, '', nextUrl);
}

function restoreFilters(filters: StudiesFilters): void {
  if (qInput !== null) qInput.value = filters.query;
  if (formatSel !== null) formatSel.value = filters.mode;
  if (rateSel !== null) rateSel.value = filters.minRate;
  if (totalSel !== null) totalSel.value = filters.minTotal;
  if (hoursSel !== null) hoursSel.value = filters.maxHours;
  if (sortSel !== null) sortSel.value = filters.sort;
  if (eligibleBox !== null) eligibleBox.checked = filters.eligibleOnly && !eligibleBox.disabled;
  showDismissed = filters.showDismissed;
  dismissedToggle?.setAttribute('aria-pressed', showDismissed ? 'true' : 'false');
  selectedTags.clear();
  for (const tag of filters.tags) selectedTags.add(tag);
  for (const btn of tagBox?.querySelectorAll<HTMLButtonElement>('[data-tag]') ?? []) {
    btn.setAttribute('aria-pressed', selectedTags.has(btn.dataset.tag ?? '') ? 'true' : 'false');
  }
}

function reset(): void {
  const advanced = document.querySelector<HTMLDetailsElement>('[data-study-filters]');
  if (advanced !== null) advanced.open = false;
  if (qInput !== null) qInput.value = '';
  if (formatSel !== null) formatSel.value = 'any';
  if (rateSel !== null) rateSel.value = '0';
  if (totalSel !== null) totalSel.value = '0';
  if (hoursSel !== null) hoursSel.value = '';
  if (sortSel !== null) sortSel.value = 'rate';
  if (eligibleBox !== null) eligibleBox.checked = false;
  showDismissed = false;
  dismissedToggle?.setAttribute('aria-pressed', 'false');
  selectedTags.clear();
  for (const btn of tagBox?.querySelectorAll<HTMLButtonElement>('[data-tag]') ?? []) {
    btn.setAttribute('aria-pressed', 'false');
  }
  setStudyTab('all');
  personalState = updateStudiesFilters({ ...DEFAULT_STUDIES_FILTERS, tags: [] });
  resort();
  apply();
  qInput?.focus();
}

// -- wiring ---------------------------------------------------------------

form?.addEventListener('submit', (e) => e.preventDefault());
document.querySelector('[data-search-form]')?.addEventListener('submit', (e) => e.preventDefault());
qInput?.addEventListener('input', () => {
  persistFilters();
  apply();
});
document.querySelector('[data-clear-search]')?.addEventListener('click', () => {
  if (qInput !== null) {
    qInput.value = '';
    qInput.focus();
  }
  persistFilters();
  apply();
});
for (const el of [formatSel, rateSel, totalSel, hoursSel, eligibleBox]) {
  el?.addEventListener('change', () => {
    persistFilters();
    apply();
  });
}
sortSel?.addEventListener('change', () => {
  persistFilters();
  resort();
  apply();
});
for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
  button.addEventListener('click', () => {
    setStudyTab(button.dataset['tab'] ?? 'all');
    persistFilters();
    apply();
  });
}
dismissedToggle?.addEventListener('click', () => {
  showDismissed = !showDismissed;
  dismissedToggle.setAttribute('aria-pressed', showDismissed ? 'true' : 'false');
  persistFilters();
  apply();
});
tagBox?.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tag]');
  if (btn === null) return;
  const tag = btn.dataset.tag ?? '';
  const on = btn.getAttribute('aria-pressed') === 'true';
  btn.setAttribute('aria-pressed', on ? 'false' : 'true');
  if (on) selectedTags.delete(tag);
  else selectedTags.add(tag);
  persistFilters();
  apply();
});
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-reset], #f-reset')) {
  btn.addEventListener('click', reset);
}

document.getElementById('results')?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('[data-study-action]');
  const card = button?.closest<HTMLElement>('[data-study]');
  const id = card?.dataset.id;
  if (!button || !id) return;
  event.preventDefault();
  personalState = button.dataset.studyAction === 'dismiss'
    ? toggleStudyDismissed(id)
    : toggleStudySaved(id);
});

// Profile: read once, then follow it. Every call is guarded because this
// module is owned elsewhere.
function readProfile(): UserProfile | null {
  try {
    return typeof profileApi.getProfile === 'function' ? profileApi.getProfile() : null;
  } catch {
    return null;
  }
}

const linkedFilters = filtersFromSearch(new URL(window.location.href).searchParams);
if (linkedFilters !== null) {
  restoreFilters(linkedFilters);
  const filters = readFilters();
  // The eligibility box stays disabled until the profile is applied, so the
  // DOM still reads "off" here. Keep the shared link's choice for that later step.
  if (eligibleBox?.disabled) filters.eligibleOnly = linkedFilters.eligibleOnly;
  personalState = updateStudiesFilters(filters);
} else {
  restoreFilters(personalState.filters);
}
const requestedTab = new URL(window.location.href).searchParams.get('tab');
if (requestedTab !== null && TAB_IDS.has(requestedTab)) setStudyTab(requestedTab);
else if (personalState.filters.mode === 'online' || personalState.filters.mode === 'inperson') {
  setStudyTab(personalState.filters.mode);
} else {
  setStudyTab(studyTab);
}
// Apply a bookmarked view before the state subscription replays stored filters.
if (requestedTab !== null && TAB_IDS.has(requestedTab)) persistFilters();
const clearSearch = document.querySelector<HTMLButtonElement>('[data-clear-search]');
const syncClear = (): void => {
  clearSearch?.toggleAttribute('hidden', (qInput?.value ?? '').length === 0);
};
qInput?.addEventListener('input', syncClear);
syncClear();
paintPersonalState(personalState);
subscribeStudiesState((next) => {
  personalState = next;
  restoreFilters(next.filters);
  paintPersonalState(next);
  resort();
  apply();
});

applyProfile(readProfile());
try {
  if (typeof profileApi.subscribe === 'function') {
    profileApi.subscribe((p) => applyProfile(p ?? readProfile()));
  }
} catch {
  /* no live profile updates; the initial read still applies */
}

resort();
apply();
