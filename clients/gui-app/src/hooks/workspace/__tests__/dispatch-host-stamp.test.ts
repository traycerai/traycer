import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  stampPreparedFoldersWithDispatchHost,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { FolderPickerIntent } from "@/stores/workspace/remote-folder-picker-store";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";

const prepareMutateAsync = vi.fn<(variables: object) => Promise<object>>();
const recordRecent = vi.fn();
const toastMock = vi.fn();

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    readonly onResponse?: (response: object) => void;
  }) => ({
    mutateAsync: async (variables: object) => {
      const response = await prepareMutateAsync(variables);
      args.onResponse?.(response);
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

const PREPARED: PreparedWorkspaceFolder = {
  workspacePath: "/Users/a/scratch",
  workspaceName: "scratch",
  repoIdentifier: null,
  repoUrl: null,
};

/**
 * Contract of the two pure mappers `pickAndPrepareFolders` stamps results
 * through: each takes the host id as an argument and applies it verbatim to
 * every folder, adding no host lookup of its own.
 *
 * The B6 race lives in the caller, which captures the host at dispatch and
 * re-checks `hostStillBound` after both awaits before returning. The
 * integration cases below drive that caller; these pure cases keep the
 * stamping contract independently explicit.
 */
describe("prepared-folder host stamping (pure mappers)", () => {
  it("applies the given host id to every folder it stamps", () => {
    const stamped = stampPreparedFoldersWithDispatchHost([PREPARED], "host-A");
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.hostId).toBe("host-A");
    expect(stamped[0]?.path).toBe("/Users/a/scratch");
  });

  it("takes the host id only from its argument when mapping one folder", () => {
    expect(
      preparedWorkspaceFolderToWorkspaceFolderInfo(PREPARED, "host-A").hostId,
    ).toBe("host-A");
    expect(
      preparedWorkspaceFolderToWorkspaceFolderInfo(PREPARED, "host-B").hostId,
    ).toBe("host-B");
  });
});

const HOST_A: HostDirectoryEntry = {
  hostId: "host-a",
  label: "Host A",
  kind: "local",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "dialable",
};

const HOST_B: HostDirectoryEntry = {
  hostId: "host-b",
  label: "Host B",
  kind: "local",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "dialable",
};

function makeMutableClient(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly setActiveHostId: (hostId: string) => void;
} {
  let activeHostId = HOST_A.hostId;
  const hostById: ReadonlyMap<string, HostDirectoryEntry> = new Map([
    [HOST_A.hostId, HOST_A],
    [HOST_B.hostId, HOST_B],
  ]);
  const client = {
    getActiveHost: () => hostById.get(activeHostId) ?? null,
    getActiveHostId: () => activeHostId,
    createRequester: (entry: HostDirectoryEntry) => ({
      getActiveHost: () => entry,
      getActiveHostId: () => entry.hostId,
    }),
  } as HostClient<HostRpcRegistry>;
  return {
    client,
    setActiveHostId: (hostId) => {
      activeHostId = hostId;
    },
  };
}

function makeWrapper() {
  const queryClient = new QueryClient();
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const INITIAL_PICKER_STATE = useRemoteFolderPickerStore.getState();

describe("pickAndPrepareFolders host binding", () => {
  beforeEach(() => {
    prepareMutateAsync.mockReset();
    recordRecent.mockReset();
    toastMock.mockReset();
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_A.hostId, {
      "workspace.prepareFolders": { major: 1, minor: 4 },
    });
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });

  afterEach(() => {
    resetNegotiatedManifests();
    useRemoteFolderPickerStore.setState(INITIAL_PICKER_STATE, true);
  });

  it("rejects a host swap while the shared picker is pending", async () => {
    let resolvePick: (intent: FolderPickerIntent | null) => void = () =>
      undefined;
    const requestPick = vi.fn(
      () =>
        new Promise<FolderPickerIntent | null>((resolve) => {
          resolvePick = resolve;
        }),
    );
    useRemoteFolderPickerStore.setState({ requestPick });
    const fixture = makeMutableClient();
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(fixture.client),
      { wrapper: makeWrapper() },
    );

    const pending = result.current.pickAndPrepareFolders(false);
    fixture.setActiveHostId(HOST_B.hostId);
    resolvePick({ kind: "prepare", folderPaths: ["/workspace/app"] });

    await expect(pending).resolves.toBeNull();
    expect(prepareMutateAsync).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalled();
  });

  it("rejects a host swap while preparation is pending", async () => {
    let resolvePick: (intent: FolderPickerIntent | null) => void = () =>
      undefined;
    const requestPick = vi.fn(
      () =>
        new Promise<FolderPickerIntent | null>((resolve) => {
          resolvePick = resolve;
        }),
    );
    useRemoteFolderPickerStore.setState({ requestPick });
    let resolvePrepare: (response: object) => void = () => undefined;
    prepareMutateAsync.mockReturnValue(
      new Promise<object>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    const fixture = makeMutableClient();
    const { result } = renderHook(
      () => useWorkspaceFolderActionsForClient(fixture.client),
      { wrapper: makeWrapper() },
    );

    const pending = result.current.pickAndPrepareFolders(false);
    resolvePick({ kind: "prepare", folderPaths: ["/workspace/app"] });
    await vi.waitFor(() => {
      expect(prepareMutateAsync).toHaveBeenCalledTimes(1);
    });
    fixture.setActiveHostId(HOST_B.hostId);
    resolvePrepare({ folders: [], repoIdentifiers: [] });

    await expect(pending).resolves.toBeNull();
    expect(toastMock).toHaveBeenCalled();
    expect(recordRecent).not.toHaveBeenCalled();
  });
});
