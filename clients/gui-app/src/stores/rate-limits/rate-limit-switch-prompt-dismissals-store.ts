import { create } from "zustand";

/**
 * App-wide registry of dismissed rate-limit switch prompts, keyed by the
 * prompt key `useProfileRateLimitSwitchPrompt` derives (harness + limited
 * profile + severity + viable alternatives). The same limited profile is
 * typically selected in several composers at once (multiple chat tabs, the
 * home composer), and each used to hold its own dismissed flag - dismissing
 * the banner in one tab left it standing everywhere else. One shared set
 * makes a dismissal stick across every composer.
 *
 * Deliberately in-memory (not persisted): a dismissal should outlive tab
 * switches, not app restarts - rate-limit state moves constantly, and any
 * material change (severity, alternatives) already re-arms the prompt via a
 * new key.
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
