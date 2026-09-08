// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const study = (id: string, online: boolean, rate: string, total: string) => `<li data-study data-id="${id}" data-rate="${rate}" data-total="${total}" data-hours="1" data-online="${online ? 1 : 0}" data-inperson="${online ? 0 : 1}" data-tags="survey" data-search="sleep survey" data-expired="0"></li>`;
const visible = () => [...document.querySelectorAll<HTMLElement>('[data-study]')].filter((card) => !card.hidden).map((card) => card.dataset.id);
function change(id: string, value: string) {
  const field = document.getElementById(id) as HTMLSelectElement;
  field.value = value; field.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  history.replaceState({}, '', '/radar/studies/');
  document.body.innerHTML = `
    <input id="f-q"><button data-clear-search hidden>Clear</button>
    <button data-tab="all">All</button><button data-tab="ranked">Known rate</button><button data-tab="saved">Saved</button>
    <select id="f-format"><option value="any">Any</option><option value="online">Online</option><option value="inperson">In person</option></select>
    <form id="filters"><details data-study-filters><summary>Filters <span data-active-study-filters></span></summary>
      <select id="f-rate"><option value="0">Any</option><option value="20">20</option></select>
      <select id="f-total"><option value="0">Any</option><option value="50">50</option></select>
      <select id="f-hours"><option value="">Any</option><option value="1">1</option></select>
      <select id="f-sort"><option value="rate">Rate</option><option value="total">Total</option></select>
      <div id="f-tags"><button type="button" data-tag="survey">Survey</button></div>
      <input id="f-eligible" type="checkbox" disabled>
    </details><button id="f-reset" type="button">Reset</button></form>
    <p data-search-summary></p><p id="f-summary"></p><p id="unknown-note" hidden></p><div id="empty-state" hidden></div>
    <div id="results"><section id="section-ranked"><ol id="list-ranked">${study('a', true, '25', '25')}${study('b', false, '50', '50')}</ol></section>
    <section id="section-unrated"><ol id="list-unrated">${study('c', true, '', '')}</ol></section></div>`;
});

describe('study discovery', () => {
  it('combines saved studies, format and pay while exposing active filters and unknown amounts', async () => {
    const state = await import('../studies/personal-state.ts');
    state.toggleStudySaved('a'); state.toggleStudySaved('b'); state.toggleStudySaved('c');
    await import('./studies-feed.ts');
    change('f-format', 'online');
    document.querySelector<HTMLButtonElement>('[data-tab="saved"]')!.click();
    expect(visible()).toEqual(['a', 'c']);
    change('f-rate', '20');
    expect(visible()).toEqual(['a']);
    expect(document.querySelector('[data-active-study-filters]')?.textContent).toContain('1 active');
    expect(document.querySelector('#unknown-note')?.textContent).toContain('1 study is hidden');
    expect(document.querySelector<HTMLDetailsElement>('[data-study-filters]')?.open).toBe(false);
    document.querySelector<HTMLButtonElement>('#f-reset')!.click();
    expect(visible()).toEqual(['b', 'a', 'c']);
    expect(document.querySelector('[data-active-study-filters]')?.textContent).toBe('');
    expect((document.getElementById('f-format') as HTMLSelectElement).value).toBe('any');
    expect(document.activeElement).toBe(document.getElementById('f-q'));
  });

  it('restores previous online bookmarks and retains that format when changing views', async () => {
    history.replaceState({}, '', '/radar/studies/?tab=online');
    await import('./studies-feed.ts');
    expect(visible()).toEqual(['a', 'c']);
    document.querySelector<HTMLButtonElement>('[data-tab="ranked"]')!.click();
    expect(visible()).toEqual(['a']);
    expect((document.getElementById('f-format') as HTMLSelectElement).value).toBe('online');
  });
});
