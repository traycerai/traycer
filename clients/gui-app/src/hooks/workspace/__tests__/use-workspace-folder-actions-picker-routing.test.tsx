import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

const prepareMutateAsync = vi.fn<(variables: object) => Promise<object>>();
const recordRecent = vi.fn();
const toastMock = vi.fn();
const afterRawResponse = vi.fn();

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    readonly onResponse?: (response: object) => void;
  }) => ({
    mutateAsync: async (variables: object) => {
      const response = await prepareMutateAsync(variables);
      args.onResponse?.(response);
      afterRawResponse();
      return response;
    },
    mutate: recordRecent,
  }),
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: (...args: ReadonlyArray<unknown>) => {
    toastMock(...args);
  },
}));

const REMOTE_HOST: HostDirectoryEntry = {
  hostId: "host-remote",
  label: "Remote Mac",
  kind: "remote",
  websocketUrl: "wss://example.invalid/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

const LOCAL_HOST: HostDirectoryEntry = {
  hostId: "host-local",
  label: "This Mac",
  kind: "local",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "dialable",
};

function makeBoundClient(
  host: HostDirectoryEntry,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) => (hostId === host.hostId ? host : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
  });
  return spine.createRequester(host);
}

function makeWrapper() {
  const queryClient = new QueryClient();
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function recordPrepareVersion(hostId: string, minor: number): void {
  recordNegotiatedHostManifest(hostId, {
    "workspace.prepareFolders": { major: 1, minor },
  });
}

/**
 * Captured before any test overrides `requestPick`, so each test starts from
 * the real store rather than from whatever the previous one installed.
 */
const INITIAL_PICKER_STATE = useRemoteFolderPickerStore.getState();

/**
 * The picker is handed a requester PINNED to the dispatch host, not the
 * caller's client, so identity is asserted by which host it is bound to.
 */
function pickedHostIdOf(requestPick: Mock): string | null {
  const passed = requestPick.mock.calls[0]?.[0] as
    HostClient<HostRpcRegistry> | undefined;
  return passed?.getActiveHostId() ?? null;
}

describe("pickAndPrepareFolders picker routing", () => {
  beforeEach(() => {
    recordPrepareVersion(REMOTE_HOST.hostId, 4);
    recordPrepareVersion(LOCAL_HOST.hostId, 4);
    prepareMutateAsync.mockReset();
    recordRecent.mockReset();
    toastMock.mockReset();
    afterRawResponse.mockReset();
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetNegotiatedManifests();
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });

  it("browses a remote host through the shared picker", async () => {
    const requestPick = vi.fn().mockResolvedValue({
      kind: "prepare",
      folderPaths: ["/remote/projects/app"],
    });
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const client = makeBoundClient(REMOTE_HOST);
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(client),
      { wrapper: makeWrapper() },
    );
    await result.current.pickAndPrepareFolders(false);
    // Pinned to the dispatch host, not merely the caller's client: an
    // app-wide client could switch hosts while the dialog is open.
    expect(pickedHostIdOf(requestPick)).toBe(REMOTE_HOST.hostId);
    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
      bumpRecency: null,
    });
    expect(toastMock).not.toHaveBeenCalled();
    expect(recordRecent).not.toHaveBeenCalled();
  });

  it("browses the current machine through the same shared picker", async () => {
    const requestPick = vi.fn().mockResolvedValue({
      kind: "prepare",
      folderPaths: ["/Users/tester/app"],
    });
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const client = makeBoundClient(LOCAL_HOST);
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(client),
      { wrapper: makeWrapper() },
    );
    await result.current.pickAndPrepareFolders(false);
    // The picker received exactly the requester's (host-bound) client...
    expect(requestPick).toHaveBeenCalledTimes(1);
    // Pinned to the dispatch host, not merely the caller's client: an
    // app-wide client could switch hosts while the dialog is open.
    expect(pickedHostIdOf(requestPick)).toBe(LOCAL_HOST.hostId);
    // The host-browser pick flows through the same preparation path.
    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/Users/tester/app"],
      path: null,
      bumpRecency: null,
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("prepares every folder returned by the shared picker", async () => {
    useRemoteFolderPickerStore.setState({
      requestPick: vi.fn().mockResolvedValue({
        kind: "prepare",
        folderPaths: ["/Users/tester/app", "/Users/tester/docs"],
      }),
    });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(LOCAL_HOST)),
      { wrapper: makeWrapper() },
    );

    await result.current.pickAndPrepareFolders(false);

    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/Users/tester/app", "/Users/tester/docs"],
      path: null,
      bumpRecency: null,
    });
  });

  it("a cancelled pick prepares nothing", async () => {
    const requestPick = vi.fn().mockResolvedValue(null);
    useRemoteFolderPickerStore.setState({ requestPick });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(REMOTE_HOST)),
      { wrapper: makeWrapper() },
    );
    const outcome = await result.current.pickAndPrepareFolders(false);
    expect(outcome).toBeNull();
    expect(prepareMutateAsync).not.toHaveBeenCalled();
  });

  it("creates and prepares a missing directory in one host operation", async () => {
    const requestPick = vi.fn().mockResolvedValue({
      kind: "createAndPrepare",
      path: "/remote/projects/new-app",
    });
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(REMOTE_HOST)),
      { wrapper: makeWrapper() },
    );

    await result.current.pickAndPrepareFolders(false);

    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "createAndPrepare",
      folderPaths: null,
      path: "/remote/projects/new-app",
      bumpRecency: null,
    });
  });

  it("records prepared workspace attachments in the same v1.4 request", async () => {
    useRemoteFolderPickerStore.setState({
      requestPick: vi.fn().mockResolvedValue({
        kind: "prepare",
        folderPaths: ["/remote/projects/app"],
      }),
    });
    prepareMutateAsync.mockResolvedValue({
      folders: [
        {
          workspacePath: "/remote/projects/app",
          workspaceName: "app",
          repoIdentifier: null,
        },
      ],
      repoIdentifiers: [],
      recentWorkspaces: [
        {
          path: "/remote/projects/app",
          lastOpenedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
    });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(REMOTE_HOST)),
      { wrapper: makeWrapper() },
    );

    await result.current.pickAndPrepareFolders(true);

    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
      bumpRecency: true,
    });
    expect(recordRecent).not.toHaveBeenCalled();
  });

  it("falls back to the legacy recent-workspace operation for a v1.3 host", async () => {
    recordPrepareVersion(REMOTE_HOST.hostId, 3);
    useRemoteFolderPickerStore.setState({
      requestPick: vi.fn().mockResolvedValue({
        kind: "prepare",
        folderPaths: ["/remote/projects/app"],
      }),
    });
    prepareMutateAsync.mockResolvedValue({
      folders: [
        {
          workspacePath: "/remote/projects/app",
          workspaceName: "app",
          repoIdentifier: null,
        },
      ],
      repoIdentifiers: [],
      recentWorkspaces: null,
    });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(REMOTE_HOST)),
      { wrapper: makeWrapper() },
    );

    await result.current.pickAndPrepareFolders(true);

    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
      bumpRecency: true,
    });
    expect(recordRecent).toHaveBeenCalledWith({
      path: "/remote/projects/app",
      bumpRecency: true,
      failureFeedback: "silent",
    });
  });

  it.each([
    {
      name: "uses v1.4 negotiated by prepare after a cached v1.3 manifest",
      before: 3,
      after: 4,
      later: 3,
      recordsLegacyRecent: false,
    },
    {
      name: "falls back when prepare negotiates v1.3 after a cached v1.4 manifest",
      before: 4,
      after: 3,
      later: 4,
      recordsLegacyRecent: true,
    },
  ])("$name", async ({ before, after, later, recordsLegacyRecent }) => {
    resetNegotiatedManifests();
    recordPrepareVersion(REMOTE_HOST.hostId, before);
    useRemoteFolderPickerStore.setState({
      requestPick: vi.fn().mockResolvedValue({
        kind: "prepare",
        folderPaths: ["/remote/projects/app"],
      }),
    });
    prepareMutateAsync.mockImplementation(() => {
      recordPrepareVersion(REMOTE_HOST.hostId, after);
      return Promise.resolve({
        folders: [
          {
            workspacePath: "/remote/projects/app",
            workspaceName: "app",
            repoIdentifier: null,
          },
        ],
        repoIdentifiers: [],
        recentWorkspaces: null,
      });
    });
    afterRawResponse.mockImplementation(() => {
      recordPrepareVersion(REMOTE_HOST.hostId, later);
    });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient(REMOTE_HOST)),
      { wrapper: makeWrapper() },
    );

    await result.current.pickAndPrepareFolders(true);

    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
      bumpRecency: true,
    });
    expect(recordRecent).toHaveBeenCalledTimes(recordsLegacyRecent ? 1 : 0);
  });
});
