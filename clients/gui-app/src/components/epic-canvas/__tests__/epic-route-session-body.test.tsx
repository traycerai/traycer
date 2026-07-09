import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";

const useInitialChatHandoffMock = vi.hoisted(() => vi.fn());
const useEpicRouteSynchronizationMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/epic-canvas/hooks/use-initial-chat-handoff", () => ({
  useInitialChatHandoff: useInitialChatHandoffMock,
}));

vi.mock(
  "@/components/epic-canvas/hooks/use-epic-route-synchronization",
  () => ({
    useEpicRouteSynchronization: useEpicRouteSynchronizationMock,
  }),
);

vi.mock("@/providers/epic-session-gate", () => ({
  EpicSessionGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/epic-shell", () => ({
  EpicShell: (props: {
    readonly active: boolean;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-testid="epic-shell"
      data-active={props.active ? "true" : "false"}
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
    />
  ),
}));

vi.mock("@/components/epic-canvas/dialogs/epic-migration-modal", () => ({
  EpicMigrationModal: (props: { readonly tabId: string }) => (
    <div data-testid="epic-migration-modal" data-tab-id={props.tabId} />
  ),
}));

const BODY_PROPS = {
  epicId: "epic-a",
  tabId: "tab-a",
  focusedAt: 123,
  focusArtifactId: "artifact-a",
  focusThreadId: "thread-a",
  focusPaneId: "pane-a",
  focusTileInstanceId: "tile-a",
};

describe("<EpicRouteSessionBody />", () => {
  afterEach(() => {
    cleanup();
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
  });

  it("keeps visual state mounted but suppresses route-global effects when inactive", () => {
    render(<EpicRouteSessionBody {...BODY_PROPS} active={false} />);

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("false");
    expect(useInitialChatHandoffMock).toHaveBeenCalledWith("epic-a", "tab-a");
    expect(useEpicRouteSynchronizationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("epic-migration-modal")).toBeNull();
  });

  it("runs route synchronization and migration modal only for the active pane", () => {
    render(<EpicRouteSessionBody {...BODY_PROPS} active />);

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("true");
    expect(useEpicRouteSynchronizationMock).toHaveBeenCalledWith(BODY_PROPS);
    expect(screen.getByTestId("epic-migration-modal").dataset.tabId).toBe(
      "tab-a",
    );
  });
});
