/**
 * Feed behaviour in the browser: tabs, personalization, and re-ranking.
 *
 * The pages ship every item as static HTML with its scoring metadata in data
 * attributes. This script then does the three things a static build cannot:
 *
 *   1. TABS. Filtering client-side keeps tab switches instant and avoids
 *      shipping the same items in nine different pre-rendered pages.
 *   2. PERSONALIZATION. Saved/dismissed/tracked state is local-first and may
 *      be mirrored to the private owner vault (see store.ts), so it is applied
 *      after load.
 *   3. RE-RANKING. Learned per-signal bias adjusts the server's score in
 *      place, so "more like this" changes the next page view rather than
 *      waiting for the next ingest.
 *
 * Progressive enhancement is the rule: with JavaScript off, every item is
 * still in the DOM, readable, and linked. Only the extras are lost.
 */

import {
  applyFeedback,
  loadState,
  saveState,
  subscribeRadarState,
  toggleAttending,
  toggleDismissed,
  toggleSaved,
  toggleTracked,
  touchVisit,
  type RadarState,
} from '@/client/store.ts';

/** Everything a card exposes to this script via data attributes. */
interface CardData {
  element: HTMLElement;
  id: string;
  relevance: number;
  /** Reason signals, for re-ranking against learned bias. */
  signals: string[];
  tabs: string[];
  firstSeen: number;
  search: string;
  category: string;
  organizer: string;
  interests: string[];
}

function readCards(root: ParentNode): CardData[] {
  return [...root.querySelectorAll<HTMLElement>('[data-item-id]')].map((element) => ({
    element,
    id: element.dataset['itemId'] ?? '',
    relevance: Number.parseInt(element.dataset['relevance'] ?? '0', 10) || 0,
    signals: (element.dataset['signals'] ?? '').split(',').filter(Boolean),
    tabs: (element.dataset['tabs'] ?? '').split(',').filter(Boolean),
    firstSeen: Date.parse(element.dataset['firstSeen'] ?? '') || 0,
    search: element.dataset['search'] ?? '',
    category: element.dataset['category'] ?? '',
    organizer: element.dataset['organizer'] ?? '',
    interests: (element.dataset['interests'] ?? '').split(',').filter(Boolean),
  }));
}

/**
 * Score after applying learned bias.
 *
 * Bias is summed over the signals that made this item score in the first
 * place, so it can only reinforce or damp what the ranker already found. The
 * result is clamped to the same 0..100 range the server uses so the displayed
 * number never contradicts the scale.
 */
function adjustedScore(card: CardData, state: RadarState): number {
  let adjustment = 0;
  for (const signal of card.signals) adjustment += state.signalBias[signal] ?? 0;
  return Math.max(0, Math.min(100, card.relevance + adjustment));
}

function setPressed(button: HTMLElement, on: boolean): void {
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/** Reflect stored state onto one card's controls and badges. */
function paintCard(card: CardData, state: RadarState, lastVisit: string | null): void {
  const { element, id } = card;
  const saved = state.saved.includes(id);
  const dismissed = state.dismissed.includes(id);
  const tracked = state.tracked.includes(id);
  const attending = state.attending.includes(id);

  element.classList.toggle('is-saved', saved);
  element.classList.toggle('is-dismissed', dismissed);
  element.classList.toggle('is-tracked', tracked);
  element.classList.toggle('is-attending', attending);

  for (const button of element.querySelectorAll<HTMLElement>('[data-action="save"]')) setPressed(button, saved);
  for (const button of element.querySelectorAll<HTMLElement>('[data-action="track"]')) setPressed(button, tracked);
  for (const button of element.querySelectorAll<HTMLElement>('[data-action="attend"]')) setPressed(button, attending);

  // "New since your last visit" can only be decided in the browser, because
  // only the browser knows when that was.
  const isNew = lastVisit !== null && card.firstSeen > Date.parse(lastVisit);
  element.classList.toggle('is-new-since-visit', isNew);

  const score = adjustedScore(card, state);
  const scoreEl = element.querySelector<HTMLElement>('[data-score]');
  if (scoreEl !== null && score !== card.relevance) {
    scoreEl.textContent = String(score);
    scoreEl.classList.add('is-adjusted');
    scoreEl.title = `Radar scored this ${card.relevance}; your feedback adjusted it to ${score}.`;
  }
}

function matchesProfile(card: CardData, state: RadarState): boolean {
  if (state.preferredCategories.includes(card.category)) return true;
  if (card.interests.some((interest) => state.campusInterests.includes(interest))) return true;
  return state.followedOrganizers.some((organizer) =>
    card.organizer.includes(organizer) || card.search.includes(organizer));
}

function matchesTab(card: CardData, state: RadarState, tab: string): boolean {
  if (tab === 'all') return true;
  if (tab === 'interested') return state.saved.includes(card.id);
  if (tab === 'going') return state.attending.includes(card.id);
  if (tab === 'for-you') return card.tabs.includes(tab) || matchesProfile(card, state);
  return card.tabs.includes(tab);
}

function matchesSearch(card: CardData, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length === 0 || terms.every((term) => card.search.includes(term));
}

/** Show only the active filters, preserve campus chronology, and update groups. */
function applyView(
  root: HTMLElement,
  cards: CardData[],
  state: RadarState,
  tab: string,
  showDismissed: boolean,
  query: string,
): void {
  const visible: CardData[] = [];

  for (const card of cards) {
    const hidden = !matchesTab(card, state, tab)
      || !matchesSearch(card, query)
      || (!showDismissed && state.dismissed.includes(card.id));
    card.element.hidden = hidden;
    if (!hidden) visible.push(card);
  }

  // Research remains relevance-first. Campus agenda roots opt out because a
  // personal preference must never make the dates jump around again.
  const parent = root.dataset['sort'] === 'chronological' ? null : visible[0]?.element.parentElement;
  if (parent !== null && parent !== undefined) {
    const sorted = [...visible].sort((a, b) => adjustedScore(b, state) - adjustedScore(a, state));
    const changed = sorted.some((card, index) => card !== visible[index]);
    if (changed) for (const card of sorted) parent.append(card.element);
  }

  for (const group of root.querySelectorAll<HTMLElement>('[data-date-group]')) {
    const groupCards = cards.filter((card) => group.contains(card.element));
    const visibleInGroup = groupCards.filter((card) => !card.element.hidden).length;
    group.hidden = visibleInGroup === 0;
    const count = group.querySelector<HTMLElement>('[data-date-count]');
    const label = group.querySelector<HTMLElement>('[data-date-count-label]');
    if (count !== null) count.textContent = String(visibleInGroup);
    if (label !== null) label.textContent = visibleInGroup === 1 ? 'event' : 'events';
  }

  for (const counter of document.querySelectorAll<HTMLElement>('[data-count-for]')) {
    const target = counter.dataset['countFor'];
    counter.textContent = String(
      target === undefined || target === 'visible'
        ? visible.length
        : cards.filter((card) => matchesTab(card, state, target) && matchesSearch(card, query)
            && !state.dismissed.includes(card.id)).length,
    );
  }


  for (const status of document.querySelectorAll<HTMLElement>('[data-search-summary]')) {
    const noun = visible.length === 1 ? 'event' : 'events';
    status.textContent = query.trim().length > 0
      ? `${visible.length} ${noun} match “${query.trim()}”.`
      : `${visible.length} ${noun} shown.`;
  }

  const empty = document.querySelector<HTMLElement>('[data-empty-state]');
  if (empty !== null) empty.hidden = visible.length > 0;
}

export function initFeed(): void {
  const root = document.querySelector<HTMLElement>('[data-feed]');
  if (root === null) return;

  const cards = readCards(root);
  if (cards.length === 0) return;
  // Some overview pages show a second, smaller card section outside the main
  // filterable feed. Its actions should still work even though it is not
  // subject to the first feed's tabs or sorting.
  const interactiveCards = readCards(document);

  const { previous, state: stamped } = touchVisit(loadState());
  let state = stamped;
  // Visiting must not outrank a newer cloud record before the first owner-
  // vault snapshot arrives. The visit is persisted, but it keeps the prior
  // content stamp until the two copies have reconciled.
  saveState(state, { visitOnly: true });

  let tab = root.dataset['defaultTab'] ?? 'for-you';
  let showDismissed = false;
  let query = '';

  const repaint = (): void => {
    for (const card of interactiveCards) paintCard(card, state, previous);
    applyView(root, cards, state, tab, showDismissed, query);
  };

  subscribeRadarState((next) => {
    state = next;
    repaint();
  });

  // --- Tabs --------------------------------------------------------------
  for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      tab = button.dataset['tab'] ?? 'for-you';
      for (const other of document.querySelectorAll<HTMLElement>('[data-tab]')) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      }
      // Keep the tab in the URL so a view is linkable and survives reload.
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      window.history.replaceState({}, '', url);
      repaint();
    });
  }

  const requested = new URL(window.location.href).searchParams.get('tab');
  if (requested !== null) {
    const target = document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(requested)}"]`);
    if (target !== null) {
      tab = requested;
      for (const other of document.querySelectorAll<HTMLElement>('[data-tab]')) {
        other.setAttribute('aria-pressed', other === target ? 'true' : 'false');
      }
    }
  }

  // --- Search ------------------------------------------------------------
  const search = document.querySelector<HTMLInputElement>('[data-event-search]');
  const clearSearch = document.querySelector<HTMLButtonElement>('[data-clear-search]');
  const searchForm = document.querySelector<HTMLFormElement>('[data-search-form]');
  const requestedQuery = new URL(window.location.href).searchParams.get('q') ?? '';

  const setQuery = (next: string): void => {
    query = next;
    clearSearch?.toggleAttribute('hidden', query.length === 0);
    const nextUrl = new URL(window.location.href);
    if (query.trim().length > 0) nextUrl.searchParams.set('q', query.trim());
    else nextUrl.searchParams.delete('q');
    window.history.replaceState({}, '', nextUrl);
    repaint();
  };

  if (search !== null) {
    search.value = requestedQuery;
    query = requestedQuery;
    clearSearch?.toggleAttribute('hidden', query.length === 0);
    search.addEventListener('input', () => setQuery(search.value));
  }
  searchForm?.addEventListener('submit', (event) => event.preventDefault());
  clearSearch?.addEventListener('click', () => {
    if (search !== null) {
      search.value = '';
      search.focus();
    }
    setQuery('');
  });

  // --- Card actions ------------------------------------------------------
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest<HTMLElement>('[data-action]');
    if (button === null) return;

    const card = button.closest<HTMLElement>('[data-item-id]');
    const id = card?.dataset['itemId'];
    if (id === undefined) return;

    const data = interactiveCards.find((entry) => entry.id === id);
    const action = button.dataset['action'];

    switch (action) {
      case 'save':
        state = toggleSaved(state, id);
        break;
      case 'attend':
        state = toggleAttending(state, id);
        break;
      case 'dismiss':
        state = toggleDismissed(state, id);
        break;
      case 'track':
        state = toggleTracked(state, id);
        break;
      case 'more':
        state = applyFeedback(state, id, 'more', data?.signals ?? []);
        break;
      case 'less':
        state = applyFeedback(state, id, 'less', data?.signals ?? []);
        break;
      default:
        return;
    }

    event.preventDefault();
    button.closest('details')?.removeAttribute('open');
    saveState(state);
    repaint();
  });

  // --- Show-dismissed toggle --------------------------------------------
  const dismissedToggle = document.querySelector<HTMLElement>('[data-show-dismissed]');
  if (dismissedToggle !== null) {
    dismissedToggle.addEventListener('click', () => {
      showDismissed = !showDismissed;
      setPressed(dismissedToggle, showDismissed);
      repaint();
    });
  }


  const reset = document.querySelector<HTMLButtonElement>('[data-reset-filters]');
  reset?.addEventListener('click', () => {
    tab = root.dataset['defaultTab'] ?? 'all';
    showDismissed = false;
    query = '';
    if (search !== null) search.value = '';
    clearSearch?.setAttribute('hidden', '');
    for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
      button.setAttribute('aria-pressed', button.dataset['tab'] === tab ? 'true' : 'false');
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('q');
    nextUrl.searchParams.delete('tab');
    window.history.replaceState({}, '', nextUrl);
    repaint();
  });

  repaint();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFeed, { once: true });
  } else {
    initFeed();
  }
}
