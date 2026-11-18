import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionReference } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { useBrowserSessionsForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

// A bot's tab renders chat transcripts OUTSIDE an <EpicSessionProvider>; the
// bot id is the transcript's container (`ChatContainerContext`). These cases
// render the container-agnostic segments exactly that way - the real hooks,
// no Epic session, no mock of `@/lib/epic-selectors` or of the session gate -
// so a segment that still reaches for the Epic throws and fails here. Only the
// boundaries the browser row talks to (the inventory hook, host reachability,
// tile navigation) are replaced, the same ones its Epic-side suite replaces.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-1";

type InventoryArgs = Parameters<typeof useBrowserSessionsForHost>[0];

const mocks = vi.hoisted(() => ({
  openTile: vi.fn<(intent: TileOpenIntent) => void>(),
  inventory: vi.fn<(args: InventoryArgs) => BrowserSessionsState>(),
  reachability: vi.fn<(hostId: string) => HostReachability>(),
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: (hostId: string) => mocks.reachability(hostId),
}));

vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  useBrowserSessionsForHost: (args: InventoryArgs) => mocks.inventory(args),
}));

import { BrowserSessionRow } from "@/components/chat/segments/browser-session-row";
import { ArtifactCardSegment } from "@/components/chat/segments/artifact-card-segment";
import { AgentReferenceChip } from "@/components/chat/agent-reference-chip";
import {
  ChatContainerContext,
  useChatContainerId,
} from "@/components/chat/chat-container-context";

function tab(tabId: string, title: string): BrowserTabInfo {
  return {
    tabId,
    url: "https://example.com/checkout",
    originTier: "external",
    status: "ready",
    title,
    viewed: false,
    drivenBy: [],
    boundWindowId: null,
  };
}

function sessionInfo(): BrowserSessionInfo {
  return {
    sessionId: "sess-a",
    scope: { kind: "epic", epicId: BOT_ID },
    hostId: HOST_ID,
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 0 },
    tabs: [tab("tab-original", "Checkout")],
  };
}

function liveInventory(): BrowserSessionsState {
  return {
    viewports: {},
    setViewport: async () => {},
    reportViewport: () => {},
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 1,
    items: [sessionInfo()],
    errorMessage: null,
    retry: () => {},
    openTab: () => Promise.reject(new Error("unused in this suite")),
    prepareOpenTab: () => {
      throw new Error("unused in this suite");
    },
    closeTab: async () => {},
    attachTab: async () => {},
    moveTab: async () => {},
  };
}

function reachable(): HostReachability {
  return {
    status: "reachable",
    hostLabel: "My Machine",
    unavailability: null,
    basis: "directory",
    hostKind: "local",
  };
}

const SESSION: BrowserSessionReference = {
  hostId: HOST_ID,
  sessionId: "sess-a",
  tabId: "tab-original",
  profile: "primary",
};

function InBotTranscript(props: { readonly children: ReactNode }) {
  return (
    <StrictMode>
      <ChatContainerContext.Provider value={BOT_ID}>
        {props.children}
      </ChatContainerContext.Provider>
    </StrictMode>
  );
}

function renderInBot(node: ReactNode) {
  return render(<InBotTranscript>{node}</InBotTranscript>);
}

/** No button, link or button-role element is rendered anywhere in the tree. */
function nothingClickableIn(container: HTMLElement): boolean {
  return container.querySelectorAll("button, a, [role='button']").length === 0;
}

beforeEach(() => {
  mocks.inventory.mockReturnValue(liveInventory());
  mocks.reachability.mockReturnValue(reachable());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<BrowserSessionRow /> in a bot transcript (no Epic session)", () => {
  it("renders the session line with no Open browser button, and does not throw", () => {
    renderInBot(<BrowserSessionRow session={SESSION} findUnitId="find-1" />);

    expect(screen.getByText(/Browser · Primary/)).not.toBeNull();
    expect(screen.getByText(/Checkout/)).not.toBeNull();
    expect(screen.getByText(/My Machine/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /open browser/i })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("scopes the inventory read to the bot id on the session's host", () => {
    renderInBot(<BrowserSessionRow session={SESSION} findUnitId="find-1" />);

    expect(mocks.inventory).toHaveBeenCalled();
    expect(mocks.inventory).toHaveBeenCalledWith({
      hostId: HOST_ID,
      scope: { kind: "epic", epicId: BOT_ID },
    });
    expect(mocks.inventory).not.toHaveBeenCalledWith({
      hostId: null,
      scope: { kind: "independent" },
    });
  });

  it("with NO container at all, reads the independent scope with a null host", () => {
    render(
      <StrictMode>
        <BrowserSessionRow session={SESSION} findUnitId="find-1" />
      </StrictMode>,
    );

    expect(mocks.inventory).toHaveBeenCalledWith({
      hostId: null,
      scope: { kind: "independent" },
    });
    expect(mocks.inventory).not.toHaveBeenCalledWith({
      hostId: HOST_ID,
      scope: { kind: "epic", epicId: BOT_ID },
    });
    // Still a row, still no button, still no throw.
    expect(screen.getByText(/Browser · Primary/)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("<ArtifactCardSegment /> in a bot transcript (no Epic session)", () => {
  it("renders the inert card with the recorded title and the operation badge", () => {
    const { container } = renderInBot(
      <ArtifactCardSegment
        findUnitId="find-2"
        operation="create"
        artifactKind="spec"
        artifactId="a1"
        title="Recorded Spec"
        change={null}
      />,
    );

    const card = screen.getByTestId("artifact-card-inert");
    expect(within(card).getByText("Recorded Spec")).not.toBeNull();
    expect(within(card).getByText("Created")).not.toBeNull();
    expect(card.getAttribute("data-chat-find-unit")).toBe("find-2");
    expect(nothingClickableIn(container)).toBe(true);
  });

  it("falls back to the kind label when the row recorded no title", () => {
    const { container } = renderInBot(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="ticket"
        artifactId="t1"
        title={null}
        change={{ beforeHash: "h0", afterHash: "h1" }}
      />,
    );

    const card = screen.getByTestId("artifact-card-inert");
    expect(within(card).getByText("Ticket")).not.toBeNull();
    expect(within(card).getByText("Updated")).not.toBeNull();
    // A captured change does not conjure a diff toggle outside an Epic.
    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
    expect(nothingClickableIn(container)).toBe(true);
  });

  it("renders the inert card for a delete too", () => {
    renderInBot(
      <ArtifactCardSegment
        findUnitId={null}
        operation="delete"
        artifactKind="review"
        artifactId="r1"
        title="Gone Review"
        change={null}
      />,
    );

    const card = screen.getByTestId("artifact-card-inert");
    expect(within(card).getByText("Gone Review")).not.toBeNull();
    expect(within(card).getByText("Deleted")).not.toBeNull();
  });
});

describe("<AgentReferenceChip /> in a bot transcript (no Epic session)", () => {
  it("renders the agent id as written for text display", () => {
    renderInBot(<AgentReferenceChip agentId="c303ea21b" display="text" />);

    expect(screen.getByText("c303ea21b")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the agent id as code for code display", () => {
    renderInBot(<AgentReferenceChip agentId="c303ea21b" display="code" />);

    const code = screen.getByText("c303ea21b");
    expect(code.tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a mixed bot trunk transcript", () => {
  it("renders the browser row, the artifact card and the agent chip in one tree", () => {
    const { container } = renderInBot(
      <>
        <BrowserSessionRow session={SESSION} findUnitId="find-1" />
        <ArtifactCardSegment
          findUnitId="find-2"
          operation="create"
          artifactKind="story"
          artifactId="s1"
          title="Plan the launch"
          change={null}
        />
        <p>
          Handed to <AgentReferenceChip agentId="c303ea21b" display="code" />
        </p>
      </>,
    );

    expect(screen.getByText(/Browser · Primary/)).not.toBeNull();
    expect(
      within(screen.getByTestId("artifact-card-inert")).getByText(
        "Plan the launch",
      ),
    ).not.toBeNull();
    expect(screen.getByText("c303ea21b").tagName).toBe("CODE");
    // The whole trunk offers nothing to click: every Epic-bound action is gone.
    expect(nothingClickableIn(container)).toBe(true);
    expect(mocks.inventory).toHaveBeenCalledWith({
      hostId: HOST_ID,
      scope: { kind: "epic", epicId: BOT_ID },
    });
  });
});

describe("useChatContainerId", () => {
  function epicHandle(epicId: string): OpenEpicStoreHandle {
    // `EpicSessionGate` / `useChatContainerId` read only the handle's presence
    // and `epicId`, so a stand-in carrying `epicId` is enough.
    const value = { epicId } as OpenEpicStoreHandle;
    handleHostIds.set(value, HOST_ID);
    return value;
  }

  it("returns the container context's id", () => {
    const { result } = renderHook(() => useChatContainerId(), {
      wrapper: (props) => (
        <ChatContainerContext.Provider value={BOT_ID}>
          {props.children}
        </ChatContainerContext.Provider>
      ),
    });

    expect(result.current).toBe(BOT_ID);
  });

  it("is null with no container context and no Epic session", () => {
    const { result } = renderHook(() => useChatContainerId());

    expect(result.current).toBeNull();
  });

  it("falls back to the open Epic's id when only an Epic session is present", () => {
    const { result } = renderHook(() => useChatContainerId(), {
      wrapper: (props) => (
        <EpicSessionContext value={epicHandle("epic-9")}>
          {props.children}
        </EpicSessionContext>
      ),
    });

    expect(result.current).toBe("epic-9");
  });

  it("prefers the container context over an Epic session's id", () => {
    const { result } = renderHook(() => useChatContainerId(), {
      wrapper: (props) => (
        <EpicSessionContext value={epicHandle("epic-9")}>
          <ChatContainerContext.Provider value={BOT_ID}>
            {props.children}
          </ChatContainerContext.Provider>
        </EpicSessionContext>
      ),
    });

    expect(result.current).toBe(BOT_ID);
  });
});
