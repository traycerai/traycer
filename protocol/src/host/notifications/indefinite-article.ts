/**
 * `noun` after "a" or "an", picked by its first letter: "an editor",
 * "a viewer", "an Acme sandbox". A letter does not always say the sound
 * ("an hour", "a unit"), and a name can start with either; the letter is
 * what a team name offers.
 */
export function withIndefiniteArticle(noun: string): string {
  return /^[aeiou]/iu.test(noun) ? `an ${noun}` : `a ${noun}`;
}
