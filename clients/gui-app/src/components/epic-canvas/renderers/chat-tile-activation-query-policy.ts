export interface ChatTileActivationQueryPolicyInput {
  readonly isCopy: boolean;
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
 * Copies cannot act on the serving host's workspace or command catalog, even
 * when their resting sandbox accepts a message. Ordinary unlocked surfaces,
 * including viewers, keep their activation queries.
 */
export function chatTileActivationQueryPolicy(
  input: ChatTileActivationQueryPolicyInput,
): ChatTileActivationQueryPolicy {
  const liveSurface = !input.isCopy && input.readOnlyNotice === null;
  return {
    refreshMissingWorktreePaths:
      liveSurface && input.surfaceVisible && input.hasWorktreeBinding,
    discoverActionSlashCommands: liveSurface && input.surfaceFocused,
    discoverCompactSlashCommands: liveSurface && input.tileActive,
  };
}
