import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  unavailability: vi.fn<(entry: unknown) => string | null>(),
  readyRemote: vi.fn<(hostId: string) => boolean>(),
  closeTab: vi.fn<(args: unknown) => Promise<void>>(),
  runAction: vi.fn<(args: unknown) => Promise<unknown>>(),
  refresh: vi.fn<() => void>(),
  discovery: vi.fn<(scope: unknown) => { refresh: () => void }>(),
  findById: vi.fn<(hostId: string) => { hostId: string } | null>(),
  liveUserId: vi.fn<() => string | null>(),
  userId: vi.fn<() => string | null>(),
}));

vi.mock("@traycer-clients/shared/host-client/remote-fetcher", () => ({
  hostUnavailability: mocks.unavailability,
}));
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: mocks.readyRemote,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getRequestContextUserId: mocks.liveUserId }),
  useHostDirectory: () => ({ findById: mocks.findById }),
}));
vi.mock("@/hooks/host/use-request-context-user-id", () => ({
  useRequestContextUserId: () => mocks.userId(),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => null,
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => ({
    wsStreamClient: null,
    close: () => undefined,
  }),
}));
vi.mock("@/lib/host/transport-key", () => ({
  remoteAwareOwnerIdentityKey: () => "identity-1",
}));
vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  jarBridgeForHost: () => null,
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => () => null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: null }),
}));
vi.mock("@/lib/browser-view/sessions/browser-catalog-owner-action", () => ({
  closeBrowserCatalogTab: mocks.closeTab,
  runBrowserCatalogOwnerAction: mocks.runAction,
}));
vi.mock("@/lib/browser-view/sessions/browser-catalog-discovery", () => ({
  browserCatalogDiscovery: mocks.discovery,
}));

import { useBrowserCatalogActions } from "../use-browser-catalog-actions";

const identity = { epicId: "epic-1", hostId: "host-b", sessionId: "session-1" };

describe("useBrowserCatalogActions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.userId.mockReturnValue("user-1");
    mocks.liveUserId.mockReturnValue("user-1");
    mocks.findById.mockReturnValue({ hostId: "host-b" });
    mocks.unavailability.mockReturnValue(null);
    mocks.readyRemote.mockReturnValue(false);
    mocks.closeTab.mockResolvedValue(undefined);
    mocks.runAction.mockResolvedValue(undefined);
    mocks.discovery.mockReturnValue({ refresh: mocks.refresh });
  });

  function actions() {
    return renderHook(() => useBrowserCatalogActions("epic-1")).result.current;
  }

  it("refuses a Close on a known-offline device without dialing it, and still asks discovery to repair", async () => {
    mocks.unavailability.mockReturnValue("offline");

    await expect(actions().closeTab(identity, "tab-1")).rejects.toThrow(
      "This device is offline.",
    );

    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("lets an offline-looking device through when a remote session is already ready", async () => {
    mocks.unavailability.mockReturnValue("offline");
    mocks.readyRemote.mockReturnValue(true);

    await actions().closeTab(identity, "tab-1");

    expect(mocks.closeTab).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        tabId: "tab-1",
        owner: { hostId: "host-b", identityKey: "identity-1" },
      }),
    );
  });

  it("attempts a Close when reachability is unknown, and reports the failure", async () => {
    mocks.unavailability.mockReturnValue(null);
    mocks.closeTab.mockRejectedValue(
      new Error("Browser sessions request timed out."),
    );

    await expect(actions().closeTab(identity, "tab-1")).rejects.toThrow(
      "Browser sessions request timed out.",
    );

    expect(mocks.closeTab).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses a tab that belongs to another task", async () => {
    await expect(
      actions().closeTab({ ...identity, epicId: "epic-2" }, "tab-1"),
    ).rejects.toThrow();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("refuses when the signed-in account changed since render", async () => {
    mocks.liveUserId.mockReturnValue("user-2");

    await expect(actions().closeTab(identity, "tab-1")).rejects.toThrow(
      "Sign in",
    );
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("refuses a device missing from the directory", async () => {
    mocks.findById.mockReturnValue(null);

    await expect(actions().closeTab(identity, "tab-1")).rejects.toThrow();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("runs other owner actions without requiring durable support, and refuses an offline owner the same way", async () => {
    const action = vi.fn(() => Promise.resolve("done"));
    await actions().withOwner("host-b", action);
    expect(mocks.runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        requireDurable: false,
        action,
      }),
    );

    mocks.unavailability.mockReturnValue("offline");
    expect(() => actions().withOwner("host-b", action)).toThrow(
      "This device is offline.",
    );
  });
});
