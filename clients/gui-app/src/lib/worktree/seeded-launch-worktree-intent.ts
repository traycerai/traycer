import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  readStagedWorktreeIntent,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

/**
 * The single read-back for a seeded launcher - the fork dialog and the
 * terminal-agent launcher both call this at submit time: take the intent the
 * user sees/edited in the picker, or - if nothing has reached the staging slot
 * yet - fall back to the seed the launcher was opened with.
 *
 * Both surfaces stage through the same `seedEntryForFolder` authority (the seed
 * is its top-precedence tier), so they read it back the same way too. The ONLY
 * thing that differs between them is the source owner the seed was built from:
 * the fork uses the chat being forked; new GUI/terminal agents use the latest
 * conversation in the epic.
 */
export function readSeededLaunchWorktreeIntent(args: {
  readonly stagingKey: WorktreeStagingKey;
  readonly fallbackIntent: WorktreeIntent | null;
}): WorktreeIntent | null {
  return readStagedWorktreeIntent(args.stagingKey) ?? args.fallbackIntent;
}
