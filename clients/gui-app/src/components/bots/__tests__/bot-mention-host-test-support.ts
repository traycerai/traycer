import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";

// These composer fixtures offer no hosts. Each requested environment has
// answered, so the real mention menu can finish an empty search.
const EMPTY_HOSTS: readonly EnvironmentHostRecordV11[] = [];

export const botMentionHostClientMock = {
  useHostClientForHostId: () => null,
};

export const emptyBotMentionHostListsMock = {
  useEnvironmentHostLists: (
    _client: unknown,
    environmentIds: readonly string[],
  ) => ({
    hostsByEnvironmentId: new Map<string, readonly EnvironmentHostRecordV11[]>(
      environmentIds.map((id) => [id, EMPTY_HOSTS]),
    ),
  }),
};
