/**
 * Re-capture the test fixtures.  `npm run capture:fixtures`
 *
 * Every file in `fixtures/` is a real upstream response, truncated. The test
 * suite parses them instead of the network, which is what makes it hermetic:
 * PubMed and Crossref both rate-limit, and CI must not flake on someone else's
 * outage or add load to a public API on every push.
 *
 * Run this when an upstream changes shape - a connector test failing against a
 * fixture that no longer resembles reality is worse than no test at all. Then
 * READ THE DIFF before committing: a fixture change is upstream telling you
 * something, and the point of committing them is that the change is reviewable.
 *
 * Records are truncated so the fixtures stay a reasonable size in the repo,
 * and the selection is deliberate rather than "the first N" where a specific
 * shape matters - the calendar sample keeps events that carry registration
 * emails, food words, coordinates, and online links, because those are exactly
 * the fields the parsers and the privacy guard are tested against.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');

const USER_AGENT =
  'radar/1.0 (+https://harsh.bet/radar; fixture capture for a personal aggregator; runs manually, rarely)';

interface Capture {
  file: string;
  url: string;
  /** Truncate the parsed JSON before writing. Omit to keep the raw text. */
  trim?: (data: unknown) => unknown;
}

/** Keep the first `n` of an array at `path` inside a JSON object. */
function keepFirst(path: string[], n: number) {
  return (data: unknown): unknown => {
    let node = data as Record<string, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    const last = path[path.length - 1];
    if (last === undefined) return data;
    const list = node[last];
    if (Array.isArray(list)) node[last] = list.slice(0, n);
    return data;
  };
}

const CAPTURES: Capture[] = [
  {
    file: 'europepmc.json',
    url:
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
      '?query=%22Mycobacterium%20tuberculosis%22%20AND%20%22positive%20selection%22' +
      '&format=json&pageSize=25&resultType=core&cursorMark=*&sort=P_PDATE_D%20desc',
    trim: keepFirst(['resultList', 'result'], 8),
  },
  {
    file: 'biorxiv.json',
    url: 'https://api.biorxiv.org/details/biorxiv/2026-08-01/2026-08-05/0',
    trim: keepFirst(['collection'], 12),
  },
  {
    file: 'medrxiv.json',
    url: 'https://api.biorxiv.org/details/medrxiv/2026-08-01/2026-08-05/0',
    trim: keepFirst(['collection'], 12),
  },
  {
    file: 'crossref.json',
    url: 'https://api.crossref.org/works?query=tuberculosis+positive+selection&rows=20',
    trim: keepFirst(['message', 'items'], 6),
  },
  {
    file: 'openalex.json',
    url:
      'https://api.openalex.org/works?filter=title_and_abstract.search:tuberculosis%20positive%20selection' +
      '&per-page=20',
    trim: keepFirst(['results'], 6),
  },
  {
    file: 'arxiv.xml',
    url:
      'https://export.arxiv.org/api/query?search_query=abs:%22codon+model%22' +
      '&max_results=15&sortBy=submittedDate&sortOrder=descending',
  },
  {
    file: 'pubmed-esearch.json',
    url:
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed' +
      '&term=%22Mycobacterium+tuberculosis%22+AND+%22positive+selection%22&retmode=json&retmax=25&sort=date',
  },
  {
    file: 'tamu-athletics.json',
    url: 'https://calendar.tamu.edu/live/json/events/group/Aggie%20Athletics',
    trim: (data) => (Array.isArray(data) ? data.slice(0, 12) : data),
  },
  {
    file: 'tamu-career-center.json',
    url: 'https://calendar.tamu.edu/live/json/events/group/Career%20Center',
    trim: (data) => (Array.isArray(data) ? data.slice(0, 12) : data),
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOne(capture: Capture): Promise<void> {
  const res = await fetch(capture.url, {
    headers: { accept: 'application/json, application/xml;q=0.9, */*;q=0.8', 'user-agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const path = join(FIXTURES, capture.file);

  if (capture.trim === undefined) {
    const text = await res.text();
    await writeFile(path, text, 'utf8');
    console.log(`  ${capture.file}: ${(text.length / 1024).toFixed(0)}KB (raw)`);
    return;
  }

  const trimmed = capture.trim(await res.json());
  const json = `${JSON.stringify(trimmed, null, 1)}\n`;
  await writeFile(path, json, 'utf8');
  console.log(`  ${capture.file}: ${(json.length / 1024).toFixed(0)}KB`);
}

async function main(): Promise<void> {
  console.log('Capturing fixtures. Read the git diff before committing.\n');
  let failures = 0;

  for (const capture of CAPTURES) {
    try {
      await fetchOne(capture);
    } catch (err) {
      failures += 1;
      console.error(`  ${capture.file}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    }
    // Be a polite guest even in a one-off script.
    await sleep(1200);
  }

  // The TAMU calendar sample is selected rather than truncated, and the PubMed
  // efetch capture depends on the ids esearch just returned, so both are
  // documented here rather than automated into a shape that hides the intent.
  console.log('\nTwo fixtures are not captured automatically:');
  console.log('  tamu-calendar.json  - a hand-picked sample that must keep events carrying');
  console.log('                        registration emails, food words, coordinates, and online');
  console.log('                        links; the privacy and parser tests depend on those.');
  console.log('  pubmed-efetch.xml   - depends on the ids in pubmed-esearch.json; refetch with');
  console.log('                        efetch.fcgi?db=pubmed&id=<ids>&retmode=xml');

  if (failures > 0) {
    console.error(`\n${failures} capture(s) failed. Existing fixtures were left alone.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('[capture:fixtures] unexpected failure:', err);
  process.exitCode = 1;
});
