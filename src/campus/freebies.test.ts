import { describe, expect, it } from 'vitest';
import { detectFreebies, isFreeStuff } from '@/campus/freebies.ts';

/**
 * The rule under test: never claim food is free unless the source says so.
 *
 * Every case below is a real shape from the TAMU calendar. The `mentioned`
 * tier is the important one - it is what stops "Coffee Chat with the Dean"
 * from being advertised as free coffee.
 */
describe('detectFreebies', () => {
  it('confirms only when "free" sits near the food', () => {
    const result = detectFreebies('Come for free pizza and a talk about grad school');
    expect(result.food.confidence).toBe('confirmed');
    expect(result.food.items).toContain('pizza');
    expect(result.food.evidence).not.toBeNull();
  });

  it('treats "lunch provided" as provided, not confirmed', () => {
    // A provided conference lunch can still cost $15. The text does not say.
    const result = detectFreebies('Registration required. Lunch provided.');
    expect(result.food.confidence).toBe('provided');
  });

  it('downgrades a bare food word to mentioned', () => {
    const result = detectFreebies('Coffee Chat with the Dean');
    expect(result.food.confidence).toBe('mentioned');
    expect(isFreeStuff(result)).toBe(false);
  });

  it('reports none when no food appears', () => {
    const result = detectFreebies('Dissertation defense: selection in M. tuberculosis');
    expect(result.food.confidence).toBe('none');
    expect(result.food.items).toEqual([]);
  });

  it('does not let a distant "free" confirm unrelated food', () => {
    // "free parking" is 60+ characters from "lunch", which is for purchase.
    const text =
      'Free parking is available in the west garage for all attendees of this event. Lunch is available for purchase at the venue.';
    expect(detectFreebies(text).food.confidence).not.toBe('confirmed');
  });

  it('promotes to provided when the event cost field says Free', () => {
    const result = detectFreebies('Kolaches & Community', 'Free');
    expect(result.food.confidence).toBe('provided');
  });

  it('never counts a raffle as guaranteed swag', () => {
    // A chance to win a t-shirt is not a t-shirt.
    const result = detectFreebies('Enter to win a raffle for a free t-shirt');
    expect(result.chance).toContain('raffle');
  });

  it('detects guaranteed swag separately from food', () => {
    const result = detectFreebies('Free stickers and swag for the first 50 people');
    expect(result.swag.length).toBeGreaterThan(0);
    expect(isFreeStuff(result)).toBe(true);
  });

  it('respects word boundaries so "tea" does not match "team"', () => {
    // Without space-padded matching, every team meeting on campus advertises
    // refreshments.
    expect(detectFreebies('Team meeting for the robotics team').food.confidence).toBe('none');
  });

  it('does not match "food" inside a larger word', () => {
    expect(detectFreebies('Seafoods research symposium').food.items).not.toContain('food');
  });
});
