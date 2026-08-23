import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewTileHandoffChange,
} from "@/lib/browser-view/desktop-agent-browser-view";
import type {
  BrowserViewBackgroundTabCreate,
  BrowserViewDurableTabRegistration,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStatusChange,
  BrowserViewTileKey,
} from "@/lib/browser-view/desktop-browser-view";
import {
  attachElectronBrowserBackgroundTabRoute,
  attachElectronBrowserTabStream,
  drainElectronBrowserHandoffs,
  findElectronBrowserTabBinding,
  findElectronBrowserTabBindingOnHost,
  handleElectronBrowserTabFrame,
  registerElectronBrowserTab,
  resetElectronBrowserTabStoreForTests,
  syncElectronBrowserTabDrivers,
  updateElectronBrowserTabView,
} from "@/lib/browser-view/electron-browser-tab-store";
import { publishAgentBrowserCdpRequest } from "@/lib/browser-view/agent-browser-cdp-store";
import {
  resetAgentTabSurfacingForTests,
  setEpicSurfaceVisibility,
} from "@/lib/browser-view/agent-tab-surfacing";
import { getPipSnapshot } from "@/lib/browser-view/pip-store";
import { appLogger } from "@/lib/logger";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { makeBrowserTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  DEFAULT_AGENT_BROWSER_VIEWPORT_PRESET,
  makeAgentBrowserTileRef,
} from "@/stores/epics/canvas/tile-schema/agent-browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { type AgentBrowserTileRef, type BrowserTileRef } from "@/stores/epics/canvas/types";

const EPIC = "epic-1";
const HOST = "host-1";
const OTHER_EPIC = "epic-2";
const OTHER_HOST = "host-2";

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

class FakeBridge {
  readonly registerDurableTabCalls: BrowserViewDurableTabRegistration[] = [];
  readonly releaseDurableTabCalls: BrowserViewDurableTabRegistration[] = [];
  readonly backgroundCreateCalls: BrowserViewBackgroundTabCreate[] = [];
  readonly storageApplyCalls: BrowserViewStorageStateApply[] = [];
  readonly backgroundOperations: string[] = [];
  readonly backgroundThrottlingCalls: Array<{
    readonly enabled: boolean;
  }> = [];
  readonly statusHandlers = new Set<
    (change: BrowserViewStatusChange) => void
  >();
  readonly openTileHandlers = new Set<
    (change: { readonly url: string } & BrowserViewTileKey) => void
  >();
  readonly cdpSessionEndedHandlers = new Set<
    (change: AgentBrowserViewCdpSessionEndedChange) => void
  >();
  readonly cdpTargetAttachedHandlers = new Set<
    (change: AgentBrowserViewCdpTargetAttachedChange) => void
  >();
  readonly tileHandoffHandlers = new Set<
    (change: AgentBrowserViewTileHandoffChange) => void
  >();

  registerDurableTab(input: BrowserViewDurableTabRegistration): Promise<void> {
    this.registerDurableTabCalls.push(input);
    return Promise.resolve();
  }

  releaseDurableTab(input: BrowserViewDurableTabRegistration): Promise<void> {
    this.releaseDurableTabCalls.push(input);
    return Promise.resolve();
  }

  createBackgroundTab(input: BrowserViewBackgroundTabCreate): Promise<void> {
    this.backgroundOperations.push("create");
    this.backgroundCreateCalls.push(input);
    return Promise.resolve();
  }

  applyStorageState(
    input: BrowserViewStorageStateApply,
  ): Promise<BrowserViewStorageStateApplyResult> {
    this.backgroundOperations.push("apply");
    this.storageApplyCalls.push(input);
    return Promise.resolve({
      status: "applied",
      cookieCount: 1,
      localStorageApplied: false,
      reason: "cookies-only",
    });
  }

  setBackgroundThrottling = (input: {
    readonly enabled: boolean;
  }): Promise<void> => {
    this.backgroundThrottlingCalls.push({ enabled: input.enabled });
    return Promise.resolve();
  };

  dispatchCdp(
    _input: AgentBrowserViewCdpDispatch,
  ): Promise<AgentBrowserViewCdpResult> {
    return Promise.resolve({
      kind: "cdpGetFrameTree",
      ok: true,
      frames: [],
    });
  }

  onStatusChange(handler: (change: BrowserViewStatusChange) => void): {
    dispose: () => void;
  } {
    this.statusHandlers.add(handler);
    return {
      dispose: () => {
        this.statusHandlers.delete(handler);
      },
    };
  }

  onCdpSessionEnded(
    handler: (change: AgentBrowserViewCdpSessionEndedChange) => void,
  ): { dispose: () => void } {
    this.cdpSessionEndedHandlers.add(handler);
    return {
      dispose: () => {
        this.cdpSessionEndedHandlers.delete(handler);
      },
    };
  }

  onCdpTargetAttached(
    handler: (change: AgentBrowserViewCdpTargetAttachedChange) => void,
  ): { dispose: () => void } {
    this.cdpTargetAttachedHandlers.add(handler);
    return {
      dispose: () => {
        this.cdpTargetAttachedHandlers.delete(handler);
      },
    };
  }

  onTileHandoff(handler: (change: AgentBrowserViewTileHandoffChange) => void): {
    dispose: () => void;
  } {
    this.tileHandoffHandlers.add(handler);
    return {
      dispose: () => {
        this.tileHandoffHandlers.delete(handler);
      },
    };
  }

  emitStatus(change: BrowserViewStatusChange): void {
    for (const handler of this.statusHandlers) handler(change);
  }

  emitTileHandoff(change: AgentBrowserViewTileHandoffChange): void {
    for (const handler of this.tileHandoffHandlers) handler(change);
  }
}

function baseRegistration(
  overrides: Partial<Parameters<typeof registerElectronBrowserTab>[0]> &
    Pick<
      Parameters<typeof registerElectronBrowserTab>[0],
      "registrationId" | "sessionId" | "bridge"
    >,
): Parameters<typeof registerElectronBrowserTab>[0] {
  return {
    epicId: EPIC,
    hostId: HOST,
    chatId: "chat-1",
    initialUrl: "https://app.example",
    title: null,
    tileKey: TILE_KEY,
    onRegistered: null,
    ...overrides,
  };
}

describe("electron-browser-tab-store (ticket 05/08 epic+host routing)", () => {
  afterEach(() => {
    resetElectronBrowserTabStoreForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("publishes registerElectronTab when the epic+host stream is attached", () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-1",
        sessionId: "session-1",
        title: "App",
        bridge,
      }),
    );

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "registerElectronTab",
        registrationId: "reg-1",
        sessionId: "session-1",
        tileInstanceId: "tile-1",
        initialUrl: "https://app.example",
        title: "App",
      }),
    ]);
  });

  it("keeps identical session and tab ids isolated by host", () => {
    const bridge = new FakeBridge();
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-host-1",
        sessionId: "shared-session",
        hostId: HOST,
        bridge,
      }),
    );
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-host-2",
        sessionId: "shared-session",
        hostId: OTHER_HOST,
        bridge,
      }),
    );
    for (const registrationId of ["reg-host-1", "reg-host-2"]) {
      handleElectronBrowserTabFrame({
        kind: "electronTabRegistered",
        hasBinaryPayload: false,
        requestId: `ack-${registrationId}`,
        registrationId,
        sessionId: "shared-session",
        tabId: "shared-tab",
      });
    }

    expect(
      findElectronBrowserTabBindingOnHost(
        "shared-session",
        "shared-tab",
        HOST,
      )?.registrationId,
    ).toBe("reg-host-1");
    expect(
      findElectronBrowserTabBindingOnHost(
        "shared-session",
        "shared-tab",
        OTHER_HOST,
      )?.registrationId,
    ).toBe("reg-host-2");
  });

  it("turns background throttling off for driven tabs and restores it when idle", async () => {
    const bridge = new FakeBridge();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-throttle",
        sessionId: "session-throttle",
        bridge,
        background: true,
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-throttle",
      registrationId: "reg-throttle",
      sessionId: "session-throttle",
      tabId: "tab-throttle",
    });

    const session = {
      sessionId: "session-throttle",
      epicId: EPIC,
      hostId: HOST,
      profile: "primary",
      name: "Agent browser",
      createdBy: { chatId: "chat-1", agentRunId: "agent-1" },
      createdAt: 0,
      lastActivityAt: 0,
      tabs: [
        {
          tabId: "tab-throttle",
          url: "https://app.example",
          originTier: "external",
          status: "ready",
          title: null,
          viewed: false,
          drivenBy: [
            { chatId: "chat-1", agentRunId: "agent-1", requestId: "req-1" },
          ],
        },
      ],
    } satisfies BrowserSessionInfo;
    syncElectronBrowserTabDrivers(session);
    syncElectronBrowserTabDrivers({
      ...session,
      tabs: [{ ...session.tabs[0], drivenBy: [] }],
    });
    await Promise.resolve();

    expect(bridge.backgroundThrottlingCalls).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
  });

  it("does not publish records from another epic or host into this stream", () => {
    const bridge = new FakeBridge();
    const localFrames: BrowserSessionsClientFrame[] = [];
    const otherEpicFrames: BrowserSessionsClientFrame[] = [];
    const otherHostFrames: BrowserSessionsClientFrame[] = [];

    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      localFrames.push(frame);
    });
    attachElectronBrowserTabStream(OTHER_EPIC, HOST, (frame) => {
      otherEpicFrames.push(frame);
    });
    attachElectronBrowserTabStream(EPIC, OTHER_HOST, (frame) => {
      otherHostFrames.push(frame);
    });

    registerElectronBrowserTab(
      baseRegistration({
        epicId: EPIC,
        hostId: HOST,
        registrationId: "reg-local",
        sessionId: "session-local",
        bridge,
      }),
    );
    registerElectronBrowserTab(
      baseRegistration({
        epicId: OTHER_EPIC,
        hostId: HOST,
        registrationId: "reg-other-epic",
        sessionId: "session-other-epic",
        bridge,
      }),
    );
    registerElectronBrowserTab(
      baseRegistration({
        epicId: EPIC,
        hostId: OTHER_HOST,
        registrationId: "reg-other-host",
        sessionId: "session-other-host",
        bridge,
      }),
    );

    expect(localFrames).toEqual([
      expect.objectContaining({ registrationId: "reg-local" }),
    ]);
    expect(otherEpicFrames).toEqual([
      expect.objectContaining({ registrationId: "reg-other-epic" }),
    ]);
    expect(otherHostFrames).toEqual([
      expect.objectContaining({ registrationId: "reg-other-host" }),
    ]);
  });

  it("re-publishes only matching epic+host registrations on attach", () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-local",
        sessionId: "session-local",
        bridge,
      }),
    );
    registerElectronBrowserTab(
      baseRegistration({
        epicId: OTHER_EPIC,
        hostId: HOST,
        registrationId: "reg-other",
        sessionId: "session-other",
        bridge,
      }),
    );

    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    expect(frames).toEqual([
      expect.objectContaining({ registrationId: "reg-local" }),
    ]);
  });

  it("re-publishes registration when the same registrationId reconnects", () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-stable",
        sessionId: "session-1",
        initialUrl: "https://app.example/a",
        title: "A",
        bridge,
      }),
    );
    frames.length = 0;

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-stable",
        sessionId: "session-1",
        initialUrl: "https://app.example/b",
        title: "B",
        tileKey: { ...TILE_KEY, tileInstanceId: "tile-rebound" },
        bridge,
      }),
    );

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "registerElectronTab",
        registrationId: "reg-stable",
        tileInstanceId: "tile-rebound",
        initialUrl: "https://app.example/b",
        title: "B",
      }),
    ]);
  });

  it("on electronTabRegistered calls registerDurableTab and onRegistered with host-minted tabId", async () => {
    const bridge = new FakeBridge();
    const onRegistered = vi.fn();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-1",
        sessionId: "session-1",
        bridge,
        onRegistered,
      }),
    );

    const handled = handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-1",
      registrationId: "reg-1",
      sessionId: "session-1",
      tabId: "host-minted-tab-99",
    } satisfies BrowserSessionsServerFrame);

    expect(handled).toBe(true);
    await Promise.resolve();
    expect(bridge.registerDurableTabCalls).toEqual([
      {
        ...TILE_KEY,
        sessionId: "session-1",
        tabId: "host-minted-tab-99",
      },
    ]);
    expect(onRegistered).toHaveBeenCalledWith("host-minted-tab-99");
  });

  it("releases the desktop durable tab without emitting a tile handoff", async () => {
    const bridge = new FakeBridge();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-release",
        sessionId: "session-release",
        bridge,
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-release-register",
      registrationId: "reg-release",
      sessionId: "session-release",
      tabId: "tab-release",
    });
    await Promise.resolve();

    expect(
      handleElectronBrowserTabFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: "req-release",
        sessionId: "session-release",
        tabId: "tab-release",
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(bridge.releaseDurableTabCalls).toEqual([
      {
        ...TILE_KEY,
        sessionId: "session-release",
        tabId: "tab-release",
      },
    ]);
    expect(
      findElectronBrowserTabBinding("session-release", "tab-release"),
    ).toBeNull();
  });

  it("consumes a late release tombstone in K2 order and leaves no provisional binding", async () => {
    const bridge = new FakeBridge();
    const sessionId = "session-late-release";
    const tabId = "tab-late-release";
    const order: string[] = [];
    let resolveRegistration!: () => void;
    const registrationPromise = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(() => {});

    vi.spyOn(bridge, "registerDurableTab").mockImplementation((input) => {
      order.push("register");
      bridge.registerDurableTabCalls.push(input);
      return registrationPromise;
    });
    vi.spyOn(bridge, "releaseDurableTab").mockImplementation((input) => {
      order.push("release");
      bridge.releaseDurableTabCalls.push(input);
      return Promise.resolve();
    });

    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    expect(
      handleElectronBrowserTabFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: "req-late-release",
        sessionId,
        tabId,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-late-release",
        sessionId,
        bridge,
      }),
    );
    expect(
      handleElectronBrowserTabFrame({
        kind: "electronTabRegistered",
        hasBinaryPayload: false,
        requestId: "req-late-registered",
        registrationId: "reg-late-release",
        sessionId,
        tabId,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);

    expect(order).toEqual(["register"]);
    expect(findElectronBrowserTabBinding(sessionId, tabId)).toBeNull();
    expect(bridge.releaseDurableTabCalls).toEqual([]);

    resolveRegistration();
    await Promise.resolve();

    expect(order).toEqual(["register", "release"]);
    expect(bridge.releaseDurableTabCalls).toEqual([
      {
        ...TILE_KEY,
        sessionId,
        tabId,
      },
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      "Electron browser tab release tombstone created",
      expect.objectContaining({
        event: "electron_release_tombstone",
        action: "create",
        sessionId,
        tabId,
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "Electron browser tab release tombstone consumed",
      expect.objectContaining({
        event: "electron_release_tombstone",
        action: "consume",
        sessionId,
        tabId,
      }),
    );
  });

  it("evicts the oldest pending release after the 128-entry cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(appLogger, "info").mockImplementation(() => {});

    const bridge = new FakeBridge();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    for (let index = 0; index < 129; index += 1) {
      expect(
        handleElectronBrowserTabFrame({
          kind: "releaseElectronTab",
          hasBinaryPayload: false,
          requestId: `req-cap-${index}`,
          sessionId: `session-cap-${index}`,
          tabId: `tab-cap-${index}`,
        } satisfies BrowserSessionsServerFrame),
      ).toBe(true);
    }

    const register = (index: number): void => {
      registerElectronBrowserTab(
        baseRegistration({
          registrationId: `reg-cap-${index}`,
          sessionId: `session-cap-${index}`,
          bridge,
        }),
      );
      handleElectronBrowserTabFrame({
        kind: "electronTabRegistered",
        hasBinaryPayload: false,
        requestId: `req-cap-registered-${index}`,
        registrationId: `reg-cap-${index}`,
        sessionId: `session-cap-${index}`,
        tabId: `tab-cap-${index}`,
      } satisfies BrowserSessionsServerFrame);
    };

    register(0);
    expect(
      findElectronBrowserTabBinding("session-cap-0", "tab-cap-0"),
    ).not.toBeNull();

    register(128);
    await Promise.resolve();
    expect(
      findElectronBrowserTabBinding("session-cap-128", "tab-cap-128"),
    ).toBeNull();
    expect(bridge.releaseDurableTabCalls).toEqual([
      {
        ...TILE_KEY,
        sessionId: "session-cap-128",
        tabId: "tab-cap-128",
      },
    ]);
  });

  it("does not consume a pending release after the 60-second TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bridge = new FakeBridge();
    const sessionId = "session-expired-release";
    const tabId = "tab-expired-release";
    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    handleElectronBrowserTabFrame({
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      requestId: "req-expired-release",
      sessionId,
      tabId,
    });

    vi.setSystemTime(60_001);
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-expired-release",
        sessionId,
        bridge,
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-expired-registered",
      registrationId: "reg-expired-release",
      sessionId,
      tabId,
    });

    expect(findElectronBrowserTabBinding(sessionId, tabId)).not.toBeNull();
    expect(bridge.releaseDurableTabCalls).toEqual([]);
  });

  it("disposes bridge and CDP callbacks across two release/re-register cycles", async () => {
    const bridge = new FakeBridge();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    const dispatchSpy = vi.spyOn(bridge, "dispatchCdp");

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const registrationId = `reg-dispose-cycle-${cycle}`;
      const sessionId = `session-dispose-cycle-${cycle}`;
      const tileInstanceId = `tile-dispose-cycle-${cycle}`;
      registerElectronBrowserTab(
        baseRegistration({
          registrationId,
          sessionId,
          bridge,
          tileKey: { ...TILE_KEY, tileInstanceId },
        }),
      );
      handleElectronBrowserTabFrame({
        kind: "electronTabRegistered",
        hasBinaryPayload: false,
        requestId: `req-dispose-cycle-${cycle}`,
        registrationId,
        sessionId,
        tabId: `tab-dispose-cycle-${cycle}`,
      });

      expect(bridge.statusHandlers.size).toBe(1);
      expect(bridge.cdpSessionEndedHandlers.size).toBe(1);
      expect(bridge.cdpTargetAttachedHandlers.size).toBe(1);
      expect(bridge.tileHandoffHandlers.size).toBe(1);
      const sendFrame = vi.fn();
      publishAgentBrowserCdpRequest({
        requestId: `req-cdp-dispose-cycle-${cycle}`,
        tileInstanceId,
        sessionId,
        command: { kind: "cdpGetFrameTree" },
        sendFrame,
      });
      await Promise.resolve();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      dispatchSpy.mockClear();

      handleElectronBrowserTabFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: `req-release-dispose-cycle-${cycle}`,
        sessionId,
        tabId: `tab-dispose-cycle-${cycle}`,
      });
      await Promise.resolve();

      expect(bridge.statusHandlers.size).toBe(0);
      expect(bridge.cdpSessionEndedHandlers.size).toBe(0);
      expect(bridge.cdpTargetAttachedHandlers.size).toBe(0);
      expect(bridge.tileHandoffHandlers.size).toBe(0);
      publishAgentBrowserCdpRequest({
        requestId: `req-cdp-dispose-cycle-${cycle}-after-release`,
        tileInstanceId,
        sessionId,
        command: { kind: "cdpGetFrameTree" },
        sendFrame,
      });
      expect(dispatchSpy).not.toHaveBeenCalled();
    }
  });

  it("forwards status changes as electronTabState only after host mint is known", async () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-1",
        sessionId: "session-1",
        bridge,
      }),
    );
    frames.length = 0;

    bridge.emitStatus({
      ...TILE_KEY,
      url: "https://app.example/loading",
      title: "Loading",
      status: "loading",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });
    expect(frames).toEqual([]);

    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-1",
      registrationId: "reg-1",
      sessionId: "session-1",
      tabId: "tab-1",
    });
    await Promise.resolve();
    frames.length = 0;

    bridge.emitStatus({
      ...TILE_KEY,
      url: "https://app.example/ready",
      title: "Ready",
      status: "ready",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        registrationId: "reg-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://app.example/ready",
        title: "Ready",
        status: "ready",
      }),
    ]);
  });

  it("forwards aggregated sibling tabs in a tileHandoff frame", () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-handoff",
        sessionId: "session-handoff",
        bridge,
      }),
    );
    frames.length = 0;

    const primaryStorage = { cookies: [], origins: [] };
    const siblingStorage = {
      cookies: [],
      origins: [
        {
          origin: "https://sibling.example",
          localStorage: [{ name: "token", value: "carried" }],
        },
      ],
    };
    bridge.emitTileHandoff({
      ...TILE_KEY,
      capturedUrl: "https://app.example/after",
      capturedStorageState: primaryStorage,
      siblingTabs: [
        {
          tabId: "tab-sibling",
          url: "https://sibling.example/after",
          capturedStorageState: siblingStorage,
        },
      ],
      reason: "gui-quit",
    });

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "tileHandoff",
        tileInstanceId: TILE_KEY.tileInstanceId,
        capturedUrl: "https://app.example/after",
        capturedStorageState: primaryStorage,
        siblingTabs: [
          {
            tabId: "tab-sibling",
            url: "https://sibling.example/after",
            capturedStorageState: siblingStorage,
          },
        ],
        reason: "gui-quit",
      }),
    ]);
  });

  it("waits for the matching tileHandoff actionAck before completing the drain", async () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-handoff-ack",
        sessionId: "session-handoff-ack",
        bridge,
      }),
    );
    frames.length = 0;

    bridge.emitTileHandoff({
      ...TILE_KEY,
      capturedUrl: "https://app.example/after",
      capturedStorageState: null,
      siblingTabs: [],
      reason: "gui-quit",
    });

    const frame = frames[0];
    if (frame.kind !== "tileHandoff") {
      throw new Error("tile handoff frame missing");
    }
    const drain = drainElectronBrowserHandoffs();
    const pending = Symbol("pending");
    await expect(Promise.race([drain, Promise.resolve(pending)])).resolves.toBe(
      pending,
    );

    expect(
      handleElectronBrowserTabFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: "wrong-request",
        ok: true,
        reason: null,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(false);
    await expect(Promise.race([drain, Promise.resolve(pending)])).resolves.toBe(
      pending,
    );

    expect(
      handleElectronBrowserTabFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: frame.requestId,
        ok: true,
        reason: null,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);
    await expect(drain).resolves.toBeUndefined();
  });

  it("does not publish registration frames when no epic+host stream is attached yet", () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];

    registerElectronBrowserTab(
      baseRegistration({
        chatId: null,
        registrationId: "reg-pending",
        sessionId: "session-pending",
        bridge,
      }),
    );
    expect(frames).toEqual([]);

    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    expect(frames).toEqual([
      expect.objectContaining({
        kind: "registerElectronTab",
        registrationId: "reg-pending",
      }),
    ]);
  });

  it("invokes onActivatedHeadless for typed BROWSER_TAB_ACTIVATED_HEADLESS failures", () => {
    const bridge = new FakeBridge();
    const onActivatedHeadless = vi.fn();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-headless",
        sessionId: "session-1",
        bridge,
        onActivatedHeadless,
      }),
    );

    const handled = handleElectronBrowserTabFrame({
      kind: "electronTabRegistrationFailed",
      hasBinaryPayload: false,
      requestId: "req-fail",
      registrationId: "reg-headless",
      sessionId: "session-1",
      tabId: "tab-headless-1",
      code: "BROWSER_TAB_ACTIVATED_HEADLESS",
    } satisfies BrowserSessionsServerFrame);

    expect(handled).toBe(true);
    expect(onActivatedHeadless).toHaveBeenCalledWith("tab-headless-1");
  });

  it("real tile close / renderer death -> existing typed loss/release behavior still fires", async () => {
    const bridge = new FakeBridge();
    const onActivatedHeadless = vi.fn();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-background-headless-loss",
        sessionId: "session-background-headless-loss",
        bridge,
        background: true,
        onActivatedHeadless,
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-background-headless-loss-register",
      registrationId: "reg-background-headless-loss",
      sessionId: "session-background-headless-loss",
      tabId: "tab-background-headless-loss-minted",
    });
    await Promise.resolve();

    expect(
      handleElectronBrowserTabFrame({
        kind: "electronTabRegistrationFailed",
        hasBinaryPayload: false,
        requestId: "req-background-headless-loss",
        registrationId: "reg-background-headless-loss",
        sessionId: "session-background-headless-loss",
        // Host reports the pre-registration/request tab id. The Desktop
        // record is already rebound to the host-minted id, so release must
        // resolve by the exact tile key instead of this runtime mismatch.
        tabId: "tab-background-headless-loss-source",
        code: "BROWSER_TAB_ACTIVATED_HEADLESS",
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);
    await Promise.resolve();

    expect(
      findElectronBrowserTabBinding(
        "session-background-headless-loss",
        "tab-background-headless-loss",
      ),
    ).toBeNull();
    expect(bridge.releaseDurableTabCalls).toEqual([
      {
        ...TILE_KEY,
        sessionId: "session-background-headless-loss",
        tabId: "tab-background-headless-loss-source",
      },
    ]);
    expect(onActivatedHeadless).toHaveBeenCalledWith(
      "tab-background-headless-loss-source",
    );
  });
});

describe("electron-browser-tab-store focus/MRU viewed (ticket 13)", () => {
  afterEach(() => {
    resetElectronBrowserTabStoreForTests();
  });

  async function registerMintedTab(input: {
    readonly bridge: FakeBridge;
    readonly registrationId: string;
    readonly sessionId: string;
    readonly tabId: string;
    readonly tileKey?: BrowserViewTileKey;
  }): Promise<void> {
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: input.registrationId,
        sessionId: input.sessionId,
        bridge: input.bridge,
        tileKey: input.tileKey ?? {
          ...TILE_KEY,
          tileInstanceId: input.registrationId,
          pageSessionId: input.sessionId,
        },
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: `req-${input.registrationId}`,
      registrationId: input.registrationId,
      sessionId: input.sessionId,
      tabId: input.tabId,
    });
    await Promise.resolve();
    input.bridge.emitStatus({
      ...(input.tileKey ?? {
        ...TILE_KEY,
        tileInstanceId: input.registrationId,
        pageSessionId: input.sessionId,
      }),
      url: `https://app.example/${input.registrationId}`,
      title: input.registrationId,
      status: "ready",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });
  }

  function electronTabStateFrames(
    frames: readonly BrowserSessionsClientFrame[],
  ): BrowserSessionsClientFrame[] {
    return frames.filter((frame) => frame.kind === "electronTabState");
  }

  it("keeps at most one viewed tab per epic+host across regular and agent registrations", async () => {
    const regularBridge = new FakeBridge();
    const agentBridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    await registerMintedTab({
      bridge: regularBridge,
      registrationId: "reg-regular",
      sessionId: "session-regular",
      tabId: "tab-regular",
    });
    await registerMintedTab({
      bridge: agentBridge,
      registrationId: "reg-agent",
      sessionId: "session-agent",
      tabId: "tab-agent",
    });
    frames.length = 0;

    updateElectronBrowserTabView({
      sessionId: "session-regular",
      registrationId: "reg-regular",
      visible: true,
      focused: false,
    });
    expect(electronTabStateFrames(frames)).toEqual([
      expect.objectContaining({
        sessionId: "session-regular",
        tabId: "tab-regular",
        viewed: true,
      }),
    ]);
    frames.length = 0;

    updateElectronBrowserTabView({
      sessionId: "session-regular",
      registrationId: "reg-regular",
      visible: true,
      focused: true,
    });
    frames.length = 0;

    updateElectronBrowserTabView({
      sessionId: "session-agent",
      registrationId: "reg-agent",
      visible: true,
      focused: true,
    });

    const states = electronTabStateFrames(frames);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "electronTabState",
          sessionId: "session-regular",
          tabId: "tab-regular",
          viewed: false,
        }),
        expect.objectContaining({
          kind: "electronTabState",
          sessionId: "session-agent",
          tabId: "tab-agent",
          viewed: true,
        }),
      ]),
    );
    expect(
      states.filter(
        (frame) => frame.kind === "electronTabState" && frame.viewed,
      ),
    ).toHaveLength(1);
  });

  it("preserves MRU viewed when focus leaves browser tiles (non-browser focus)", async () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    await registerMintedTab({
      bridge,
      registrationId: "reg-1",
      sessionId: "session-1",
      tabId: "tab-1",
    });
    frames.length = 0;

    updateElectronBrowserTabView({
      sessionId: "session-1",
      registrationId: "reg-1",
      visible: true,
      focused: true,
    });
    expect(electronTabStateFrames(frames)).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        tabId: "tab-1",
        viewed: true,
      }),
    ]);
    frames.length = 0;

    // Pane loses focus to a chat/editor surface while the tile stays mounted.
    updateElectronBrowserTabView({
      sessionId: "session-1",
      registrationId: "reg-1",
      visible: true,
      focused: false,
    });
    expect(electronTabStateFrames(frames)).toEqual([]);

    // A later status publish still reports the MRU tile as viewed.
    bridge.emitStatus({
      ...TILE_KEY,
      tileInstanceId: "reg-1",
      pageSessionId: "session-1",
      url: "https://app.example/still-viewed",
      title: "Still viewed",
      status: "ready",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });
    expect(electronTabStateFrames(frames)).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        tabId: "tab-1",
        url: "https://app.example/still-viewed",
        viewed: true,
      }),
    ]);
  });

  it("hands viewed to the next MRU tile on close/unbind, or clears when none remain", async () => {
    const bridgeA = new FakeBridge();
    const bridgeB = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    await registerMintedTab({
      bridge: bridgeA,
      registrationId: "reg-a",
      sessionId: "session-a",
      tabId: "tab-a",
    });
    await registerMintedTab({
      bridge: bridgeB,
      registrationId: "reg-b",
      sessionId: "session-b",
      tabId: "tab-b",
    });

    updateElectronBrowserTabView({
      sessionId: "session-a",
      registrationId: "reg-a",
      visible: true,
      focused: true,
    });
    updateElectronBrowserTabView({
      sessionId: "session-b",
      registrationId: "reg-b",
      visible: true,
      focused: true,
    });
    frames.length = 0;

    // Unbind the currently viewed tile (effect cleanup / tile close).
    updateElectronBrowserTabView({
      sessionId: "session-b",
      registrationId: "reg-b",
      visible: false,
      focused: false,
    });
    expect(electronTabStateFrames(frames)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "electronTabState",
          sessionId: "session-b",
          tabId: "tab-b",
          viewed: false,
        }),
        expect.objectContaining({
          kind: "electronTabState",
          sessionId: "session-a",
          tabId: "tab-a",
          viewed: true,
        }),
      ]),
    );
    expect(
      electronTabStateFrames(frames).filter(
        (frame) => frame.kind === "electronTabState" && frame.viewed,
      ),
    ).toHaveLength(1);
    frames.length = 0;

    // Unbind the last remaining MRU tile - previous clears viewed; none remain.
    updateElectronBrowserTabView({
      sessionId: "session-a",
      registrationId: "reg-a",
      visible: false,
      focused: false,
    });
    expect(electronTabStateFrames(frames)).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        sessionId: "session-a",
        tabId: "tab-a",
        viewed: false,
      }),
    ]);
  });

  it("publishes viewed transitions only on the existing electronTabState path", async () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    await registerMintedTab({
      bridge,
      registrationId: "reg-1",
      sessionId: "session-1",
      tabId: "tab-1",
    });
    frames.length = 0;

    updateElectronBrowserTabView({
      sessionId: "session-1",
      registrationId: "reg-1",
      visible: true,
      focused: true,
    });

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.kind).toBe("electronTabState");
      if (frame.kind === "electronTabState") {
        expect(frame).toEqual(
          expect.objectContaining({
            registrationId: "reg-1",
            sessionId: "session-1",
            tabId: "tab-1",
            status: "ready",
            viewed: true,
          }),
        );
      }
    }
  });
});

describe("electron-browser-tab-store createElectronTab (ticket 14)", () => {
  const VIEW_TAB_ID = "view-create-electron";
  const CHAT_NODE_ID = "chat-node-create-electron";
  const SOURCE_BROWSER: BrowserTileRef = makeBrowserTileRef({
    name: "Source browser",
    hostId: HOST,
    url: "https://app.example/source",
    viewportPreset: "responsive",
  });

  function resetCanvas(): void {
    useEpicCanvasStore.setState({
      canvasByTabId: {},
      tabsById: {},
    });
  }



  afterEach(() => {
    resetElectronBrowserTabStoreForTests();
    resetCanvas();
  });

  it("applies background storage seed before creating the native tab", async () => {
    const bridge = new FakeBridge();
    const detachRoute = attachElectronBrowserBackgroundTabRoute(
      EPIC,
      HOST,
      bridge,
    );
    const seedStorageState = {
      cookies: [
        {
          name: "sid",
          value: "carried",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "token", value: "carried" }],
        },
      ],
    };

    expect(
      handleElectronBrowserTabFrame({
        kind: "createElectronTab",
        hasBinaryPayload: false,
        requestId: "req-background-seeded",
        sessionId: "session-background-seeded",
        sourceTabId: "tab-background-seeded",
        url: "https://example.com/background",
        background: true,
        epicId: EPIC,
        hostId: HOST,
        seedStorageState,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(bridge.backgroundOperations).toEqual(["apply", "create"]);
    });
    expect(bridge.storageApplyCalls).toEqual([
      {
        storageState: seedStorageState,
        sessionId: "session-background-seeded",
        tabId: "tab-background-seeded",
        purpose: "primary-profile-seed",
      },
    ]);
    expect(bridge.backgroundCreateCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-background-seeded",
        tabId: "tab-background-seeded",
        url: "https://example.com/background",
        seedStorageState,
      }),
    ]);

    detachRoute();
  });

  it("acks a seeded background create only after main-frame readiness", async () => {
    const bridge = new FakeBridge();
    let resolveCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    vi.spyOn(bridge, "createBackgroundTab").mockImplementation((input) => {
      bridge.backgroundOperations.push("create");
      bridge.backgroundCreateCalls.push(input);
      return committed;
    });
    const frames: BrowserSessionsClientFrame[] = [];
    const detachStream = attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    const detachRoute = attachElectronBrowserBackgroundTabRoute(
      EPIC,
      HOST,
      bridge,
    );
    const sessionId = "session-background-commit";
    const seedStorageState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "token", value: "carried" }],
        },
      ],
    };

    expect(
      handleElectronBrowserTabFrame({
        kind: "createElectronTab",
        hasBinaryPayload: false,
        requestId: "req-background-commit",
        sessionId,
        sourceTabId: "tab-source",
        url: "https://example.com/background",
        background: true,
        epicId: EPIC,
        hostId: HOST,
        seedStorageState,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(bridge.backgroundOperations).toEqual(["apply", "create"]);
    });
    expect(bridge.backgroundCreateCalls[0]).toEqual(
      expect.objectContaining({
        sessionId,
        tabId: "tab-source",
        url: "https://example.com/background",
        seedStorageState,
      }),
    );
    expect(frames.some((frame) => frame.kind === "electronTabCreated")).toBe(
      false,
    );

    const registration = frames.find(
      (frame) => frame.kind === "registerElectronTab",
    );
    expect(registration).toEqual(
      expect.objectContaining({
        kind: "registerElectronTab",
        sessionId,
        requestedTabId: "tab-source",
      }),
    );
    if (registration === undefined) {
      throw new Error("expected background registration frame");
    }
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-background-register",
      registrationId: registration.registrationId,
      sessionId,
      tabId: "tab-minted",
    });
    await Promise.resolve();
    expect(frames.some((frame) => frame.kind === "electronTabCreated")).toBe(
      false,
    );

    // The bridge promise represents the desktop main-frame commit. No
    // did-finish-load/full-load event is needed for the renderer ack.
    resolveCommitted();
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        kind: "electronTabCreated",
        hasBinaryPayload: false,
        requestId: "req-background-commit",
        sessionId,
        tabId: "tab-minted",
        reason: null,
      });
    });

    detachRoute();
    detachStream();
  });

  it("registers a background record before delayed desktop readiness, then releases a late ack", async () => {
    const bridge = new FakeBridge();
    let resolveCreation!: () => void;
    const creation = new Promise<void>((resolve) => {
      resolveCreation = resolve;
    });
    vi.spyOn(bridge, "createBackgroundTab").mockImplementation((input) => {
      bridge.backgroundOperations.push("create");
      bridge.backgroundCreateCalls.push(input);
      return creation;
    });
    const frames: BrowserSessionsClientFrame[] = [];
    const detachStream = attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    const detachRoute = attachElectronBrowserBackgroundTabRoute(
      EPIC,
      HOST,
      bridge,
    );
    const sessionId = "session-delayed-background";

    expect(
      handleElectronBrowserTabFrame({
        kind: "createElectronTab",
        hasBinaryPayload: false,
        requestId: "req-delayed-background",
        sessionId,
        sourceTabId: "tab-source",
        url: "https://example.com/delayed-background",
        background: true,
        epicId: EPIC,
        hostId: HOST,
        seedStorageState: null,
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(
        frames.some((frame) => frame.kind === "registerElectronTab"),
      ).toBe(true);
    });
    const registration = frames.find(
      (frame) => frame.kind === "registerElectronTab",
    );
    if (registration === undefined) {
      throw new Error("expected background registration frame");
    }
    const background = bridge.backgroundCreateCalls[0];

    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-delayed-background-register",
      registrationId: registration.registrationId,
      sessionId,
      tabId: "tab-minted",
    });
    await Promise.resolve();

    expect(findElectronBrowserTabBinding(sessionId, "tab-minted")).not.toBe(
      null,
    );
    expect(bridge.registerDurableTabCalls).toEqual([]);
    expect(frames.some((frame) => frame.kind === "electronTabCreated")).toBe(
      false,
    );

    resolveCreation();
    await vi.waitFor(() => {
      expect(bridge.registerDurableTabCalls).toEqual([
        expect.objectContaining({ sessionId, tabId: "tab-minted" }),
      ]);
      expect(frames).toContainEqual({
        kind: "electronTabCreated",
        hasBinaryPayload: false,
        requestId: "req-delayed-background",
        sessionId,
        tabId: "tab-minted",
        reason: null,
      });
    });

    expect(
      handleElectronBrowserTabFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: "req-late-release",
        sessionId,
        tabId: "tab-minted",
      } satisfies BrowserSessionsServerFrame),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(bridge.releaseDurableTabCalls).toEqual([
        {
          viewTabId: background.viewTabId,
          paneId: background.paneId,
          tileInstanceId: background.tileInstanceId,
          pageSessionId: background.pageSessionId,
          sessionId,
          tabId: "tab-minted",
        },
      ]);
    });
    expect(findElectronBrowserTabBinding(sessionId, "tab-minted")).toBeNull();

    detachRoute();
    detachStream();
  });

  function seedChatCanvas(): void {
    const base = createSingleTileCanvas(SOURCE_BROWSER);
    const pane = collectPanes(base.root).at(0);
    if (pane === undefined) throw new Error("expected a pane");
    const chatInstance = "chat-instance-1";
    const patchedPane = {
      ...pane,
      tabInstanceIds: [...pane.tabInstanceIds, chatInstance],
      activeTabId: chatInstance,
    };
    useEpicCanvasStore.setState({
      tabsById: {
        [VIEW_TAB_ID]: {
          tabId: VIEW_TAB_ID,
          epicId: EPIC,
          name: "Create electron",
        },
      },
      canvasByTabId: {
        [VIEW_TAB_ID]: {
          ...base,
          root: patchedPane,
          tilesByInstanceId: {
            ...base.tilesByInstanceId,
            [chatInstance]: {
              id: CHAT_NODE_ID,
              instanceId: chatInstance,
              type: "chat",
              name: "Chat",
              hostId: HOST,
            },
          },
        },
      },
    });
  }

  it("opens a session-addressed sibling into the chat canvas and acks after its own registration", async () => {
    seedChatCanvas();
    const siblingBridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });

    const handled = handleElectronBrowserTabFrame(
      {
        kind: "createElectronTab",
        hasBinaryPayload: false,
        requestId: "req-create-1",
        sessionId: "session-shared",
        sourceTabId: "tab-source-anchor",
        url: "https://example.com/agent",
        tabId: "tab-sibling-9",
      } satisfies BrowserSessionsServerFrame,
      { chatId: CHAT_NODE_ID },
    );
    expect(handled).toBe(true);

    expect(frames.some((frame) => frame.kind === "electronTabCreated")).toBe(
      false,
    );

    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (
      canvas === undefined ||
      canvas.root === null ||
      canvas.root.kind !== "pane"
    ) {
      throw new Error("expected single-pane canvas after createElectronTab");
    }
    const siblings = Object.values(canvas.tilesByInstanceId).filter(
      (tile): tile is AgentBrowserTileRef =>
        tile !== undefined &&
        "sessionId" in tile &&
        tile.sessionId === "session-shared" &&
        "tabId" in tile &&
        tile.tabId === "tab-sibling-9",
    );
    expect(siblings).toHaveLength(1);
    const [sibling] = siblings;
    expect(canvas.root.tabInstanceIds).toContain(sibling.instanceId);

    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-sibling",
        sessionId: "session-shared",
        bridge: siblingBridge,
        requestedTabId: "tab-sibling-9",
        tileKey: {
          viewTabId: VIEW_TAB_ID,
          paneId: canvas.root.id,
          tileInstanceId: sibling.instanceId,
          pageSessionId: "reg-sibling",
        },
        initialUrl: "https://example.com/agent",
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-create-1",
      registrationId: "reg-sibling",
      sessionId: "session-shared",
      tabId: "tab-sibling-9",
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual(
        expect.objectContaining({
          kind: "electronTabCreated",
          requestId: "req-create-1",
          sessionId: "session-shared",
          tabId: "tab-sibling-9",
          reason: null,
        }),
      );
    });
    expect(
      findElectronBrowserTabBinding("session-shared", "tab-sibling-9"),
    ).not.toBeNull();
  });

  it("acks null with a precise reason when the host omits the durable id", async () => {
    seedChatCanvas();
    const sourceBridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-anchor",
        sessionId: "session-shared",
        bridge: sourceBridge,
        tileKey: {
          viewTabId: VIEW_TAB_ID,
          paneId: "anchor-pane",
          tileInstanceId: SOURCE_BROWSER.instanceId,
          pageSessionId: "reg-anchor",
        },
        initialUrl: "https://app.example/source",
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-anchor-mint",
      registrationId: "reg-anchor",
      sessionId: "session-shared",
      tabId: "tab-anchor-1",
    });
    frames.length = 0;

    const handled = handleElectronBrowserTabFrame({
      kind: "createElectronTab",
      hasBinaryPayload: false,
      requestId: "req-no-id",
      sessionId: "session-shared",
      sourceTabId: "tab-anchor-1",
      url: "https://example.com/agent",
    } satisfies BrowserSessionsServerFrame);
    expect(handled).toBe(true);
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: "electronTabCreated",
        requestId: "req-no-id",
        sessionId: "session-shared",
        tabId: null,
        reason: expect.stringContaining("durable tab id"),
      }),
    );
  });
});

describe("electron-browser-tab-store agent surfacing dispositions", () => {
  const VIEW_TAB_ID_SURFACING = "view-surfacing";
  const SOURCE_BROWSER_SURFACING: BrowserTileRef = makeBrowserTileRef({
    name: "Source browser",
    hostId: HOST,
    url: "https://app.example/source",
    viewportPreset: "responsive",
  });

  function seedSourcePaneSurfacing(): {
    readonly paneId: string;
    readonly tileKey: BrowserViewTileKey;
  } {
    const canvas = createSingleTileCanvas(SOURCE_BROWSER_SURFACING);
    const pane = collectPanes(canvas.root).at(0);
    if (pane === undefined) throw new Error("expected a pane");
    useEpicCanvasStore.setState({
      tabsById: {
        [VIEW_TAB_ID_SURFACING]: {
          tabId: VIEW_TAB_ID_SURFACING,
          epicId: EPIC,
          name: "Surfacing",
        },
      },
      canvasByTabId: { [VIEW_TAB_ID_SURFACING]: canvas },
    });
    return {
      paneId: pane.id,
      tileKey: {
        viewTabId: VIEW_TAB_ID_SURFACING,
        paneId: pane.id,
        tileInstanceId: SOURCE_BROWSER_SURFACING.instanceId,
        pageSessionId: SOURCE_BROWSER_SURFACING.id,
      },
    };
  }

  afterEach(() => {
    resetElectronBrowserTabStoreForTests();
    resetAgentTabSurfacingForTests();
    useSettingsStore.setState({ agentTabSurfacingMode: "off" });
    vi.restoreAllMocks();
  });

  it("answers an off-mode foreground create with a hidden view and a successful ack", async () => {
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    attachElectronBrowserBackgroundTabRoute(EPIC, HOST, bridge);
    const { tileKey } = seedSourcePaneSurfacing();
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-off-source",
        sessionId: "session-off",
        bridge,
        tileKey,
        initialUrl: "https://app.example/source",
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-off-source-mint",
      registrationId: "reg-off-source",
      sessionId: "session-off",
      tabId: "tab-off-source",
    });
    await Promise.resolve();
    frames.length = 0;
    const canvasBefore =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID_SURFACING];
    const panesBefore =
      canvasBefore === undefined || canvasBefore.root === null
        ? 0
        : collectPanes(canvasBefore.root).length;

    const handled = handleElectronBrowserTabFrame({
      kind: "createElectronTab",
      hasBinaryPayload: false,
      requestId: "req-off-create",
      sessionId: "session-off",
      sourceTabId: "tab-off-source",
      url: "https://example.com/hidden",
      tabId: "tab-off-hidden",
      epicId: EPIC,
      hostId: HOST,
    } satisfies BrowserSessionsServerFrame);
    expect(handled).toBe(true);

    // Hidden view created off-screen; the canvas layout is untouched.
    await vi.waitFor(() => {
      expect(bridge.backgroundCreateCalls).toHaveLength(1);
    });
    expect(bridge.backgroundCreateCalls[0].url).toBe("https://example.com/hidden");
    expect(bridge.backgroundCreateCalls[0].viewTabId).toBe("background");
    const canvasAfter =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID_SURFACING];
    const panesAfter =
      canvasAfter === undefined || canvasAfter.root === null
        ? 0
        : collectPanes(canvasAfter.root).length;
    expect(panesAfter).toBe(panesBefore);

    // Under the pre-mint contract the hidden view registers claiming the
    // host-minted id carried on the create frame.
    const registration = frames.find(
      (frame) => frame.kind === "registerElectronTab",
    );
    expect(registration).toBeDefined();
    if (registration?.kind !== "registerElectronTab") {
      throw new Error("expected registerElectronTab frame");
    }
    expect(registration.requestedTabId).toBe("tab-off-hidden");

    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: registration.requestId,
      registrationId: registration.registrationId,
      sessionId: "session-off",
      tabId: "tab-off-hidden",
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual(
        expect.objectContaining({
          kind: "electronTabCreated",
          requestId: "req-off-create",
          sessionId: "session-off",
          tabId: "tab-off-hidden",
          reason: null,
        }),
      );
    });
  });

  it("groups a tile-mode foreground create into the session's existing pane without splitting", async () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "tile" });
    const bridge = new FakeBridge();
    attachElectronBrowserTabStream(EPIC, HOST, () => {});
    // The source pane hosts an AGENT tile of this session, so grouping applies.
    const agentSourceTile = makeAgentBrowserTileRef({
      name: "Agent source",
      hostId: HOST,
      url: "https://app.example/source",
      sessionId: "session-group",
      viewportPreset: DEFAULT_AGENT_BROWSER_VIEWPORT_PRESET,
      runtime: "isolated",
    });
    const canvas = createSingleTileCanvas(agentSourceTile);
    const pane = collectPanes(canvas.root).at(0);
    if (pane === undefined) throw new Error("expected a pane");
    useEpicCanvasStore.setState({
      tabsById: {
        [VIEW_TAB_ID_SURFACING]: {
          tabId: VIEW_TAB_ID_SURFACING,
          epicId: EPIC,
          name: "Surfacing",
        },
      },
      canvasByTabId: { [VIEW_TAB_ID_SURFACING]: canvas },
    });
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-group-source",
        sessionId: "session-group",
        bridge,
        tileKey: {
          viewTabId: VIEW_TAB_ID_SURFACING,
          paneId: pane.id,
          tileInstanceId: agentSourceTile.instanceId,
          pageSessionId: agentSourceTile.id,
        },
        initialUrl: "https://app.example/source",
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-group-source-mint",
      registrationId: "reg-group-source",
      sessionId: "session-group",
      tabId: "tab-group-source",
    });
    await Promise.resolve();

    const handled = handleElectronBrowserTabFrame({
      kind: "createElectronTab",
      hasBinaryPayload: false,
      requestId: "req-group-create",
      sessionId: "session-group",
      sourceTabId: "tab-group-source",
      url: "https://example.com/grouped",
      tabId: "tab-group-new",
      epicId: EPIC,
      hostId: HOST,
    } satisfies BrowserSessionsServerFrame);

    expect(handled).toBe(true);
    const nextCanvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID_SURFACING];
    if (nextCanvas === undefined || nextCanvas.root === null) {
      throw new Error("expected canvas");
    }
    // No split: the grouped tab lands in the anchor pane itself.
    expect(collectPanes(nextCanvas.root)).toHaveLength(1);
    const anchorPane = collectPanes(nextCanvas.root).find(
      (candidate) => candidate.id === pane.id,
    );
    expect(anchorPane?.tabInstanceIds).toHaveLength(2);
    expect(nextCanvas.activePaneId).toBe(pane.id);
  });

  it("arms PiP for a pip-mode foreground create once the hidden view registers", async () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "pip" });
    setEpicSurfaceVisibility(EPIC, true);
    const bridge = new FakeBridge();
    const frames: BrowserSessionsClientFrame[] = [];
    attachElectronBrowserTabStream(EPIC, HOST, (frame) => {
      frames.push(frame);
    });
    attachElectronBrowserBackgroundTabRoute(EPIC, HOST, bridge);
    const { tileKey } = seedSourcePaneSurfacing();
    registerElectronBrowserTab(
      baseRegistration({
        registrationId: "reg-pip-source",
        sessionId: "session-pip",
        bridge,
        tileKey,
        initialUrl: "https://app.example/source",
      }),
    );
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: "req-pip-source-mint",
      registrationId: "reg-pip-source",
      sessionId: "session-pip",
      tabId: "tab-pip-source",
    });
    await Promise.resolve();
    frames.length = 0;

    const handled = handleElectronBrowserTabFrame({
      kind: "createElectronTab",
      hasBinaryPayload: false,
      requestId: "req-pip-create",
      sessionId: "session-pip",
      sourceTabId: "tab-pip-source",
      url: "https://example.com/floating",
      tabId: "tab-pip-hidden",
      epicId: EPIC,
      hostId: HOST,
    } satisfies BrowserSessionsServerFrame);
    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(bridge.backgroundCreateCalls).toHaveLength(1);
    });

    const registration = frames.find(
      (frame) => frame.kind === "registerElectronTab",
    );
    if (registration?.kind !== "registerElectronTab") {
      throw new Error("expected registerElectronTab frame");
    }
    handleElectronBrowserTabFrame({
      kind: "electronTabRegistered",
      hasBinaryPayload: false,
      requestId: registration.requestId,
      registrationId: registration.registrationId,
      sessionId: "session-pip",
      tabId: "tab-pip-hidden",
    });
    // onRegistered hands the host-minted durable tab to the PiP pipeline.
    await vi.waitFor(() => {
      expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
        sessionId: "session-pip",
        tabId: "tab-pip-hidden",
        origin: "agent",
      });
    });
    setEpicSurfaceVisibility(EPIC, false);
  });
});
