export interface RowChildHostClient {
  getActiveHostId(): string | null;
}

export type RowChildHostResolution<Client extends RowChildHostClient> =
  | {
      readonly kind: "legacy-active";
      readonly client: Client;
      readonly hostId: string | null;
      readonly isUnavailable: boolean;
      readonly intendedHostId: string | null;
    }
  | {
      readonly kind: "active";
      readonly client: Client;
      readonly hostId: string | null;
      readonly isUnavailable: boolean;
      readonly intendedHostId: string;
    }
  | {
      readonly kind: "remote";
      readonly client: Client;
      readonly hostId: string;
      readonly isUnavailable: false;
      readonly intendedHostId: string;
    }
  | {
      readonly kind: "unavailable-remote";
      readonly client: null;
      readonly hostId: null;
      readonly isUnavailable: true;
      readonly intendedHostId: string;
    };

export function resolveRowChildHost<Client extends RowChildHostClient>(args: {
  readonly rowHostId: string | null;
  readonly activeHostId: string | null;
  readonly activeClient: Client;
  readonly remoteClient: Client | null;
}): RowChildHostResolution<Client> {
  const activeClientHostId = args.activeClient.getActiveHostId();

  if (args.rowHostId === null) {
    return {
      kind: "legacy-active",
      client: args.activeClient,
      hostId: activeClientHostId,
      isUnavailable: activeClientHostId === null,
      intendedHostId: null,
    };
  }

  if (args.rowHostId === args.activeHostId) {
    return {
      kind: "active",
      client: args.activeClient,
      hostId: activeClientHostId,
      isUnavailable: activeClientHostId === null,
      intendedHostId: args.rowHostId,
    };
  }

  const remoteClientHostId = args.remoteClient?.getActiveHostId() ?? null;
  if (args.remoteClient === null || remoteClientHostId !== args.rowHostId) {
    return {
      kind: "unavailable-remote",
      client: null,
      hostId: null,
      isUnavailable: true,
      intendedHostId: args.rowHostId,
    };
  }

  return {
    kind: "remote",
    client: args.remoteClient,
    hostId: remoteClientHostId,
    isUnavailable: false,
    intendedHostId: args.rowHostId,
  };
}
