/**
 * The Free Stuff classifier.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: never say "FREE FOOD" unless the
 * source actually says the food is free.
 *
 * Sending someone across campus for pizza that was never offered is the single
 * most annoying thing a tool like this can do, and it is the default outcome
 * of naive keyword matching - "Coffee Chat with the Dean" contains "coffee",
 * and a grep-based detector will happily advertise free coffee. So the output
 * is a TIER, not a boolean, and the UI is required to render the tiers
 * differently:
 *
 *   confirmed  the text says it is free       "free pizza", "lunch at no cost"
 *   provided   the text says it is supplied   "lunch provided", "dinner served"
 *   mentioned  a food word appears, unclear   "Coffee Chat", "Pizza with Profs"
 *   none       no food signal at all
 *
 * `provided` is deliberately separate from `confirmed`: a departmental lunch
 * that is "provided" is almost always free, but a conference lunch that is
 * "provided" can be $15, and the text does not distinguish them.
 *
 * RAFFLES AND GIVEAWAYS ARE NOT FREE STUFF. A chance to win a t-shirt is not a
 * t-shirt. They are tracked separately as `chance` so the UI can show them
 * without ever implying a guaranteed item.
 */

import type { FoodConfidence, FoodSignal } from '@/types.ts';

/**
 * Foods that actually appear in these listings.
 *
 * Ordered longest-phrase-first within the matcher so "ice cream" is found
 * before "cream" would be, and multi-word entries are matched as phrases.
 */
const FOOD_TERMS: readonly string[] = [
  'kolaches', 'kolache', 'pizza', 'tacos', 'taco', 'barbecue', 'bbq', 'brisket',
  'donuts', 'doughnuts', 'donut', 'bagels', 'bagel', 'cookies', 'cookie',
  'sandwiches', 'sandwich', 'burgers', 'burger', 'wings', 'chips', 'queso',
  'ice cream', 'popsicles', 'cupcakes', 'cake', 'candy', 'popcorn', 'fruit',
  'coffee', 'boba', 'tea', 'lemonade', 'drinks', 'beverages', 'soda',
  'breakfast', 'brunch', 'lunch', 'dinner', 'supper', 'snacks', 'snack',
  'refreshments', 'catering', 'catered', 'food', 'meal', 'buffet',
  'chick fil a', 'whataburger', 'raising canes', 'panda express', 'torchys',
];

/**
 * Terms that state something is free of charge.
 *
 * `no cost`, `complimentary`, and `on us` are included because campus copy
 * uses them constantly; `sponsored` is NOT, because a sponsored event still
 * routinely charges for food.
 */
const FREE_TERMS: readonly string[] = [
  'free', 'no cost', 'at no cost', 'complimentary', 'on us', 'free of charge', 'no charge',
];

/** Terms that state food is supplied, without committing on price. */
const PROVIDED_TERMS: readonly string[] = [
  'provided', 'served', 'will be served', 'included', 'available', 'furnished', 'catered',
];

/**
 * Non-food giveaways. Guaranteed items only.
 *
 * `raffle`, `drawing`, `enter to win`, and `chance to win` are deliberately
 * absent - see CHANCE_TERMS.
 */
const SWAG_TERMS: readonly string[] = [
  'swag', 'free t-shirt', 'free tshirt', 'free shirt', 'giveaways', 'giveaway',
  'free stickers', 'stickers', 'free samples', 'samples', 'goodie bag', 'goody bag',
  'merch', 'free merch', 'prizes',
];

/** Lottery language. Never counts as a guaranteed freebie. */
const CHANCE_TERMS: readonly string[] = [
  'raffle', 'drawing', 'enter to win', 'chance to win', 'sweepstakes', 'lottery', 'door prize',
];

/** Window, in characters, within which two terms count as related. */
const PROXIMITY = 60;

/**
 * Normalize for matching: lowercase, punctuation to spaces, collapse.
 *
 * Hyphens become spaces so "chick-fil-a" and "t-shirt" match their entries,
 * and the result is space-padded so `includes(' term ')` enforces word
 * boundaries - without it "tea" matches inside "team" and every team meeting
 * on campus advertises refreshments.
 */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function findTerm(haystack: string, terms: readonly string[]): { term: string; index: number } | null {
  for (const term of terms) {
    const index = haystack.indexOf(` ${term} `);
    if (index >= 0) return { term, index };
  }
  return null;
}

function findAllTerms(haystack: string, terms: readonly string[]): { term: string; index: number }[] {
  const out: { term: string; index: number }[] = [];
  for (const term of terms) {
    const index = haystack.indexOf(` ${term} `);
    if (index >= 0) out.push({ term, index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** A readable snippet around a match, so the UI can show its evidence. */
function evidenceAround(original: string, haystack: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(haystack.length, index + 70);
  const snippet = haystack.slice(start, end).trim();
  return snippet.length > 0 ? snippet : original.slice(0, 100);
}

export interface FreebieResult {
  food: FoodSignal;
  /** Guaranteed non-food items, e.g. ['swag', 'stickers']. */
  swag: string[];
  /** Lottery-style offers. Never presented as guaranteed. */
  chance: string[];
}

/**
 * Classify an event's free-stuff signals.
 *
 * `cost` is the LiveWhale `cost` field, which is frequently the literal string
 * "Free". That is strong evidence about the EVENT's price - and only weak
 * evidence about the food - so it can promote `mentioned` to `provided`, but
 * never straight to `confirmed`: a free event can still have a $10 lunch.
 */
export function detectFreebies(text: string, cost: string | null = null): FreebieResult {
  const haystack = normalize(text);

  const foods = findAllTerms(haystack, FOOD_TERMS);
  const swag = findAllTerms(haystack, SWAG_TERMS).map((s) => s.term);
  const chance = findAllTerms(haystack, CHANCE_TERMS).map((c) => c.term);

  if (foods.length === 0) {
    return { food: { confidence: 'none', items: [], evidence: null }, swag, chance };
  }

  const items = [...new Set(foods.map((f) => f.term))].slice(0, 6);
  let confidence: FoodConfidence = 'mentioned';
  let evidence: string | null = evidenceAround(text, haystack, foods[0]?.index ?? 0);

  // "free" near a food word - the only path to `confirmed`. Proximity matters:
  // "free parking ... lunch available for purchase" must not qualify.
  const free = findTerm(haystack, FREE_TERMS);
  if (free !== null) {
    const nearFood = foods.some((food) => Math.abs(food.index - free.index) <= PROXIMITY);
    if (nearFood) {
      confidence = 'confirmed';
      evidence = evidenceAround(text, haystack, Math.min(free.index, foods[0]?.index ?? free.index));
    }
  }

  if (confidence === 'mentioned') {
    const provided = findTerm(haystack, PROVIDED_TERMS);
    if (provided !== null) {
      const nearFood = foods.some((food) => Math.abs(food.index - provided.index) <= PROXIMITY);
      if (nearFood) {
        confidence = 'provided';
        evidence = evidenceAround(text, haystack, Math.min(provided.index, foods[0]?.index ?? provided.index));
      }
    }
  }

  // A free event with food mentioned is probably feeding people, but "probably"
  // is exactly the gap between `provided` and `confirmed`.
  if (confidence === 'mentioned' && cost !== null && /free/i.test(cost)) {
    confidence = 'provided';
  }

  return { food: { confidence, items, evidence }, swag, chance };
}

/** True when an item belongs in the Free Stuff tab. */
export function isFreeStuff(result: FreebieResult): boolean {
  return result.food.confidence === 'confirmed' || result.food.confidence === 'provided' || result.swag.length > 0;
}

/** Human label for a tier. Used verbatim in the UI so wording stays consistent. */
export const FOOD_LABELS: Record<FoodConfidence, string> = {
  confirmed: 'Free food confirmed',
  provided: 'Food provided',
  mentioned: 'Food mentioned',
  none: '',
};
