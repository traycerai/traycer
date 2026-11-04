/**
 * Which fixed phrase family a sent message thanked the agent with. The keys
 * are the only part of a match that leaves the device (as the
 * `share_prompt_shown` event's `match_key`); the message text never does.
 */
export type GratitudeMatchKey =
  | "thank_you"
  | "appreciate"
  | "great_job"
  | "amazing"
  | "nailed_it"
  | "perfect"
  | "love_it"
  | "legend"
  | "hype"
  | "emoji";

type Phrases = ReadonlyArray<
  readonly [GratitudeMatchKey, ReadonlyArray<string>]
>;

/**
 * Phrases per key, in the normalised form {@link normaliseMessage} produces:
 * lowercase words separated by single spaces ("you're" becomes "you re"). A
 * phrase matches only on whole words, so "ty" never matches inside "type".
 */
const PHRASES: Phrases = [
  [
    "thank_you",
    [
      "thank you",
      "thanks",
      "thank u",
      "thanku",
      "thankyou",
      "thx",
      "thnx",
      "thanx",
      "thnks",
      "ty",
      "tysm",
      "tyvm",
      "tyty",
      "tqsm",
      "many thanks",
      "gracias",
      "merci",
      "danke",
      "grazie",
      "obrigado",
      "obrigada",
      "arigato",
      "arigatou",
      "shukriya",
      "dhanyavad",
      "dhanyawad",
    ],
  ],
  [
    "appreciate",
    [
      "appreciate it",
      "appreciate you",
      "appreciate that",
      "appreciate this",
      "much appreciated",
      "really appreciate",
      "greatly appreciated",
      "much obliged",
      "so grateful",
      "really grateful",
    ],
  ],
  [
    "great_job",
    [
      "great job",
      "great work",
      "great stuff",
      "great going",
      "nice work",
      "nice job",
      "nice one",
      "nicely done",
      "good job",
      "good work",
      "good stuff",
      "solid work",
      "amazing work",
      "awesome work",
      "excellent work",
      "brilliant work",
      "fantastic work",
      "well done",
      "very well done",
      "bravo",
      "kudos",
      "props",
      "hats off",
      "keep it up",
      "bahut badhiya",
      "badhiya",
      "shabash",
      "zabardast",
      "kamaal",
    ],
  ],
  [
    "amazing",
    [
      "amazing",
      "awesome",
      "brilliant",
      "fantastic",
      "excellent",
      "superb",
      "incredible",
      "outstanding",
      "wonderful",
      "impressive",
      "phenomenal",
      "stellar",
      "beautiful",
      "nice",
    ],
  ],
  [
    "nailed_it",
    [
      "nailed it",
      "crushed it",
      "killed it",
      "smashed it",
      "aced it",
      "knocked it out of the park",
      "works like a charm",
      "worked like a charm",
      "works perfectly",
      "worked perfectly",
      "works great",
      "worked great",
      "spot on",
      "bang on",
      "flawless",
    ],
  ],
  [
    "perfect",
    [
      "perfect",
      "exactly what i wanted",
      "exactly what i needed",
      "just what i needed",
      "chef s kiss",
      "chefs kiss",
      "10 10",
    ],
  ],
  [
    "love_it",
    ["love it", "love this", "love that", "loved it", "love you", "ily"],
  ],
  [
    "legend",
    [
      "you re a legend",
      "youre a legend",
      "ur a legend",
      "absolute legend",
      "legend",
      "you re the best",
      "youre the best",
      "ur the best",
      "you rock",
      "you re awesome",
      "youre awesome",
      "you re amazing",
      "youre amazing",
      "you saved me",
      "saved my life",
      "lifesaver",
      "life saver",
      "goat",
      "goated",
      "the goat",
      "mvp",
      "genius",
      "my hero",
      "rockstar",
      "wizard",
      "champ",
      "king",
      "beast",
    ],
  ],
  [
    "hype",
    [
      "lfg",
      "let s go",
      "lets go",
      "letsgo",
      "lets goo",
      "lets gooo",
      "sheesh",
      "fire",
      "this is fire",
      "that s fire",
      "thats fire",
      "so fire",
      "banger",
      "w",
      "w agent",
      "big w",
      "huge w",
      "massive w",
      "slaps",
      "bussin",
      "dope",
      "sick",
      "this is sick",
      "that s sick",
      "so sick",
      "lit",
      "clutch",
      "cracked",
      "insane",
      "that s insane",
      "thats insane",
      "op",
      "so op",
      "mast",
      "jhakaas",
    ],
  ],
];

/** Emoji that thank or cheer on their own, matched on the message as typed. */
const EMOJI = [
  "🙏",
  "🐐",
  "🔥",
  "👏",
  "🙌",
  "💯",
  "🫶",
  "❤️",
  "😍",
  "🥰",
  "🤩",
];

/**
 * Phrases that contain a match but say the opposite, or open an instruction
 * ("make it perfect"). Checked on the same normalised text, before any match
 * is accepted.
 */
const NEGATIONS: ReadonlyArray<string> = [
  "no thanks",
  "no thank you",
  "thanks but",
  "thank you but",
  "not perfect",
  "not quite perfect",
  "far from perfect",
  "not great",
  "not good",
  "not amazing",
  "not awesome",
  "not nice",
  "not fire",
  "not working",
  "not what i wanted",
  "not what i needed",
  "doesn t work",
  "doesnt work",
  "didn t work",
  "didnt work",
  "still broken",
  "still failing",
  "make it",
  "make this",
  "make that",
  "make them",
  "should be",
  "needs to be",
  "need it to be",
];

/**
 * Phrases that also turn up in instructions ("use ty to check the stubs",
 * "a pixel perfect layout", "I'd love it if you added tests"). They count
 * only in a message of at most {@link SHORT_MESSAGE_WORDS} words, as do the
 * emoji.
 */
const SHORT_ONLY_PHRASES: ReadonlySet<string> = new Set([
  "ty",
  "perfect",
  "love it",
  "love this",
  "love that",
  "amazing",
  "awesome",
  "brilliant",
  "fantastic",
  "excellent",
  "superb",
  "incredible",
  "outstanding",
  "wonderful",
  "impressive",
  "phenomenal",
  "stellar",
  "beautiful",
  "flawless",
  "the goat",
  "my hero",
  "let s go",
  "lets go",
  "this is fire",
  "that s fire",
  "thats fire",
  "so fire",
  "banger",
  "big w",
  "huge w",
  "massive w",
  "slaps",
  "this is sick",
  "that s sick",
  "so sick",
  "that s insane",
  "thats insane",
  "so op",
  "10 10",
]);
const SHORT_MESSAGE_WORDS = 4;

/**
 * Words that name ordinary things in a short instruction too ("fire the
 * event", "add a legend", "use w"). They count only as the whole message.
 */
const WHOLE_MESSAGE_PHRASES: ReadonlySet<string> = new Set([
  "w",
  "nice",
  "props",
  "legend",
  "goat",
  "mvp",
  "genius",
  "wizard",
  "champ",
  "king",
  "beast",
  "fire",
  "sick",
  "lit",
  "dope",
  "clutch",
  "cracked",
  "insane",
  "op",
  "mast",
]);

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

/**
 * Words as a reader counts them: punctuation and spaces separate words
 * ("ty/ruff" is two), and an apostrophe inside a contraction does not
 * ("that's" is one).
 */
const WORD = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;

function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
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
  if (NEGATIONS.some((phrase) => containsPhrase(normalised, phrase))) {
    return null;
  }
  const short = countWords(text) <= SHORT_MESSAGE_WORDS;
  for (const [key, phrases] of PHRASES) {
    for (const phrase of phrases) {
      if (WHOLE_MESSAGE_PHRASES.has(phrase)) {
        if (normalised === phrase) return key;
        continue;
      }
      if (!short && SHORT_ONLY_PHRASES.has(phrase)) continue;
      if (containsPhrase(normalised, phrase)) return key;
    }
  }
  if (short && EMOJI.some((emoji) => text.includes(emoji))) return "emoji";
  return null;
}
