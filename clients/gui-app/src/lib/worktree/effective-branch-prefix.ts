import type { RepoBranchPrefixState } from "@traycer/protocol/host/worktree-schemas";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";

/**
 * The single choke point for `repo override ?? global` precedence (product
 * decision: "Valid repository override, including an intentional empty
 * string, wins over the global value. An absent override inherits the global
 * value."). Used both by branch-name composition and by the Environment
 * dialog's repository-defaults section, so the two always agree on what
 * "effective" means and on when to warn.
 *
 * The host never judges git-ref validity for a stored override (see
 * `RepoBranchPrefixState`'s doc comment) - this is the ONE place that
 * re-validates a `"present"` value with the same rules the editor itself
 * enforces, so a hand-edited or externally-written `environment.json` can
 * never smuggle an illegal prefix into a generated branch name.
 */
export interface EffectiveBranchPrefix {
  readonly value: string;
  readonly source: "repo" | "global";
  /** Non-null exactly when `source === "global"` because the repo override
   * was invalid or the file couldn't be read - `null` for a clean inherit
   * (repo state `"absent"`) or a valid repo override. Carries the
   * `.traycer/environment.json` path so every renderer (the Environment
   * dialog, the creation picker) can show the same actionable, repair-ready
   * text without re-deriving it. */
  readonly warning: string | null;
}

/**
 * `workspacePath` is the exact source checkout the override was (or should
 * have been) read from - always folded into the warning text so a renderer
 * that shows the warning away from the Environment dialog (e.g. a creation
 * picker row) still names the file to fix.
 */
export function resolveEffectiveBranchPrefix(
  repoState: RepoBranchPrefixState,
  globalPrefix: string,
  workspacePath: string,
): EffectiveBranchPrefix {
  if (repoState.status === "absent") {
    return { value: globalPrefix, source: "global", warning: null };
  }
  const envFilePath = `${workspacePath}/.traycer/environment.json`;
  if (repoState.status === "malformed") {
    return {
      value: globalPrefix,
      source: "global",
      warning: `Couldn't read the repository branch prefix override in ${envFilePath} — it's malformed or unreadable. Using the global default.`,
    };
  }
  const validationError = worktreeBranchPrefixError(repoState.value);
  if (validationError !== null) {
    return {
      value: globalPrefix,
      source: "global",
      warning: `Repository branch prefix "${repoState.value}" in ${envFilePath} is invalid: ${validationError} Using the global default.`,
    };
  }
  return { value: repoState.value, source: "repo", warning: null };
}
