import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { setMobileApp } from "@/lib/mobile-app";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
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
  appearance: null,
};

const DUPLICATABLE_TAB: Extract<HeaderTab, { kind: "epic" }> = {
  ...EPIC_TAB,
  id: "epic-duplicate",
  epicId: "epic-duplicate",
  canDuplicate: true,
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
    setMobileApp(false);
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
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
    // with locally-preserved edits) - "needs a newer host" is the
    // `local-home` sentence, and pinning it here was pinning the
    // pre-split conflation. Updated to the surviving preserved-orphan
    // sentence, "task deleted".
    expect(item.textContent).toContain("Pin Task in History — task deleted");
    expect(item.textContent).not.toMatch(/cloud|device/i);
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

  it("renders live non-Mac binding labels for reopen and duplicate actions", () => {
    setMobileApp(false);
    render(
      <ContextMenu open>
        <ContextMenuTrigger>Open menu</ContextMenuTrigger>
        <TabContextMenuContent
          tab={DUPLICATABLE_TAB}
          canCloseOtherTabs
          canOpenInNewWindow={false}
          canEditTitle={false}
          taskPinnedState={null}
          isTaskPinPending={false}
          onCloseOtherTabs={() => undefined}
          onDuplicateTab={() => undefined}
          onOpenInNewWindow={() => undefined}
          onSplitCommand={() => undefined}
          onEditTitle={() => undefined}
          onSetTaskPinned={() => undefined}
        />
      </ContextMenu>,
    );

    expect(
      screen.getByText(formatChordForDisplay("mod+shift+t")),
    ).not.toBeNull();
    expect(
      screen.getByText(formatChordForDisplay("mod+shift+k")),
    ).not.toBeNull();
    expect(screen.getByText("Reopen Closed Tab")).not.toBeNull();
    expect(screen.getByText("Duplicate Tab")).not.toBeNull();
  });

  it("updates a duplicate hint when rebound, then hides it when cleared while keeping the action", () => {
    const onDuplicateTab = vi.fn<(tab: HeaderTab) => void>();
    const view = render(
      <ContextMenu open>
        <ContextMenuTrigger>Open menu</ContextMenuTrigger>
        <TabContextMenuContent
          tab={DUPLICATABLE_TAB}
          canCloseOtherTabs
          canOpenInNewWindow={false}
          canEditTitle={false}
          taskPinnedState={null}
          isTaskPinPending={false}
          onCloseOtherTabs={() => undefined}
          onDuplicateTab={onDuplicateTab}
          onOpenInNewWindow={() => undefined}
          onSplitCommand={() => undefined}
          onEditTitle={() => undefined}
          onSetTaskPinned={() => undefined}
        />
      </ContextMenu>,
    );

    act(() => {
      useKeybindingStore
        .getState()
        .setBinding("epic.duplicate-tab", "mod+alt+k");
    });
    expect(screen.getByText(formatChordForDisplay("mod+alt+k"))).not.toBeNull();
    expect(screen.queryByText(formatChordForDisplay("mod+shift+k"))).toBeNull();

    act(() => {
      useKeybindingStore.getState().clearBinding("epic.duplicate-tab");
    });
    expect(screen.queryByText(formatChordForDisplay("mod+alt+k"))).toBeNull();
    const item = screen.getByTestId(
      `tab-duplicate-epic-${DUPLICATABLE_TAB.id}`,
    );
    expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item);
    expect(onDuplicateTab).toHaveBeenCalledWith(DUPLICATABLE_TAB);

    act(() => {
      useKeybindingStore.getState().setBinding("tab.reopen", "mod+alt+r");
    });
    expect(screen.getByText(formatChordForDisplay("mod+alt+r"))).not.toBeNull();
    act(() => {
      useKeybindingStore.getState().clearBinding("tab.reopen");
    });
    expect(screen.queryByText(formatChordForDisplay("mod+alt+r"))).toBeNull();
    expect(screen.getByTestId("tab-reopen-closed")).not.toBeNull();
    view.unmount();
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
      "Pin Task in History — needs a newer host",
    );
    expect(item.textContent).not.toMatch(/cloud|device/i);
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
    expect(item.textContent).not.toContain("needs a newer host");
    fireEvent.click(item);
    expect(onSetTaskPinned).toHaveBeenCalledWith(true);
  });

  it("stays unavailable on a @1.1 host when the reading is a filler (pinnedKnown false), reading pin state unknown rather than needs a newer host", async () => {
    // For RED: reverting the `pinReadingKnown` check ahead of the
    // host-capability arm in `tabPinUnavailableReason` would make this fall
    // through to `local-home` and say "needs a newer host" instead - the
    // wrong remedy, since this host DOES speak `@1.1` and a newer host would
    // change nothing.
    pinSupportState.supported = true;
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      hostId: null,
      pinnedKnown: false,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBeNull();
    expect(
      item.getAttribute("data-preserved-orphan-pin-unavailable"),
    ).toBeNull();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "Pin Task in History — pin state unknown",
    );
    expect(item.textContent).not.toMatch(/newer host/i);
    expect(item.textContent).not.toMatch(/cloud|device/i);
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

  it("reads pin state unknown, not needs a newer host, on the EPIC's own @1.1 host when its reading is a filler (pinnedKnown false)", async () => {
    // Even the epic's OWN host negotiating `@1.1` must not paper over a
    // filler reading: `pinReadingKnown` is checked before the
    // host-capability arm, so this stays "pin-unknown" rather than falling
    // through to a "needs a newer host" remedy that would be wrong here -
    // the epic's own host already speaks `@1.1`.
    pinSupportState.supported = false;
    pinSupportState.supportedByHostId.set("host-owning-epic", true);
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned, {
      pinned: false,
      home: "local",
      hostId: "host-owning-epic",
      pinnedKnown: false,
    });

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBeNull();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "Pin Task in History — pin state unknown",
    );
    expect(item.textContent).not.toMatch(/newer host/i);
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });
});
