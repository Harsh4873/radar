import { describe, expect, it } from 'vitest';

import { dedupeTags } from '@/core/normalize.ts';

describe('dedupeTags', () => {
  it('drops malformed upstream values without aborting normalization', () => {
    expect(dedupeTags([' Genomics ', null, undefined, 42, 'genomics', '', 'Phylogenetics'])).toEqual([
      'Genomics',
      'Phylogenetics',
    ]);
  });
});
