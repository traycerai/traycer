/**
 * Which fixed phrase family a sent message thanked the agent with. The keys
 * are the only part of a match that leaves the device (as the
 * `share_prompt_shown` event's `match_key`); the message text never does.
 */
export type GratitudeMatchKey =
  | "thank_you"
  | "appreciate"
  | "great_job"
  | "nailed_it"
  | "perfect"
  | "love_it"
  | "legend";

/**
 * Phrases per key, in the normalised form {@link normaliseMessage} produces:
 * lowercase words separated by single spaces. A phrase matches only on whole
 * words, so "ty" never matches inside "type".
 */
const PHRASES: ReadonlyArray<readonly [GratitudeMatchKey, string]> = [
  ["thank_you", "thank you"],
  ["thank_you", "thanks"],
  ["thank_you", "thank u"],
  ["thank_you", "thx"],
  ["thank_you", "ty"],
  ["thank_you", "tysm"],
  ["thank_you", "tyvm"],
  ["appreciate", "appreciate it"],
  ["appreciate", "much appreciated"],
  ["appreciate", "really appreciate"],
  ["great_job", "great job"],
  ["great_job", "great work"],
  ["great_job", "nice work"],
  ["great_job", "nice job"],
  ["great_job", "good job"],
  ["great_job", "well done"],
  ["nailed_it", "nailed it"],
  ["perfect", "perfect"],
  ["love_it", "love it"],
  ["love_it", "love this"],
  ["legend", "you re a legend"],
  ["legend", "youre a legend"],
  ["legend", "you re the best"],
  ["legend", "youre the best"],
];

/**
 * Phrases that contain a match but say the opposite. Checked on the same
 * normalised text, before any match is accepted.
 */
const NEGATIONS: ReadonlyArray<string> = [
  "no thanks",
  "no thank you",
  "thanks but",
  "thank you but",
  "not perfect",
  "not quite perfect",
  "far from perfect",
];

/**
 * Phrases that also turn up in instructions ("use ty to check the stubs",
 * "a pixel perfect layout", "I'd love it if you added tests"). They count
 * only in a message of at most {@link SHORT_MESSAGE_WORDS} words.
 */
const SHORT_ONLY_PHRASES: ReadonlySet<string> = new Set([
  "ty",
  "perfect",
  "love it",
  "love this",
]);
const SHORT_MESSAGE_WORDS = 4;

/**
 * A long message is a new instruction that happens to open with "thanks";
 * the prompt is for a message that is mostly the thank-you itself.
 */
const MAX_MESSAGE_LENGTH = 200;

function normaliseMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(normalised: string, phrase: string): boolean {
  return ` ${normalised} `.includes(` ${phrase} `);
}

/**
 * The phrase family a sent message thanks the agent with, or `null` when it
 * does not. Runs on the device against the plain text of the message.
 */
export function matchGratitude(text: string): GratitudeMatchKey | null {
  if (text.length > MAX_MESSAGE_LENGTH) return null;
  const normalised = normaliseMessage(text);
  if (normalised.length === 0) return null;
  if (NEGATIONS.some((phrase) => containsPhrase(normalised, phrase))) {
    return null;
  }
  const short = normalised.split(" ").length <= SHORT_MESSAGE_WORDS;
  for (const [key, phrase] of PHRASES) {
    if (!short && SHORT_ONLY_PHRASES.has(phrase)) continue;
    if (containsPhrase(normalised, phrase)) return key;
  }
  return null;
}
