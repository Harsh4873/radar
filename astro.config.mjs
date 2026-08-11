// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

/**
 * Deployed at https://harsh.bet/radar/ (GitHub Pages project site; the user
 * site carries the harsh.bet custom domain, so this repo's name is the path
 * segment).
 *
 * `output: 'static'` is not a preference, it is forced by the upstreams.
 * NONE of Radar's sources send `Access-Control-Allow-Origin`:
 *
 *   eutils.ncbi.nlm.nih.gov      PubMed E-utilities
 *   www.ebi.ac.uk/europepmc      Europe PMC REST
 *   api.biorxiv.org              bioRxiv / medRxiv
 *   api.crossref.org             Crossref
 *   api.openalex.org             OpenAlex
 *   export.arxiv.org             arXiv Atom
 *   calendar.tamu.edu            TAMU LiveWhale calendar
 *   research.tamu.edu            Aggie Research Volunteers
 *
 * A browser `fetch()` to any of them is blocked. Every upstream read happens
 * server-side in `npm run ingest` and is baked into the build. Never fetch an
 * upstream from client-side code - it will work in dev (Vite proxies it) and
 * fail silently in production.
 */
export default defineConfig({
  site: 'https://harsh.bet',
  base: '/radar',
  output: 'static',

  // 'always' + 'directory' keeps every internal link canonical under /radar/
  // and works on any plain static host without rewrite rules.
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
