import { beforeEach, describe, expect, it } from "vitest";
import {
  landingPanelLayoutFor,
  landingTabRefKey,
  parseLandingPanelTabRef,
  parsePersistedLandingPanelState,
  useLandingPanelStore,
  type LandingBrowserTabRef,
  type LandingPanelTabRef,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";

const HOST_A = "host-a";
const HOST_B = "host-b";
const LANDING_PAGE_ID = "landing-page";
const BROWSER_SESSION_A = "browser-session-a";

function terminalTab(input: {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
}): LandingTerminalTabRef {
  return {
    kind: "terminal",
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    hostId: input.hostId,
    cwd: "/workspace/project",
    name: "project",
    titleSource: "default",
  };
}

function browserTab(input: {
  readonly instanceId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): LandingBrowserTabRef {
  return {
    kind: "browser",
    instanceId: input.instanceId,
    hostId: input.hostId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    name: "example.com",
    titleSource: "default",
  };
}

/** The persist round trip the store actually performs on reload. */
function persistRoundTrip(
  tabs: ReadonlyArray<LandingPanelTabRef>,
): ReadonlyArray<LandingPanelTabRef> {
  return parsePersistedLandingPanelState(
    JSON.parse(JSON.stringify({ tabs, activeInstanceId: null })),
  ).tabs;
}

function instanceIds(
  tabs: ReadonlyArray<LandingPanelTabRef>,
): readonly string[] {
  return tabs.map((tab) => tab.instanceId);
}

beforeEach(() => {
  useLandingPanelStore.getState().resetForTests();
});

describe("landingTabRefKey", () => {
  it("distinguishes two browser tabs that share one device session", () => {
    // The constraint the whole mixed panel rests on: browser tabs on a device
    // share ONE independent session, so a host+session key would name the
    // device rather than the tab.
    const first = browserTab({
      instanceId: "instance-1",
      hostId: HOST_A,
      sessionId: BROWSER_SESSION_A,
      tabId: "tab-1",
    });
    const second = browserTab({
      instanceId: "instance-2",
      hostId: HOST_A,
      sessionId: BROWSER_SESSION_A,
      tabId: "tab-2",
    });
    expect(landingTabRefKey(first)).not.toBe(landingTabRefKey(second));
  });

  it("keys a tab ref and its tombstone identically", () => {
    const tab = browserTab({
      instanceId: "instance-1",
      hostId: HOST_A,
      sessionId: BROWSER_SESSION_A,
      tabId: "tab-1",
    });
    useLandingPanelStore.getState().addTab(tab);
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-1");
    const [pending] = useLandingPanelStore.getState().pendingKills;
    expect(landingTabRefKey(pending)).toBe(landingTabRefKey(tab));
  });

  it("separates a terminal from a browser tab with the same ids", () => {
    expect(
      landingTabRefKey({
        kind: "terminal",
        hostId: HOST_A,
        sessionId: "shared-id",
      }),
    ).not.toBe(
      landingTabRefKey({
        kind: "browser",
        hostId: HOST_A,
        sessionId: "shared-id",
        tabId: "shared-id",
      }),
    );
  });
});

describe("tolerant parse", () => {
  it("reads a legacy ref with no kind as a terminal", () => {
    const parsed = parseLandingPanelTabRef({
      instanceId: "instance-1",
      sessionId: "session-1",
      hostId: HOST_A,
      cwd: "/workspace/project",
      name: "project",
      titleSource: "manual",
    });
    expect(parsed).toEqual({
      kind: "terminal",
      instanceId: "instance-1",
      sessionId: "session-1",
      hostId: HOST_A,
      cwd: "/workspace/project",
      name: "project",
      titleSource: "manual",
    });
  });

  it("reads a legacy tombstone with no kind as a terminal", () => {
    const [pending] = parsePersistedLandingPanelState({
      pendingKills: [
        {
          hostId: HOST_A,
          sessionId: "session-1",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        },
      ],
    }).pendingKills;
    expect(pending).toEqual({
      kind: "terminal",
      hostId: HOST_A,
      sessionId: "session-1",
      hostAuthorityAcknowledged: true,
      pendingCreate: false,
    });
  });

  it("drops a browser ref that carries no tab id", () => {
    expect(
      parseLandingPanelTabRef({
        kind: "browser",
        instanceId: "instance-1",
        sessionId: BROWSER_SESSION_A,
        hostId: HOST_A,
        name: "example.com",
        titleSource: "default",
      }),
    ).toBeNull();
  });
});

describe("addTab and persistence", () => {
  it("keeps two browser tabs of one device through add and a persist round trip", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    store.addTab(
      browserTab({
        instanceId: "instance-2",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-2",
      }),
    );
    const added = useLandingPanelStore.getState().tabs;
    expect(instanceIds(added)).toEqual(["instance-1", "instance-2"]);
    expect(instanceIds(persistRoundTrip(added))).toEqual([
      "instance-1",
      "instance-2",
    ]);
  });

  it("still collapses a genuine duplicate of one browser tab", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    store.addTab(
      browserTab({
        instanceId: "instance-2",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "instance-1",
    ]);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("instance-1");
  });
});

describe("placeholder", () => {
  it("is never written to the persisted slot", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().openPlaceholder("placeholder-1", 1);
    expect(useLandingPanelStore.getState().placeholder).not.toBeNull();
    // The mechanism itself, not a round trip that would pass just as well if
    // `partialize` let the field through and the parser happened to drop it.
    const persisted = useLandingPanelStore.persist
      .getOptions()
      .partialize?.(useLandingPanelStore.getState());
    expect(persisted).not.toHaveProperty("placeholder");
  });

  it("is not restored by the tolerant parser either", () => {
    expect(
      parsePersistedLandingPanelState({
        placeholder: { instanceId: "placeholder-1", index: 0 },
      }),
    ).not.toHaveProperty("placeholder");
  });

  it("focuses the open one instead of stacking a second", () => {
    const store = useLandingPanelStore.getState();
    store.openPlaceholder("placeholder-1", 0);
    store.openPlaceholder("placeholder-2", 0);
    expect(useLandingPanelStore.getState().placeholder?.instanceId).toBe(
      "placeholder-1",
    );
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "placeholder-1",
    );
  });

  it("is activatable like any other strip row", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    store.openPlaceholder("placeholder-1", 1);
    useLandingPanelStore.getState().activateTab("instance-1");
    useLandingPanelStore.getState().activateTab("placeholder-1");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "placeholder-1",
    );
  });

  it("counts as a tab when closing the last real one, so the panel stays open", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().openPlaceholder("placeholder-1", 1);
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-1");
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(true);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "placeholder-1",
    );
  });

  it("collapses the panel when the last tab closes and no placeholder is open", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-1");
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(false);
  });

  it("collapses the panel when the placeholder is dismissed with nothing behind it", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    store.openPlaceholder("placeholder-1", 0);
    useLandingPanelStore.getState().dismissPlaceholder();
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(false);
    expect(useLandingPanelStore.getState().activeInstanceId).toBeNull();
  });
});

describe("fulfillPlaceholder", () => {
  it("puts the picked tab at the placeholder's position and activates it", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    store.addTab(
      terminalTab({
        instanceId: "instance-3",
        sessionId: "session-3",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().openPlaceholder("placeholder-1", 1);
    useLandingPanelStore.getState().fulfillPlaceholder(
      browserTab({
        instanceId: "instance-2",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "instance-1",
      "instance-2",
      "instance-3",
    ]);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("instance-2");
    expect(useLandingPanelStore.getState().placeholder).toBeNull();
  });

  it("appends when the placeholder was dismissed while the create was in flight", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().fulfillPlaceholder(
      terminalTab({
        instanceId: "instance-2",
        sessionId: "session-2",
        hostId: HOST_A,
      }),
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "instance-1",
      "instance-2",
    ]);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("instance-2");
  });

  it("clamps a placeholder index that outlived the tabs it pointed past", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
    );
    store.addTab(
      terminalTab({
        instanceId: "instance-2",
        sessionId: "session-2",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().openPlaceholder("placeholder-1", 2);
    // Both tabs vanish under the open chooser, so index 2 no longer exists.
    useLandingPanelStore
      .getState()
      .applyReconciliationSlice(HOST_A, "terminal", [], true);
    useLandingPanelStore.getState().fulfillPlaceholder(
      terminalTab({
        instanceId: "instance-3",
        sessionId: "session-3",
        hostId: HOST_A,
      }),
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "instance-3",
    ]);
  });
});

describe("applyReconciliationSlice", () => {
  function seedMixedFleet(): void {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "a-term-1",
        sessionId: "a-session-1",
        hostId: HOST_A,
      }),
    );
    store.addTab(
      browserTab({
        instanceId: "a-browser-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    store.addTab(
      terminalTab({
        instanceId: "b-term-1",
        sessionId: "b-session-1",
        hostId: HOST_B,
      }),
    );
    store.addTab(
      browserTab({
        instanceId: "b-browser-1",
        hostId: HOST_B,
        sessionId: "browser-session-b",
        tabId: "tab-1",
      }),
    );
  }

  it("leaves browser refs on the same device and every ref on the other alone", () => {
    seedMixedFleet();
    useLandingPanelStore.getState().applyReconciliationSlice(
      HOST_A,
      "terminal",
      [
        terminalTab({
          instanceId: "a-term-2",
          sessionId: "a-session-2",
          hostId: HOST_A,
        }),
      ],
      true,
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "a-term-2",
      "a-browser-1",
      "b-term-1",
      "b-browser-1",
    ]);
  });

  it("leaves terminal refs alone when the browser slice is reconciled", () => {
    seedMixedFleet();
    useLandingPanelStore.getState().applyReconciliationSlice(
      HOST_A,
      "browser",
      [
        browserTab({
          instanceId: "a-browser-2",
          hostId: HOST_A,
          sessionId: BROWSER_SESSION_A,
          tabId: "tab-2",
        }),
      ],
      true,
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "a-term-1",
      "a-browser-2",
      "b-term-1",
      "b-browser-1",
    ]);
  });

  it("appends an adoption at the slice's last position, not the end of the list", () => {
    seedMixedFleet();
    useLandingPanelStore.getState().applyReconciliationSlice(
      HOST_A,
      "terminal",
      [
        terminalTab({
          instanceId: "a-term-1",
          sessionId: "a-session-1",
          hostId: HOST_A,
        }),
        terminalTab({
          instanceId: "a-term-2",
          sessionId: "a-session-2",
          hostId: HOST_A,
        }),
      ],
      true,
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "a-term-1",
      "a-term-2",
      "a-browser-1",
      "b-term-1",
      "b-browser-1",
    ]);
  });

  it("appends when the device has no tab of that kind yet", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      terminalTab({
        instanceId: "a-term-1",
        sessionId: "a-session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().applyReconciliationSlice(
      HOST_A,
      "browser",
      [
        browserTab({
          instanceId: "a-browser-1",
          hostId: HOST_A,
          sessionId: BROWSER_SESSION_A,
          tabId: "tab-1",
        }),
      ],
      true,
    );
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "a-term-1",
      "a-browser-1",
    ]);
  });

  it("does not collapse a panel whose chooser is open", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    store.addTab(
      terminalTab({
        instanceId: "a-term-1",
        sessionId: "a-session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore.getState().openPlaceholder("placeholder-1", 1);
    useLandingPanelStore
      .getState()
      .applyReconciliationSlice(HOST_A, "terminal", [], true);
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(true);
  });

  it("collapses an emptied panel with no chooser open", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    store.addTab(
      terminalTab({
        instanceId: "a-term-1",
        sessionId: "a-session-1",
        hostId: HOST_A,
      }),
    );
    useLandingPanelStore
      .getState()
      .applyReconciliationSlice(HOST_A, "terminal", [], true);
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(false);
  });

  it("leaves an already-empty panel open when the pass removed nothing", () => {
    const store = useLandingPanelStore.getState();
    store.setPanelOpen(LANDING_PAGE_ID, true);
    useLandingPanelStore
      .getState()
      .applyReconciliationSlice(HOST_A, "terminal", [], false);
    expect(
      landingPanelLayoutFor(useLandingPanelStore.getState(), LANDING_PAGE_ID)
        .panelOpen,
    ).toBe(true);
  });
});

describe("tombstones keyed by ref", () => {
  it("clears only the tombstone whose key matches", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    store.addTab(
      browserTab({
        instanceId: "instance-2",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-2",
      }),
    );
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-1");
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-2");
    expect(useLandingPanelStore.getState().pendingKills).toHaveLength(2);
    useLandingPanelStore.getState().clearPendingKill({
      kind: "browser",
      hostId: HOST_A,
      sessionId: BROWSER_SESSION_A,
      tabId: "tab-1",
    });
    expect(useLandingPanelStore.getState().pendingKills).toEqual([
      {
        kind: "browser",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-2",
      },
    ]);
  });

  it("copies terminal provenance off the closing tab", () => {
    useLandingPanelStore.getState().addTab({
      ...terminalTab({
        instanceId: "instance-1",
        sessionId: "session-1",
        hostId: HOST_A,
      }),
      hostAuthorityAcknowledged: true,
    });
    useLandingPanelStore.getState().closeTab(LANDING_PAGE_ID, "instance-1");
    expect(useLandingPanelStore.getState().pendingKills).toEqual([
      {
        kind: "terminal",
        hostId: HOST_A,
        sessionId: "session-1",
        hostAuthorityAcknowledged: true,
        pendingCreate: false,
      },
    ]);
  });

  it("does not let removeHostTerminal take a browser tab", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: "shared-id",
        tabId: "shared-id",
      }),
    );
    useLandingPanelStore.getState().removeHostTerminal(HOST_A, "shared-id");
    expect(instanceIds(useLandingPanelStore.getState().tabs)).toEqual([
      "instance-1",
    ]);
  });
});

describe("titles", () => {
  it("renames a browser tab and pins it manual", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    useLandingPanelStore.getState().renameTab("instance-1", "  Docs  ");
    useLandingPanelStore
      .getState()
      .syncDefaultTitle("instance-1", "example.com");
    const [tab] = useLandingPanelStore.getState().tabs;
    expect(tab).toEqual({
      kind: "browser",
      instanceId: "instance-1",
      hostId: HOST_A,
      sessionId: BROWSER_SESSION_A,
      tabId: "tab-1",
      name: "Docs",
      titleSource: "manual",
    });
  });

  it("syncs a browser tab's default title", () => {
    const store = useLandingPanelStore.getState();
    store.addTab(
      browserTab({
        instanceId: "instance-1",
        hostId: HOST_A,
        sessionId: BROWSER_SESSION_A,
        tabId: "tab-1",
      }),
    );
    useLandingPanelStore.getState().syncDefaultTitle("instance-1", "Example");
    const [tab] = useLandingPanelStore.getState().tabs;
    expect(tab.name).toBe("Example");
    expect(tab.titleSource).toBe("default");
  });
});
