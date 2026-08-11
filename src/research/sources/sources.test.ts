/**
 * Connector parsing, against frozen captures of real upstream responses.
 *
 * Every fixture in `fixtures/` is an unmodified (only truncated) capture of a
 * live response, so these tests assert against the shapes the APIs actually
 * emit rather than the shapes the docs imply. Nothing here touches the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { mapRecord as mapEpmc } from '@/research/sources/europepmc.ts';
import { mapRecord as mapPreprint } from '@/research/sources/biorxiv.ts';
import { mapEntry as mapArxiv } from '@/research/sources/arxiv.ts';
import { mapWork as mapOpenAlex, reconstructAbstract } from '@/research/sources/openalex.ts';
import { mapArticle as mapPubmed } from '@/research/sources/pubmed.ts';
import { assertPlausibleDate, mapItem as mapCrossref } from '@/research/sources/crossref.ts';
import { extractAll } from '@/core/xml.ts';

const NOW = '2026-08-10T00:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8');
}

function json<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

describe('Europe PMC', () => {
  const data = json<{ resultList: { result: Record<string, unknown>[] } }>('europepmc.json');

  it('maps a real record with identity keys for every identifier it has', () => {
    const record = data.resultList.result[0]!;
    const item = mapEpmc(record, 'test query')!;

    expect(item.vertical).toBe('research');
    expect(item.title.length).toBeGreaterThan(10);
    // Titles carry inline markup upstream; nothing downstream should see a tag.
    expect(item.title).not.toContain('<');
    expect(item.identity.some((key) => key.startsWith('doi:'))).toBe(true);
    expect(item.identity.some((key) => key.startsWith('pmid:'))).toBe(true);
  });

  it('reads isOpenAccess as the string Y, not a boolean', () => {
    const open = data.resultList.result.find((r) => r['isOpenAccess'] === 'Y');
    expect(open).toBeDefined();
    expect(mapEpmc(open!, 'q')!.research?.isOpenAccess).toBe(true);

    const closed = data.resultList.result.find((r) => r['isOpenAccess'] === 'N');
    if (closed !== undefined) expect(mapEpmc(closed, 'q')!.research?.isOpenAccess).toBe(false);
  });

  it('only offers an open-access URL when upstream declares one', () => {
    for (const record of data.resultList.result) {
      const item = mapEpmc(record, 'q');
      if (item === null) continue;
      // A link presented as open access must never point at a paywall.
      if (item.research?.openAccessUrl !== null) expect(item.research?.isOpenAccess).toBe(true);
    }
  });

  it('strips section headers into readable prose', () => {
    const withAbstract = data.resultList.result.find(
      (r) => typeof r['abstractText'] === 'string' && (r['abstractText'] as string).includes('<h4>'),
    );
    if (withAbstract === undefined) return;
    const abstract = mapEpmc(withAbstract, 'q')!.research!.abstract;
    expect(abstract).not.toContain('<h4>');
    expect(abstract).toMatch(/Background \w/);
  });
});

describe('bioRxiv / medRxiv', () => {
  const data = json<{ collection: Record<string, unknown>[] }>('biorxiv.json');

  it('maps a preprint with its version', () => {
    const item = mapPreprint(data.collection[0]!, 'biorxiv')!;
    expect(item.research?.kind).toBe('preprint');
    expect(item.research?.lifecycle.preprintVersion).toBeGreaterThanOrEqual(1);
    expect(item.url).toContain('biorxiv.org/content/');
  });

  it("parses `version` even though upstream sends it as a string", () => {
    const revised = data.collection.find((r) => String(r['version']) !== '1');
    expect(revised).toBeDefined();
    expect(mapPreprint(revised!, 'biorxiv')!.research?.lifecycle.preprintVersion).toBeGreaterThan(1);
  });

  it("treats the literal 'NA' published field as unpublished", () => {
    // If 'NA' ever became an identity key, every unpublished preprint would
    // weld into one item.
    const unpublished = data.collection.find((r) => r['published'] === 'NA');
    expect(unpublished).toBeDefined();
    const item = mapPreprint(unpublished!, 'biorxiv')!;
    expect(item.research?.lifecycle.publishedDoi).toBeNull();
    expect(item.research?.lifecycle.isSuperseded).toBe(false);
  });

  it('does not adopt the published DOI as an identity key', () => {
    // The preprint and its journal version must stay linked-but-distinct so
    // "now published" is a change event with a before and an after.
    for (const record of data.collection) {
      const item = mapPreprint(record, 'biorxiv');
      if (item?.research?.lifecycle.publishedDoi == null) continue;
      expect(item.identity).not.toContain(`doi:${item.research.lifecycle.publishedDoi}`);
    }
  });
});

describe('arXiv', () => {
  const xml = fixture('arxiv.xml');
  const entries = extractAll(xml, 'entry');

  it('parses the Atom feed', () => {
    expect(entries.length).toBeGreaterThan(0);
    const item = mapArxiv(entries[0]!, 'test')!;
    expect(item.research?.arxivId).toMatch(/^\d{4}\.\d{4,5}$/);
    expect(item.title.length).toBeGreaterThan(5);
    expect((item.research?.authors ?? []).length).toBeGreaterThan(0);
    expect(item.tags.length).toBeGreaterThan(0);
  });

  it('separates the id from its version', () => {
    const item = mapArxiv(entries[0]!, 'test')!;
    expect(item.research?.arxivId).not.toContain('v');
    expect(item.research?.lifecycle.preprintVersion).toBeGreaterThanOrEqual(1);
  });
});

describe('OpenAlex', () => {
  const data = json<{ results: Record<string, unknown>[] }>('openalex.json');

  it('reconstructs an abstract from the inverted index', () => {
    const index = { Hello: [0], world: [1], again: [2] };
    expect(reconstructAbstract(index)).toBe('Hello world again');
  });

  it('survives a null inverted index', () => {
    // OpenAlex genuinely returns null here; Object.entries(null) throws and
    // took out three of six queries on the first live run.
    expect(reconstructAbstract(null)).toBe('');
    expect(reconstructAbstract(undefined)).toBe('');
  });

  it('maps a work with topics and identity keys', () => {
    const work = data.results.find((w) => w['type'] === 'article' || w['type'] === 'preprint');
    if (work === undefined) return;
    const item = mapOpenAlex(work, 'q')!;
    expect(item.identity.some((key) => key.startsWith('openalex:'))).toBe(true);
    expect(item.research?.openAlexId).toMatch(/^W\d+$/);
  });

  it('rejects datasets and other non-literature types', () => {
    // Zenodo code deposits were surfacing at the top of the feed.
    const dataset = { id: 'https://openalex.org/W1', title: 'code for: something', type: 'dataset' };
    expect(mapOpenAlex(dataset, 'q')).toBeNull();

    const paratext = { id: 'https://openalex.org/W2', title: 'Front matter', type: 'article', is_paratext: true };
    expect(mapOpenAlex(paratext, 'q')).toBeNull();
  });
});

describe('PubMed', () => {
  const xml = fixture('pubmed-efetch.xml');
  const articles = extractAll(xml, 'PubmedArticle');

  it('parses efetch XML, which unlike esummary carries the abstract', () => {
    expect(articles.length).toBeGreaterThan(0);
    const item = mapPubmed(articles[0]!, 'q')!;
    expect(item.research?.pmid).toMatch(/^\d+$/);
    // The whole reason this connector uses efetch rather than esummary.
    expect((item.research?.abstract ?? '').length).toBeGreaterThan(100);
    expect(item.research?.journal).toBeTruthy();
    expect((item.research?.authors ?? []).length).toBeGreaterThan(0);
  });

  it('extracts the DOI as an identity key', () => {
    const withDoi = articles.find((a) => a.includes('IdType="doi"'));
    expect(withDoi).toBeDefined();
    expect(mapPubmed(withDoi!, 'q')!.identity.some((key) => key.startsWith('doi:'))).toBe(true);
  });

  it('produces plain-text abstracts with no residual markup', () => {
    for (const article of articles) {
      const item = mapPubmed(article, 'q');
      // Checks for TAGS, not for '<'. A bare less-than is ordinary prose in
      // this corpus - real abstracts are full of "P < 0.05" - and asserting on
      // the character would fail on correct output.
      expect(item?.research?.abstract ?? '').not.toMatch(/<\/?[a-zA-Z][^>]*>/);
    }
  });

  it('keeps inequalities in abstract prose intact', () => {
    const stats = articles.find((a) => a.includes('P &lt;') || a.includes('P <'));
    if (stats === undefined) return;
    expect(mapPubmed(stats, 'q')?.research?.abstract).toMatch(/P\s*</);
  });
});

describe('Crossref', () => {
  const data = json<{ message: { items: Record<string, unknown>[] } }>('crossref.json');

  it('maps DOI metadata', () => {
    const record = mapCrossref(data.message.items[0]!, NOW);
    expect(record?.doi).toMatch(/^10\./);
  });

  it('rejects impossible future dates', () => {
    // A live response carried `"issued": {"date-parts": [[2106]]}` - a
    // publisher typo. Recency scoring would treat it as "just posted" and pin
    // it to the top of the feed forever.
    expect(assertPlausibleDate('2106-01-01T00:00:00.000Z', NOW)).toBeNull();
    expect(assertPlausibleDate('2026-09-01T00:00:00.000Z', NOW)).toBe('2026-09-01T00:00:00.000Z');
  });

  it('claims open access only from a recognised licence', () => {
    const noLicense = mapCrossref({ DOI: '10.1038/abc', license: [] }, NOW);
    expect(noLicense?.isOpenAccess).toBe(false);

    const cc = mapCrossref(
      { DOI: '10.1038/xyz', license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }], URL: 'https://x' },
      NOW,
    );
    expect(cc?.isOpenAccess).toBe(true);
  });

  it('drops records whose DOI is not validly shaped', () => {
    expect(mapCrossref({ DOI: 'not-a-doi' }, NOW)).toBeNull();
  });
});
