/**
 * Picks a memorable two-word `<adjective>-<noun>` slug for a default
 * branch name when the Epic / chat title doesn't yield anything
 * meaningful. Lives client-side so the Create-new-worktree input shows
 * the same name the user would land with after a host-side collision
 * pass - `swift-otter` over `k7m9`.
 *
 * Wordlists are embedded (no network / dependency); roughly
 * `ADJECTIVES.length * NOUNS.length` ≈ 1.6k combinations before the
 * client-side collision suffix kicks in (`-2`, `-3`, …).
 */

const ADJECTIVES: ReadonlyArray<string> = [
  "amber",
  "brave",
  "bright",
  "calm",
  "chipper",
  "clever",
  "cosmic",
  "crisp",
  "daring",
  "dapper",
  "eager",
  "electric",
  "fierce",
  "gentle",
  "happy",
  "humble",
  "jolly",
  "keen",
  "lucid",
  "lucky",
  "merry",
  "mighty",
  "nimble",
  "noble",
  "plucky",
  "polite",
  "prancing",
  "quick",
  "quiet",
  "radiant",
  "ripe",
  "rugged",
  "silent",
  "smart",
  "snappy",
  "soft",
  "spry",
  "stellar",
  "sturdy",
  "swift",
  "tidy",
  "wild",
  "witty",
  "zealous",
  "zesty",
];

const NOUNS: ReadonlyArray<string> = [
  "otter",
  "panda",
  "fox",
  "owl",
  "wolf",
  "hawk",
  "crane",
  "lynx",
  "puma",
  "robin",
  "sparrow",
  "falcon",
  "eagle",
  "raven",
  "swan",
  "tiger",
  "bear",
  "elk",
  "seal",
  "whale",
  "dolphin",
  "rabbit",
  "badger",
  "beaver",
  "cheetah",
  "koala",
  "lemur",
  "leopard",
  "lion",
  "moose",
  "newt",
  "ocelot",
  "octopus",
  "penguin",
  "platypus",
  "raccoon",
  "salmon",
  "sloth",
  "squid",
  "stork",
  "turtle",
  "walrus",
  "weasel",
  "wombat",
  "yak",
];

export function pickFriendlyBranchSuffix(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}
