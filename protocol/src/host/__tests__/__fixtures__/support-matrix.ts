import type { ConnectionManifest } from "@traycer/protocol/framework/index";

/**
 * One historically-released, still-supported app/host version's frozen
 * `ConnectionManifest` - the per-method `{ major, minor }` canonical it
 * advertised at that version - plus a human-readable label.
 *
 * Complementary to `released-method-names.ts` (which freezes only the
 * method-NAME set for the same `host-v1.0.0` baseline): this captures the
 * full per-method version so `two-sided-release-invariant.test.ts` can run
 * `compatibility-checker.check()` against the CURRENT live registry, not
 * just diff name sets.
 */
export type SupportMatrixEntry = {
  readonly version: string;
  readonly manifest: ConnectionManifest;
};

/**
 * AUTO-GENERATED entries come from `protocol/scripts/snapshot-support-matrix.ts`.
 * Do not hand-edit an entry's `manifest` - regenerate it instead.
 *
 * ## Appending a new version at release-cut time
 *
 * 1. On the commit/tag being released, run:
 *      bun run protocol/scripts/snapshot-support-matrix.ts <version-label>
 *    e.g. `host-v1.2.0` (match the tag naming already used for
 *    `host-v1.0.0`, `host-v1.1.0`, ... in this repo's git tags).
 * 2. Paste the printed entry as a NEW element appended to the array below.
 *    Never edit or reorder existing entries in the same change - append only.
 * 3. Only DROP an entry when a coordinated release deliberately ends support
 *    for that version (mirrors how `released-method-names.ts` is
 *    regenerated only for that same class of decision). The diff that
 *    removes it is the reviewable record.
 *
 * ## Why only `host-v1.0.0` is seeded today
 *
 * `host-v1.0.0` is the oldest still-supported floor - it's the exact
 * baseline `released-method-names.ts` already freezes the method-name set
 * against, so reusing it here keeps both guards anchored to the same
 * historical release instead of inventing a second, unrelated baseline.
 * Its manifest below was captured from this repo's `fd65a24` commit (#84,
 * "fix(protocol): keep the RPC method-set compatible with the v1.0.0 host"),
 * which is the commit that produced the currently-committed
 * `released-method-names.ts` fixture - i.e. this manifest and that
 * name-only fixture describe the exact same registry state. (Note: the
 * literal git tag `host-v1.0.0` in this repo points at an unrelated, much
 * earlier commit from before the protocol registry reached its shipped
 * v1.0.0 shape - it predates `agent.gui.*`, `worktree.*`, etc. entirely, so
 * it is NOT the right source for this baseline. `fd65a24` is the actual
 * shipped-v1.0.0-compatible registry state; that is what is snapshotted
 * here.)
 *
 * The CURRENT dev-tip registry itself is intentionally NOT a frozen entry
 * here - `two-sided-release-invariant.test.ts` reads `hostRpcRegistry`
 * live and checks it against every entry below, so the "current" side of
 * the matrix is always up to date by construction and never goes stale.
 * Once a second real release ships (e.g. `host-v1.1.0`), append it via the
 * procedure above to grow this to a true N-entry matrix.
 */
export const supportMatrix: readonly SupportMatrixEntry[] = [
  {
    version: "host-v1.0.0",
    manifest: {
      "agent.create": { major: 1, minor: 0 },
      "agent.getTranscript": { major: 1, minor: 0 },
      "agent.gui.getPlan": { major: 1, minor: 0 },
      "agent.gui.listCommands": { major: 1, minor: 0 },
      "agent.gui.listHarnesses": { major: 2, minor: 0 },
      "agent.gui.listModels": { major: 1, minor: 0 },
      "agent.inbox.read": { major: 1, minor: 0 },
      "agent.list": { major: 2, minor: 0 },
      "agent.listHarnessModels": { major: 1, minor: 0 },
      "agent.selectionGuide": { major: 1, minor: 0 },
      "agent.selectionGuide.getGlobal": { major: 1, minor: 0 },
      "agent.selectionGuide.getGlobalOnboardingDraft": { major: 1, minor: 0 },
      "agent.selectionGuide.resetGlobalToDefault": { major: 1, minor: 0 },
      "agent.selectionGuide.setGlobal": { major: 1, minor: 0 },
      "agent.sendMessage": { major: 1, minor: 0 },
      "agent.stop": { major: 1, minor: 0 },
      "agent.tui.generateTitle": { major: 1, minor: 0 },
      "agent.tui.listHarnesses": { major: 1, minor: 0 },
      "agent.tui.prepareLaunch": { major: 1, minor: 0 },
      "agent.tui.recordActivity": { major: 1, minor: 0 },
      "agent.tui.turnEnded": { major: 1, minor: 0 },
      "comments.listThreads": { major: 1, minor: 0 },
      "comments.setThreadStatus": { major: 1, minor: 0 },
      "editor.openPaths": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 0 },
      "epic.batchUpdateRoles": { major: 1, minor: 0 },
      "epic.create": { major: 1, minor: 0 },
      "epic.createArtifact": { major: 1, minor: 0 },
      "epic.createChat": { major: 1, minor: 0 },
      "epic.createCommentThread": { major: 1, minor: 0 },
      "epic.createTuiAgent": { major: 1, minor: 0 },
      "epic.deleteArtifact": { major: 1, minor: 0 },
      "epic.deleteChat": { major: 1, minor: 0 },
      "epic.deleteComment": { major: 1, minor: 0 },
      "epic.deleteCommentThread": { major: 1, minor: 0 },
      "epic.deleteTuiAgent": { major: 1, minor: 0 },
      "epic.editComment": { major: 1, minor: 0 },
      "epic.grantAccess": { major: 1, minor: 0 },
      "epic.listCollaborators": { major: 1, minor: 0 },
      "epic.listCommentThreads": { major: 1, minor: 0 },
      "epic.listTasks": { major: 1, minor: 0 },
      "epic.mentionEpics": { major: 1, minor: 0 },
      "epic.mentionReviews": { major: 1, minor: 0 },
      "epic.mentionSpecs": { major: 1, minor: 0 },
      "epic.mentionStories": { major: 1, minor: 0 },
      "epic.mentionTickets": { major: 1, minor: 0 },
      "epic.removeRepo": { major: 1, minor: 0 },
      "epic.renameArtifact": { major: 1, minor: 0 },
      "epic.renameChat": { major: 1, minor: 0 },
      "epic.renameTuiAgent": { major: 1, minor: 0 },
      "epic.reparentArtifact": { major: 1, minor: 0 },
      "epic.reparentChat": { major: 1, minor: 0 },
      "epic.replyToCommentThread": { major: 1, minor: 0 },
      "epic.resolveArtifactByPath": { major: 1, minor: 0 },
      "epic.revokeCollaborator": { major: 1, minor: 0 },
      "epic.setCommentThreadResolved": { major: 1, minor: 0 },
      "epic.updateArtifactStatus": { major: 1, minor: 0 },
      "epic.updateTitle": { major: 1, minor: 0 },
      "git.getCapabilities": { major: 1, minor: 0 },
      "git.getFileDiff": { major: 1, minor: 0 },
      "git.getFileDiffs": { major: 1, minor: 0 },
      "git.listChangedFiles": { major: 1, minor: 0 },
      "host.getRateLimitUsage": { major: 1, minor: 1 },
      "host.getRuntimeCapabilities": { major: 1, minor: 0 },
      "host.status": { major: 1, minor: 0 },
      "phase.migrateToEpic": { major: 1, minor: 0 },
      "providers.addCustomPath": { major: 1, minor: 0 },
      "providers.awaitLogin": { major: 1, minor: 0 },
      "providers.cancelLogin": { major: 1, minor: 0 },
      "providers.clearApiKey": { major: 1, minor: 0 },
      "providers.deleteEnvOverride": { major: 1, minor: 0 },
      "providers.detectVersion": { major: 1, minor: 0 },
      "providers.list": { major: 2, minor: 0 },
      "providers.removeCustomPath": { major: 1, minor: 0 },
      "providers.setApiKey": { major: 1, minor: 0 },
      "providers.setEnabled": { major: 1, minor: 0 },
      "providers.setEnvOverride": { major: 1, minor: 0 },
      "providers.setSelection": { major: 1, minor: 0 },
      "providers.setTerminalAgentArgs": { major: 1, minor: 0 },
      "providers.startLogin": { major: 1, minor: 0 },
      "snapshots.clearLocalSnapshots": { major: 1, minor: 0 },
      "snapshots.getLocalStorageSize": { major: 1, minor: 0 },
      "snapshots.readSnapshotDiff": { major: 1, minor: 0 },
      "speech.ensureModel": { major: 1, minor: 0 },
      "speech.getModelStatus": { major: 1, minor: 0 },
      "terminal.create": { major: 1, minor: 0 },
      "terminal.kill": { major: 1, minor: 0 },
      "terminal.list": { major: 1, minor: 0 },
      "terminal.rename": { major: 1, minor: 0 },
      "workspace.listDirectory": { major: 1, minor: 0 },
      "workspace.listFileTree": { major: 1, minor: 0 },
      "workspace.mentionFiles": { major: 1, minor: 0 },
      "workspace.mentionFolders": { major: 1, minor: 0 },
      "workspace.mentionGitBranches": { major: 1, minor: 0 },
      "workspace.mentionGitCommits": { major: 1, minor: 0 },
      "workspace.mentionGitRoot": { major: 1, minor: 0 },
      "workspace.mentionWorktrees": { major: 1, minor: 0 },
      "workspace.prepareFolders": { major: 1, minor: 0 },
      "workspace.readFile": { major: 1, minor: 0 },
      "workspace.resolvePathsByRepoIdentifiers": { major: 1, minor: 0 },
      "workspaceBinding.removeEntry": { major: 1, minor: 0 },
      "worktree.create": { major: 1, minor: 0 },
      "worktree.createPaths": { major: 1, minor: 0 },
      "worktree.delete": { major: 1, minor: 0 },
      "worktree.getBinding": { major: 1, minor: 0 },
      "worktree.import": { major: 1, minor: 0 },
      "worktree.listAllForHost": { major: 1, minor: 0 },
      "worktree.listBindingsForEpic": { major: 1, minor: 0 },
      "worktree.listBranches": { major: 1, minor: 0 },
      "worktree.listByWorkspacePaths": { major: 1, minor: 1 },
      "worktree.retrySetup": { major: 1, minor: 0 },
      "worktree.setEntryMode": { major: 1, minor: 0 },
      "worktree.setRepoScripts": { major: 1, minor: 0 },
    },
  },
];
