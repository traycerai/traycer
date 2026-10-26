import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  forgetEndedSandboxHost,
  recordEndedSandboxHost,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

interface TestBootstrapState {
  reachability: {
    status: string;
    hostLabel: string;
    basis: string;
    unavailability: string | null;
  };
  createIsError: boolean;
  createError: { readonly message: string } | null;
  entry: HostDirectoryEntry | null;
}

const testState = vi.hoisted<TestBootstrapState>(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  },
  createIsError: true,
  createError: {
    message: "secret-token-should-never-render /Users/hostile/path",
  },
  entry: null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => testState.entry,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: 0,
    recoveryExhausted: false,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: () => undefined,
  }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: null,
    createIsError: testState.createIsError,
    createError: testState.createError,
    retry: () => undefined,
    hostHasSession: false,
    hostSessionExited: false,
  }),
}));

vi.mock("@/hooks/terminal/use-epic-terminal-authority", () => ({
  useEpicTerminalAuthority: () => ({
    capability: "legacy",
    projection: undefined,
    viewModel: null,
    canMutate: false,
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    create: {},
    ensureRunning: {},
    rename: {},
    close: {},
  }),
}));

vi.mock("@/lib/perf/terminal-load-perf", () => ({
  beginTerminalLoad: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: { TerminalOpened: "TerminalOpened" },
  Analytics: {
    getInstance: () => ({ track: vi.fn() }),
  },
}));

import { TerminalTile } from "../terminal-tile";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

function withTabHost(node: ReactNode): ReactNode {
  return <TabHostProvider hostId={HOST_ID}>{node}</TabHostProvider>;
}

function terminalNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "shell",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "/work/repo",
  };
}

function renderErroredTile(): void {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const node = terminalNode("terminal-1", "inst-terminal-1");
  store.openTileInTab(viewTabId, node);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const paneId = collectPanes(canvas.root)[0].id;
  render(
    withTabHost(
      <TerminalTile
        viewTabId={viewTabId}
        node={node}
        tileId={paneId}
        isActive
      />,
    ),
  );
}

describe("<TerminalTile /> bootstrap error report action", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    testState.reachability = {
      status: "reachable",
      hostLabel: "Host A",
      basis: "directory",
      unavailability: null,
    };
    testState.createIsError = true;
    testState.createError = {
      message: "secret-token-should-never-render /Users/hostile/path",
    };
    testState.entry = null;
  });

  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action when the support capability is unavailable", () => {
    renderErroredTile();

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context, never the raw bootstrap error", () => {
    renderErroredTile();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Failed to start terminal",
        message: "The terminal session could not be started.",
        code: null,
        source: "Terminal",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });
});

function sandboxEntry(
  sandboxState: HostListItem["sandboxState"],
): HostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId: HOST_ID,
      displayName: "e2e-sbx-p1",
      platform: "linux",
      kind: "sandbox",
      sandboxState,
      publicKey: "pk",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatePolicy: "manual",
      status: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      owner: { kind: "user", id: "user-1" },
    },
    "wss://relay.example.test",
  );
}

describe("<TerminalTile /> on an unreachable host", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    testState.createIsError = false;
    testState.createError = null;
    testState.reachability = {
      status: "unreachable",
      hostLabel: "e2e-sbx-p1",
      basis: "directory",
      unavailability: null,
    };
  });

  afterEach(() => {
    cleanup();
    __resetAppLocalNotificationsStoreForTests();
    forgetEndedSandboxHost(HOST_ID);
  });

  function closedMessage(): string {
    const entries = Object.values(
      useAppLocalNotificationsStore.getState().byId,
    );
    return entries.map((entry) => entry.message).join("\n");
  }

  it("says a stopped sandbox is stopped, in the banner and the notification", () => {
    testState.entry = sandboxEntry("stopped");

    renderErroredTile();

    expect(
      screen.getByText(
        "e2e-sbx-p1 is stopped. Start it to use this terminal again.",
      ),
    ).toBeTruthy();
    expect(closedMessage()).toBe("Terminal closed: e2e-sbx-p1 was stopped.");
  });

  it("says who destroyed a sandbox a member destroyed, and raises no terminal-closed notification", () => {
    testState.entry = sandboxEntry("destroyed");
    recordEndedSandboxHost(HOST_ID, {
      name: "e2e-sbx-p1",
      at: new Date(2026, 9, 25, 11, 1).getTime(),
      actor: { userId: "user-2", displayName: "Priya" },
    });

    renderErroredTile();

    expect(
      screen.getByText("e2e-sbx-p1 was destroyed by Priya at 11:01."),
    ).toBeTruthy();
    expect(screen.queryByText(/permanently closed/)).toBeNull();
    expect(closedMessage()).toBe("");
  });

  it("keeps saying the host is unreachable for a host that is not a stopped sandbox", () => {
    testState.entry = sandboxEntry("awake");

    renderErroredTile();

    expect(
      screen.getByText(
        'Host "e2e-sbx-p1" is unreachable. This terminal is permanently closed.',
      ),
    ).toBeTruthy();
    expect(closedMessage()).toBe(
      'Terminal closed: host "e2e-sbx-p1" is unreachable.',
    );
  });
});
