import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";

/**
 * `useEpicPinLocalHomeSupported` reads `useHostClient()`, which throws
 * outside a `<HostRuntimeProvider>` - this suite renders the menu with none.
 * Mocked at the module boundary rather than standing up a provider: every
 * other test in this file is about the pin GUARD, not the host negotiation,
 * and a hoisted flag lets each case say what the negotiated manifest would
 * have answered without dragging in a messenger/registry harness.
 */
const pinSupportState = vi.hoisted(() => ({ supported: false }));
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: (): boolean => pinSupportState.supported,
}));

const EPIC_TAB: Extract<HeaderTab, { kind: "epic" }> = {
  kind: "epic",
  id: "epic-orphan",
  epicId: "epic-orphan",
  hostId: null,
  route: "/epics/epic-orphan",
  name: "Preserved orphan",
  icon: null,
  canClose: true,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function createPausedEpicHandle(epicId: string, retained: boolean) {
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handle.store.setState(
    retained
      ? {
          retainedDurabilityPauseReason:
            "orphaned-local-edits-after-cloud-delete",
        }
      : {
          durabilityPauseReason: "orphaned-local-edits-after-cloud-delete",
        },
  );
  return handle;
}

/**
 * The resolved default every caller used to get implicitly. Named rather than
 * defaulted: the repo bans defaulted parameters in tests too, and a default
 * here hid WHICH pin state five cases were exercising - the state is the
 * subject of three of them.
 */
const CLOUD_UNPINNED_KNOWN: TaskPinnedState = {
  pinned: false,
  home: undefined,
  pinnedKnown: true,
};

function renderPinMenu(
  onSetTaskPinned: (pinned: boolean) => void,
  taskPinnedState: TaskPinnedState | null,
): void {
  render(
    <ContextMenu open>
      <ContextMenuTrigger>Open menu</ContextMenuTrigger>
      <TabContextMenuContent
        tab={EPIC_TAB}
        canCloseOtherTabs
        canOpenInNewWindow={false}
        canEditTitle={false}
        taskPinnedState={taskPinnedState}
        isTaskPinPending={false}
        onCloseOtherTabs={() => undefined}
        onDuplicateTab={() => undefined}
        onOpenInNewWindow={() => undefined}
        onSplitCommand={() => undefined}
        onEditTitle={() => undefined}
        onSetTaskPinned={onSetTaskPinned}
      />
    </ContextMenu>,
  );
}

describe("TabContextMenuContent preserved-orphan pin guard", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    vi.restoreAllMocks();
  });

  it("disables Pin from the live session pause state even when task context says cloud and unpinned", async () => {
    const handle = createPausedEpicHandle(EPIC_TAB.epicId, false);
    __getOpenEpicRegistryForTests().acquire(EPIC_TAB.epicId, () => handle);
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, CLOUD_UNPINNED_KNOWN);

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBe(
      "true",
    );
    // Permanently unavailable: `aria-disabled`, NOT `disabled`, so the label
    // explaining the restriction stays reachable by keyboard.
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("data-disabled")).toBeNull();
    // Lane 9 item 5 split the collapsed "row" reason into `local-home` and
    // `preserved-orphan`, and this row is the latter (a cloud-deleted epic
    // with locally-preserved edits) - "stored on the connected device" is
    // the `local-home` sentence, and pinning it here was pinning the
    // pre-split conflation. Updated to the surviving preserved-orphan
    // sentence, "cloud copy deleted".
    expect(item.textContent).toContain(
      "Pin Task in History — cloud copy deleted",
    );
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });

  it("also disables Pin from a retained session pause state", async () => {
    const handle = createPausedEpicHandle(EPIC_TAB.epicId, true);
    __getOpenEpicRegistryForTests().acquire(EPIC_TAB.epicId, () => handle);
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, CLOUD_UNPINNED_KNOWN);

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBe(
      "true",
    );
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });
});

/**
 * Lane 9 item 5: `epic.setPinned@1.1` lets a `@1.1` host pin a local-homed
 * epic, so `local-home` stops being permanent. The gate is a CONJUNCTION -
 * `localHomePinSupported && pinReadingKnown` - and `pinnedKnown: false` is
 * the regression item 5 introduced (a local-homed epic only a live session
 * knows about, which the app-wide host never resolved) and fixed in the same
 * commit; it is pinned here so a future edit that drops the conjunct is
 * caught rather than silently offering "Pin" for an unresolved reading.
 */
describe("TabContextMenuContent local-home pin gate (lane 9 item 5)", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    pinSupportState.supported = false;
    vi.restoreAllMocks();
  });

  it("stays unavailable on a host that does not negotiate the local arm", async () => {
    pinSupportState.supported = false;
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBe("true");
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBeNull();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "Pin Task in History — stored on the connected device",
    );
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });

  it("becomes available on a @1.1 host with a resolved (pinnedKnown) reading", async () => {
    pinSupportState.supported = true;
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    // Neither unavailability attribute keys an ENABLED item.
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBeNull();
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBeNull();
    expect(item.getAttribute("aria-disabled")).toBeNull();
    expect(item.textContent).toContain("Pin Task in History");
    expect(item.textContent).not.toContain("stored on the connected device");
    fireEvent.click(item);
    expect(onSetTaskPinned).toHaveBeenCalledWith(true);
  });

  it("stays unavailable on a @1.1 host when the reading is a filler (pinnedKnown false) - the item 5 regression", async () => {
    // For RED: reverting the `localHomePinSupported && pinReadingKnown`
    // conjunct in `tab-strip-context-menu.tsx` back to plain
    // `localHomePinSupported` makes this offer "Pin" for a fabricated
    // `pinned: false` instead.
    pinSupportState.supported = true;
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      pinnedKnown: false,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBe("true");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "Pin Task in History — stored on the connected device",
    );
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });
});
