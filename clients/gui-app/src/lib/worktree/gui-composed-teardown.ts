import type { TeardownStopTarget } from "@/lib/worktree/owner-teardown-snapshot";

/**
 * Phase-1 GUI-composed teardown. `worktree.create` has no `commitIntent`
 * (protocol is frozen behind the pin), so the GUI stops exactly the
 * owner-scoped holders it disclosed — managed-command stop for supervised
 * shells, `agent.stop` for a chat turn — then mutates the binding. Upgrade
 * with `listHolders` + create-with-intent in the same follow-up as the
 * snapshot provider.
 *
 * Partial failure is consequential: if any stop fails, the caller must not
 * proceed with remove/create, and must name the failure on that holder row.
 */
export type HolderTeardownFailure = {
  readonly holderKey: string;
  readonly message: string;
};

export function failuresByHolderKey(
  failures: readonly HolderTeardownFailure[],
): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const failure of failures) {
    record[failure.holderKey] = failure.message;
  }
  return record;
}

export function teardownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Couldn't stop it.";
}

export async function runGuiComposedTeardown(input: {
  readonly stopTargets: readonly TeardownStopTarget[];
  readonly stopShell: (commandId: string) => Promise<unknown>;
  readonly stopTurn: () => Promise<unknown>;
  readonly isCancelled: () => boolean;
}): Promise<readonly HolderTeardownFailure[]> {
  const failures: HolderTeardownFailure[] = [];
  for (const target of input.stopTargets) {
    if (input.isCancelled()) return failures;
    try {
      if (target.kind === "supervised-shell") {
        await input.stopShell(target.commandId);
      } else {
        await input.stopTurn();
      }
    } catch (error: unknown) {
      failures.push({
        holderKey: target.holderKey,
        message: teardownErrorMessage(error),
      });
    }
    if (input.isCancelled()) return failures;
  }
  return failures;
}
