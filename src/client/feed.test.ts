// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from './store.ts';

vi.mock('./store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.ts')>();
  return { ...actual, subscribeRadarState: vi.fn(), saveState: vi.fn() };
});

const card = (id: string, tabs: string, search: string) => `<li data-item-id="${id}" data-tabs="${tabs}" data-search="${search}"><button data-action="save">Save</button></li>`;
const visible = () => [...document.querySelectorAll<HTMLElement>('[data-item-id]')].filter((item) => !item.hidden).map((item) => item.dataset.itemId);
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
const select = (name: string, value: string) => {
  const input = document.querySelector<HTMLSelectElement>(`[data-feed-filter="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', '/radar/campus/');
  document.body.innerHTML = `
    <form data-search-form><input data-event-search><button type="button" data-clear-search hidden>Clear</button></form>
    <button data-tab="all" aria-pressed="true">All</button><button data-tab="clubs">Clubs</button>
    <select data-feed-filter="when"><option value="all">Any date</option><option value="today">Today</option><option value="this-week">Week</option></select>
    <select data-feed-filter="personal"><option value="all">All</option><option value="interested">Saved</option></select>
    <select data-feed-filter="extra"><option value="all">Any</option><option value="online">Online</option></select>
    <p data-search-summary role="status"></p><button data-show-dismissed aria-pressed="false">Dismissed</button>
    <button data-reset-filters>Reset</button><div data-empty-state hidden><button data-reset-filters>Reset empty</button></div>
    <div data-feed data-default-tab="all" data-sort="chronological"><section data-date-group>
      <span data-date-count></span><span data-date-count-label></span><ul>
      ${card('a', 'clubs,today,this-week,online', 'chess club')}
      ${card('b', 'clubs,this-week', 'book club')}
      ${card('c', 'sports,today,this-week', 'soccer match')}
    </ul></section></div>`;
});

describe('campus discovery', () => {
  it('restores base scores and ranking when feedback cancels out', async () => {
    document.querySelector('[data-feed]')!.outerHTML = `
      <ul data-feed data-default-tab="all">
        <li data-item-id="a" data-relevance="50" data-signals="organism"><span data-score>50</span><button data-action="more">More</button></li>
        <li data-item-id="b" data-relevance="51"><span data-score>51</span></li>
        <li data-item-id="c" data-relevance="40" data-signals="organism"><span data-score>40</span><button data-action="less">Less</button></li>
      </ul>`;
    await import('./feed.ts');
    const score = document.querySelector<HTMLElement>('[data-item-id="a"] [data-score]')!;
    click('[data-item-id="a"] [data-action="more"]');
    expect(score.textContent).toBe('52');
    expect(score.classList.contains('is-adjusted')).toBe(true);
    expect(score.title).toContain('adjusted it to 52');
    expect(visible()).toEqual(['a', 'b', 'c']);

    click('[data-item-id="c"] [data-action="less"]');
    expect(score.textContent).toBe('50');
    expect(score.classList.contains('is-adjusted')).toBe(false);
    expect(score.hasAttribute('title')).toBe(false);
    expect(visible()).toEqual(['b', 'a']);
  });

  it('clears adjusted score presentation when synced preferences return to the base score', async () => {
    const item = document.querySelector('[data-item-id="a"]')!;
    item.setAttribute('data-relevance', '50');
    item.setAttribute('data-signals', 'organism');
    item.insertAdjacentHTML('beforeend', '<span data-score>50</span>');
    localStorage.setItem('radar:v1', JSON.stringify({ ...emptyState(), signalBias: { organism: 2 } }));
    await import('./feed.ts');
    const { subscribeRadarState } = await import('./store.ts');
    const repaint = vi.mocked(subscribeRadarState).mock.calls.at(-1)![0];
    const score = item.querySelector<HTMLElement>('[data-score]')!;
    expect(score.textContent).toBe('52');
    const state = emptyState();
    repaint(state, { schemaVersion: 1, state, updatedAtMs: 1, clientId: 'test' });
    expect(score.textContent).toBe('50');
    expect(score.classList.contains('is-adjusted')).toBe(false);
    expect(score.hasAttribute('title')).toBe(false);
  });

  it('combines interest, date, format and saved state without changing event order', async () => {
    localStorage.setItem('radar:v1', JSON.stringify({ ...emptyState(), saved: ['a', 'b'] }));
    await import('./feed.ts');
    click('[data-tab="clubs"]');
    select('when', 'this-week');
    expect(visible()).toEqual(['a', 'b']);
    select('extra', 'online');
    select('personal', 'interested');
    expect(visible()).toEqual(['a']);
    expect(document.querySelector('[data-search-summary]')?.textContent).toBe('1 event shown.');
    expect(new URL(location.href).searchParams.get('when')).toBe('this-week');
    expect(document.querySelector('[data-date-count]')?.textContent).toBe('1');
  });

  it('restores legacy date bookmarks and supports search and a complete keyboard-focus reset', async () => {
    window.history.replaceState({}, '', '/radar/campus/?tab=today&q=chess');
    await import('./feed.ts');
    expect(visible()).toEqual(['a']);
    expect(document.querySelector<HTMLSelectElement>('[data-feed-filter="when"]')?.value).toBe('today');
    expect(new URL(location.href).searchParams.has('tab')).toBe(false);
    select('when', 'this-week');
    expect(new URL(location.href).searchParams.get('when')).toBe('this-week');
    click('[data-show-dismissed]');
    const search = document.querySelector<HTMLInputElement>('[data-event-search]')!;
    search.value = 'missing'; search.dispatchEvent(new Event('input'));
    expect(visible()).toEqual([]);
    expect(document.querySelector<HTMLElement>('[data-date-group]')?.hidden).toBe(true);
    click('[data-empty-state] [data-reset-filters]');
    expect(visible()).toEqual(['a', 'b', 'c']);
    expect(document.activeElement).toBe(search);
    expect(document.querySelector('[data-show-dismissed]')?.getAttribute('aria-pressed')).toBe('false');
    expect(location.search).toBe('');
  });

  it('restores combined shareable filters and reports empty snapshots', async () => {
    window.history.replaceState({}, '', '/radar/campus/?tab=clubs&when=today&extra=online');
    await import('./feed.ts');
    expect(visible()).toEqual(['a']);
  });

  it('announces an empty feed and allows reset when a source has no events', async () => {
    document.querySelector('[data-feed]')!.innerHTML = '';
    await import('./feed.ts');
    expect(document.querySelector('[data-search-summary]')?.textContent).toBe('0 events shown.');
    expect(document.querySelector<HTMLElement>('[data-empty-state]')?.hidden).toBe(false);
    click('[data-reset-filters]');
    expect(document.activeElement).toBe(document.querySelector('[data-event-search]'));
  });
});
