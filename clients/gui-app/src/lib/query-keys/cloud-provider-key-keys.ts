/** Public key metadata is partitioned by the displayed sign-in and configuration. */
export const cloudProviderKeyKeys = {
  records: (
    viewerId: string,
    identityGeneration: number,
    environmentId: string,
  ) =>
    [
      "cloud-provider-keys",
      viewerId,
      identityGeneration,
      environmentId,
    ] as const,
  change: (
    viewerId: string,
    identityGeneration: number,
    environmentId: string,
    providerId: string,
  ) =>
    [
      "cloud-provider-key-change",
      viewerId,
      identityGeneration,
      environmentId,
      providerId,
    ] as const,
};
