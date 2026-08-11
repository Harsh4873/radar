/**
 * The campus interest model.
 *
 * Same shape as the research profile and for the same reason: every point the
 * ranker awards must be traceable to a named line in a file a human can edit.
 *
 * The tiers come straight from the brief:
 *
 *   VERY HIGH  computer science, bioinformatics, biotech, research
 *              opportunities, worthwhile paid studies
 *   HIGH       company recruiting, career events, basketball, football,
 *              graduate opportunities
 *   MEDIUM     free food, social events, workshops
 *   LOW        things consistently dismissed (learned at runtime, not here)
 *
 * The LOW tier is deliberately absent from this file. Dismissals are personal
 * and change week to week, so they live in browser storage and are applied by
 * the client re-ranker in `src/client/personalize.ts`. Baking them in would
 * make "not relevant" require a redeploy.
 */

export interface CampusInterest {
  id: string;
  label: string;
  weight: number;
  signal: 'field' | 'career' | 'sport' | 'perk' | 'opportunity' | 'social';
  patterns: string[];
}

export const CAMPUS_INTERESTS: readonly CampusInterest[] = [
  // --- VERY HIGH ----------------------------------------------------------
  {
    id: 'cs',
    label: 'computer science',
    weight: 26,
    signal: 'field',
    patterns: [
      'computer science', 'software engineering', 'software', 'programming', 'algorithms',
      'systems', 'distributed systems', 'compilers', 'operating systems', 'cybersecurity',
      'artificial intelligence', 'machine learning', 'deep learning', 'llm', 'hackathon',
      'coding', 'developer', 'open source', 'cloud computing', 'devops',
    ],
  },
  {
    id: 'bioinformatics',
    label: 'bioinformatics / genomics',
    weight: 28,
    signal: 'field',
    patterns: [
      'bioinformatics', 'computational biology', 'genomics', 'genomic', 'genome',
      'sequencing', 'phylogenetics', 'molecular evolution', 'systems biology',
      'biostatistics', 'population genetics', 'microbiome', 'proteomics',
    ],
  },
  {
    id: 'biotech',
    label: 'biotech',
    weight: 22,
    signal: 'field',
    patterns: [
      'biotech', 'biotechnology', 'life sciences', 'pharmaceutical', 'pharma',
      'drug discovery', 'clinical research', 'biomedical', 'infectious disease',
      'microbiology', 'immunology', 'epidemiology', 'public health',
    ],
  },
  {
    id: 'research-opportunity',
    label: 'research opportunity',
    weight: 24,
    signal: 'opportunity',
    patterns: [
      'research assistant', 'undergraduate research', 'research opportunity',
      'lab position', 'reu', 'research experience', 'thesis', 'graduate research',
      'research symposium', 'poster session', 'research showcase',
    ],
  },
  {
    id: 'paid-study',
    label: 'paid study',
    weight: 20,
    signal: 'opportunity',
    patterns: [
      'paid study', 'research study', 'participants needed', 'volunteers needed',
      'compensation', 'clinical trial', 'study participants',
    ],
  },
  {
    id: 'data-science',
    label: 'data science',
    weight: 22,
    signal: 'field',
    patterns: [
      'data science', 'data analytics', 'statistics', 'statistical', 'tamids',
      'high performance computing', 'hprc', 'supercomputing', 'gpu', 'python', 'r programming',
    ],
  },

  // --- HIGH ---------------------------------------------------------------
  {
    id: 'recruiting',
    label: 'company recruiting',
    weight: 18,
    signal: 'career',
    patterns: [
      'info session', 'information session', 'tech talk', 'career fair', 'job fair',
      'recruiting', 'recruiter', 'hiring', 'internship', 'full time', 'employer',
      'networking', 'industry', 'career expo', 'meet the firms',
    ],
  },
  {
    id: 'grad-school',
    label: 'graduate opportunities',
    weight: 15,
    signal: 'opportunity',
    patterns: [
      'graduate school', 'grad school', 'phd', 'masters', 'fellowship', 'assistantship',
      'graduate program', 'application workshop', 'gre', 'admissions',
    ],
  },
  {
    id: 'basketball',
    label: 'basketball',
    weight: 14,
    signal: 'sport',
    patterns: ['basketball', 'reed arena', 'hoops'],
  },
  {
    id: 'football',
    label: 'football',
    weight: 14,
    signal: 'sport',
    patterns: ['football', 'kyle field', 'midnight yell', 'bonfire'],
  },
  {
    id: 'other-sports',
    label: 'other Aggie sports',
    weight: 7,
    signal: 'sport',
    patterns: [
      'baseball', 'softball', 'soccer', 'volleyball', 'tennis', 'track and field',
      'swimming', 'olsen field', 'equestrian', 'golf',
    ],
  },

  // --- MEDIUM -------------------------------------------------------------
  {
    id: 'career-dev',
    label: 'career development',
    weight: 9,
    signal: 'career',
    patterns: [
      'resume', 'cover letter', 'interview prep', 'mock interview', 'linkedin',
      'portfolio', 'personal statement', 'professional development', 'salary negotiation',
    ],
  },
  {
    id: 'workshop',
    label: 'workshop / training',
    weight: 7,
    signal: 'field',
    patterns: [
      'workshop', 'training', 'bootcamp', 'short course', 'tutorial', 'seminar',
      'certification', 'hands on', 'lab session',
    ],
  },
  {
    id: 'social',
    label: 'social',
    weight: 3,
    signal: 'social',
    patterns: [
      'social', 'mixer', 'game night', 'movie night', 'trivia', 'community',
      'welcome', 'meet and greet', 'open house',
    ],
  },
];

/** Interests keyed by id, for applying learned muting from the client. */
export const CAMPUS_INTERESTS_BY_ID: ReadonlyMap<string, CampusInterest> = new Map(
  CAMPUS_INTERESTS.map((interest) => [interest.id, interest]),
);
