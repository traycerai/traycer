export const environmentQueryKeys = {
  removalPreview: (environmentId: string, userId: string, viewerId: string) =>
    [
      "environment",
      "members",
      "removal-preview",
      environmentId,
      userId,
      viewerId,
    ] as const,
  personalForMove: (viewerId: string) =>
    ["environment", "move", "personal", viewerId] as const,
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
