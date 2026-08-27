import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { fetchAllStudies } from '@/studies/fetch-studies.ts';
import type { RawStudy } from '@/studies/types.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const RAW = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RawStudy[];
const RECORD = RAW[0] as RawStudy;
const log = { info: () => {}, warn: () => {}, error: () => {} };

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('fetchAllStudies completeness', () => {
  it('marks a validated header-complete read as complete', async () => {
    const fetchImpl = vi.fn(async () => json([RECORD], {
      'x-wp-total': '1',
      'x-wp-totalpages': '1',
    }));

    const result = await fetchAllStudies({ fetchImpl, attempts: 1, log, allowFallback: false });

    expect(result.source).toBe('network');
    expect(result.complete).toBe(true);
    expect(result.studies).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('marks malformed records and total mismatches as incomplete', async () => {
    const fetchImpl = vi.fn(async () => json([RECORD, { id: 'bad' }], {
      'x-wp-total': '2',
      'x-wp-totalpages': '1',
    }));

    const result = await fetchAllStudies({ fetchImpl, attempts: 1, log, allowFallback: false });

    expect(result.source).toBe('network');
    expect(result.complete).toBe(false);
    expect(result.studies).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/malformed/);
    expect(result.warnings.join(' ')).toMatch(/X-WP-Total/);
  });

  it('does not call a read complete when pagination headers disappear', async () => {
    const fetchImpl = vi.fn(async () => json([RECORD]));

    const result = await fetchAllStudies({ fetchImpl, attempts: 1, log, allowFallback: false });

    expect(result.source).toBe('network');
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain('pagination headers were missing or invalid');
  });

  it('marks network or fixture fallback reads incomplete', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    const empty = await fetchAllStudies({ fetchImpl, attempts: 1, log, allowFallback: false });
    const fixture = await fetchAllStudies({ fetchImpl, attempts: 1, log, allowFallback: true });

    expect(empty.source).toBe('empty');
    expect(empty.complete).toBe(false);
    expect(fixture.source).toBe('fixture');
    expect(fixture.complete).toBe(false);
    expect(fixture.studies.length).toBeGreaterThan(0);
  });
});
