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
  /**
   * authn's listing of `hostId` in `environmentId`, as a save on that host
   * reads it in one editor session.
   */
  settingsSaveHost: (
    environmentId: string,
    hostId: string,
    viewerId: string,
    session: string,
  ) =>
    [
      "environment",
      "settings-save",
      "host",
      environmentId,
      hostId,
      viewerId,
      session,
    ] as const,
  /**
   * authn's rows of `kind` in `environmentId`, as the person's edit was made
   * over them in one editor session.
   */
  settingsSaveItems: (
    environmentId: string,
    kind: string,
    viewerId: string,
    session: string,
  ) =>
    [
      "environment",
      "settings-save",
      "items",
      environmentId,
      kind,
      viewerId,
      session,
    ] as const,
};
