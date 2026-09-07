/** Resting chip label deriver. */
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
