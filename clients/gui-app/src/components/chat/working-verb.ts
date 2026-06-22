import { createContext } from "react";

/**
 * Present-tense "thinking" verbs shown while a turn is live (Claude-CLI style),
 * a playful stand-in for a static "Working…". Companion to the past-tense
 * `ELAPSED_VERBS` the completed-turn footer uses.
 */
const WORKING_VERBS = [
  "Cogitating",
  "Pondering",
  "Crunching",
  "Brewing",
  "Noodling",
  "Mulling",
  "Scheming",
  "Hatching",
  "Tinkering",
  "Conjuring",
  "Distilling",
  "Wrangling",
  "Marinating",
  "Riffing",
  "Sleuthing",
  "Plotting",
  "Stewing",
  "Forging",
  "Spelunking",
  "Channeling",
] as const;

export function pickWorkingVerb(seed: string): string {
  // djb2 - fast, well-distributed for short strings, no allocation.
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % WORKING_VERBS.length;
  return WORKING_VERBS[index] ?? WORKING_VERBS[0];
}

/**
 * The active run's working verb, resolved once per turn by the chat tile and
 * read by the in-progress indicator. Seeding the verb here - rather than off
 * the indicator row's `messageId` - keeps the word fixed for the whole turn:
 * the pre-turn placeholder row swaps its id from `assistant:live` to
 * `assistant:<turnId>` when the host exposes the turn (~seconds in), which
 * would otherwise reshuffle a `messageId`-seeded verb mid-turn. `null` outside
 * a chat (e.g. isolated component tests) - the indicator then falls back to a
 * `messageId` seed.
 */
export const WorkingVerbContext = createContext<string | null>(null);
