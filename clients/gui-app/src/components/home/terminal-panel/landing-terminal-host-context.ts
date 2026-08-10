/**
 * Host-keyed context published by a settled landing-terminal reconciliation
 * generation. `homeCwd` is the process-account home from the fresh
 * `terminal.list@2.1` response (`null` when an older host bridged the field).
 *
 * Auto-spawn receives this object directly from the generation that produced
 * it. Manual create paths may use the last published context only when its
 * `hostId` still equals the active host.
 */
export interface LandingTerminalHostContext {
  readonly hostId: string;
  readonly homeCwd: string | null;
}

/**
 * Launch cwd for a new landing terminal: primary workspace folder when set,
 * otherwise the reconciled active host's home. Never returns a home path whose
 * context host does not match `activeHostId`.
 */
export function resolveLandingTerminalLaunchCwd(
  primaryWorkspacePath: string | null,
  hostContext: LandingTerminalHostContext | null,
  activeHostId: string | null,
): string | null {
  if (primaryWorkspacePath !== null) return primaryWorkspacePath;
  if (hostContext === null || activeHostId === null) return null;
  if (hostContext.hostId !== activeHostId) return null;
  return hostContext.homeCwd;
}

/** Copy for old hosts that list terminals but cannot authoritatively provide home. */
export const LANDING_TERMINAL_HOST_UPDATE_GUIDANCE =
  "Update the selected host to open a terminal without a folder.";
