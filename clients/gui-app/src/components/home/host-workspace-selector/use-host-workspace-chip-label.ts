/**
 * Resting chip label deriver. Produces `<host> · <primary>` with an
 * optional `+N` badge count for the trigger; mode is intentionally
 * dropped when the binding has multiple folders since per-folder modes
 * can differ.
 */
export interface HostWorkspaceChipLabel {
  readonly hostLabel: string;
  readonly primaryFolderLabel: string | null;
  readonly extraFolderCount: number;
}

export interface HostWorkspaceChipLabelInputs {
  readonly hostLabel: string;
  readonly folderNames: ReadonlyArray<string>;
}

export function deriveHostWorkspaceChipLabel(
  inputs: HostWorkspaceChipLabelInputs,
): HostWorkspaceChipLabel {
  if (inputs.folderNames.length === 0) {
    return {
      hostLabel: inputs.hostLabel,
      primaryFolderLabel: null,
      extraFolderCount: 0,
    };
  }
  return {
    hostLabel: inputs.hostLabel,
    primaryFolderLabel: inputs.folderNames[0],
    extraFolderCount: Math.max(inputs.folderNames.length - 1, 0),
  };
}
