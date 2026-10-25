import { useEffect, type ReactNode } from "react";
import { TERMINAL_ACCOUNT_SENTENCE } from "@/components/settings/host-scope/host-access-model";
import { useTerminalAccountMentionStore } from "@/stores/onboarding/terminal-account-mention-store";

/**
 * The Terminal account's sentence, under the composer's account picker the
 * first time it names one: "This computer's own sign-in, which stays on this
 * computer. Sign in on Providers to use one everywhere." Shown until the picker that
 * showed it closes, then never again on this desktop.
 */
export function TerminalAccountFirstMention(props: {
  /** Whether the picker names a Terminal account for the active provider. */
  readonly named: boolean;
}): ReactNode {
  const explained = useTerminalAccountMentionStore((state) => state.explained);
  const markExplained = useTerminalAccountMentionStore(
    (state) => state.markExplained,
  );
  const shown = props.named && !explained;
  // Counted as said once the picker that said it goes away, so it does not
  // vanish under the person while they read it.
  useEffect(() => {
    if (!shown) return undefined;
    return () => {
      markExplained();
    };
  }, [shown, markExplained]);
  if (!shown) return null;
  return (
    <p
      className="px-2 pt-1.5 text-ui-xs text-muted-foreground"
      data-testid="terminal-account-first-mention"
    >
      {TERMINAL_ACCOUNT_SENTENCE}
    </p>
  );
}
