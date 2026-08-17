import type { ResolvedWorkspaceFolder } from "@traycer/protocol/host/epic/snapshot-meta";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

/**
 * The new-conversation modal's workspace seed for an EXISTING epic. The
 * fallback chain is deliberately closed over in-epic sources only:
 *
 * 1. The latest conversation's own seed (its binding / staged intent), when
 *    the caller resolved one.
 * 2. The epic's stored workspace folders (`snapshotMeta.workspaceFolders`,
 *    resolved to on-disk checkouts by the serving host) that live on the
 *    host the conversation will be created on. This mirrors the host's own
 *    send-time fallback (`deriveProviderDirectories` falls back to the epic
 *    workspace context when a chat carries no binding), so the modal seeds
 *    the same folders the created chat would run against.
 * 3. Empty folders. A folderless epic submits with a `null` intent and the
 *    host runs it folderless - the modal never invents one.
 *
 * The active-project overlay (`selectEffectiveWorkspaceFoldersBucket`) is
 * NOT a tier here: it answers "which folders does the user have selected
 * right now", which is the landing/new-epic question. For an existing epic
 * it would silently re-home the new conversation into whatever project the
 * header switcher last selected (e.g. a CRM epic's chat born in Titanos).
 *
 * A null `hostId` (no active host resolved yet) matches no folders: the
 * paths are stamped with the host that resolved them, so without a create
 * host their on-disk validity cannot be established - and submit bails
 * hostless anyway. The hook reseeds once the host arrives.
 */
export function resolveNewConversationWorkspaceSeed(args: {
  readonly latestWorkspace: LandingDraftWorkspaceSnapshot | null;
  readonly epicWorkspaceFolders: readonly ResolvedWorkspaceFolder[];
  readonly hostId: string | null;
}): LandingDraftWorkspaceSnapshot {
  if (args.latestWorkspace !== null) return args.latestWorkspace;
  const folders =
    args.hostId === null
      ? []
      : args.epicWorkspaceFolders.filter(
          (folder) => folder.hostId === args.hostId,
        );
  if (folders.length === 0) return emptyLandingDraftWorkspaceSnapshot();
  const folderInfoByPath = folders.reduce<Record<string, WorkspaceFolderInfo>>(
    (accumulator, folder) => ({
      ...accumulator,
      [folder.workspacePath]: {
        path: folder.workspacePath,
        name: workspaceFolderName(folder.workspacePath),
        repoIdentifier: folder.repoIdentifier,
        hostId: folder.hostId,
      },
    }),
    {},
  );
  return {
    folders: folders.map((folder) => folder.workspacePath),
    folderInfoByPath,
    // The stored set carries no primary marker; first entry wins, matching
    // `buildForkWorkspaceSeedFromWorkspaceFolders`'s convention.
    primaryPath: folders[0].workspacePath,
  };
}
