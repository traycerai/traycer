import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";

const TAB_ID = "tab-1";

const refetch = vi.fn();
const listState = vi.hoisted<{ isFetching: boolean }>(() => ({
  isFetching: false,
}));

// The sidebar is outside every tile `TabHostProvider`, so its client and its
// ref host both come from the Epic SESSION - not from the app-wide effective
// host, which this panel deliberately no longer reads.
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-1",
}));

// The stranded state this guards: `terminal.list` errored (transport already
// retried), no automatic refetch route exists, and the panel must offer a
// manual way back.
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: undefined,
    isPending: false,
    isError: true,
    isFetching: listState.isFetching,
    error: new Error("WebSocket dial timed out after 10000ms"),
    refetch,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    capability: { status: "legacy" },
    canMutate: false,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useHostPlainTerminalMutations: () => ({
    close: { mutateAsync: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => null,
}));

import { TerminalsPanelBody } from "../epic-terminal-sidebar";

function wrapper(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SnapshotLoadingProvider
          value={{ snapshotLoaded: true, snapshotFetchError: null }}
        >
          {node}
        </SnapshotLoadingProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("terminal sidebar error-state Retry", () => {
  beforeEach(() => {
    refetch.mockClear();
    listState.isFetching = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the error with a Retry button that refetches the list", () => {
    const { getByRole, getByText } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    getByText("WebSocket dial timed out after 10000ms");

    const retry = getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("disables Retry while the refetch is in flight, keeping the label", () => {
    listState.isFetching = true;
    const { getByRole } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    // The accessible name stays "Retry" mid-flight - the spinner is
    // `aria-hidden`, so the label never swaps to "Retrying...".
    const retry = getByRole("button", { name: "Retry" });
    expect(retry).toHaveProperty("disabled", true);
    fireEvent.click(retry);
    expect(refetch).not.toHaveBeenCalled();
  });
});
