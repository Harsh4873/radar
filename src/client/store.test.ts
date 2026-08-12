import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAll, loadRadarVaultRecord, loadState } from './store.ts';

const STORAGE_KEY = 'radar:v1';

function installStorage(initial?: unknown) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(STORAGE_KEY, JSON.stringify(initial));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  vi.stubGlobal('localStorage', storage);
  return { storage, values };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fresh visitor state', () => {
  it('starts with no saved, dismissed, tracked, or learned interests', () => {
    installStorage();

    expect(loadState()).toEqual({
      lastVisit: null,
      saved: [],
      dismissed: [],
      tracked: [],
      feedback: {},
      authors: [],
      companies: [],
      signalBias: {},
    });
  });

  it('clears the entire visitor-owned record', () => {
    const { storage, values } = installStorage({
      saved: ['paper-1'],
      dismissed: ['paper-2'],
      signalBias: { organism: 8 },
    });

    clearAll();

    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadState().saved).toEqual([]);
    expect(loadState().signalBias).toEqual({});
    expect(loadRadarVaultRecord().updatedAtMs).toBeGreaterThan(0);
  });

  it('describes private sync truthfully and never feeds it into public ingest', () => {
    const watchlist = readFileSync(new URL('../pages/research/watchlist.astro', import.meta.url), 'utf8');
    const topics = readFileSync(new URL('../pages/research/topics.astro', import.meta.url), 'utf8');
    const view = readFileSync(new URL('../lib/view.ts', import.meta.url), 'utf8');

    expect(watchlist).toContain('A fresh signed-out browser starts with an empty list.');
    expect(watchlist).toContain('private owner vault');
    expect(watchlist).toMatch(/It does not\s+change or target the next ingest\./);
    expect(watchlist).not.toContain('Radar re-checks these every ingest');
    expect(watchlist).not.toMatch(/add <strong>\+14<\/strong>.*next ingest/);
    expect(topics).not.toMatch(/papers you have saved|author on your watchlist/);
    expect(view).not.toContain("label: 'For You'");
  });
});
