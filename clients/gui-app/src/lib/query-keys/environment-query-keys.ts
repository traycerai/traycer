/** Read keys for the app's own environment reads that answer no host method. */
export const environmentQueryKeys = {
  /** authn's removal preview for one member, by the viewer who asked. */
  removalPreview: (environmentId: string, userId: string, viewerId: string) =>
    [
      "environment",
      "members",
      "removal-preview",
      environmentId,
      userId,
      viewerId,
    ] as const,
};
