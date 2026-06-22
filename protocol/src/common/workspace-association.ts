import { z } from "zod";

const workspaceDirectoriesSchema = {
  primaryWorkspace: z.string(),
  secondaryWorkspaces: z.array(z.string()).default([]),
};

/**
 * Live workspace projection for a provider turn or terminal-agent launch.
 *
 * This is runtime intent: it comes from the current owner-scoped
 * WorktreeBinding / visible workspace picker and is what adapters thread to
 * SDKs and CLIs as cwd + additional directories. Do not source this from a
 * persisted session anchor; doing so can launch a new turn in stale historical
 * directories.
 */
export const providerWorkspaceSchema = z.object({
  workspaceKind: z.literal("provider"),
  ...workspaceDirectoriesSchema,
});
export type ProviderWorkspace = z.infer<typeof providerWorkspaceSchema>;

/**
 * Historical workspace snapshot attached to a harness session anchor.
 *
 * This is not runtime intent. It records where the provider session previously
 * ran so resume/fork policy can compare that history against the current
 * ProviderWorkspace. The discriminator intentionally prevents accidentally
 * passing this object to SDK launch paths.
 */
export const sessionWorkspaceSnapshotSchema = z.object({
  workspaceKind: z.literal("session-snapshot"),
  ...workspaceDirectoriesSchema,
});
export type SessionWorkspaceSnapshot = z.infer<
  typeof sessionWorkspaceSnapshotSchema
>;

type WorkspaceDirectorySet = {
  readonly primaryWorkspace: string;
  readonly secondaryWorkspaces: readonly string[];
};

export function workspaceDirectorySetsEqual(
  left: WorkspaceDirectorySet,
  right: WorkspaceDirectorySet,
): boolean {
  const leftSecondaries = new Set(left.secondaryWorkspaces);
  const rightSecondaries = new Set(right.secondaryWorkspaces);
  return (
    left.primaryWorkspace === right.primaryWorkspace &&
    leftSecondaries.size === rightSecondaries.size &&
    [...leftSecondaries].every((workspace) => rightSecondaries.has(workspace))
  );
}

export function sessionWorkspaceSnapshotFromProviderWorkspace(
  providerWorkspace: ProviderWorkspace,
): SessionWorkspaceSnapshot {
  return {
    workspaceKind: "session-snapshot",
    primaryWorkspace: providerWorkspace.primaryWorkspace,
    secondaryWorkspaces: [...providerWorkspace.secondaryWorkspaces],
  };
}
