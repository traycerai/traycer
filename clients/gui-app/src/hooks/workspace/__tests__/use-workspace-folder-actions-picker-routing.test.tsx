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
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  preferPickedPathOverAncestorRewrite,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

const prepareMutateAsync = vi.fn();
const nativePickFolders = vi.fn();
const toastMock = vi.fn();
let canPickNatively = true;

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: () => ({
    mutateAsync: prepareMutateAsync,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    workspaceFolders: {
      get canPickNatively() {
        return canPickNatively;
      },
      pickFolders: nativePickFolders,
    },
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
  status: "available",
};

function makeBoundClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
  });
  client.bind(REMOTE_HOST);
  return client;
}

function makeWrapper() {
  const queryClient = new QueryClient();
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
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

describe("pickAndPrepareFolders shell routing for a remote host", () => {
  beforeEach(() => {
    prepareMutateAsync.mockReset();
    nativePickFolders.mockReset();
    toastMock.mockReset();
    canPickNatively = true;
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });

  // A remote host's filesystem is out of reach of the shell's native OS dialog
  // even on desktop, so a remote host browses over RPC on EVERY shell - the
  // native dialog is reserved for hosts that share the client machine.
  it("desktop-style shells (canPickNatively) still browse a remote host over RPC", async () => {
    canPickNatively = true;
    const requestPick = vi.fn().mockResolvedValue("/remote/projects/app");
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const client = makeBoundClient();
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(client),
      { wrapper: makeWrapper() },
    );
    await result.current.pickAndPrepareFolders();
    // Pinned to the dispatch host, not merely the caller's client: an
    // app-wide client could switch hosts while the dialog is open.
    expect(pickedHostIdOf(requestPick)).toBe(REMOTE_HOST.hostId);
    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
    });
    // No native dialog, and none of the old "switch to the local host" copy.
    expect(nativePickFolders).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dialog-less shells route through the picker with the bound client and prepare the pick", async () => {
    canPickNatively = false;
    const requestPick = vi.fn().mockResolvedValue("/remote/projects/app");
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [], repoIdentifiers: [] });
    const client = makeBoundClient();
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(client),
      { wrapper: makeWrapper() },
    );
    await result.current.pickAndPrepareFolders();
    // The picker received exactly the requester's (host-bound) client...
    expect(requestPick).toHaveBeenCalledTimes(1);
    // Pinned to the dispatch host, not merely the caller's client: an
    // app-wide client could switch hosts while the dialog is open.
    expect(pickedHostIdOf(requestPick)).toBe(REMOTE_HOST.hostId);
    // ...the picked host path went to prepare, and the native dialog never ran.
    expect(prepareMutateAsync).toHaveBeenCalledWith({
      operation: "prepare",
      folderPaths: ["/remote/projects/app"],
      path: null,
    });
    expect(nativePickFolders).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("a cancelled pick prepares nothing", async () => {
    canPickNatively = false;
    const requestPick = vi.fn().mockResolvedValue(null);
    useRemoteFolderPickerStore.setState({ requestPick });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient()),
      { wrapper: makeWrapper() },
    );
    const outcome = await result.current.pickAndPrepareFolders();
    expect(outcome).toBeNull();
    expect(prepareMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the picked folder when the host rewrites it to an ancestor (home-as-git-repo)", async () => {
    canPickNatively = false;
    const requestPick = vi
      .fn()
      .mockResolvedValue("/Users/x/Documents/Workspaces/Server");
    useRemoteFolderPickerStore.setState({ requestPick });
    // The host walked the pick up to its git root: HOME.
    prepareMutateAsync.mockResolvedValue({
      folders: [
        {
          workspacePath: "/Users/x",
          workspaceName: "x",
          repoIdentifier: null,
          repoUrl: null,
        },
      ],
      repoIdentifiers: [],
    });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient()),
      { wrapper: makeWrapper() },
    );
    const outcome = await result.current.pickAndPrepareFolders();
    expect(outcome?.folders).toEqual([
      {
        workspacePath: "/Users/x/Documents/Workspaces/Server",
        workspaceName: "Server",
        repoIdentifier: null,
        repoUrl: null,
      },
    ]);
  });

  it("keeps the host path when it matches the pick (no rewrite)", async () => {
    canPickNatively = false;
    const requestPick = vi.fn().mockResolvedValue("/Users/x/code/app");
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({
      folders: [
        {
          workspacePath: "/Users/x/code/app",
          workspaceName: "app",
          repoIdentifier: null,
          repoUrl: null,
        },
      ],
      repoIdentifiers: [],
    });
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient()),
      { wrapper: makeWrapper() },
    );
    const outcome = await result.current.pickAndPrepareFolders();
    expect(outcome?.folders[0]?.workspacePath).toBe("/Users/x/code/app");
  });
});

describe("preferPickedPathOverAncestorRewrite", () => {
  const prepared = (
    workspacePath: string,
    workspaceName: string,
  ): PreparedWorkspaceFolder => ({
    workspacePath,
    workspaceName,
    repoIdentifier: null,
    repoUrl: null,
  });

  it("replaces a strict-ancestor rewrite and drops ancestor repo metadata", () => {
    const withRepo: PreparedWorkspaceFolder = {
      ...prepared("/Users/x", "x"),
      repoIdentifier: { owner: "x", repo: "home" },
      repoUrl: "https://example.invalid/x/home",
    };
    const result = preferPickedPathOverAncestorRewrite(
      ["/Users/x/Documents/Workspaces/Buzz"],
      [withRepo],
    );
    expect(result[0]?.workspacePath).toBe("/Users/x/Documents/Workspaces/Buzz");
    expect(result[0]?.workspaceName).toBe("Buzz");
    expect(result[0]?.repoIdentifier).toBe(null);
    expect(result[0]?.repoUrl).toBe(null);
  });

  it("leaves same-path and non-ancestor results untouched", () => {
    expect(
      preferPickedPathOverAncestorRewrite(
        ["/Users/x/code/app"],
        [prepared("/Users/x/code/app", "app")],
      )[0],
    ).toEqual(prepared("/Users/x/code/app", "app"));
    // A DESCENDANT rewrite is not the git-root walk - keep the host value.
    expect(
      preferPickedPathOverAncestorRewrite(
        ["/Users/x/code"],
        [prepared("/Users/x/code/app", "app")],
      )[0]?.workspacePath,
    ).toBe("/Users/x/code/app");
    // Sibling prefix that is not a path ancestor ("app2" vs "app/") must not match.
    expect(
      preferPickedPathOverAncestorRewrite(
        ["/Users/x/app2"],
        [prepared("/Users/x/app", "app")],
      )[0]?.workspacePath,
    ).toBe("/Users/x/app");
  });
});
