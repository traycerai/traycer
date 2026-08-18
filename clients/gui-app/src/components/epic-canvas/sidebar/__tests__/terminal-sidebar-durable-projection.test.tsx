import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import {
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";
const TAB_ID = "tab-1";
const TERMINAL_ID = "term-durable-1";

function epicRunningPlainTerminal(terminalId: string): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId: HOST_ID,
      scope: { kind: "epic", epicId: EPIC_ID },
      launch: {
        cwd: "/tmp/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: "Streamed terminal",
      revision: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: terminalId,
      currentCwd: "/tmp/work",
      activeProcessName: null,
      cols: 80,
      rows: 24,
    },
  };
}

function freshPlainCollection(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, terminals),
    ),
    "open",
  );
}

const durableCollection = vi.hoisted(() => ({
  value: null as PlainTerminalCollection | null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

// Reproduces a capable host whose unary list is still cached empty while the
// durable stream has already delivered a running epic-scoped projection.
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: [] },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-mutation", () => ({
  useTerminalKill: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-mutation", () => ({
  useTerminalRename: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: "host-1",
    scope: { kind: "epic", epicId: "epic-1" },
    capability: { status: "capable" },
    canMutate: true,
    collection: durableCollection.value,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useHostPlainTerminalMutations: () => ({
    close: { mutateAsync: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean | undefined;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
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

describe("terminal sidebar durable projection rows", () => {
  beforeEach(() => {
    durableCollection.value = freshPlainCollection([
      epicRunningPlainTerminal(TERMINAL_ID),
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders outside TabHostProvider from the active host's durable stream", () => {
    const { getByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );

    expect(queryByTestId("epic-terminal-sidebar-empty")).toBeNull();
    expect(getByTestId("epic-terminal-sidebar-list")).not.toBeNull();
    expect(
      getByTestId(`epic-terminal-sidebar-item-${TERMINAL_ID}`),
    ).not.toBeNull();
  });
});
