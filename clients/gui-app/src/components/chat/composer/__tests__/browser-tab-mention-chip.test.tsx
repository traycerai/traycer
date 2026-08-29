import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { BrowserTabMentionAttachment } from "@/lib/composer/types";

const TILE_HOST_ID = "host-remote";
const CANVAS_HOST_ID = "host-canvas";

/**
 * Two coordinators, one per host, exactly as an epic with a remote-host chat
 * tile now holds (`renderTile`'s `BrowserSessionsHostBoundary` plus the
 * canvas's ambient provider).
 */
const registryHarness = vi.hoisted(() => ({
  sessions: [] as BrowserSessionInfo[],
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
    >("@/lib/browser-view/sessions/browser-sessions-coordinator");
    return {
      ...actual,
      subscribeToBrowserSessionsCoordinators: () => () => undefined,
      browserSessionAcrossCoordinators: (sessionId: string) =>
        registryHarness.sessions.find((item) => item.sessionId === sessionId) ??
        null,
    };
  },
);

function sessionInfo(seed: {
  readonly sessionId: string;
  readonly hostId: string;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}): BrowserSessionInfo {
  return {
    sessionId: seed.sessionId,
    epicId: "epic-1",
    hostId: seed.hostId,
    profile: "isolated",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 0 },
    tabs: [
      {
        tabId: seed.tabId,
        url: seed.url,
        title: seed.title,
        originTier: "dev",
        status: "ready",
        viewed: false,
        drivenBy: [],
      },
    ],
  };
}

function mention(seed: {
  readonly sessionId: string;
  readonly tabId: string;
}): BrowserTabMentionAttachment {
  return {
    kind: "mention",
    contextType: "browser-tab",
    path: seed.tabId,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: "captured label",
    description: "",
    tabId: seed.tabId,
    sessionId: seed.sessionId,
    url: "https://captured.test/",
  };
}

/** The context a remote-host chat tile sees: the TILE host's stream only. */
function tileHostSessionsState(): BrowserSessionsState {
  return {
    hostId: TILE_HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    items: [
      sessionInfo({
        sessionId: "session-tile",
        hostId: TILE_HOST_ID,
        tabId: "tab-tile",
        title: "Tile host page",
        url: "https://tile.test/",
      }),
    ],
    errorMessage: null,
    retry: vi.fn(),
    openTab: vi.fn(() => Promise.reject(new Error("not used"))),
    closeTab: vi.fn(() => Promise.resolve()),
  };
}

describe("browser-tab mention chip inside a remote-host chat tile", () => {
  beforeEach(() => {
    registryHarness.sessions = [
      sessionInfo({
        sessionId: "session-tile",
        hostId: TILE_HOST_ID,
        tabId: "tab-tile",
        title: "Tile host page",
        url: "https://tile.test/",
      }),
      sessionInfo({
        sessionId: "session-canvas",
        hostId: CANVAS_HOST_ID,
        tabId: "tab-canvas",
        title: "Canvas host page",
        url: "https://canvas.test/",
      }),
    ];
  });

  afterEach(cleanup);

  it("resolves tabs on the tile's host and on another host alike", () => {
    render(
      <BrowserSessionsContext.Provider value={tileHostSessionsState()}>
        <ComposerMentionDecorator
          density="regular"
          mention={mention({ sessionId: "session-tile", tabId: "tab-tile" })}
        />
        <ComposerMentionDecorator
          density="regular"
          mention={mention({
            sessionId: "session-canvas",
            tabId: "tab-canvas",
          })}
        />
      </BrowserSessionsContext.Provider>,
    );

    expect(screen.getByText("Tile host page")).toBeTruthy();
    // The one the ambient (tile-host) context cannot answer: it resolves only
    // because the chip reads every coordinator, not its surroundings.
    expect(screen.getByText("Canvas host page")).toBeTruthy();
    expect(screen.queryByText("captured label")).toBeNull();
  });

  it("falls back to the captured label when no coordinator knows the tab", () => {
    registryHarness.sessions = [];

    render(
      <ComposerMentionDecorator
        density="regular"
        mention={mention({ sessionId: "session-canvas", tabId: "tab-canvas" })}
      />,
    );

    expect(screen.getByText("captured label")).toBeTruthy();
  });
});
