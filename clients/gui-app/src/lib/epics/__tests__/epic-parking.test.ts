import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEpicParkingForTests,
  isEpicParked,
  trackEpicParkingSurface,
} from "@/lib/epics/epic-parking";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";

/**
 * Plan C, decisions C1/C3/C6, ticket "renderer parking of hidden epic tabs".
 * Pins 2 and 3 - the "a second window keeps an epic in front" and "a tab
 * with unsynced edits/an active agent is not parked" rules - direct against
 * `lib/epics/epic-parking.ts` and the real `OpenEpicSessionRegistry`
 * singleton. Pin 1 (both timer arms, with the session/chat-lease/record-poll
 * release) and pin 4 (record-sync remount on show) live beside
 * `<EpicRouteSessionBody />`'s own suite; pin 4's session re-acquisition and
 * pin 5 [comment polling] live beside `<EpicSessionProvider />`'s.
 */

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildParkableEpicHandle(epicId: string, dirty: boolean) {
  const base = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  let disposed = false;
  const realDispose = base.dispose.bind(base);
  if (dirty) {
    base.store.setState({ isDirty: true });
  }
  return {
    handle: {
      ...base,
      get doc() {
        return base.doc;
      },
      get awareness() {
        return base.awareness;
      },
      get store() {
        return base.store;
      },
      dispose: () => {
        disposed = true;
        realDispose();
      },
      hotArtifactRoomIdsForTests: () => [],
      ...INERT_ROOT_STATE_PORT,
    },
    get disposed() {
      return disposed;
    },
  };
}

function markAgentWorking(epicId: string, agentId: string): void {
  publishAgentActivity([
    {
      hostId: "host-parking-tests",
      byEpic: { [epicId]: { working: [agentId], turn: [agentId] } },
    },
  ]);
}

describe("epic-parking - visibility roll-up (C6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    vi.useRealTimers();
  });

  it("never parks an epic that is visible in a second window", () => {
    // A dedicated epic id: `setEpicSurfaceVisibility`'s visible-view set
    // (`surface-host-opened-tab.ts`) is module state with no test reset, so a
    // shared id across tests would leak a `visible: true` view left behind by
    // a previous test's teardown into this one's roll-up.
    const EPIC = "epic-park-second-window-a";
    const viewA = "view-a";
    const viewB = "view-b";
    const unsubA = trackEpicParkingSurface(EPIC, viewA);
    const unsubB = trackEpicParkingSurface(EPIC, viewB);
    try {
      // Window A is the epic's only pane, and it is hidden from birth (e.g.
      // the tab was opened in the background) - this arms the park window.
      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      // A second window shows the SAME epic before the window elapses - the
      // roll-up is visible-if-any, so this must cancel the pending park.
      setEpicSurfaceVisibility(EPIC, viewB, true);
      vi.advanceTimersByTime(60_000 + PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      // The first window's own visibility flag never changed - going hidden
      // in the SECOND window while the first stays visible must not arm a
      // window either.
      setEpicSurfaceVisibility(EPIC, viewB, false);
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      unsubA();
      unsubB();
    }
  });

  it("parks once the LAST visible window of the epic goes hidden", () => {
    const EPIC = "epic-park-second-window-b";
    const viewA = "view-a-last";
    const viewB = "view-b-last";
    const unsubA = trackEpicParkingSurface(EPIC, viewA);
    const unsubB = trackEpicParkingSurface(EPIC, viewB);
    try {
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      // Now the only remaining visible pane hides too - the roll-up finally
      // reads "no visible pane anywhere", so the window starts here.
      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1);
      expect(isEpicParked(EPIC)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      unsubA();
      unsubB();
    }
  });
});

describe("epic-parking - eligibility (C1, prune's own gates)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAgentActivity();
    vi.useRealTimers();
  });

  it("does not park a tab with unsynced edits", () => {
    const EPIC = "epic-park-dirty";
    const dirty = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => dirty.handle);

    const unsub = trackEpicParkingSurface(EPIC, "view-dirty");
    try {
      setEpicSurfaceVisibility(EPIC, "view-dirty", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(dirty.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      unsub();
    }
  });

  it("does not park a tab with an active agent turn", () => {
    const EPIC = "epic-park-busy";
    const busy = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => busy.handle);
    markAgentWorking(EPIC, "agent-1");

    const unsub = trackEpicParkingSurface(EPIC, "view-busy");
    try {
      setEpicSurfaceVisibility(EPIC, "view-busy", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(busy.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      unsub();
    }
  });

  it("parks a formerly-dirty tab once its edits settle, without a fresh hidden window", () => {
    const EPIC = "epic-park-settles";
    const th = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => th.handle);

    const unsub = trackEpicParkingSurface(EPIC, "view-settles");
    try {
      setEpicSurfaceVisibility(EPIC, "view-settles", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      // The edits sync: the registry's own subscription fires, and the
      // parking module's eligibility watch (armed on the earlier refusal)
      // retries without waiting for another 5-minute window.
      th.handle.store.setState({
        ...th.handle.store.getState(),
        isDirty: false,
      });

      expect(isEpicParked(EPIC)).toBe(true);
      expect(th.disposed).toBe(true);
    } finally {
      unsub();
    }
  });
});
