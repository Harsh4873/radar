import { loadState, subscribeRadarState, watchAuthor, saveState, clearAll, exportState } from '@/client/store.ts';
import {
  loadStudiesState,
  subscribeStudiesState,
  toggleStudyDismissed,
  toggleStudySaved,
} from '@/studies/personal-state.ts';
import { answeredCount, subscribe as subscribeProfile } from '@/studies/profile.ts';

interface PaperEntry {
  id: string;
  title: string;
  journal: string | null;
  date: string | null;
  relevance: number;
  href: string;
}

interface StudyEntry {
  id: string;
  title: string;
  href: string;
  rate: number | null;
  /** Ceiling or rising stated rate. Absent on older profile islands. */
  upTo?: boolean;
}

function formatHourly(rate: number, upTo: boolean): string {
  const rounded = Math.round(rate * 100) / 100;
  const body = Number.isInteger(rounded)
    ? `$${rounded.toLocaleString('en-US')}`
    : `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return upTo ? `up to ${body}/hr` : `${body}/hr guaranteed`;
}

function parseIsland<T>(id: string, fallback: T): T {
  const island = document.querySelector<HTMLScriptElement>(`#${id}`);
  if (island === null) return fallback;
  try {
    return JSON.parse(island.textContent ?? '') as T;
  } catch {
    return fallback;
  }
}

function renderList(
  listId: string,
  emptyId: string,
  entries: Array<{ href: string; title: string; meta: string; id?: string }>,
  missing: number,
  removable = false,
): void {
  const list = document.querySelector<HTMLElement>(`#${listId}`);
  const empty = document.querySelector<HTMLElement>(`#${emptyId}`);
  if (list === null || empty === null) return;

  list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement('li');
      li.className = 'profile-event-row';
      const copy = document.createElement('div');
      const title = document.createElement('a');
      title.className = 'profile-event-title';
      title.href = entry.href;
      title.textContent = entry.title;
      const meta = document.createElement('p');
      meta.textContent = entry.meta;
      copy.append(title, meta);
      li.append(copy);
      if (removable && entry.id !== undefined) {
        const actions = document.createElement('div');
        actions.className = 'profile-event-actions';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'action';
        remove.dataset['studyAction'] = 'save';
        remove.dataset['itemId'] = entry.id;
        remove.setAttribute('aria-label', `Remove ${entry.title}`);
        remove.textContent = 'Remove';
        actions.append(remove);
        li.append(actions);
      }
      return li;
    }),
  );
  list.hidden = entries.length === 0;
  empty.hidden = entries.length > 0;
  if (entries.length === 0 && missing > 0) {
    empty.textContent = `${missing} saved, but none are in the current snapshot.`;
  }
}

export function initRadarProfile(): void {
  const papers = parseIsland<PaperEntry[]>('research-profile-index', []);
  const studies = parseIsland<StudyEntry[]>('studies-profile-index', []);
  if (document.querySelector('#research-profile-index') === null
    && document.querySelector('#studies-profile-index') === null) {
    return;
  }

  const papersById = new Map(papers.map((entry) => [entry.id, entry]));
  const studiesById = new Map(studies.map((entry) => [entry.id, entry]));

  const renderResearch = (): void => {
    const state = loadState();
    const paint = (listId: string, emptyId: string, ids: readonly string[]): number => {
      const found = ids
        .map((id) => papersById.get(id))
        .filter((entry): entry is PaperEntry => entry !== undefined)
        .map((entry) => ({
          href: entry.href,
          title: entry.title,
          meta: [entry.journal, entry.date?.slice(0, 10), `${entry.relevance}/100`].filter(Boolean).join(' · '),
        }));
      renderList(listId, emptyId, found, ids.length);
      return found.length;
    };
    const saved = paint('profile-papers-saved', 'profile-papers-saved-empty', state.saved);
    const tracked = paint('profile-papers-tracked', 'profile-papers-tracked-empty', state.tracked);

    const watchList = document.querySelector<HTMLElement>('#watch-list');
    if (watchList !== null) {
      watchList.replaceChildren(
        ...state.authors.map((name) => {
          const li = document.createElement('li');
          li.className = 'badge';
          const button = document.createElement('button');
          button.className = 'action';
          button.type = 'button';
          button.textContent = `${name} ✕`;
          button.addEventListener('click', () => {
            saveState(watchAuthor(loadState(), name));
          });
          li.append(button);
          return li;
        }),
      );
    }

    const papersCount = document.querySelector<HTMLElement>('[data-profile-count="papers"]');
    if (papersCount !== null) papersCount.textContent = String(saved + tracked);
  };

  const renderStudies = (): void => {
    const state = loadStudiesState();
    const found = state.saved
      .map((id) => studiesById.get(id))
      .filter((entry): entry is StudyEntry => entry !== undefined)
      .map((entry) => ({
        id: entry.id,
        href: entry.href,
        title: entry.title,
        meta: entry.rate === null ? 'Rate unknown' : formatHourly(entry.rate, entry.upTo === true),
      }));
    renderList('profile-studies-saved', 'profile-studies-saved-empty', found, state.saved.length, true);
    const output = document.querySelector<HTMLElement>('[data-profile-count="studies"]');
    if (output !== null) output.textContent = String(found.length);
  };

  subscribeRadarState(renderResearch);
  subscribeStudiesState(renderStudies);
  subscribeProfile((profile) => {
    const output = document.querySelector<HTMLElement>('[data-profile-count="screening"]');
    if (output !== null) output.textContent = String(answeredCount(profile));
  });

  document.querySelector<HTMLFormElement>('#watch-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#watch-input');
    if (input === null || input.value.trim().length === 0) return;
    saveState(watchAuthor(loadState(), input.value));
    input.value = '';
  });

  document.querySelector('#export-profile')?.addEventListener('click', () => {
    const blob = new Blob([exportState(loadState())], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'radar-state.json';
    document.body.append(link);
    link.click();
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(href);
    }, 1000);
  });

  document.querySelector('#reset-profile')?.addEventListener('click', () => {
    if (!window.confirm('Clear saved papers, events, attendance, tracking, and learned interests? This cannot be undone.')) {
      return;
    }
    clearAll();
  });

  document.querySelector('#profile-studies-saved')?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-study-action]');
    const id = button?.dataset['itemId'];
    if (!button || !id) return;
    if (button.dataset['studyAction'] === 'dismiss') toggleStudyDismissed(id);
    else toggleStudySaved(id);
  });

  renderResearch();
  renderStudies();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRadarProfile, { once: true });
  } else {
    initRadarProfile();
  }
}
