import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsyncedCloseDialog } from "@/components/layout/dialogs/use-unsynced-close-dialog";
import type { HeaderTab } from "@/stores/tabs/types";

const mockUnsynced = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/registries/epic-session-registry", () => ({
  epicHasUnsyncedEdits: () => mockUnsynced.value,
  getOpenEpicRegistry: () => ({
    subscribe: () => () => undefined,
  }),
}));

const EPIC_TAB: HeaderTab = {
  kind: "epic",
  id: "tab-1",
  epicId: "epic-1",
  name: "Alpha",
  route: "/epics/epic-1/tab-1",
  icon: null,
  canDuplicate: true,
  canOpenInNewWindow: true,
};
const DRAFT_TAB: HeaderTab = {
  kind: "draft",
  id: "draft-1",
  route: "/draft/draft-1",
  name: "Start Page",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

interface HostProps {
  readonly tab: HeaderTab;
  readonly onPrompt: (opened: boolean) => void;
  readonly onConfirm: () => void;
}

function Host(props: HostProps) {
  const ctrl = useUnsyncedCloseDialog();
  return (
    <>
      {ctrl.dialog}
      <button
        type="button"
        data-testid="trigger"
        onClick={() => {
          const opened = ctrl.promptOrConfirm(props.tab, props.onConfirm);
          props.onPrompt(opened);
        }}
      >
        prompt
      </button>
    </>
  );
}

describe("useUnsyncedCloseDialog", () => {
  beforeEach(() => {
    mockUnsynced.value = false;
  });
  afterEach(() => {
    cleanup();
  });

  it("returns false and does not open the dialog for non-epic tabs", () => {
    const promptResults: boolean[] = [];
    let confirmCount = 0;
    render(
      <Host
        tab={DRAFT_TAB}
        onPrompt={(o) => promptResults.push(o)}
        onConfirm={() => {
          confirmCount += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(promptResults).toEqual([false]);
    expect(confirmCount).toBe(0);
    expect(screen.queryByTestId("epic-tab-unsynced-dialog")).toBeNull();
  });

  it("returns false for epic tabs without unsynced edits", () => {
    mockUnsynced.value = false;
    const promptResults: boolean[] = [];
    render(
      <Host
        tab={EPIC_TAB}
        onPrompt={(o) => promptResults.push(o)}
        onConfirm={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(promptResults).toEqual([false]);
    expect(screen.queryByTestId("epic-tab-unsynced-dialog")).toBeNull();
  });

  it("opens the dialog for epic tabs with unsynced edits and fires onConfirm on discard", () => {
    mockUnsynced.value = true;
    const promptResults: boolean[] = [];
    let confirmCount = 0;
    render(
      <Host
        tab={EPIC_TAB}
        onPrompt={(o) => promptResults.push(o)}
        onConfirm={() => {
          confirmCount += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(promptResults).toEqual([true]);
    expect(screen.getByTestId("epic-tab-unsynced-dialog")).toBeDefined();

    fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));
    expect(confirmCount).toBe(1);
  });

  it("does not fire onConfirm on wait", () => {
    mockUnsynced.value = true;
    let confirmCount = 0;
    render(
      <Host
        tab={EPIC_TAB}
        onPrompt={() => undefined}
        onConfirm={() => {
          confirmCount += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("epic-tab-unsynced-dialog")).toBeDefined();

    fireEvent.click(screen.getByTestId("epic-tab-unsynced-wait"));
    expect(confirmCount).toBe(0);
  });
});
