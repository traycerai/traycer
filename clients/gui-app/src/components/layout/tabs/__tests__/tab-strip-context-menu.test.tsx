import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { HeaderTab } from "@/stores/tabs/types";

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

function renderPinMenu(onSetTaskPinned: (pinned: boolean) => void): void {
  render(
    <ContextMenu open>
      <ContextMenuTrigger>Open menu</ContextMenuTrigger>
      <TabContextMenuContent
        tab={EPIC_TAB}
        canCloseOtherTabs
        canOpenInNewWindow={false}
        canEditTitle={false}
        taskPinnedState={{ pinned: false, home: undefined }}
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

    renderPinMenu(onSetTaskPinned);

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBe(
      "true",
    );
    // Permanently unavailable: `aria-disabled`, NOT `disabled`, so the label
    // explaining the restriction stays reachable by keyboard.
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("data-disabled")).toBeNull();
    expect(item.textContent).toContain("stored on this device");
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });

  it("also disables Pin from a retained session pause state", async () => {
    const handle = createPausedEpicHandle(EPIC_TAB.epicId, true);
    __getOpenEpicRegistryForTests().acquire(EPIC_TAB.epicId, () => handle);
    const onSetTaskPinned = vi.fn<(pinned: boolean) => void>();

    renderPinMenu(onSetTaskPinned);

    const item = await screen.findByTestId(`tab-pin-history-${EPIC_TAB.id}`);
    expect(item.getAttribute("data-preserved-orphan-pin-unavailable")).toBe(
      "true",
    );
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(onSetTaskPinned).not.toHaveBeenCalled();
  });
});
