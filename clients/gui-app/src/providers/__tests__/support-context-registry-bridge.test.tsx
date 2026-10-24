import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  __resetSupportContextRegistryForTests,
  getSupportContextSnapshot,
} from "@/lib/support-context-registry";
import { SupportContextRegistryBridge } from "../support-context-registry-bridge";

/**
 * The bridge sits above every tab, so its `hostId` is the app-wide effective
 * host. A report from a chat tab bound to another host used to name the
 * default host and nothing else, which made "which machine was this chat on"
 * unanswerable from the report. `tabHostId` is the tab's own binding.
 */

const mocks = vi.hoisted(() => ({
  addressableHostId: "host-app-default" as string | null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.addressableHostId,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined, isError: false }),
}));

// A real router, never loaded: the bridge only reads `state`/`subscribe`, and
// the route template is not what these tests are about.
const ROUTER: AppRouter = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  context: {
    queryClient: new QueryClient(),
    getAuthSnapshot: () => useAuthStore.getState(),
    getHostClient: () => null,
  },
});

function recordRef(
  type: "chat" | "terminal-agent" | "spec" | "ticket",
  hostId: string,
): EpicCanvasTileRef {
  return {
    id: `${type}-1`,
    instanceId: `instance-${type}`,
    type,
    name: type,
    hostId,
  };
}

function terminalRef(hostId: string): EpicCanvasTileRef {
  return {
    id: "terminal-1",
    instanceId: "instance-terminal",
    type: "terminal",
    name: "Terminal",
    titleSource: "manual",
    hostId,
    cwd: "/work",
  };
}

function browserRef(hostId: string): EpicCanvasTileRef {
  return {
    id: "browser-1",
    instanceId: "instance-browser",
    type: "browser-session",
    name: "Browser",
    hostId,
    viewportPreset: "responsive",
    sessionId: "session-1",
    tabId: "browser-tab-1",
  };
}

function blankRef(hostId: string): EpicCanvasTileRef {
  return {
    id: "blank-1",
    instanceId: "instance-blank",
    type: "blank",
    name: "New tab",
    hostId,
  };
}

/** Opens `ref` as the active tile of a real epic tab in the real canvas store. */
function openActiveTile(ref: EpicCanvasTileRef): void {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab("epic-1", "Epic");
  store.openTileInTab(viewTabId, ref);
}

afterEach(() => {
  cleanup();
  __resetSupportContextRegistryForTests();
  mocks.addressableHostId = "host-app-default";
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("SupportContextRegistryBridge tab host", () => {
  it("records the chat tab's own host beside the app-wide host", () => {
    openActiveTile(recordRef("chat", "host-tab-bound"));

    render(<SupportContextRegistryBridge router={ROUTER} />);

    const snapshot = getSupportContextSnapshot();
    expect(snapshot.hostId).toEqual({
      status: "known",
      value: "host-app-default",
    });
    expect(snapshot.tabHostId).toEqual({
      status: "known",
      value: "host-tab-bound",
    });
  });

  it.each(["terminal-agent", "spec", "ticket"] as const)(
    "records a %s tile's bound host the same way",
    (type) => {
      openActiveTile(recordRef(type, "host-bound"));

      render(<SupportContextRegistryBridge router={ROUTER} />);

      expect(getSupportContextSnapshot().tabHostId).toEqual({
        status: "known",
        value: "host-bound",
      });
    },
  );

  // Renderer-only tiles are not record-backed, so the record-backed selector
  // never returns them; the bridge has to read the active tile itself.
  it.each([
    ["terminal", terminalRef("host-term")],
    ["browser", browserRef("host-browser")],
  ] as const)("records a %s tile's bound host", (_kind, ref) => {
    openActiveTile(ref);

    render(<SupportContextRegistryBridge router={ROUTER} />);

    expect(getSupportContextSnapshot().tabHostId).toEqual({
      status: "known",
      value: ref.hostId,
    });
  });

  it("leaves the tab host unavailable for a blank tab, whose host is a placeholder", () => {
    openActiveTile(blankRef("placeholder-host"));

    render(<SupportContextRegistryBridge router={ROUTER} />);

    expect(getSupportContextSnapshot().tabHostId).toEqual({
      status: "unavailable",
    });
  });

  it("leaves the tab host unavailable when there is no active tile", () => {
    render(<SupportContextRegistryBridge router={ROUTER} />);

    const snapshot = getSupportContextSnapshot();
    expect(snapshot.hostId).toEqual({
      status: "known",
      value: "host-app-default",
    });
    expect(snapshot.tabHostId).toEqual({ status: "unavailable" });
  });
});
