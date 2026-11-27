import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => <div data-testid="host-workspace-selector" />,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    useHostBinding: () => support.MOCK_HOST_BINDING,
    useOptionalHostClient: () => support.MOCK_HOST_CLIENT,
    useHostDirectory: () => support.MOCK_HOST_DIRECTORY,
    useAuthService: () =>
      support.hostDirectoryTestState.teamSandboxForCurrentChat
        ? support.MOCK_HOST_BINDING.auth
        : {
            revalidateCurrentContext: () =>
              Promise.resolve({ kind: "valid" as const }),
          },
    useHostClient: () => support.MOCK_HOST_CLIENT,
    useHostRuntimeClient: () => support.MOCK_HOST_CLIENT,
  };
});
vi.mock("@/hooks/host/use-tab-host-client", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useTabHostClient: () => support.MOCK_HOST_CLIENT };
});
vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importActual) => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    ...(await importActual<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >()),
    useHostClientForHostId: () => null,
    useHostDirectoryEntryForHostId: (hostId: string | null) =>
      hostId === null ? null : support.MOCK_HOST_DIRECTORY.findById(hostId),
  };
});
vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useAddressableHostId: () => support.HOST_ID };
});
vi.mock("@/hooks/host/use-effective-host-id", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useEffectiveHostId: () => support.HOST_ID };
});
vi.mock("@/hooks/bots/use-environment-list-query", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    useEnvironmentListQuery: () => ({
      data: support.environmentListTestState.data,
      error: null,
      isError: false,
      refetch: () => Promise.resolve(),
    }),
  };
});

// The real hydrate mutation, sent on the test's own host client: the one
// boundary the tile does not own.
vi.mock("@/hooks/chats/use-chat-hydrate-mutation", async (importActual) => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  const actual =
    await importActual<
      typeof import("@/hooks/chats/use-chat-hydrate-mutation")
    >();
  return {
    ...actual,
    useChatHydrateMutation: (input: {
      readonly client: HostClient<HostRpcRegistry> | null;
      readonly hostId: string;
      readonly chatId: string;
    }) =>
      actual.useChatHydrateMutation({
        ...input,
        client: support.hydrateBoundary.client,
      }),
  };
});

beforeAll(async () => {
  const { settleEvictedSendHostTier } =
    await import("./chat-tile-evicted-send-support");
  settleEvictedSendHostTier();
});
beforeEach(async () => {
  const { resetEvictedSendFixture } =
    await import("./chat-tile-evicted-send-support");
  resetEvictedSendFixture();
});
afterEach(async () => {
  const { teardownEvictedSendFixture } =
    await import("./chat-tile-evicted-send-support");
  teardownEvictedSendFixture();
});
