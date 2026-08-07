import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
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

describe("pickAndPrepareFolders shell routing for a remote host", () => {
  beforeEach(() => {
    prepareMutateAsync.mockReset();
    nativePickFolders.mockReset();
    toastMock.mockReset();
    useRemoteFolderPickerStore.setState({
      open: false,
      client: null,
      resolvePick: null,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("desktop-style shells (canPickNatively) toast and never open any picker", async () => {
    canPickNatively = true;
    const requestPickSpy = vi.spyOn(
      useRemoteFolderPickerStore.getState(),
      "requestPick",
    );
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(makeBoundClient()),
      { wrapper: makeWrapper() },
    );
    await waitFor(async () => {
      const outcome = await result.current.pickAndPrepareFolders();
      expect(outcome).toBeNull();
    });
    expect(toastMock).toHaveBeenCalledWith(
      "Select the local host to add folders.",
      undefined,
      expect.objectContaining({ message: "The local host was not selected." }),
    );
    expect(requestPickSpy).not.toHaveBeenCalled();
    expect(nativePickFolders).not.toHaveBeenCalled();
    expect(prepareMutateAsync).not.toHaveBeenCalled();
  });

  it("dialog-less shells route through the picker with the bound client and prepare the pick", async () => {
    canPickNatively = false;
    const requestPick = vi.fn().mockResolvedValue("/remote/projects/app");
    useRemoteFolderPickerStore.setState({ requestPick });
    prepareMutateAsync.mockResolvedValue({ folders: [] });
    const client = makeBoundClient();
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(client),
      { wrapper: makeWrapper() },
    );
    await result.current.pickAndPrepareFolders();
    // The picker received exactly the requester's (host-bound) client...
    expect(requestPick).toHaveBeenCalledTimes(1);
    expect(requestPick).toHaveBeenCalledWith(client);
    // ...the picked host path went to prepare, and the native dialog never ran.
    expect(prepareMutateAsync).toHaveBeenCalledWith({
      folderPaths: ["/remote/projects/app"],
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
});
