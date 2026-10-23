import { createContext, useState } from "react";

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

/** The tile owns the verb across the placeholder-to-host row remount. */
export const WorkingVerbContext = createContext<string | null>(null);

export function useWorkingVerb(
  seed: string,
  active: boolean,
  turnId: string | null,
): string {
  const [latched, setLatched] = useState(() => ({
    active,
    turnId,
    verb: pickWorkingVerb(seed),
  }));
  const newTurn =
    active &&
    (!latched.active ||
      (latched.turnId !== null &&
        turnId !== null &&
        latched.turnId !== turnId));
  if (latched.active !== active || latched.turnId !== turnId) {
    const next = {
      active,
      turnId,
      verb: newTurn ? pickWorkingVerb(seed) : latched.verb,
    };
    setLatched(next);
    return next.verb;
  }
  return latched.verb;
}
