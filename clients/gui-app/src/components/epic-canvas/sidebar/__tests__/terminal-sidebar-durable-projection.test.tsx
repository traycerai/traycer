import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
const hostDirectory = vi.hoisted(() => ({
  entry: null as { hostId: string; label: string | null } | null,
}));
const toastHarness = vi.hoisted(() => ({
  toast: vi.fn<(message: string) => void>(),
}));

// A terminal's task directory is named by its host's directory row; this
// suite has no host directory and no task terminal in the task's own folder.
vi.mock("@/hooks/terminal/use-task-home-directory", () => ({
  useTaskHomeDirectory: () => null,
  useTaskHomeDirectoryFor: () => () => null,
}));
vi.mock("@/lib/host", () => ({
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostDirectory.entry?.hostId === hostId ? hostDirectory.entry : null,
  }),
  useHostClient: () => null,
  useHostRuntimeClient: () => ({
    resolveHostById: () => null,
    getRequestContext: () => null,
    getRequestContextUserId: () => null,
    createRequester: () => null,
  }),
}));

vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => null,
}));

vi.mock("sonner", () => ({ toast: toastHarness.toast }));

// The sidebar reads the Epic SESSION's host (it sits outside every tile's
// `<TabHostProvider>`); no `EpicSessionContext` is mounted here, so pin it to
// the fixture's host explicitly. This used to mock the app-wide reader the
// component no longer imports - a `vi.mock` on an unresolved specifier is
// silent, and the row was rendering under `UNKNOWN_HOST_PLACEHOLDER`.
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => HOST_ID,
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

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: "host-1",
    scope: { kind: "epic", epicId: "epic-1" },
    capability: {
      status: "capable",
      schemaVersion: { major: 2, minor: 1 },
    },
    canMutate: true,
    collection: durableCollection.value,
    coverage: durableCollection.value?.coverage ?? null,
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
    hostDirectory.entry = { hostId: HOST_ID, label: "Studio Mac" };
    toastHarness.toast.mockClear();
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

  it("names the unavailable computer in the terminal toast", () => {
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId(`epic-terminal-sidebar-item-${TERMINAL_ID}`));

    expect(toastHarness.toast).toHaveBeenCalledWith(
      "Can't open this terminal right now - Studio Mac is not reachable.",
    );
  });

  it.each([
    ["a missing entry", null],
    ["a blank label", { hostId: HOST_ID, label: "   " }],
    ["a label equal to the host id", { hostId: HOST_ID, label: HOST_ID }],
  ])("uses the plain host fallback for %s", (_description, entry) => {
    hostDirectory.entry = entry;
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId(`epic-terminal-sidebar-item-${TERMINAL_ID}`));

    expect(toastHarness.toast).toHaveBeenCalledWith(
      "Can't open this terminal right now - the host is not reachable.",
    );
  });
});
