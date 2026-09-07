import { create } from "zustand";

/**
 * App-wide registry of dismissed rate-limit switch prompts, keyed by the prompt key
 * `useProfileRateLimitSwitchPrompt` derives (harness + limited profile + severity + viable
 */
interface RateLimitSwitchPromptDismissalsState {
  readonly dismissedKeys: ReadonlySet<string>;
  readonly dismiss: (promptKey: string) => void;
}

export const useRateLimitSwitchPromptDismissalsStore =
  create<RateLimitSwitchPromptDismissalsState>()((set, get) => ({
    dismissedKeys: new Set<string>(),
    dismiss: (promptKey) => {
      const { dismissedKeys } = get();
      if (dismissedKeys.has(promptKey)) return;
      set({ dismissedKeys: new Set([...dismissedKeys, promptKey]) });
    },
  }));
