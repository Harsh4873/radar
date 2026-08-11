/**
 * The research profile.
 *
 * This is the thing that makes ResearchRadar a filter rather than a firehose.
 * It is deliberately DATA, not code: adding a term is a one-line edit here,
 * and every score the site shows traces back to an entry in this file.
 *
 * Structure follows the three bands the product uses:
 *
 *   CORE      the actual subject. Firing here is what makes something a
 *             "highly relevant" red-band paper.
 *   METHODS   how the work is done. A methods paper can be worth reading even
 *             when the organism is wrong - a better codon model matters
 *             regardless of what it was demonstrated on.
 *   ADJACENT  the neighbourhood. Not enough on its own; earns its place by
 *             stacking with a core or methods hit.
 *
 * MATCHING IS PHRASE-BASED, NOT KEYWORD-BASED, and that distinction is the
 * whole reason this is not a PubMed alert. `dN/dS`, `M. tuberculosis`, and
 * `Mycobacterium tuberculosis` must all resolve to the same concept, while
 * "selection" on its own (as in "selection of participants") must not fire the
 * positive-selection term. Patterns are matched against a normalized token
 * stream so punctuation and spacing variants collapse automatically.
 */

import { tokenize } from '@/core/text.ts';

export type ProfileBand = 'core' | 'methods' | 'adjacent';

export interface ProfileTerm {
  id: string;
  /** Rendered verbatim in the "why Radar picked it" list. Keep it short. */
  label: string;
  band: ProfileBand;
  /** Signal family, groups reasons in the UI. */
  signal: 'organism' | 'method' | 'topic' | 'host' | 'domain';
  /** Points awarded on a hit. Tuned relative to each other, not absolute. */
  weight: number;
  /**
   * Normalized phrase forms. Each is compared against the item's token stream,
   * so write them as space-separated lowercase words with punctuation removed:
   * `M. tuberculosis` becomes `tuberculosis` preceded by the token `m`.
   */
  patterns: string[];
}

/**
 * Weights are editorial. The ratios that matter:
 *
 *   organism (28)  the single strongest signal. A paper about the right bug is
 *                  worth surfacing even if nothing else matches.
 *   method (21)    nearly as strong, because methods transfer across systems.
 *   host/diabetes  (17) the specific angle of this work, rarer than either.
 *   adjacent (4-8) never enough alone; they exist to break ties and to build
 *                  a case when three of them fire together.
 */
export const PROFILE: readonly ProfileTerm[] = [
  // --- CORE ---------------------------------------------------------------
  {
    id: 'mtb',
    label: 'M. tuberculosis',
    band: 'core',
    signal: 'organism',
    weight: 28,
    patterns: [
      'mycobacterium tuberculosis',
      'm tuberculosis',
      'mtb',
      'tuberculosis',
      'tubercle bacillus',
      'mycobacterium africanum',
      'mycobacterium bovis',
      'mtbc',
      'tuberculosis complex',
    ],
  },
  {
    id: 'positive-selection',
    label: 'positive selection',
    band: 'core',
    signal: 'topic',
    weight: 24,
    patterns: [
      'positive selection',
      'positively selected',
      'diversifying selection',
      'adaptive evolution',
      'selective pressure',
      'selection pressure',
      'selective sweep',
      'darwinian selection',
      'purifying selection',
      'convergent evolution',
    ],
  },
  {
    id: 'comparative-genomics',
    label: 'comparative genomics',
    band: 'core',
    signal: 'topic',
    weight: 18,
    patterns: [
      'comparative genomics',
      'comparative genomic',
      'pangenome',
      'pan genome',
      'population genomics',
      'whole genome sequencing',
      'genome wide association',
      'phylogenomics',
    ],
  },
  {
    id: 'diabetes-tb',
    label: 'diabetes / host metabolic',
    band: 'core',
    signal: 'host',
    weight: 17,
    patterns: [
      'diabetes',
      'diabetic',
      'type 2 diabetes',
      'hyperglycemia',
      'hyperglycaemia',
      'metabolic syndrome',
      'glycemic',
      'insulin resistance',
      'comorbidity',
    ],
  },

  // --- METHODS ------------------------------------------------------------
  {
    id: 'codon-models',
    label: 'codon-model analysis',
    band: 'methods',
    signal: 'method',
    weight: 21,
    patterns: [
      'codon model',
      'codon models',
      'codon substitution',
      'site model',
      'branch site',
      'branch site model',
      'dn ds',
      'dnds',
      'ka ks',
      'nonsynonymous synonymous',
      'omega ratio',
    ],
  },
  {
    id: 'paml',
    label: 'PAML / codeml',
    band: 'methods',
    signal: 'method',
    weight: 19,
    patterns: ['paml', 'codeml', 'baseml', 'yn00'],
  },
  {
    id: 'hyphy',
    label: 'HyPhy / selection tests',
    band: 'methods',
    signal: 'method',
    weight: 18,
    patterns: ['hyphy', 'meme', 'fubar', 'busted', 'absrel', 'slac', 'fel', 'datamonkey'],
  },
  {
    id: 'genomegamap',
    label: 'genomegaMap',
    band: 'methods',
    signal: 'method',
    weight: 20,
    patterns: ['genomegamap', 'genomega map', 'genomegamaps'],
  },
  {
    id: 'phylogenetics',
    label: 'phylogenetics',
    band: 'methods',
    signal: 'method',
    weight: 12,
    patterns: [
      'phylogenetic',
      'phylogeny',
      'phylogenies',
      'maximum likelihood tree',
      'raxml',
      'iqtree',
      'iq tree',
      'beast',
      'mrbayes',
      'ancestral reconstruction',
    ],
  },
  {
    id: 'mcmc',
    label: 'MCMC / Bayesian inference',
    band: 'methods',
    signal: 'method',
    weight: 11,
    patterns: [
      'mcmc',
      'markov chain monte carlo',
      'bayesian inference',
      'posterior distribution',
      'gibbs sampling',
      'hamiltonian monte carlo',
      'variational inference',
    ],
  },
  {
    id: 'pipelines',
    label: 'bioinformatics tooling',
    band: 'methods',
    signal: 'method',
    weight: 9,
    patterns: [
      'nextflow',
      'snakemake',
      'workflow manager',
      'bioinformatics pipeline',
      'command line tool',
      'open source tool',
      'software package',
      'benchmarking',
      'reproducible analysis',
    ],
  },

  // --- ADJACENT -----------------------------------------------------------
  {
    id: 'host-pathogen',
    label: 'host-pathogen interaction',
    band: 'adjacent',
    signal: 'topic',
    weight: 8,
    patterns: [
      'host pathogen',
      'host pathogen interaction',
      'host response',
      'immune evasion',
      'virulence factor',
      'pathogenesis',
      'infection model',
      'granuloma',
      'macrophage',
    ],
  },
  {
    id: 'pathogen-evolution',
    label: 'pathogen evolution',
    band: 'adjacent',
    signal: 'topic',
    weight: 8,
    patterns: [
      'pathogen evolution',
      'bacterial evolution',
      'microbial evolution',
      'within host evolution',
      'within host diversity',
      'transmission dynamics',
      'molecular epidemiology',
      'lineage',
    ],
  },
  {
    id: 'amr',
    label: 'antimicrobial resistance',
    band: 'adjacent',
    signal: 'topic',
    weight: 8,
    patterns: [
      'antimicrobial resistance',
      'antibiotic resistance',
      'drug resistance',
      'drug resistant',
      'multidrug resistant',
      'mdr tb',
      'xdr tb',
      'rifampicin',
      'isoniazid',
      'fluoroquinolone',
    ],
  },
  {
    id: 'genome-evolution',
    label: 'genome evolution',
    band: 'adjacent',
    signal: 'topic',
    weight: 6,
    patterns: [
      'genome evolution',
      'molecular evolution',
      'substitution rate',
      'mutation rate',
      'recombination',
      'horizontal gene transfer',
      'gene duplication',
    ],
  },
  {
    id: 'computational-biology',
    label: 'computational biology',
    band: 'adjacent',
    signal: 'domain',
    weight: 5,
    patterns: [
      'computational biology',
      'bioinformatics',
      'statistical genetics',
      'machine learning',
      'deep learning',
      'sequence analysis',
    ],
  },
  {
    id: 'epidemiology',
    label: 'TB epidemiology',
    band: 'adjacent',
    signal: 'topic',
    weight: 5,
    patterns: [
      'incidence',
      'prevalence',
      'cohort study',
      'case control',
      'clinical isolates',
      'clinical isolate',
      'treatment outcome',
      'latent infection',
    ],
  },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface ProfileMatch {
  term: ProfileTerm;
  /** Which pattern fired. Useful when auditing a surprising score. */
  matched: string;
}

/**
 * Normalize free text into a padded token stream for phrase matching.
 *
 * Padding with leading/trailing spaces lets a pattern be tested with plain
 * `includes(' phrase ')`, which enforces WORD boundaries. Without the padding,
 * `fel` (a HyPhy test) would match inside "fell" and "self", and the methods
 * band would light up on every paper that used the word.
 */
export function searchable(...parts: (string | null | undefined)[]): string {
  const text = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
  return ` ${tokenize(text).join(' ')} `;
}

/**
 * Every profile term present in the text.
 *
 * A term fires at most once no matter how many of its patterns match - a paper
 * that says "tuberculosis" forty times is not forty times more relevant, and
 * counting occurrences would let a long paper out-rank a precise one.
 */
export function matchProfile(haystack: string, profile: readonly ProfileTerm[] = PROFILE): ProfileMatch[] {
  const matches: ProfileMatch[] = [];
  for (const term of profile) {
    for (const pattern of term.patterns) {
      if (haystack.includes(` ${pattern} `)) {
        matches.push({ term, matched: pattern });
        break;
      }
    }
  }
  return matches;
}

/** Terms in one band, for building per-source queries. */
export function termsInBand(band: ProfileBand): readonly ProfileTerm[] {
  return PROFILE.filter((term) => term.band === band);
}

/**
 * Search queries derived from the profile.
 *
 * Kept small and high-precision on purpose. These decide what Radar even
 * LOOKS at; the profile scorer then decides what survives. A broad query wastes
 * upstream quota and buries the ranker in noise, so each of these pairs a core
 * concept with a second constraint rather than fishing on one word.
 */
export const RESEARCH_QUERIES: readonly string[] = [
  '"Mycobacterium tuberculosis" AND "positive selection"',
  '"Mycobacterium tuberculosis" AND ("comparative genomics" OR phylogenomics)',
  '"Mycobacterium tuberculosis" AND (diabetes OR "metabolic syndrome")',
  '"Mycobacterium tuberculosis" AND ("drug resistance" OR "antimicrobial resistance") AND evolution',
  '("codon model" OR "dN/dS" OR "branch-site") AND (selection OR evolution)',
  '(PAML OR codeml OR HyPhy OR genomegaMap) AND selection',
  '"within-host" AND ("Mycobacterium tuberculosis" OR "pathogen evolution")',
];

/** arXiv is queried separately - it holds the methods work, not the biology. */
export const ARXIV_QUERIES: readonly string[] = [
  'abs:"codon model" OR abs:"molecular evolution"',
  'abs:"phylogenetic inference" AND abs:"Bayesian"',
  'abs:"pathogen genomics" OR abs:"bacterial genomics"',
];
