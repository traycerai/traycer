import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { clearProfileCopyObservations } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  DEST_HOST_ID,
  hostDirectoryEntry,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
  } => ({
    spine: null,
    hosts: [],
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SCOPED_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

function resetStores(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  clearProfileCopyObservations();
}

describe("Sync profiles: Check again", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
    ];
    Element.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never dispatches a preview while no destination is chosen", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-check-again",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.sync.list": () => ({ batches: [], rules: [] }),
        "providers.profileCopy.sync.preview": (params) => ({
          selection: params,
          revision: "a".repeat(64),
          items: [],
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-sync",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore
        .getState()
        .open({ kind: "sync", sourceHostId: SOURCE_HOST_ID, providerId: null });
    });
    const button = await screen.findByRole("button", { name: /Check again/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.sync.preview",
      ),
    ).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
