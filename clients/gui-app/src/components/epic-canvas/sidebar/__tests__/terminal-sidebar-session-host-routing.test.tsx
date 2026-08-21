import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";

/**
 * The terminals panel is a sidebar - a sibling of the canvas, outside every
 * tile `TabHostProvider` - so both of its host reads belong to the Epic
 * SESSION, never to the app-wide effective host. The two disagree for as long
 * as a re-point is establishing (and permanently if it failed), which is
 * exactly when an Epic projected from host A would otherwise list, operate on
 * and open host B's terminals.
 *
 * Every ambient reader the panel used to call is mocked here with a DIFFERENT
 * host than the session's, so the two sources are always distinguishable: a
 * build that reads either one fails on the value, not on an absence. That is
 * the whole design of this fixture - `hostId` threading is not observable, so
 * the assertions are on the two things a wrong host actually produces: the
 * client `terminal.list` is issued on, and the host each opened tile is bound
 * to for life.
 */
const SESSION_ID = "term-1";
const TAB_ID = "tab-1";
const SESSION_HOST = "host-session";
const AMBIENT_HOST = "host-ambient";

// Identity sentinels, not real clients: nothing here dials, and the assertion
// is "which object was handed to the query", which `toBe` answers exactly.
const clients = vi.hoisted(() => ({
  ambient: { label: "ambient-client" },
  session: { label: "session-client" },
}));
const listCalls = vi.hoisted<{ clients: unknown[] }>(() => ({ clients: [] }));
// The client each ROW hands to its kill / rename mutation - the two reads
// that stayed on the ambient host after the list moved (PR #1243, round 6).
const mutationClients = vi.hoisted<{ kill: unknown[]; rename: unknown[] }>(
  () => ({ kill: [], rename: [] }),
);
const terminalSessions = vi.hoisted<{
  value: ReadonlyArray<CanonicalTerminalSessionInfo>;
}>(() => ({ value: [] }));

vi.mock("@/lib/host", () => ({
  useHostClient: () => clients.ambient,
  useHostRuntimeClient: () => clients.ambient,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => AMBIENT_HOST,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => clients.session,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST,
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: (_scope: unknown, client: unknown) => {
    listCalls.clients.push(client);
    return {
      data: { sessions: terminalSessions.value },
      isPending: false,
      isError: false,
      error: null,
    };
  },
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: (client: unknown) => {
    mutationClients.kill.push(client);
    return { mutate: vi.fn(), isPending: false };
  },
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: (client: unknown) => {
    mutationClients.rename.push(client);
    return { mutate: vi.fn(), isPending: false };
  },
}));

// This suite is about the LEGACY unary path (`useTerminalList` above), not
// the durable stream authority main added alongside it; wholesale-mocked out
// of scope, same as its sibling terminal-sidebar-durable-projection.test.tsx.
vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: SESSION_HOST,
    scope: { kind: "epic", epicId: "epic-1" },
    capability: { status: "legacy" },
    canMutate: false,
    collection: undefined,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useHostPlainTerminalMutations: () => ({
    close: { mutateAsync: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => ({
    request: vi.fn(),
  }),
}));

import { TerminalsPanelBody } from "../epic-terminal-sidebar";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

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

describe("terminals panel resolves through the Epic session host", () => {
  beforeEach(() => {
    listCalls.clients = [];
    mutationClients.kill = [];
    mutationClients.rename = [];
    terminalSessions.value = [RUNNING_SESSION];
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useEpicCanvasStore.setState({
      tabsById: {
        [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("issues terminal.list on the session's client, not the ambient one", () => {
    render(wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />));

    // The panel rendered and asked for a list at all - without this, an empty
    // `listCalls` would satisfy any `not.toContain(ambient)` phrasing.
    expect(listCalls.clients.length).toBeGreaterThan(0);
    for (const client of listCalls.clients) {
      expect(client).toBe(clients.session);
    }
  });

  it("a row's kill and rename mutations take the session's client, not the ambient one", () => {
    // The list moved to the session client in an earlier round; kill and
    // rename in the same row still rode the app-wide wrappers, so during a
    // re-point host A's rows killed and renamed host B's sessions.
    render(wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />));

    expect(mutationClients.kill.length).toBeGreaterThan(0);
    expect(mutationClients.rename.length).toBeGreaterThan(0);
    for (const client of mutationClients.kill) {
      expect(client).toBe(clients.session);
    }
    for (const client of mutationClients.rename) {
      expect(client).toBe(clients.session);
    }
  });

  it("binds a terminal opened from a row to the session host", () => {
    // Precondition: nothing is open for this session, so the click takes the
    // `makeTerminalRef` arm rather than re-focusing an existing tile.
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull();

    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    fireEvent.click(getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`));

    const opened = findOpenArtifactInTab(TAB_ID, SESSION_ID);
    expect(opened).not.toBeNull();
    const tile =
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId[
        opened?.instanceId ?? ""
      ];
    expect(tile?.hostId).toBe(SESSION_HOST);
  });
});
