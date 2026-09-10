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
 * `useEpicPinLocalHomeSupported` resolves a host client, which throws outside a
 * `<HostRuntimeProvider>` - this suite renders the menu with none. Mocked at
 * the module boundary rather than standing up a provider: every other test in
 * this file is about the pin GUARD, not the host negotiation, and a hoisted
 * flag lets each case say what the negotiated manifest would have answered
 * without dragging in a messenger/registry harness.
 *
 * The mock RECORDS the host it is asked about, and can answer differently per
 * host. That is deliberate: the hook takes the dispatch host as an argument
 * precisely so the gate and the dispatch agree on a machine, and a mock that
 * ignored the argument would keep answering for every case - including the one
 * where the window's host and the epic's host disagree, which is the whole
 * reason the parameter exists.
 */
const pinSupportState = vi.hoisted(() => ({
  supported: false,
  supportedByHostId: new Map<string | null, boolean>(),
  askedHostIds: [] as Array<string | null>,
}));
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: (hostId: string | null): boolean => {
    pinSupportState.askedHostIds.push(hostId);
    return (
      pinSupportState.supportedByHostId.get(hostId) ?? pinSupportState.supported
    );
  },
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
  hostId: null,
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
    pinSupportState.supportedByHostId.clear();
    pinSupportState.askedHostIds.length = 0;
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
      hostId: null,
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBe("true");
    expect(
      item.getAttribute("data-preserved-orphan-pin-unavailable"),
    ).toBeNull();
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
      hostId: null,
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    // Neither unavailability attribute keys an ENABLED item.
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBeNull();
    expect(
      item.getAttribute("data-preserved-orphan-pin-unavailable"),
    ).toBeNull();
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
      hostId: null,
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

  /**
   * The gate asks the host the pin would be DISPATCHED to - the epic's own, from
   * the row's reading - and not the window's.
   *
   * This is the pairing the hook's docstring claims, and it stopped holding the
   * moment `useEpicSetPinned` began resolving a per-dispatch host: the gate kept
   * asking the window. The result was not a type error and neither half's own
   * tests could see it - the menu offered the item (the window negotiated
   * `@1.1`) and the dispatch refused the click in silence (the epic's host had
   * not). An item that looks available and does nothing is worse than one that
   * says why it is not, which is what this now renders.
   */
  it("asks the EPIC's host, not the window's, and stays unavailable when only the window negotiated", async () => {
    // The window's host would say yes; the epic's host says no.
    pinSupportState.supported = true;
    pinSupportState.supportedByHostId.set("host-owning-epic", false);
    // Cleared HERE, not in an `afterEach`: the assertion below is about what
    // THIS render asked, and earlier cases in this describe ask about `null`.
    pinSupportState.askedHostIds.length = 0;
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      hostId: "host-owning-epic",
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(pinSupportState.askedHostIds).toContain("host-owning-epic");
    expect(pinSupportState.askedHostIds).not.toContain(null);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBe("true");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });

  it("offers the item when the EPIC's host negotiated, though the window's did not", async () => {
    // The mirror image, so the row above cannot pass by the gate simply
    // answering `false` for everything.
    pinSupportState.supported = false;
    pinSupportState.supportedByHostId.set("host-owning-epic", true);
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      hostId: "host-owning-epic",
      pinnedKnown: true,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item);
    expect(onSetTaskPinned).toHaveBeenCalledWith(true);
  });
});
