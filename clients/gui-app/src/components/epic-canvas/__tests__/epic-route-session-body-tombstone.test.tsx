import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { type PlainTerminalCollection } from "@/lib/terminals/plain-terminal-authority";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

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

vi.mock("@/hooks/chats/use-epic-chat-records", () => ({
  useEpicSyncChatRecords: useEpicSyncChatRecordsMock,
  invalidateEpicChatRecords: () => undefined,
}));

vi.mock("@/components/epic-canvas/epic-shell", () => ({
  EpicShell: () => <div data-testid="epic-shell" />,
}));

vi.mock("@/components/epic-canvas/dialogs/epic-migration-modal", () => ({
  EpicMigrationModal: () => <div data-testid="epic-migration-modal" />,
}));

const HOST_ID = "host-authority";
const SCOPE = { kind: "epic", epicId: "epic-1" } as const;

describe("<EpicRouteSessionBody /> closed-only tombstone without a session handle", () => {
  afterEach(() => {
    cleanup();
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
    useEpicSyncChatRecordsMock.mockReset();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("prunes a closed-only legacy payload while EpicSessionGate has no open handle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const queryKey = hostQueryKeys.plainTerminals(HOST_ID, SCOPE);
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: HOST_ID,
        terminalId: "terminal-1",
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);

    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic");
    const lateLegacy: EpicCanvasTileRef = {
      id: "terminal-1",
      instanceId: "late-closed-legacy",
      type: "terminal",
      name: "Late closed",
      hostId: HOST_ID,
      titleSource: "manual",
      cwd: "/legacy",
    };
    useEpicCanvasStore.setState((state) => ({
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        [tabId]: {
          "late-closed-legacy": { node: lateLegacy, pendingCreate: false },
          "late-closed-future": {
            node: {
              id: "terminal-1",
              instanceId: "late-closed-future",
              type: "terminal",
              name: "Future authority",
              hostId: HOST_ID,
              authority: "unsupported",
              rawAuthority: "future-v2",
              legacyFallback: {
                name: "Future authority",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
        },
      },
    }));

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    render(
      <EpicRouteSessionBody
        epicId="epic-1"
        tabId={tabId}
        active
        focusedAt={undefined}
        focusArtifactId={undefined}
        focusThreadId={undefined}
        focusPaneId={undefined}
        focusTileInstanceId={undefined}
      />,
      { wrapper: Wrapper },
    );

    expect(useInitialChatHandoffMock).not.toHaveBeenCalled();
    expect(useEpicSyncChatRecordsMock).not.toHaveBeenCalled();
    expect(useEpicRouteSynchronizationMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
          "late-closed-legacy"
        ],
      ).toBeUndefined();
    });
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        "late-closed-future"
      ],
    ).toBeDefined();
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(queryKey)
        ?.projectionSequence,
    ).toBe(1);
  });
});
