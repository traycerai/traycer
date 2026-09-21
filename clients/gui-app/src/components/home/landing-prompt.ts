const PROMPT_POOL: ReadonlyArray<string> = [
  "What should we work on?",
  "What's on your mind?",
  "Where shall we start?",
  "What's next on the list?",
  "Ready when you are.",
  "Let's ship something.",
];

/**
 * Chosen once per page load. Switching hosts remounts the hero; picking
 * again made the greeting line jump while the only thing that changed was
 * the host chip.
 */
let sessionPrompt: string | null = null;

function pickPrompt(): string {
  const index = Math.floor(Math.random() * PROMPT_POOL.length);
  return PROMPT_POOL[index];
}

export function landingPrompt(): string {
  if (sessionPrompt === null) sessionPrompt = pickPrompt();
  return sessionPrompt;
}

/** Clears the page-load greeting. Tests only. */
export function resetLandingPromptForTests(): void {
  sessionPrompt = null;
}
