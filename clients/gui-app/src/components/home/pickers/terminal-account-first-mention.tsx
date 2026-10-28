import { useEffect, type ReactNode } from "react";
import { useComposerStagedSandboxName } from "@/components/composer/composer-staged-surface-key";
import { terminalAccountSentence } from "@/components/settings/host-scope/host-access-model";
import { findHostOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useTerminalAccountMentionStore } from "@/stores/onboarding/terminal-account-mention-store";

/**
 * The Terminal account's sentence, under the composer's account picker the
 * first time it names one, for the host the run goes to: "This computer's
 * own sign-in, which stays on this computer. Sign in on Providers to use one
 * everywhere.", or, in place of `this computer`, the staged sandbox's name
 * while one is staged (the run goes there) and otherwise the host's name on
 * any other host. Shown until the picker that showed it closes, then never
 * again on this desktop.
 */
export function TerminalAccountFirstMention(props: {
  /** Whether the picker names a Terminal account for the active provider. */
  readonly named: boolean;
  /** The host the next run executes on; `null` for the app-wide default. */
  readonly runTargetHostId: string | null;
}): ReactNode {
  const host = findHostOption(useHostOptions().hosts, props.runTargetHostId);
  const stagedName = useComposerStagedSandboxName();
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
      {terminalAccountSentence(
        stagedName ?? (host === null || host.isLocalMachine ? null : host.name),
      )}
    </p>
  );
}
