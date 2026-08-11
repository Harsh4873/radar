import { describe, expect, it } from 'vitest';
import {
  canonicalTitle,
  clamp,
  daysBetween,
  decodeEntities,
  htmlToText,
  jaccard,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  stripEmails,
  tidyPunctuation,
  titleSimilarity,
  tokenize,
  toIso,
  versionOf,
} from '@/core/text.ts';

describe('htmlToText', () => {
  it('keeps words apart across block boundaries', () => {
    // The Europe PMC case: <h4>Background</h4> welded to the next word by a
    // naive tag strip, producing "BackgroundWithin".
    expect(htmlToText('<h4>Background</h4>Within host diversity')).toBe('Background Within host diversity');
  });

  it('handles LiveWhale <br /> and entities', () => {
    expect(htmlToText('<p>\n  A&amp;M Law<br />\n  Fort Worth\n</p>')).toBe('A&M Law Fort Worth');
  });

  it('drops script and style bodies entirely', () => {
    expect(htmlToText('<p>Real</p><script>var x = 1;</script>')).toBe('Real');
  });

  it('returns empty string for null and undefined', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex forms', () => {
    expect(decodeEntities('a &amp; b &#65; c &#x42;')).toBe('a & b A c B');
  });

  it('leaves malformed and out-of-range references alone rather than throwing', () => {
    expect(decodeEntities('&notreal; &#99999999;')).toBe('&notreal; &#99999999;');
  });
});

describe('tidyPunctuation', () => {
  it('reattaches punctuation orphaned by tag removal', () => {
    // "<i>M. tuberculosis</i> : weak" -> "M. tuberculosis : weak"
    expect(tidyPunctuation('M. tuberculosis : weak host association')).toBe(
      'M. tuberculosis: weak host association',
    );
  });
});

describe('clamp', () => {
  it('cuts on a word boundary and marks the cut', () => {
    const out = clamp('the quick brown fox jumps over the lazy dog', 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain('jumpz');
  });

  it('leaves short text untouched', () => {
    expect(clamp('short', 20)).toBe('short');
  });
});

describe('tokenize', () => {
  it('splits on punctuation so identifier variants converge', () => {
    expect(tokenize('dN/dS')).toEqual(['dn', 'ds']);
    expect(tokenize('host-pathogen')).toEqual(['host', 'pathogen']);
  });

  it('strips diacritics', () => {
    expect(tokenize('Séraphin')).toEqual(['seraphin']);
  });

  it('drops stop words but keeps domain-meaningful short words', () => {
    const tokens = tokenize('the host of new high selection');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('host');
    expect(tokens).toContain('new');
  });

  it('keeps single digits, which discriminate between series instalments', () => {
    expect(tokenize('Day 1')).toEqual(['day', '1']);
    expect(tokenize('Day 2')).toEqual(['day', '2']);
  });

  it('still drops single letters', () => {
    expect(tokenize('J. Smith')).toEqual(['smith']);
  });
});

describe('jaccard', () => {
  it('treats two empty sets as no match, not a perfect one', () => {
    expect(jaccard([], [])).toBe(0);
  });

  it('scores overlap', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});

describe('titleSimilarity', () => {
  it('keeps career-fair days apart below the 0.82 merge threshold', () => {
    // The regression this threshold exists for: merging these would delete a
    // whole day of a career fair from the feed.
    const score = titleSimilarity('Engineering Career Fair - Day 1', 'Engineering Career Fair - Day 2');
    expect(score).toBeLessThan(0.82);
  });

  it('scores genuine feed duplication high', () => {
    expect(titleSimilarity('Google Tech Talk', 'Google Tech Talk')).toBe(1);
  });

  it('is unaffected by case and punctuation', () => {
    expect(titleSimilarity('NVIDIA Info-Session', 'nvidia info session')).toBe(1);
  });
});

describe('canonicalTitle', () => {
  it('drops a leading year so re-posted events collapse', () => {
    expect(canonicalTitle('2026 Fall Career Fair')).toBe(canonicalTitle('Fall Career Fair'));
  });

  it('normalizes ampersands', () => {
    expect(canonicalTitle('Arts & Sciences')).toBe(canonicalTitle('Arts and Sciences'));
  });
});

describe('normalizeDoi', () => {
  it('accepts bare, prefixed, and URL forms as equal', () => {
    const expected = '10.1038/ng.2747';
    expect(normalizeDoi('10.1038/ng.2747')).toBe(expected);
    expect(normalizeDoi('https://doi.org/10.1038/NG.2747')).toBe(expected);
    expect(normalizeDoi('doi:10.1038/ng.2747')).toBe(expected);
  });

  it("rejects bioRxiv's literal 'NA' for an unpublished preprint", () => {
    // If this ever returns a value, every unpublished preprint gets welded to
    // one bogus shared identity key.
    expect(normalizeDoi('NA')).toBeNull();
  });

  it('rejects non-DOI strings', () => {
    expect(normalizeDoi('')).toBeNull();
    expect(normalizeDoi('not a doi')).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });
});

describe('normalizeArxivId and versionOf', () => {
  it('strips the URL and version', () => {
    expect(normalizeArxivId('http://arxiv.org/abs/2606.27607v1')).toBe('2606.27607');
    expect(versionOf('http://arxiv.org/abs/2606.27607v2')).toBe(2);
  });

  it('handles the legacy category/number form', () => {
    expect(normalizeArxivId('q-bio/0701001')).toBe('q-bio/0701001');
  });
});

describe('normalizeOpenAlexId', () => {
  it('extracts the bare id from the URL form', () => {
    expect(normalizeOpenAlexId('https://openalex.org/W2110150994')).toBe('W2110150994');
  });
});

describe('toIso', () => {
  it('parses unix seconds and milliseconds', () => {
    // LiveWhale last_modified is seconds.
    expect(toIso(1786052984)).toBe('2026-08-06T21:49:44.000Z');
    expect(toIso(1786052984000)).toBe('2026-08-06T21:49:44.000Z');
  });

  it("parses PubMed's '2026 Apr 13' shape", () => {
    expect(toIso('2026 Apr 13')).toBe('2026-04-13T00:00:00.000Z');
    expect(toIso('2026 Apr')).toBe('2026-04-01T00:00:00.000Z');
    expect(toIso('2026')).toBe('2026-01-01T00:00:00.000Z');
  });

  it("parses Crossref's date-parts", () => {
    expect(toIso([[2024, 3, 15]])).toBe('2024-03-15T00:00:00.000Z');
    expect(toIso([[2024]])).toBe('2024-01-01T00:00:00.000Z');
  });

  it('treats a bare datetime with no timezone as UTC, not local', () => {
    // WordPress returns `2025-02-17T15:53:22` with no zone. Parsing that as
    // local time made the same input yield different instants on a laptop in
    // US Central and a CI runner in UTC, flipping 62 items to "Updated" on
    // every alternation between them.
    expect(toIso('2025-02-17T15:53:22')).toBe('2025-02-17T15:53:22.000Z');
    expect(toIso('2025-02-17 15:53:22')).toBe('2025-02-17T15:53:22.000Z');
  });

  it('respects an explicit timezone when one is present', () => {
    // LiveWhale sends a real offset; it must not be reinterpreted as UTC.
    expect(toIso('2026-08-10T08:00:00-05:00')).toBe('2026-08-10T13:00:00.000Z');
    expect(toIso('2026-08-10T13:00:00Z')).toBe('2026-08-10T13:00:00.000Z');
  });

  it('returns null rather than guessing', () => {
    expect(toIso('NA')).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso('not a date')).toBeNull();
  });

  it('rejects implausible years outright', () => {
    expect(toIso('1653-01-01')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('is negative for future dates', () => {
    expect(daysBetween('2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z')).toBe(-10);
  });
});

describe('stripEmails', () => {
  it('removes addresses bound for the published site', () => {
    // TAMU publishes registration_owner_email on 594 of 1000 events. This is
    // the last line of defence before those reach dist/.
    expect(stripEmails('Contact tkevans@tamu.edu to register')).toBe('Contact [email removed] to register');
  });

  it('handles several addresses in one string', () => {
    expect(stripEmails('a@b.com and c.d@e.org')).toBe('[email removed] and [email removed]');
  });
});
