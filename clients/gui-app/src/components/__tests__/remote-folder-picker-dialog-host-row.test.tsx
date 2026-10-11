import {
  act,
  cleanup,
  fireEvent,
  render as renderBase,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { WorkspaceBrowseFoldersResponseV11 } from "@traycer/protocol/host/workspace/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { RemoteFolderPickerDialog } from "@/components/remote-folder-picker-dialog";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * The picker reads the requester's active host row while rendering: the native
 * picker's availability follows its kind, and a keyboard aim is only valid for
 * the host id it was made against. The client the dialog holds is STABLE across
 * a row disappearing and returning, so nothing but the registry's row-changed
 * signal can make the dialog look again. Everything here drives that signal and
 * asserts the rendered outcome; the picker's other behavior is owned by
 * `remote-folder-picker-dialog.test.tsx`.
 */

const HOST_ID = "picker-host";
const HOME: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "/Users/tester",
  parentPath: "/Users",
  entries: [
    { path: "/Users/tester/code", name: "code", hidden: false },
    { path: "/Users/tester/docs", name: "docs", hidden: false },
  ],
};

vi.mock("@/hooks/workspace/use-workspace-browse-folders-query", () => ({
  useWorkspaceBrowseFolders: () => ({
    data: HOME,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("@/hooks/workspace/use-workspace-list-recent-workspaces-query", () => ({
  useWorkspaceListRecentWorkspaces: () => ({ data: undefined }),
}));
vi.mock("@/hooks/workspace/use-workspace-get-home-dir-query", () => ({
  useWorkspaceGetHomeDir: () => ({ data: undefined }),
}));
const negotiatedVersion: { current: NegotiatedMethodVersion } = vi.hoisted(
  () => ({ current: { major: 1, minor: 4 } }),
);
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => negotiatedVersion.current,
}));

const LOCAL_ROW: HostDirectoryEntry = {
  hostId: HOST_ID,
  label: "Picker Host",
  kind: "local",
  websocketUrl: null,
  version: "0.0.0-mock",
  transportDialability: "dialable",
};
const REMOTE_ROW: HostDirectoryEntry = {
  ...LOCAL_ROW,
  kind: "remote",
  websocketUrl: "wss://picker.traycer.invalid/rpc",
};

/** A directory whose one row can vanish, return, or change kind. */
class MutableDirectory {
  row: HostDirectoryEntry | null = null;
  private readonly listeners = new Set<() => void>();

  findById(hostId: string): HostDirectoryEntry | null {
    // Fresh object per read, like production, so nothing can pass by
    // reference-equality.
    return this.row !== null && this.row.hostId === hostId
      ? { ...this.row }
      : null;
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  set(row: HostDirectoryEntry | null): void {
    this.row = row;
    for (const listener of [...this.listeners]) listener();
  }
}

function setup(): {
  readonly directory: MutableDirectory;
  readonly pinned: HostClient<HostRpcRegistry>;
} {
  const directory = new MutableDirectory();
  directory.row = LOCAL_ROW;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
    findHostById: (hostId) => directory.findById(hostId),
  });
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => directory.findById(hostId),
      onDirectoryChanged: (listener) => directory.onChange(listener),
    },
    leases: null,
  });
  return { directory, pinned: client.createRequesterForHostId(HOST_ID) };
}

function render(ui: ReactNode) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return renderBase(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostContext.Provider value={runnerHost}>
        {ui}
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

function nativeButton(): HTMLElement {
  return screen.getByTestId("remote-folder-picker-native");
}

function pathInput(): HTMLElement {
  return screen.getByTestId("remote-folder-picker-path");
}

describe("<RemoteFolderPickerDialog /> host-row reads", () => {
  beforeEach(() => {
    useRemoteFolderPickerStore.setState({
      open: false,
      client: null,
      resolvePick: null,
      showHiddenFolders: false,
    });
  });
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
  });

  it("re-derives native picker availability when the stable client's host row leaves, returns, or changes kind", async () => {
    const { directory, pinned } = setup();
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(pinned);
    await screen.findAllByTestId("remote-folder-picker-row");
    expect(nativeButton().getAttribute("aria-disabled")).toBeNull();

    act(() => {
      directory.set(null);
    });
    expect(nativeButton().getAttribute("aria-disabled")).toBe("true");

    act(() => {
      directory.set(LOCAL_ROW);
    });
    expect(nativeButton().getAttribute("aria-disabled")).toBeNull();

    // Same id, same client: only the row's kind moves.
    act(() => {
      directory.set(REMOTE_ROW);
    });
    expect(nativeButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("drops a keyboard aim made before the host row left, and does not revive it on return", async () => {
    const { directory, pinned } = setup();
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore.getState().requestPick(pinned);
    await screen.findAllByTestId("remote-folder-picker-row");
    // Aim `code`. Add would now submit it.
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });

    // The listing, the client and the path field never change; only the row
    // does. The host id the aim was made against disappears, then returns.
    act(() => {
      directory.set(null);
    });
    act(() => {
      directory.set(LOCAL_ROW);
    });

    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester"],
    });
  });
});
