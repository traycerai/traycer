export interface ChatTileActivationQueryPolicyInput {
  readonly readOnlyNotice: string | null;
  readonly surfaceVisible: boolean;
  readonly surfaceFocused: boolean;
  readonly tileActive: boolean;
  readonly hasWorktreeBinding: boolean;
}

export interface ChatTileActivationQueryPolicy {
  readonly refreshMissingWorktreePaths: boolean;
  readonly discoverActionSlashCommands: boolean;
  readonly discoverCompactSlashCommands: boolean;
}

/**
 * Activation queries serve actions that a locked published-chat copy cannot
 * perform. Keep them live for every ordinary chat surface, including viewers;
 * `readOnlyNotice` is the explicit copy marker and is null on live surfaces.
 */
export function chatTileActivationQueryPolicy(
  input: ChatTileActivationQueryPolicyInput,
): ChatTileActivationQueryPolicy {
  const liveSurface = input.readOnlyNotice === null;
  return {
    refreshMissingWorktreePaths:
      liveSurface && input.surfaceVisible && input.hasWorktreeBinding,
    discoverActionSlashCommands: liveSurface && input.surfaceFocused,
    discoverCompactSlashCommands: liveSurface && input.tileActive,
  };
}
