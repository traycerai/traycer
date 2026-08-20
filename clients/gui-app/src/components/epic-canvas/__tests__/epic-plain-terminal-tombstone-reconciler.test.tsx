import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpicPlainTerminalTombstoneReconciler } from "@/components/epic-canvas/epic-plain-terminal-tombstone-reconciler";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { type PlainTerminalCollection } from "@/lib/terminals/plain-terminal-authority";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

const HOST_ID = "host-authority";
const SCOPE = { kind: "epic", epicId: "epic-1" } as const;

describe("EpicPlainTerminalTombstoneReconciler", () => {
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("consumes a retained tombstone for a closed-only late epic payload without mounting authority", async () => {
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

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    render(<EpicPlainTerminalTombstoneReconciler epicId="epic-1" />, {
      wrapper: Wrapper,
    });

    const store = useEpicCanvasStore.getState();
    let openedTabId = "";
    act(() => {
      const tabId = store.openEpicTab("epic-1", "Epic");
      openedTabId = tabId;
      useEpicCanvasStore.setState((state) => ({
        closedTilePayloadsByTabId: {
          ...state.closedTilePayloadsByTabId,
          [tabId]: {
            "late-closed-legacy": {
              node: {
                id: "terminal-1",
                instanceId: "late-closed-legacy",
                type: "terminal",
                name: "Late closed",
                hostId: HOST_ID,
                titleSource: "manual",
                cwd: "/legacy",
              },
              pendingCreate: false,
            },
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
    });
    const tabId = openedTabId;

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
