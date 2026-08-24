import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  replacePlainTerminalState,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import {
  acceptEpicTerminalDurableCreate,
  requestEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The phone Terminals category over the SHARED panel layer, against the real
 * canvas store: what a phone lists, and what a tap binds a tile to, are the two
 * things that drifted while this surface read `terminal.list` on its own, so
 * both are exercised end to end here. Only host transport, the plain-terminal
 * authority and the sibling create row are faked.
 */

const EPIC_ID = "epic-1";
const HOST_A = "host-a";
const HOST_B = "host-b";
const SHARED_ID = "shared-term";

interface DurableCollectionHolder {
  value: PlainTerminalCollection | null;
}
interface ListedSessionsHolder {
  value: CanonicalTerminalSessionInfo[];
}
interface ListQueryHolder {
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  refetchCalls: number;
}
interface AuthorityHolder {
  capability: "unknown" | "legacy" | "capable";
  canMutate: boolean;
}
interface RoleHolder {
  value: "owner" | "viewer";
}

const durableCollection = vi.hoisted((): DurableCollectionHolder => ({
  value: null,
}));
const listedSessions = vi.hoisted((): ListedSessionsHolder => ({ value: [] }));
const listQuery = vi.hoisted((): ListQueryHolder => ({
  isPending: false,
  isError: false,
  errorMessage: null,
  refetchCalls: 0,
}));
const authority = vi.hoisted((): AuthorityHolder => ({
  capability: "capable",
  canMutate: true,
}));
const role = vi.hoisted((): RoleHolder => ({ value: "owner" }));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => HOST_A,
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({ request: vi.fn() }),
}));
vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => ({ request: vi.fn() }),
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: listedSessions.value },
    isPending: listQuery.isPending,
    isError: listQuery.isError,
    error:
      listQuery.errorMessage === null
        ? null
        : { message: listQuery.errorMessage },
    isFetching: false,
    refetch: () => {
      listQuery.refetchCalls += 1;
    },
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
    hostId: HOST_A,
    scope: { kind: "epic", epicId: EPIC_ID },
    capability:
      authority.capability === "capable"
        ? { status: "capable", schemaVersion: { major: 2, minor: 1 } }
        : { status: authority.capability },
    canMutate: authority.canMutate,
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
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));
vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => role.value,
}));
// The create row opens the host + folder picker, a sibling surface with its own
// coverage; this file is about the list below it.
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewTerminalRow: () => (
    <button type="button" data-testid="switcher-new-terminal" />
  ),
}));
vi.mock("@/components/resources/resource-usage-chip", () => ({
  OwnerResourceChip: (props: {
    readonly ownerId: string;
    readonly hostId: string | null;
  }) => (
    <span
      data-testid={`owner-resource-chip-${props.hostId}-${props.ownerId}`}
    />
  ),
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

import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";

function durableTerminal(args: {
  readonly hostId: string;
  readonly terminalId: string;
  readonly title: string;
  readonly runtime: PlainTerminalProjection["runtime"];
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: args.terminalId,
      hostId: args.hostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      launch: { cwd: "/tmp/work", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: args.title,
      revision: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    runtime: args.runtime,
  };
}

function runningRuntime(
  terminalId: string,
): PlainTerminalProjection["runtime"] {
  return {
    status: "running",
    sessionId: terminalId,
    currentCwd: "/tmp/work",
    activeProcessName: null,
    cols: 80,
    rows: 24,
  };
}

function completeFleet(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return settlePlainTerminalSnapshot(
    replacePlainTerminalState(undefined, {
      coverage: "complete-fleet",
      scope: { kind: "epic", epicId: EPIC_ID },
      terminals: [...terminals],
    }),
  );
}

function wrapper(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

const onClose = vi.fn();

function openEpicTab(): string {
  return useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Epic");
}

function renderList(tabId: string) {
  return render(
    wrapper(
      <SwitcherTerminalsList
        epicId={EPIC_ID}
        tabId={tabId}
        onClose={onClose}
      />,
    ),
  );
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSettingsStore.setState({ showNavigatorResourceStats: false });
  resetEpicTerminalDurableCreatesForTests();
  durableCollection.value = null;
  listedSessions.value = [];
  listQuery.isPending = false;
  listQuery.isError = false;
  listQuery.errorMessage = null;
  listQuery.refetchCalls = 0;
  authority.capability = "capable";
  authority.canMutate = true;
  role.value = "owner";
  onClose.mockClear();
});
afterEach(() => {
  cleanup();
  useSettingsStore.setState({ showNavigatorResourceStats: false });
  resetEpicTerminalDurableCreatesForTests();
});

describe("<SwitcherTerminalsList /> rows", () => {
  it("lists durable projections a raw terminal.list read cannot see", () => {
    // Capable host, no live PTY in `terminal.list`: before the shared panel
    // layer this list was empty on a phone and populated on desktop.
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_A,
        terminalId: "durable-term",
        title: "Durable shell",
        runtime: { status: "unknown" },
      }),
    ]);
    renderList(openEpicTab());
    // Anchored: the row and its "…" trigger are both buttons, and the trigger
    // is named "Actions for Durable shell".
    const row = screen.getByRole("button", { name: /^Durable shell/ });
    expect(row.textContent).toContain("Durable shell");
    // Desktop's per-row status line, which the phone used to drop.
    expect(row.textContent).toContain("Runtime status unavailable");
  });

  it("marks only the row whose owner host holds the open tile", () => {
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_A,
        terminalId: SHARED_ID,
        title: "Host A shell",
        runtime: runningRuntime(SHARED_ID),
      }),
      durableTerminal({
        hostId: HOST_B,
        terminalId: SHARED_ID,
        title: "Host B shell",
        runtime: runningRuntime(SHARED_ID),
      }),
    ]);
    const tabId = openEpicTab();
    useEpicCanvasStore.getState().openTileInTab(tabId, {
      id: SHARED_ID,
      instanceId: "inst-host-a",
      type: "terminal",
      name: "Host A shell",
      hostId: HOST_A,
      authority: "host",
      legacyFallback: {
        name: "Host A shell",
        titleSource: "manual",
        cwd: "/tmp/work",
      },
    });
    renderList(tabId);

    // Two rows share a terminalId across hosts: matching on the id alone lights
    // both up, which is exactly what the id-only mobile selector did.
    const hostA = screen.getByRole("button", { name: /^Host A shell/ });
    const hostB = screen.getByRole("button", { name: /^Host B shell/ });
    expect(hostA.getAttribute("aria-current")).toBe("true");
    expect(hostB.getAttribute("aria-current")).toBeNull();
  });

  it("opens a durable row as a host-authority tile and closes the sheet", () => {
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_B,
        terminalId: "durable-term",
        title: "Durable shell",
        runtime: runningRuntime("durable-term"),
      }),
    ]);
    const tabId = openEpicTab();
    renderList(tabId);
    fireEvent.click(screen.getByRole("button", { name: /^Durable shell/ }));

    const tiles = Object.values(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId ??
        {},
    );
    expect(tiles).toHaveLength(1);
    const tile = tiles[0];
    if (tile === undefined || tile.type !== "terminal") {
      throw new Error("expected a terminal tile");
    }
    // The row's OWNER host, and the host lifetime authority - the two fields
    // the hand-built mobile ref got wrong.
    expect(tile.hostId).toBe(HOST_B);
    expect("authority" in tile && tile.authority === "host").toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("carries the resource chip for the row's owner host when stats are on", () => {
    useSettingsStore.setState({ showNavigatorResourceStats: true });
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_B,
        terminalId: "durable-term",
        title: "Durable shell",
        runtime: runningRuntime("durable-term"),
      }),
    ]);
    renderList(openEpicTab());
    expect(
      screen.getByTestId(`owner-resource-chip-${HOST_B}-durable-term`),
    ).toBeTruthy();
  });

  it("gives an editor Rename and Close, and a viewer no menu at all", () => {
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_A,
        terminalId: "durable-term",
        title: "Durable shell",
        runtime: runningRuntime("durable-term"),
      }),
    ]);
    const editor = renderList(openEpicTab());
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    editor.unmount();

    role.value = "viewer";
    renderList(openEpicTab());
    expect(
      screen.queryByRole("button", { name: "Actions for Durable shell" }),
    ).toBeNull();
  });

  it("disables both mutations for a durable row the client may not mutate", () => {
    authority.canMutate = false;
    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_A,
        terminalId: "durable-term",
        title: "Durable shell",
        runtime: runningRuntime("durable-term"),
      }),
    ]);
    renderList(openEpicTab());
    const close = screen.getByRole<HTMLButtonElement>("button", {
      name: "Close",
    });
    expect(close.disabled).toBe(true);
    // Rename goes through the same authority gate, so a regression that leaves
    // it enabled for a non-mutating client would otherwise pass here.
    const rename = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rename",
    });
    expect(rename.disabled).toBe(true);
  });
});

describe("<SwitcherTerminalsList /> states", () => {
  it("holds the loading state instead of claiming there are no terminals", () => {
    authority.capability = "unknown";
    renderList(openEpicTab());
    expect(screen.getByTestId("switcher-terminal-loading")).toBeTruthy();
    expect(screen.queryByText("No terminals yet.")).toBeNull();
  });

  it("surfaces a load failure with the host's message and a retry", () => {
    listQuery.isError = true;
    listQuery.errorMessage = "host unreachable";
    renderList(openEpicTab());
    expect(screen.getByTestId("switcher-terminal-error").textContent).toContain(
      "host unreachable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(listQuery.refetchCalls).toBe(1);
  });

  it("shows the empty state only when the list is genuinely empty", () => {
    durableCollection.value = completeFleet([]);
    renderList(openEpicTab());
    expect(screen.getByTestId("switcher-terminal-empty")).toBeTruthy();
    expect(screen.getByText("No terminals yet.")).toBeTruthy();
    // The create row stays above it either way.
    expect(screen.getByTestId("switcher-new-terminal")).toBeTruthy();
  });

  it("gives a viewer no New terminal row, empty list or not", () => {
    // A viewer's create is server-rejected, so the row would only lead to a
    // dead end. The gate lives on the list, not inside the create row.
    role.value = "viewer";
    durableCollection.value = completeFleet([]);
    const empty = renderList(openEpicTab());
    expect(screen.getByTestId("switcher-terminal-empty")).toBeTruthy();
    expect(screen.queryByTestId("switcher-new-terminal")).toBeNull();
    empty.unmount();

    durableCollection.value = completeFleet([
      durableTerminal({
        hostId: HOST_A,
        terminalId: "term-1",
        title: "Build",
        runtime: runningRuntime("term-1"),
      }),
    ]);
    renderList(openEpicTab());
    expect(screen.queryByTestId("switcher-new-terminal")).toBeNull();
  });

  it("offers retry and discard for a durable create that failed", async () => {
    authority.capability = "unknown";
    acceptEpicTerminalDurableCreate({
      hostId: HOST_A,
      terminalId: "failed-term",
      epicId: EPIC_ID,
      cwd: "/tmp/work",
      cols: 80,
      rows: 24,
    });
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: HOST_A,
        terminalId: "failed-term",
        ready: true,
        create: () => Promise.reject(new Error("host offline")),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("host offline");

    renderList(openEpicTab());
    const key = epicTerminalUiIdentityKey("failed", HOST_A, "failed-term");
    expect(
      screen.getByTestId(`switcher-terminal-failed-create-${key}`).textContent,
    ).toContain("host offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    // A failed create is not an empty list.
    expect(screen.queryByTestId("switcher-terminal-empty")).toBeNull();
  });
});
