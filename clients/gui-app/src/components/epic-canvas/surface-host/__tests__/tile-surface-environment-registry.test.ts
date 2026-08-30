import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import {
  getTileSurfaceEnvironment,
  isTileSurfacePresented,
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
  retractTileSurfacePresentation,
  subscribeTileSurfaceEnvironment,
  type ReadyTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { MAX_RETAINED_TOP_LEVEL_SURFACES } from "@/stores/tabs/top-level-surface-retention";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";

function canvasWithChat(instanceId: string): EpicCanvasState {
  return {
    root: pane("p1", [instanceId]),
    activePaneId: "p1",
    tilesByInstanceId: {
      [instanceId]: {
        id: instanceId,
        instanceId,
        type: "chat",
        name: "Chat",
        hostId: TEST_HOST_ID,
      },
    },
    sizesByGroupId: {},
  };
}

function seedMember(instanceId: string, tabId: string): void {
  useEpicCanvasStore.setState({
    tabsById: { [tabId]: { tabId, epicId: tabId, name: tabId } },
    canvasByTabId: { [tabId]: canvasWithChat(instanceId) },
    openTabOrder: [tabId],
    activeTabId: tabId,
  });
  const ref: TabRef = { kind: "epic", id: tabId };
  useTabsStore.setState((state) => ({
    ...state,
    items: [{ kind: "tab" as const, id: `tab:${ref.kind}:${ref.id}`, ref }],
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: [ref],
  }));
}

function environment(
  overrides: Partial<ReadyTileSurfaceEnvironment>,
): ReadyTileSurfaceEnvironment {
  return {
    identity: {
      instanceId: "chat-1",
      tileKind: "chat",
      contentId: "chat-1",
      epicId: "tab-1",
      hostId: TEST_HOST_ID,
    },
    placement: {
      epicId: "tab-1",
      viewTabId: "tab-1",
      paneId: "p1",
      hostId: TEST_HOST_ID,
    },
    presentation: { topLevelVisible: true, topLevelFocused: false },
    canvasActivity: { tabSelected: true, canvasPaneActive: false },
    paneActivation: {
      focusIntent: {
        mark: () => undefined,
        shouldYieldAutoFocus: () => false,
      },
    },
    services: {
      // Slice 2 has no real session wiring yet - a synthetic handle is the
      // deliberate fixture seam the design calls for (real host/session
      // integration is slice 5).
      openEpicHandle:
        {} as ReadyTileSurfaceEnvironment["services"]["openEpicHandle"],
      hostClient: null,
      geometryAnchorElement: document.createElement("div"),
      panePortalContainer: null,
      isPaneFocusedNow: () => false,
    },
    ...overrides,
  };
}

function resetAll(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
}

describe("tile surface environment registry", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("reads null (dormant) for a member with no published environment yet", () => {
    seedMember("chat-1", "tab-1");
    expect(getTileSurfaceEnvironment("chat-1")).toBeNull();
  });

  it("reads null for a non-member instance", () => {
    expect(getTileSurfaceEnvironment("never-a-member")).toBeNull();
  });

  it("keeps the requested registry key when a synthetic identity override disagrees", () => {
    const synthetic = buildSyntheticTileSurfaceEnvironment("chat-1", {
      identity: {
        instanceId: "mismatched-instance",
        tileKind: "chat",
        contentId: "chat-content",
        epicId: "epic-1",
        hostId: TEST_HOST_ID,
      },
    });

    expect(synthetic.identity.instanceId).toBe("chat-1");
    expect(synthetic.identity.contentId).toBe("chat-content");
  });

  it("publishes a ready environment for a current member and notifies its subscribers", () => {
    seedMember("chat-1", "tab-1");
    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    publishTileSurfaceEnvironment(environment({}));

    expect(notifications).toBe(1);
    expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();
    unsubscribe();
  });

  it("drops a publish for an instance that is not currently a member", () => {
    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    publishTileSurfaceEnvironment(environment({}));

    expect(notifications).toBe(0);
    expect(getTileSurfaceEnvironment("chat-1")).toBeNull();
    unsubscribe();
  });

  it("a repeated stale unsubscribe cannot delete a newer listener set", () => {
    seedMember("chat-1", "tab-1");
    const unsubscribeStale = subscribeTileSurfaceEnvironment(
      "chat-1",
      () => {},
    );
    unsubscribeStale();

    let notifications = 0;
    const unsubscribeCurrent = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });
    onTestFinished(unsubscribeCurrent);

    unsubscribeStale();
    publishTileSurfaceEnvironment(environment({}));

    expect(notifications).toBe(1);
  });

  it("retains the last valid environment across a structural transfer (no round-trip through null)", () => {
    seedMember("chat-1", "tab-1");
    const first = environment({
      placement: {
        epicId: "tab-1",
        viewTabId: "tab-1",
        paneId: "p1",
        hostId: TEST_HOST_ID,
      },
    });
    publishTileSurfaceEnvironment(first);
    expect(getTileSurfaceEnvironment("chat-1")).toBe(first);

    // Simulate a structural move: the tile stays a member (instanceId
    // unchanged) while its owning pane changes underneath it - the source
    // slot goes quiet (no unregister call exists; see the module doc) and
    // the destination slot has not published yet.
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": {
          ...canvasWithChat("chat-1"),
          root: pane("p2", ["chat-1"]),
          activePaneId: "p2",
        },
      },
    }));

    expect(getTileSurfaceEnvironment("chat-1")).toBe(first);

    const second = environment({
      placement: {
        epicId: "tab-1",
        viewTabId: "tab-1",
        paneId: "p2",
        hostId: TEST_HOST_ID,
      },
    });
    publishTileSurfaceEnvironment(second);
    expect(getTileSurfaceEnvironment("chat-1")).toBe(second);
  });

  it("retracting presentation lowers tabSelected without clearing the record or re-creating its services", () => {
    seedMember("chat-1", "tab-1");
    const published = environment({});
    publishTileSurfaceEnvironment(published);
    expect(isTileSurfacePresented(getTileSurfaceEnvironment("chat-1"))).toBe(
      true,
    );

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    retractTileSurfacePresentation(
      "chat-1",
      published.services.geometryAnchorElement,
    );

    const after = getTileSurfaceEnvironment("chat-1");
    if (after === null) throw new Error("expected the record to be retained");
    expect(isTileSurfacePresented(after)).toBe(false);
    expect(notifications).toBe(1);
    // The continuity guarantee is untouched: same identity, same placement,
    // and the SAME services object (by reference) the source slot published.
    expect(after.identity).toBe(published.identity);
    expect(after.placement).toBe(published.placement);
    expect(after.services).toBe(published.services);
    expect(after.presentation).toBe(published.presentation);
    // A fresh object, so a `useSyncExternalStore` reader actually re-renders
    // rather than bailing out on an identity-equal snapshot.
    expect(after).not.toBe(published);
    unsubscribe();
  });

  it("a slot can only retract its OWN publish: an anchor the record no longer carries is a no-op", () => {
    seedMember("chat-1", "tab-1");
    const sourceAnchor = document.createElement("div");
    publishTileSurfaceEnvironment(
      environment({
        services: {
          openEpicHandle:
            {} as ReadyTileSurfaceEnvironment["services"]["openEpicHandle"],
          hostClient: null,
          geometryAnchorElement: sourceAnchor,
          panePortalContainer: null,
          isPaneFocusedNow: () => false,
        },
      }),
    );
    // The destination slot publishes for the same instance BEFORE the source
    // slot tears down - the cross-commit transfer ordering. The source's
    // teardown must not conceal the live record.
    const destination = environment({});
    publishTileSurfaceEnvironment(destination);

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    retractTileSurfacePresentation("chat-1", sourceAnchor);

    expect(getTileSurfaceEnvironment("chat-1")).toBe(destination);
    expect(isTileSurfacePresented(getTileSurfaceEnvironment("chat-1"))).toBe(
      true,
    );
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("the source-first transfer gap is bounded by the destination publish, not by a frame", async () => {
    seedMember("chat-1", "tab-1");
    const source = environment({});
    publishTileSurfaceEnvironment(source);

    // Source tears down before any destination has published - the accepted
    // gap. The record is RETAINED (still non-null, still a member) but stops
    // claiming the rect.
    retractTileSurfacePresentation(
      "chat-1",
      source.services.geometryAnchorElement,
    );
    expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    expect(isTileSurfacePresented(getTileSurfaceEnvironment("chat-1"))).toBe(
      false,
    );

    // Elapsed time does not end the gap: nothing in the registry schedules or
    // bounds the recovery. Only the destination's own publish does - which is
    // why the bound is "until the destination publishes", not "one frame".
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isTileSurfacePresented(getTileSurfaceEnvironment("chat-1"))).toBe(
      false,
    );

    publishTileSurfaceEnvironment(environment({}));
    expect(isTileSurfacePresented(getTileSurfaceEnvironment("chat-1"))).toBe(
      true,
    );
  });

  it("retracting an already-unpresented or unknown record notifies nobody", () => {
    seedMember("chat-1", "tab-1");
    const published = environment({});
    publishTileSurfaceEnvironment(published);
    const anchor = published.services.geometryAnchorElement;
    retractTileSurfacePresentation("chat-1", anchor);

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    retractTileSurfacePresentation("chat-1", anchor);
    retractTileSurfacePresentation("never-a-member", anchor);

    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("removes the record and notifies only on membership loss, never mid-transfer", () => {
    seedMember("chat-1", "tab-1");
    publishTileSurfaceEnvironment(environment({}));
    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": {
          root: null,
          activePaneId: null,
          tilesByInstanceId: {},
          sizesByGroupId: {},
        },
      },
    }));

    expect(notifications).toBe(1);
    expect(getTileSurfaceEnvironment("chat-1")).toBeNull();
    unsubscribe();
  });

  it("isolates subscriptions per instance: publishing for B never notifies A's subscribers", () => {
    seedMember("chat-a", "tab-a");
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        "tab-b": { tabId: "tab-b", epicId: "tab-b", name: "tab-b" },
      },
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-b": canvasWithChat("chat-b"),
      },
      openTabOrder: [...state.openTabOrder, "tab-b"],
    }));
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        ...state.items,
        {
          kind: "tab" as const,
          id: "tab:epic:tab-b",
          ref: { kind: "epic" as const, id: "tab-b" },
        },
      ],
      // Becomes active so layer 2 (never-yet-active tabs are not retained;
      // see the membership suite) treats it as an eligible member too.
      activeItemId: "tab:epic:tab-b",
      stripOrder: [...state.stripOrder, { kind: "epic" as const, id: "tab-b" }],
    }));

    let notificationsA = 0;
    let notificationsB = 0;
    const unsubA = subscribeTileSurfaceEnvironment("chat-a", () => {
      notificationsA += 1;
    });
    const unsubB = subscribeTileSurfaceEnvironment("chat-b", () => {
      notificationsB += 1;
    });

    publishTileSurfaceEnvironment(
      environment({
        identity: {
          instanceId: "chat-b",
          tileKind: "chat",
          contentId: "chat-b",
          epicId: "tab-b",
          hostId: TEST_HOST_ID,
        },
      }),
    );

    expect(notificationsB).toBe(1);
    expect(notificationsA).toBe(0);
    unsubA();
    unsubB();
  });

  it("updates in place on a second publish for the same still-a-member instanceId", () => {
    seedMember("chat-1", "tab-1");
    const first = environment({
      presentation: { topLevelVisible: true, topLevelFocused: false },
    });
    const second = environment({
      presentation: { topLevelVisible: true, topLevelFocused: true },
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    publishTileSurfaceEnvironment(first);
    expect(getTileSurfaceEnvironment("chat-1")).toBe(first);
    expect(notifications).toBe(1);

    publishTileSurfaceEnvironment(second);
    expect(getTileSurfaceEnvironment("chat-1")).toBe(second);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("clears a published environment when membership drops via top-level MRU eviction", () => {
    const ref0: TabRef = { kind: "epic", id: "epic-0" };
    const ref1: TabRef = { kind: "epic", id: "epic-1" };
    const ref2: TabRef = { kind: "epic", id: "epic-2" };
    const ref3: TabRef = { kind: "epic", id: "epic-3" };
    const ref4: TabRef = { kind: "epic", id: "epic-4" };
    const ref5: TabRef = { kind: "epic", id: "epic-5" };
    const refs = [ref0, ref1, ref2, ref3, ref4, ref5];

    useEpicCanvasStore.setState({
      tabsById: Object.fromEntries(
        refs.map((ref) => [
          ref.id,
          { tabId: ref.id, epicId: ref.id, name: ref.id },
        ]),
      ),
      canvasByTabId: Object.fromEntries(
        refs.map((ref) => [
          ref.id,
          {
            root: pane("p1", [`chat-${ref.id}`]),
            activePaneId: "p1",
            tilesByInstanceId: {
              [`chat-${ref.id}`]: {
                id: `chat-${ref.id}`,
                instanceId: `chat-${ref.id}`,
                type: "chat",
                name: `Chat ${ref.id}`,
                hostId: TEST_HOST_ID,
              },
            },
            sizesByGroupId: {},
          },
        ]),
      ),
      openTabOrder: refs.map((ref) => ref.id),
      activeTabId: ref0.id,
    });
    useTabsStore.setState((state) => ({
      ...state,
      items: refs.map((ref) => ({
        kind: "tab" as const,
        id: `tab:${ref.kind}:${ref.id}`,
        ref,
      })),
      activeItemId: `tab:${ref0.kind}:${ref0.id}`,
      stripOrder: refs,
    }));

    const doomedInstanceId = `chat-${ref0.id}`;
    expect(getTileSurfaceMembership().has(doomedInstanceId)).toBe(true);
    publishTileSurfaceEnvironment(
      environment({
        identity: {
          instanceId: doomedInstanceId,
          tileKind: "chat",
          contentId: doomedInstanceId,
          epicId: ref0.id,
          hostId: TEST_HOST_ID,
        },
      }),
    );
    expect(getTileSurfaceEnvironment(doomedInstanceId)).not.toBeNull();

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment(
      doomedInstanceId,
      () => {
        notifications += 1;
      },
    );

    // Walk recency through the remaining tabs so ref0 is the least-recently
    // active and is evicted once the retained cap is exceeded (same pattern
    // as the membership suite's eviction pin).
    for (const ref of [ref1, ref2, ref3, ref4, ref5]) {
      useTabsStore.setState((state) => ({
        ...state,
        activeItemId: `tab:${ref.kind}:${ref.id}`,
      }));
    }

    expect(getTileSurfaceMembership().has(doomedInstanceId)).toBe(false);
    expect(getTileSurfaceMembership().has(`chat-${ref5.id}`)).toBe(true);
    expect(
      refs.filter((ref) => getTileSurfaceMembership().has(`chat-${ref.id}`))
        .length,
    ).toBe(MAX_RETAINED_TOP_LEVEL_SURFACES);
    expect(getTileSurfaceEnvironment(doomedInstanceId)).toBeNull();
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("resetTileSurfaceEnvironmentRegistryForTesting clears environments and subscribers", () => {
    seedMember("chat-1", "tab-1");
    publishTileSurfaceEnvironment(environment({}));
    expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();

    let staleNotifications = 0;
    subscribeTileSurfaceEnvironment("chat-1", () => {
      staleNotifications += 1;
    });

    resetTileSurfaceEnvironmentRegistryForTesting();
    expect(getTileSurfaceEnvironment("chat-1")).toBeNull();

    // Re-seed membership and publish again for the same instanceId (fake
    // reincarnation). The pre-reset subscriber must not fire - the registry
    // dropped its listener map on reset.
    seedMember("chat-1", "tab-1");
    publishTileSurfaceEnvironment(environment({}));
    expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();
    expect(staleNotifications).toBe(0);
  });

  it("ReadyTileSurfaceEnvironment type-shape smoke: full object round-trips publish/get", () => {
    seedMember("chat-1", "tab-1");
    const portal = document.createElement("div");
    const isPaneFocusedNow = (): boolean => true;
    const full: ReadyTileSurfaceEnvironment = {
      identity: {
        instanceId: "chat-1",
        tileKind: "chat",
        contentId: "content-chat-1",
        epicId: "tab-1",
        hostId: TEST_HOST_ID,
      },
      placement: {
        epicId: "tab-1",
        viewTabId: "tab-1",
        paneId: "p1",
        hostId: TEST_HOST_ID,
      },
      presentation: {
        topLevelVisible: true,
        topLevelFocused: true,
      },
      canvasActivity: {
        tabSelected: true,
        canvasPaneActive: true,
      },
      paneActivation: {
        focusIntent: {
          mark: () => undefined,
          shouldYieldAutoFocus: () => false,
        },
      },
      services: {
        openEpicHandle:
          {} as ReadyTileSurfaceEnvironment["services"]["openEpicHandle"],
        hostClient: null,
        geometryAnchorElement: document.createElement("div"),
        panePortalContainer: portal,
        isPaneFocusedNow,
      },
    };

    publishTileSurfaceEnvironment(full);
    const got = getTileSurfaceEnvironment("chat-1");
    expect(got).toBe(full);
    expect(got).toEqual(full);
    if (got === null) throw new Error("expected published environment");
    expect(got.presentation.topLevelFocused).toBe(true);
    expect(got.canvasActivity.canvasPaneActive).toBe(true);
    expect(got.services.panePortalContainer).toBe(portal);
    expect(got.services.isPaneFocusedNow()).toBe(true);
  });

  it("design-review F2: clears an environment on its first removal even when membership was already populated at registry init", () => {
    seedMember("chat-1", "tab-1");
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    // Simulate the registry module initializing (or being reset) while
    // membership is already non-empty - the "normal shape" the review
    // flagged, since the canvas/tabs stores are synchronously hydrated
    // before this module's own module-load-time snapshot runs.
    resetTileSurfaceEnvironmentRegistryForTesting();

    publishTileSurfaceEnvironment(environment({}));
    expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();

    let notifications = 0;
    const unsubscribe = subscribeTileSurfaceEnvironment("chat-1", () => {
      notifications += 1;
    });

    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": {
          root: null,
          activePaneId: null,
          tilesByInstanceId: {},
          sizesByGroupId: {},
        },
      },
    }));

    expect(getTileSurfaceMembership().has("chat-1")).toBe(false);
    expect(getTileSurfaceEnvironment("chat-1")).toBeNull();
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("design-review F3: the record is always keyed by the environment's own identity.instanceId - no independent key parameter exists to disagree with it", () => {
    seedMember("chat-a", "tab-a");
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        "tab-b": { tabId: "tab-b", epicId: "tab-b", name: "tab-b" },
      },
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-b": canvasWithChat("chat-b"),
      },
      openTabOrder: [...state.openTabOrder, "tab-b"],
    }));
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        ...state.items,
        {
          kind: "tab" as const,
          id: "tab:epic:tab-b",
          ref: { kind: "epic" as const, id: "tab-b" },
        },
      ],
      activeItemId: "tab:epic:tab-b",
      stripOrder: [...state.stripOrder, { kind: "epic" as const, id: "tab-b" }],
    }));

    const envForA = environment({
      identity: {
        instanceId: "chat-a",
        tileKind: "chat",
        contentId: "chat-a",
        epicId: "tab-a",
        hostId: TEST_HOST_ID,
      },
    });
    const envForB = environment({
      identity: {
        instanceId: "chat-b",
        tileKind: "chat",
        contentId: "chat-b",
        epicId: "tab-b",
        hostId: TEST_HOST_ID,
      },
    });

    publishTileSurfaceEnvironment(envForA);
    publishTileSurfaceEnvironment(envForB);

    const gotA = getTileSurfaceEnvironment("chat-a");
    const gotB = getTileSurfaceEnvironment("chat-b");
    if (gotA === null || gotB === null) {
      throw new Error(
        "expected both instances to have a published environment",
      );
    }
    expect(gotA.identity.instanceId).toBe("chat-a");
    expect(gotB.identity.instanceId).toBe("chat-b");
    expect(gotA).not.toBe(gotB);
  });
});
