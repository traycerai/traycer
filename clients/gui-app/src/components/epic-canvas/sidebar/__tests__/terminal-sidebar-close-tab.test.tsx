import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";

const SESSION_ID = "term-1";
const TAB_ID = "tab-1";

const killMutate = vi.fn();
interface DurableRenameOptions {
  readonly onSuccess: () => void;
}
const durableCloseMutateAsync =
  vi.fn<(request: { readonly terminalId: string }) => Promise<void>>();
const durableRenameMutate =
  vi.fn<
    (
      request: { readonly terminalId: string; readonly manualTitle: string },
      options: DurableRenameOptions,
    ) => void
  >();
const legacyRenameMutate = vi.fn();
const durableAuthority = vi.hoisted<{
  capability: "unknown" | "legacy" | "capable";
  canMutate: boolean;
  closePending: boolean;
  renamePending: boolean;
  collectionIncludesSession: boolean;
}>(() => ({
  capability: "legacy",
  canMutate: false,
  closePending: false,
  renamePending: false,
  collectionIncludesSession: false,
}));
const hostRequest = vi.hoisted(() =>
  vi.fn<
    (method: string, vars: { readonly terminalId: string }) => Promise<unknown>
  >(),
);
const terminalSessions = vi.hoisted<{
  value: ReadonlyArray<CanonicalTerminalSessionInfo>;
}>(() => ({ value: [] }));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

const RUNNING_SESSION: CanonicalTerminalSessionInfo = {
  sessionId: SESSION_ID,
  scope: { kind: "epic", epicId: "epic-1" },
  sessionKind: "terminal",
  cwd: "/tmp/work",
  shellCommand: "/bin/zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  createdAt: 0,
  title: null,
};
const DURABLE_PROJECTION: PlainTerminalProjection = {
  record: {
    terminalId: SESSION_ID,
    hostId: "host-1",
    scope: { kind: "epic", epicId: "epic-1" },
    launch: {
      cwd: RUNNING_SESSION.cwd,
      shellCommand: RUNNING_SESSION.shellCommand,
      shellArgs: RUNNING_SESSION.shellArgs,
    },
    manualTitle: null,
    revision: 1,
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
  },
  runtime: {
    status: "running",
    sessionId: SESSION_ID,
    currentCwd: RUNNING_SESSION.cwd,
    activeProcessName: null,
    cols: RUNNING_SESSION.cols,
    rows: RUNNING_SESSION.rows,
  },
};

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: terminalSessions.value },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-mutation", () => ({
  useTerminalKill: () => ({ mutate: killMutate, isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-mutation", () => ({
  useTerminalRename: () => ({ mutate: legacyRenameMutate, isPending: false }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    request: hostRequest,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: "host-1",
    scope: { kind: "epic", epicId: "epic-1" },
    capability: { status: durableAuthority.capability },
    canMutate: durableAuthority.canMutate,
    collection: {
      terminalsById: durableAuthority.collectionIncludesSession
        ? { [SESSION_ID]: DURABLE_PROJECTION }
        : {},
    },
  }),
}));

vi.mock(
  "@/hooks/terminal/use-plain-terminal-mutations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/terminal/use-plain-terminal-mutations")
      >();
    return {
      ...actual,
      useHostPlainTerminalMutations: (
        authority: Parameters<typeof actual.useHostPlainTerminalMutations>[0],
      ) => {
        const real = actual.useHostPlainTerminalMutations(authority);
        return {
          ...real,
          close: {
            ...real.close,
            mutateAsync: async (request: { readonly terminalId: string }) => {
              const pending = durableCloseMutateAsync(request);
              const result = await real.close.mutateAsync(request);
              await pending;
              return result;
            },
            isPending: durableAuthority.closePending || real.close.isPending,
          },
          rename: {
            mutate: durableRenameMutate,
            isPending: durableAuthority.renamePending,
          },
        };
      },
    };
  },
);

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
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

let testQueryClient = createTestQueryClient();

function wrapper(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={testQueryClient}>
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

function resolveCloseRequest(vars: { readonly terminalId: string }): {
  readonly terminalId: string;
  readonly revision: number;
} {
  return { terminalId: vars.terminalId, revision: 2 };
}

function seedOpenTerminalTab(authority: "legacy" | "host" | "future"): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
  });
  let ref: EpicTerminalRef = {
    id: SESSION_ID,
    instanceId: "inst-term-1",
    type: "terminal",
    name: "New Terminal",
    titleSource: "default",
    hostId: "host-1",
    cwd: "/tmp/work",
  };
  if (authority === "host") {
    ref = {
      id: SESSION_ID,
      instanceId: "inst-term-1",
      type: "terminal",
      name: "New Terminal",
      hostId: "host-1",
      authority: "host",
      legacyFallback: {
        name: "New Terminal",
        titleSource: "default",
        cwd: "/tmp/work",
      },
    };
  }
  if (authority === "future") {
    ref = {
      id: SESSION_ID,
      instanceId: "inst-term-1",
      type: "terminal",
      name: "New Terminal",
      hostId: "host-1",
      authority: "unsupported",
      rawAuthority: "host-v2",
      legacyFallback: {
        name: "Rollback only",
        titleSource: "default",
        cwd: "/tmp/work",
      },
    };
  }
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, ref);
}

describe("terminal sidebar Close", () => {
  beforeEach(() => {
    testQueryClient = createTestQueryClient();
    killMutate.mockClear();
    durableCloseMutateAsync.mockReset();
    durableCloseMutateAsync.mockResolvedValue();
    durableRenameMutate.mockReset();
    legacyRenameMutate.mockReset();
    hostRequest.mockReset();
    hostRequest.mockImplementation((method, vars) => {
      if (method === "terminal.plain.close") {
        return Promise.resolve(resolveCloseRequest(vars));
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    durableAuthority.capability = "legacy";
    durableAuthority.canMutate = false;
    durableAuthority.closePending = false;
    durableAuthority.renamePending = false;
    durableAuthority.collectionIncludesSession = false;
    terminalSessions.value = [RUNNING_SESSION];
    seedOpenTerminalTab("legacy");
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("highlights the terminal shown in the active canvas pane", () => {
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).className.split(
        " ",
      ),
    ).toContain("bg-accent");
  });

  it("closes the open canvas tab and kills the session", () => {
    // Precondition: a canvas tab is open for this session.
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).not.toBeNull();

    const { getByTestId, queryByTestId, queryByText } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).textContent,
    ).toBe("work · New Terminal");
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).className,
    ).toContain("h-7");
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).className,
    ).not.toContain("h-9");
    expect(queryByText("/tmp/work")).toBeNull();
    expect(
      getByTestId(`epic-terminal-sidebar-more-${SESSION_ID}`),
    ).not.toBeNull();
    expect(
      getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`),
    ).not.toBeNull();
    expect(
      queryByTestId(`epic-terminal-sidebar-kill-${SESSION_ID}`),
    ).toBeNull();

    fireEvent.click(
      getByTestId(`epic-terminal-sidebar-kill-menu-${SESSION_ID}`),
    );

    // The open tab is closed...
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull();
    // ...and the PTY is terminated.
    expect(killMutate).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("offers the ellipsis actions from the row context menu", async () => {
    const { getByTestId, findByRole } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.contextMenu(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );

    expect(await findByRole("menuitem", { name: "Rename" })).not.toBeNull();
    fireEvent.click(await findByRole("menuitem", { name: "Close" }));

    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull();
    expect(killMutate).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("retains canvas refs when a capable close has not acknowledged", async () => {
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = true;
    durableAuthority.collectionIncludesSession = true;
    seedOpenTerminalTab("host");
    let acknowledge: (() => void) | undefined;
    hostRequest.mockImplementation(
      (method, vars) =>
        new Promise((resolve, reject) => {
          acknowledge = () => {
            if (method !== "terminal.plain.close") {
              reject(new Error(`unexpected method ${method}`));
              return;
            }
            resolve(resolveCloseRequest(vars));
          };
        }),
    );
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.click(
      getByTestId(`epic-terminal-sidebar-kill-menu-${SESSION_ID}`),
    );

    await waitFor(() =>
      expect(durableCloseMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(durableCloseMutateAsync.mock.calls[0]?.[0]).toEqual({
      terminalId: SESSION_ID,
    });
    expect(killMutate).not.toHaveBeenCalled();
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).not.toBeNull();
    acknowledge?.();
    await waitFor(() =>
      expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull(),
    );
  });

  it("removes every canvas ref after a capable sidebar close acknowledges", async () => {
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = true;
    durableAuthority.collectionIncludesSession = true;
    durableCloseMutateAsync.mockResolvedValue();
    seedOpenTerminalTab("host");
    const duplicate = {
      id: SESSION_ID,
      instanceId: "inst-term-2",
      type: "terminal" as const,
      name: "Duplicate",
      hostId: "host-1",
      authority: "host" as const,
      legacyFallback: {
        name: "Duplicate",
        titleSource: "manual" as const,
        cwd: "/tmp/work",
      },
    };
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, duplicate);
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.click(
      getByTestId(`epic-terminal-sidebar-kill-menu-${SESSION_ID}`),
    );
    await waitFor(() =>
      expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull(),
    );
    expect(durableCloseMutateAsync).toHaveBeenCalledTimes(1);
    expect(killMutate).not.toHaveBeenCalled();
  });

  it("disables close while capable-host support is unknown", () => {
    durableAuthority.capability = "unknown";
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    const close = getByTestId(`epic-terminal-sidebar-kill-menu-${SESSION_ID}`);

    expect(close.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(close);
    expect(durableCloseMutateAsync).not.toHaveBeenCalled();
    expect(killMutate).not.toHaveBeenCalled();
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).not.toBeNull();
  });

  it.each([
    { capability: "capable", canMutate: true },
    { capability: "legacy", canMutate: false },
  ] as const)(
    "keeps a future-authority ref presentation-only when capability is $capability",
    ({ capability, canMutate }) => {
      durableAuthority.capability = capability;
      durableAuthority.canMutate = canMutate;
      durableAuthority.collectionIncludesSession = capability === "capable";
      seedOpenTerminalTab("future");
      const { getByTestId } = render(
        wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
      );

      const dropdownClose = getByTestId(
        `epic-terminal-sidebar-kill-menu-${SESSION_ID}`,
      );
      expect(dropdownClose.getAttribute("disabled")).not.toBeNull();
      fireEvent.click(dropdownClose);

      fireEvent.contextMenu(
        getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
      );
      const contextClose = getByTestId(
        `epic-terminal-sidebar-context-kill-${SESSION_ID}`,
      );
      expect(contextClose.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.keyDown(contextClose, { key: "Enter" });
      fireEvent.click(contextClose);

      expect(durableCloseMutateAsync).not.toHaveBeenCalled();
      expect(killMutate).not.toHaveBeenCalled();
      expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).not.toBeNull();
    },
  );

  it("does not suppress the native context menu while renaming", async () => {
    const { getByTestId, findByTestId, queryByRole } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`));

    const renameInput = await findByTestId(
      `epic-terminal-sidebar-rename-input-${SESSION_ID}`,
    );
    const contextMenuEvent = createEvent.contextMenu(renameInput);
    fireEvent(renameInput, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(false);
    expect(queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(queryByRole("menuitem", { name: "Close" })).toBeNull();
  });

  it("uses shared durable rename for a fresh capable terminal", () => {
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = true;
    durableAuthority.collectionIncludesSession = true;
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.doubleClick(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );
    const input = getByTestId(
      `epic-terminal-sidebar-rename-input-${SESSION_ID}`,
    );
    fireEvent.change(input, { target: { value: "Durable title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(durableRenameMutate.mock.calls[0]?.[0]).toEqual({
      terminalId: SESSION_ID,
      manualTitle: "Durable title",
    });
    expect(legacyRenameMutate).not.toHaveBeenCalled();
  });

  it("disables sidebar rename for a capable host compatibility row while canMutate is false", () => {
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = false;
    durableAuthority.collectionIncludesSession = false;
    const { getByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    const rename = getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`);
    expect(rename.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(rename);
    fireEvent.doubleClick(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );
    expect(
      queryByTestId(`epic-terminal-sidebar-rename-input-${SESSION_ID}`),
    ).toBeNull();
    expect(durableRenameMutate).not.toHaveBeenCalled();
    expect(legacyRenameMutate).not.toHaveBeenCalled();
  });

  it("keeps legacy rename for a capable host's compatibility row", () => {
    // Setup and provider-login shells stay `terminal.list` rows and never
    // enter the durable collection. The host still serves `terminal.rename`
    // for them, so a capable host must not strand them with rename disabled.
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = true;
    durableAuthority.collectionIncludesSession = false;
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(
      getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`).getAttribute(
        "disabled",
      ),
    ).toBeNull();
    fireEvent.doubleClick(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );
    const input = getByTestId(
      `epic-terminal-sidebar-rename-input-${SESSION_ID}`,
    );
    fireEvent.change(input, { target: { value: "Compatibility title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(legacyRenameMutate.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION_ID,
      title: "Compatibility title",
    });
    expect(durableRenameMutate).not.toHaveBeenCalled();
  });

  it("retains legacy sidebar rename only for a positively known old host", () => {
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.doubleClick(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );
    const input = getByTestId(
      `epic-terminal-sidebar-rename-input-${SESSION_ID}`,
    );
    fireEvent.change(input, { target: { value: "Legacy title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(legacyRenameMutate.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION_ID,
      title: "Legacy title",
    });
    expect(durableRenameMutate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unknown capability",
      capability: "unknown",
      canMutate: false,
      includesSession: true,
      renamePending: false,
    },
    {
      name: "stale capable authority",
      capability: "capable",
      canMutate: false,
      includesSession: true,
      renamePending: false,
    },
    {
      name: "unreachable capable authority",
      capability: "capable",
      canMutate: false,
      includesSession: true,
      renamePending: false,
    },
    {
      name: "pending durable mutation",
      capability: "capable",
      canMutate: true,
      includesSession: true,
      renamePending: true,
    },
  ] as const)(
    "disables sidebar rename for $name",
    ({ capability, canMutate, includesSession, renamePending }) => {
      durableAuthority.capability = capability;
      durableAuthority.canMutate = canMutate;
      durableAuthority.collectionIncludesSession = includesSession;
      durableAuthority.renamePending = renamePending;
      const { getByTestId, queryByTestId } = render(
        wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
      );
      const rename = getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`);

      expect(rename.getAttribute("disabled")).not.toBeNull();
      fireEvent.doubleClick(
        getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
      );
      expect(
        queryByTestId(`epic-terminal-sidebar-rename-input-${SESSION_ID}`),
      ).toBeNull();
      expect(durableRenameMutate).not.toHaveBeenCalled();
      expect(legacyRenameMutate).not.toHaveBeenCalled();
    },
  );

  it("disables sidebar rename for an unsupported future-authority ref", () => {
    durableAuthority.capability = "capable";
    durableAuthority.canMutate = true;
    durableAuthority.collectionIncludesSession = true;
    seedOpenTerminalTab("future");
    const { getByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    const rename = getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`);
    expect(rename.getAttribute("disabled")).not.toBeNull();
    fireEvent.doubleClick(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );
    expect(
      queryByTestId(`epic-terminal-sidebar-rename-input-${SESSION_ID}`),
    ).toBeNull();
    expect(durableRenameMutate).not.toHaveBeenCalled();
    expect(legacyRenameMutate).not.toHaveBeenCalled();
  });

  it("prefixes the active process with the directory for an unnamed terminal", () => {
    terminalSessions.value = [{ ...RUNNING_SESSION, activeProcessName: "vim" }];

    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).textContent,
    ).toBe("work · vim");
  });

  it("shows the empty terminal panel state when there are no terminals", () => {
    terminalSessions.value = [];

    const { getByTestId, getByText, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(getByTestId("epic-terminal-sidebar-empty")).not.toBeNull();
    expect(getByText("No terminals yet.")).not.toBeNull();
    expect(queryByTestId("epic-terminal-sidebar-list")).toBeNull();
  });
});
