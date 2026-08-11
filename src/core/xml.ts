/**
 * Minimal XML reading for the two Atom/XML feeds Radar consumes.
 *
 * This is regex-based, and that is a deliberate, bounded choice rather than
 * laziness. It parses exactly two inputs:
 *
 *   export.arxiv.org  Atom 1.0, machine-generated, flat two-level structure
 *   eutils efetch     PubMed article XML, machine-generated, DTD-validated
 *
 * Both are emitted by long-lived server software with stable schemas; neither
 * contains the things that make regex XML parsing infamous (arbitrary nesting
 * of same-named elements, CDATA holding markup, namespaced attributes that
 * matter). Pulling in a real parser to read two well-formed machine feeds
 * would be a dependency and a supply-chain surface for no correctness gain.
 *
 * The limits are real, so they are stated: this cannot handle recursive
 * same-name nesting, and it does not validate. If a third XML source ever
 * shows up - especially a hand-authored one - replace this with a parser
 * rather than extending it.
 */

import { decodeEntities, collapse } from '@/core/text.ts';

/** Every `<tag>...</tag>` body in `xml`, in document order. Non-greedy. */
export function extractAll(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** First `<tag>` body, or null. Also matches the self-closing `<tag/>` as ''. */
export function extractOne(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const match = pattern.exec(xml);
  if (match?.[1] !== undefined) return match[1];
  return new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(xml) ? '' : null;
}

/** First `<tag>` body as collapsed, entity-decoded plain text. */
export function textOf(xml: string, tag: string): string | null {
  const raw = extractOne(xml, tag);
  return raw === null ? null : collapse(decodeEntities(stripTags(raw)));
}

/** All `<tag>` bodies as collapsed plain text, blanks dropped. */
export function textsOf(xml: string, tag: string): string[] {
  return extractAll(xml, tag)
    .map((raw) => collapse(decodeEntities(stripTags(raw))))
    .filter((value) => value.length > 0);
}

/**
 * Value of `attr` on the first `<tag ...>` whose attributes satisfy `where`.
 *
 * Used for arXiv's `<link rel="alternate" href="...">` and
 * `<category term="q-bio.PE">`, where the useful data lives in attributes.
 */
export function attrOf(
  xml: string,
  tag: string,
  attr: string,
  where?: (attrs: Record<string, string>) => boolean,
): string | null {
  const pattern = new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    const attrs = parseAttrs(match[1] ?? '');
    if (where !== undefined && !where(attrs)) continue;
    const value = attrs[attr];
    if (value !== undefined) return value;
  }
  return null;
}

/** Every value of `attr` across all `<tag>` elements. */
export function attrsOf(xml: string, tag: string, attr: string): string[] {
  const pattern = new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g');
  const out: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    const value = parseAttrs(match[1] ?? '')[attr];
    if (value !== undefined) out.push(value);
  }
  return out;
}

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = decodeEntities(value);
  }
  return out;
}

/** Drop tags, keeping their text. Block-ish tags become spaces. */
export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}
