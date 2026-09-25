/**
 * `SwitcherRowActions`'s terminal-agent delete must target the row's OWNING
 * host, not whichever host the session/window happens to be on - a
 * host-minted id is unique per host, not globally. Tile-close and
 * closed-payload cleanup for the delete are owned by the mutation hook
 * itself (`useEpicDeleteTuiAgent`, mocked here) and covered by that hook's
 * own regression suite, not this component-level one.
 *
 * Network mutation hooks are mocked; the open-epic store feeding
 * `useEpicNodeHostId` is real, since the owner-host derivation this suite
 * pins depends on it.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import {
  EpicSessionContext,
  __getOpenEpicRegistryForTests,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const {
  deleteTuiAgentMutate,
  deleteChatMutate,
  deleteArtifactMutate,
  exportMutate,
} = vi.hoisted(() => ({
  deleteTuiAgentMutate: vi.fn(),
  deleteChatMutate: vi.fn(),
  deleteArtifactMutate: vi.fn(),
  exportMutate: vi.fn(),
}));

vi.mock("@/hooks/epic/use-epic-export-artifacts-mutation", () => ({
  useEpicExportArtifacts: () => ({ mutate: exportMutate, isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicDeleteChat: () => ({ mutate: deleteChatMutate, isPending: false }),
  useEpicRenameChat: () => ({
    mutateAsync: vi.fn(() => new Promise(() => undefined)),
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgent: () => ({
    mutate: deleteTuiAgentMutate,
    isPending: false,
  }),
  useEpicRenameTuiAgent: () => ({
    mutateAsync: vi.fn(() => new Promise(() => undefined)),
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicDeleteArtifact: () => ({
    mutate: deleteArtifactMutate,
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-record-mutation-client", () => ({
  useEpicRecordMutationClient: () => () => null,
}));

const EPIC_ID = "epic-switcher-row-actions";
const VIEWER_ID = "viewer-switcher-row-actions";
const NODE_ID = "agent-shared";
const HOST_B = "host-B";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Switcher row actions",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

function tuiAgentProjection(hostId: string): TuiAgentProjection {
  return {
    id: NODE_ID,
    docResident: false,
    origin: "registry",
    harnessId: null,
    title: "Shared terminal agent",
    parentId: null,
    createdAt: 1,
    updatedAt: 2,
    userId: VIEWER_ID,
    hostId,
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    archivedAt: null,
    profileId: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    sessionState: null,
    lastExit: null,
  };
}

let handle: OpenedStoreForTest;
let tabId: string;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const registry = __getOpenEpicRegistryForTests();
  registry.disposeAll();
  handle = newSession();
  registry.acquireMounted(EPIC_ID, () => handle);
  // The row's owning host - `agent-shared` is bound to host-B in the record
  // plane, which is what `useEpicNodeHostId` (real, under test) resolves.
  handle.store.setState({
    tuiAgents: {
      byId: { [NODE_ID]: tuiAgentProjection(HOST_B) },
      allIds: [NODE_ID],
    },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  tabId = useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Tab");
});

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  handle.store.getState().dispose();
  vi.clearAllMocks();
});

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={handle}>
        {props.children}
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

describe("SwitcherRowActions terminal-agent delete", () => {
  it("sends the delete to the row's OWNING host, derived from the real projection", () => {
    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="terminal-agent"
        nodeId={NODE_ID}
        name="Shared terminal agent"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId(`switcher-more-${NODE_ID}`), {
      button: 0,
    });
    fireEvent.click(screen.getByTestId(`switcher-delete-${NODE_ID}`));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(deleteTuiAgentMutate).toHaveBeenCalledExactlyOnceWith({
      epicId: EPIC_ID,
      tuiAgentId: NODE_ID,
      hostId: HOST_B,
    });
  });
});

const ARTIFACT_NODE_ID = "artifact-1";

describe("artifact export", () => {
  it("lists both export items ahead of Rename on an artifact row, and exporting calls the mutation", () => {
    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="artifact"
        nodeId={ARTIFACT_NODE_ID}
        name="Artifact One"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.pointerDown(
      screen.getByTestId(`switcher-more-${ARTIFACT_NODE_ID}`),
      { button: 0 },
    );

    const markdownItem = screen.getByTestId(
      `switcher-export-markdown-${ARTIFACT_NODE_ID}`,
    );
    const pdfItem = screen.getByTestId(
      `switcher-export-pdf-${ARTIFACT_NODE_ID}`,
    );
    const renameItem = screen.getByTestId(
      `switcher-rename-${ARTIFACT_NODE_ID}`,
    );
    expect(
      markdownItem.compareDocumentPosition(renameItem) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      pdfItem.compareDocumentPosition(renameItem) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(pdfItem);

    expect(exportMutate).toHaveBeenCalledExactlyOnceWith({
      artifacts: [{ id: ARTIFACT_NODE_ID, title: "Artifact One" }],
      format: "pdf",
      archive: false,
      archiveTitle: null,
    });
  });

  it("has no export items on a terminal-agent row", () => {
    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="terminal-agent"
        nodeId={NODE_ID}
        name="Shared terminal agent"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.pointerDown(screen.getByTestId(`switcher-more-${NODE_ID}`), {
      button: 0,
    });

    expect(
      screen.queryByTestId(`switcher-export-markdown-${NODE_ID}`),
    ).toBeNull();
    expect(screen.queryByTestId(`switcher-export-pdf-${NODE_ID}`)).toBeNull();
  });

  it("keeps the artifact menu for a viewer, with export enabled and Rename disabled", () => {
    handle.store.setState({ permissionRole: "viewer" });

    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="artifact"
        nodeId={ARTIFACT_NODE_ID}
        name="Artifact One"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.pointerDown(
      screen.getByTestId(`switcher-more-${ARTIFACT_NODE_ID}`),
      { button: 0 },
    );

    const pdfItem = screen.getByTestId(
      `switcher-export-pdf-${ARTIFACT_NODE_ID}`,
    );
    expect(pdfItem.hasAttribute("data-disabled")).toBe(false);

    const renameItem = screen.getByTestId(
      `switcher-rename-${ARTIFACT_NODE_ID}`,
    );
    expect(renameItem.hasAttribute("data-disabled")).toBe(true);
  });
});
