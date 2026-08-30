import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";

const useInitialChatHandoffMock = vi.hoisted(() => vi.fn());
const useEpicRouteSynchronizationMock = vi.hoisted(() => vi.fn());
const useEpicSyncChatRecordsMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/epic-canvas/hooks/use-initial-chat-handoff", () => ({
  useInitialChatHandoff: useInitialChatHandoffMock,
}));

vi.mock(
  "@/components/epic-canvas/hooks/use-epic-route-synchronization",
  () => ({
    useEpicRouteSynchronization: useEpicRouteSynchronizationMock,
  }),
);

// Both exports, not just the hook this component calls: a factory that lists
// only what today's importer uses answers `undefined` for the rest, and the
// next importer of this module gets a silent no-op instead of a failure.
vi.mock("@/hooks/chats/use-epic-chat-records", () => ({
  useEpicSyncChatRecords: useEpicSyncChatRecordsMock,
  invalidateEpicChatRecords: () => undefined,
}));
// The terminal-agent twin of the record sync above: same subtree, same
// reason to stub it - it reaches the session host client, which this
// harness does not provide.
vi.mock("@/hooks/chats/use-epic-tui-agent-records", () => ({
  useEpicSyncTuiAgentRecords: () => undefined,
  invalidateEpicTuiAgentRecords: () => undefined,
}));

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

vi.mock("@/components/epic-canvas/epic-plain-terminal-create-owner", () => ({
  EpicPlainTerminalCreateOwner: () => null,
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

function renderBody(props: Parameters<typeof EpicRouteSessionBody>[0]): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (wrapperProps: { readonly children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      wrapperProps.children,
    );
  render(<EpicRouteSessionBody {...props} />, { wrapper: Wrapper });
}

describe("<EpicRouteSessionBody />", () => {
  afterEach(() => {
    cleanup();
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
    useEpicSyncChatRecordsMock.mockReset();
  });

  it("keeps visual state mounted but suppresses route-global effects when inactive", () => {
    renderBody({ ...BODY_PROPS, active: false });

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("false");
    expect(useInitialChatHandoffMock).toHaveBeenCalledWith("epic-a", "tab-a");
    expect(useEpicRouteSynchronizationMock).not.toHaveBeenCalled();
    // Session-scoped, NOT route-active-scoped: the chat record channel backs
    // the sidebar tree and every open tile of a background epic, which would
    // lose their swept chats again if it stopped while another tab is in front.
    expect(useEpicSyncChatRecordsMock).toHaveBeenCalledWith("epic-a");
    expect(screen.queryByTestId("epic-migration-modal")).toBeNull();
  });

  it("runs route synchronization and migration modal only for the active pane", () => {
    renderBody({ ...BODY_PROPS, active: true });

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("true");
    expect(useEpicRouteSynchronizationMock).toHaveBeenCalledWith(BODY_PROPS);
    expect(screen.getByTestId("epic-migration-modal").dataset.tabId).toBe(
      "tab-a",
    );
  });
});
