import {
  followOrganizer,
  loadState,
  saveState,
  subscribeRadarState,
  toggleAttending,
  toggleCampusInterest,
  togglePreferredCategory,
  toggleSaved,
} from '@/client/store.ts';

interface CampusProfileEntry {
  id: string;
  title: string;
  startsAt: string | null;
  location: string | null;
  organizer: string | null;
  category: string | null;
  interests: string[];
  search: string;
  href: string;
  sourceHref: string;
}

const CENTRAL = 'America/Chicago';

function dateLabel(iso: string | null): string {
  if (iso === null) return 'Date to be announced';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Date to be announced';
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: CENTRAL,
  });
}

function eventRow(entry: CampusProfileEntry, kind: 'going' | 'interested'): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'profile-event-row';

  const copy = document.createElement('div');
  const title = document.createElement('a');
  title.className = 'profile-event-title';
  title.href = entry.href;
  title.textContent = entry.title;
  const meta = document.createElement('p');
  meta.textContent = [dateLabel(entry.startsAt), entry.location, entry.organizer].filter(Boolean).join(' · ');
  copy.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'profile-event-actions';
  const source = document.createElement('a');
  source.className = 'action action-quiet';
  source.href = entry.sourceHref;
  source.rel = 'noopener external';
  source.textContent = 'View event';
  const remove = document.createElement('button');
  remove.className = 'action';
  remove.type = 'button';
  remove.dataset['profileEventAction'] = kind;
  remove.dataset['itemId'] = entry.id;
  remove.textContent = kind === 'going' ? 'Not going' : 'Remove';
  actions.append(source, remove);

  row.append(copy, actions);
  return row;
}

export function initCampusProfile(): void {
  const island = document.querySelector<HTMLScriptElement>('#campus-profile-index');
  if (island === null) return;

  let entries: CampusProfileEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(island.textContent ?? '[]');
    if (Array.isArray(parsed)) entries = parsed as CampusProfileEntry[];
  } catch {
    entries = [];
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let state = loadState();

  const renderEvents = (kind: 'going' | 'interested', ids: readonly string[]): number => {
    const list = document.querySelector<HTMLElement>(`[data-profile-event-list="${kind}"]`);
    const empty = document.querySelector<HTMLElement>(`[data-profile-empty="${kind}"]`);
    if (list === null || empty === null) return 0;
    const current = ids.map((id) => byId.get(id)).filter((entry): entry is CampusProfileEntry => entry !== undefined);
    list.replaceChildren(...current.map((entry) => eventRow(entry, kind)));
    empty.hidden = current.length > 0;
    return current.length;
  };

  const render = (): void => {
    for (const input of document.querySelectorAll<HTMLInputElement>('[data-preference-category]')) {
      input.checked = state.preferredCategories.includes(input.value);
    }
    for (const input of document.querySelectorAll<HTMLInputElement>('[data-preference-interest]')) {
      input.checked = state.campusInterests.includes(input.value);
    }

    const followed = document.querySelector<HTMLElement>('[data-followed-list]');
    const followedEmpty = document.querySelector<HTMLElement>('[data-followed-empty]');
    if (followed !== null && followedEmpty !== null) {
      followed.replaceChildren(...state.followedOrganizers.map((organizer) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = organizer;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-remove';
        remove.dataset['unfollowOrganizer'] = organizer;
        remove.setAttribute('aria-label', `Stop following ${organizer}`);
        remove.textContent = 'Remove';
        item.append(name, remove);
        return item;
      }));
      followedEmpty.hidden = state.followedOrganizers.length > 0;
    }

    const going = renderEvents('going', state.attending);
    const interested = renderEvents('interested', state.saved);
    const counts: Record<string, number> = {
      going,
      interested,
      preferences: state.preferredCategories.length + state.campusInterests.length,
      following: state.followedOrganizers.length,
    };
    for (const output of document.querySelectorAll<HTMLElement>('[data-profile-count]')) {
      const key = output.dataset['profileCount'];
      if (key === undefined || key === '' || !(key in counts)) continue;
      output.textContent = String(counts[key] ?? 0);
    }
  };

  subscribeRadarState((next) => {
    state = next;
    render();
  });

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.matches('[data-preference-category]')) {
      state = togglePreferredCategory(state, input.value);
    } else if (input.matches('[data-preference-interest]')) {
      state = toggleCampusInterest(state, input.value);
    } else {
      return;
    }
    saveState(state);
  });

  document.querySelector<HTMLFormElement>('[data-follow-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('[data-follow-input]');
    if (input === null || input.value.trim().length === 0) return;
    state = followOrganizer(state, input.value);
    input.value = '';
    saveState(state);
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const unfollow = target.closest<HTMLElement>('[data-unfollow-organizer]');
    if (unfollow !== null) {
      state = followOrganizer(state, unfollow.dataset['unfollowOrganizer'] ?? '');
      saveState(state);
      return;
    }

    const eventAction = target.closest<HTMLButtonElement>('[data-profile-event-action]');
    const id = eventAction?.dataset['itemId'];
    if (eventAction === null || id === undefined) return;
    state = eventAction.dataset['profileEventAction'] === 'going'
      ? toggleAttending(state, id)
      : toggleSaved(state, id);
    saveState(state);
  });

  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCampusProfile, { once: true });
  } else {
    initCampusProfile();
  }
}
