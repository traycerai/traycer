import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  WorkspaceBrowseFoldersResponseV11,
  WorkspacePrepareFoldersResponseV13,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { modLabel } from "@/lib/keybindings/platform";
import { RemoteFolderPickerDialog } from "@/components/remote-folder-picker-dialog";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

const nativePicker = vi.hoisted(() => ({
  canPickNatively: true,
  pickFolders: vi.fn(),
}));
const negotiatedVersion = vi.hoisted(() => ({ minor: 4 }));
let pickerQueryClient: QueryClient;
const FOLDER_PICKER_STORAGE_KEY = "traycer-gui-app:folder-picker-preferences";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQueryClient: () => pickerQueryClient };
});

vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({
    major: 1,
    minor: negotiatedVersion.minor,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({
    workspaceFolders: {
      canPickNatively: nativePicker.canPickNatively,
      pickFolders: nativePicker.pickFolders,
    },
  }),
}));

interface FakeQueryState {
  readonly data: WorkspaceBrowseFoldersResponseV11 | undefined;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly refetch: () => Promise<unknown>;
}

const queryByPath = new Map<string, FakeQueryState>();
const requestedPaths: Array<string | null> = [];
let lastClient: unknown;

function pathKey(path: string | null): string {
  return path ?? "<roots>";
}

vi.mock("@/hooks/workspace/use-workspace-browse-folders-query", () => ({
  useWorkspaceBrowseFolders: (args: {
    client: unknown;
    directoryPath: string | null;
    enabled: boolean;
  }) => {
    lastClient = args.client;
    if (args.enabled) requestedPaths.push(args.directoryPath);
    return (
      queryByPath.get(pathKey(args.directoryPath)) ?? {
        data: undefined,
        isPending: true,
        error: null,
        refetch: () => Promise.resolve(),
      }
    );
  },
}));

/**
 * `workspace.prepareFolders` conveniences, faked at the same seam as the
 * browse query. `undefined` data stands in for the fail-closed
 * `DOWNGRADE_UNSUPPORTED` a v1.0 host answers these with - the picker must
 * treat that as "absent", never as an error.
 */
let recentEntries: readonly WorkspaceRecentEntry[] | undefined;
let reportedHomeDir: string | null | undefined;
const homeDirEnabledCalls: boolean[] = [];
function prepareFoldersResponse(
  fields: Partial<WorkspacePrepareFoldersResponseV13>,
): WorkspacePrepareFoldersResponseV13 {
  return {
    operation: "prepare",
    folders: [],
    repoIdentifiers: [],
    homeDir: null,
    validation: null,
    recentWorkspaces: null,
    ...fields,
  };
}

vi.mock("@/hooks/workspace/use-workspace-list-recent-workspaces-query", () => ({
  useWorkspaceListRecentWorkspaces: () => ({
    data:
      recentEntries === undefined
        ? undefined
        : prepareFoldersResponse({
            operation: "listRecentWorkspaces",
            recentWorkspaces: [...recentEntries],
          }),
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-get-home-dir-query", () => ({
  useWorkspaceGetHomeDir: (args: { enabled: boolean }) => {
    homeDirEnabledCalls.push(args.enabled);
    return {
      data:
        !args.enabled || reportedHomeDir === undefined
          ? undefined
          : prepareFoldersResponse({
              operation: "getHomeDir",
              homeDir: reportedHomeDir,
            }),
    };
  },
}));

/**
 * A real (mock-messenger) HostClient: the store's request contract takes the
 * requester's client verbatim, so identity is what the dialog must preserve.
 */
function makeClient(): HostClient<HostRpcRegistry> {
  return new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
  });
}

const LOCAL_HOST: HostDirectoryEntry = {
  hostId: "host-local",
  label: "This computer",
  kind: "local",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "dialable",
};

const REMOTE_HOST: HostDirectoryEntry = {
  hostId: "host-remote",
  label: "Remote computer",
  kind: "remote",
  websocketUrl: "wss://example.invalid/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

function makeBoundClient(
  host: HostDirectoryEntry,
): HostClient<HostRpcRegistry> {
  return makeClient().createRequester(host);
}

function readyLevel(
  response: WorkspaceBrowseFoldersResponseV11,
): FakeQueryState {
  return {
    data: response,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve(),
  };
}

const HOME_RESPONSE: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "/Users/tester",
  parentPath: "/Users",
  entries: [
    { path: "/Users/tester/.config", name: ".config", hidden: true },
    { path: "/Users/tester/code", name: "code", hidden: false },
    {
      path: "/Users/tester/consulting",
      name: "consulting",
      hidden: false,
    },
    {
      path: "/Users/tester/Documents",
      name: "Documents",
      hidden: false,
    },
  ],
};

const CODE_RESPONSE: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "/Users/tester/code",
  parentPath: "/Users/tester",
  entries: [],
};

function pathInput(): HTMLInputElement {
  const element = screen.getByTestId("remote-folder-picker-path");
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("path field is not an input");
  }
  return element;
}

function rowNames(): string[] {
  return screen
    .queryAllByTestId("remote-folder-picker-row")
    .map((row) => row.textContent);
}

describe("<RemoteFolderPickerDialog />", () => {
  beforeEach(() => {
    pickerQueryClient = new QueryClient();
    negotiatedVersion.minor = 4;
    queryByPath.clear();
    requestedPaths.length = 0;
    lastClient = undefined;
    queryByPath.set(pathKey(null), readyLevel(HOME_RESPONSE));
    // Typed/clicked navigation targets explicit paths, not the null root key.
    queryByPath.set(pathKey("/Users/tester"), readyLevel(HOME_RESPONSE));
    queryByPath.set(pathKey("/Users/tester/code"), readyLevel(CODE_RESPONSE));
    // The host refuses to list the already-denied directory.
    queryByPath.set(pathKey("/Users/tester/Documents"), {
      data: undefined,
      isPending: false,
      error: new Error(
        "Access to this folder is denied on the host machine (System Settings > Privacy & Security on the host Mac)",
      ),
      refetch: () => Promise.resolve(),
    });
    // Default: a host that answers neither convenience operation, so every
    // pre-existing expectation describes the picker WITHOUT recents.
    recentEntries = undefined;
    reportedHomeDir = undefined;
    homeDirEnabledCalls.length = 0;
    window.localStorage.removeItem(FOLDER_PICKER_STORAGE_KEY);
    nativePicker.canPickNatively = true;
    nativePicker.pickFolders.mockReset();
    nativePicker.pickFolders.mockResolvedValue([]);
    useRemoteFolderPickerStore.setState({
      open: false,
      client: null,
      resolvePick: null,
      showHiddenFolders: false,
    });
  });
  afterEach(() => {
    cleanup();
    useRemoteFolderPickerStore.setState({ showHiddenFolders: false });
    window.localStorage.removeItem(FOLDER_PICKER_STORAGE_KEY);
  });

  it("stays unmounted until a pick is requested", () => {
    render(<RemoteFolderPickerDialog />);
    expect(screen.queryByTestId("remote-folder-picker-dialog")).toBeNull();
  });

  it("uses a capped desktop surface and a safe full-screen narrow layout", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const dialog = await screen.findByTestId("remote-folder-picker-dialog");
    expect(dialog.className).toContain("max-h-[45svh]");
    expect(dialog.className).toContain("md:top-[18svh]");
    expect(dialog.className).toContain("md:max-w-2xl");
    expect(dialog.className).toContain("md:translate-y-0");
    expect(dialog.className).toContain("max-md:h-safe-dvh");
    expect(dialog.className).toContain("max-md:w-safe-dvw");
    expect(dialog.className).toContain("max-md:max-h-none");
    expect(dialog.className).toContain("max-w-none");
    expect(dialog.className).toContain("sm:max-w-none");
    expect(pathInput().value).toBe("/Users/tester/");
    // .config was sent by the host but the empty filter hides dot folders;
    // Documents renders like any other row (no lock affordance).
    expect(rowNames()).toEqual(["code", "consulting", "Documents"]);
    expect(screen.queryByTestId("remote-folder-picker-locked-row")).toBeNull();
  });

  it("a dot filter reveals hidden folders", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(
      screen.getByRole("button", { name: "Folder picker settings" }),
    );
    expect(
      screen
        .getByRole("switch", { name: "Show hidden folders" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
    fireEvent.change(pathInput(), { target: { value: "/Users/tester/.co" } });
    expect(rowNames()).toEqual([".config"]);
  });

  it("shows hidden folders on demand and remembers the preference locally", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(
      screen.getByRole("button", { name: "Folder picker settings" }),
    );
    const toggle = screen.getByRole("switch", {
      name: "Show hidden folders",
    });
    expect(rowNames()).toEqual(["code", "consulting", "Documents"]);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("data-state")).toBe("checked");
    expect(rowNames()).toEqual([".config", "code", "consulting", "Documents"]);
    expect(
      window.localStorage.getItem(FOLDER_PICKER_STORAGE_KEY) ?? "",
    ).toContain('"showHiddenFolders":true');
  });

  it("returns every folder chosen through the native picker", async () => {
    nativePicker.pickFolders.mockResolvedValue([
      "/Users/tester/code",
      "/Users/tester/Documents",
    ]);
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeBoundClient(LOCAL_HOST));
    const button = await screen.findByTestId("remote-folder-picker-native");
    const invalidate = vi.spyOn(pickerQueryClient, "invalidateQueries");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.textContent).toBe("Open native picker");
    expect(button.getAttribute("data-variant")).toBe("outline");

    fireEvent.click(button);

    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/code", "/Users/tester/Documents"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["host", LOCAL_HOST.hostId, "workspace.browseFolders"],
      refetchType: "none",
    });
  });

  it("keeps the native picker single-flight and refreshes after cancellation", async () => {
    const pending = {
      resolve: (_paths: readonly string[]): void => {},
    };
    nativePicker.pickFolders.mockImplementation(
      () =>
        new Promise<readonly string[]>((resolvePromise) => {
          pending.resolve = resolvePromise;
        }),
    );
    const refetch = vi.fn(() => Promise.resolve());
    queryByPath.set(pathKey(null), { ...readyLevel(HOME_RESPONSE), refetch });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore
      .getState()
      .requestPick(makeBoundClient(LOCAL_HOST));
    const button = await screen.findByTestId("remote-folder-picker-native");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(nativePicker.pickFolders).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve([]);
      await Promise.resolve();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("explains why the native picker is unavailable for a remote host", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore
      .getState()
      .requestPick(makeBoundClient(REMOTE_HOST));
    const button = await screen.findByTestId("remote-folder-picker-native");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.focus(button);

    expect(
      await screen.findByText(
        "Switch to this computer's host to use the system folder picker.",
      ),
    ).toBeTruthy();
    fireEvent.click(button);
    expect(nativePicker.pickFolders).not.toHaveBeenCalled();
  });

  it("a timed-out listing shows the host's message with Retry", async () => {
    queryByPath.set(pathKey("/Users/tester/Desktop"), {
      data: undefined,
      isPending: false,
      error: new Error(
        "Timed out listing this folder on the host machine - it may be waiting on a permission prompt; check the host Mac, then retry",
      ),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/Desktop/" },
    });
    expect(
      screen.getByTestId("remote-folder-picker-error").textContent,
    ).toContain("Timed out listing");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry hands focus back to the path field", async () => {
    queryByPath.set(pathKey("/Users/tester/Desktop"), {
      data: undefined,
      isPending: false,
      error: new Error(
        "Timed out listing this folder on the host machine - retry",
      ),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/Desktop/" },
    });
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(pathInput());
  });

  it("a too-old host shows upgrade guidance without Retry", async () => {
    queryByPath.set(pathKey(null), {
      data: undefined,
      isPending: false,
      error: new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message:
          "This host does not support 'workspace.browseFolders'. Upgrade the host to use this feature.",
        requestId: "request-1",
        method: "workspace.browseFolders",
        fatalDetails: null,
      }),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    expect(
      (await screen.findByTestId("remote-folder-picker-error")).textContent,
    ).toContain("update Traycer on the host");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a nonexistent typed folder shows a short no-such-folder line", async () => {
    queryByPath.set(pathKey("/Users/tester/nope"), {
      data: undefined,
      isPending: false,
      error: new Error("No such folder on the host machine"),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), { target: { value: "/Users/tester/nope/" } });
    expect(screen.getByTestId("remote-folder-picker-error").textContent).toBe(
      "No such folder.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("browses every level through exactly the requester's client", async () => {
    // The dialog is globally mounted, but a pick can start from a tab bound
    // to a different host than the app-wide active one. The query must
    // receive the client handed to requestPick - never resolve its own.
    const requesterClient = makeClient();
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(requesterClient);
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    expect(requestedPaths.at(-1)).toBe("/Users/tester/code");
    expect(lastClient).toBe(requesterClient);
  });

  it("live-filters the listing by the segment after the last slash", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/co" },
    });
    // Filtering happens against the parent listing - no new directory browse.
    expect(requestedPaths.at(-1)).toBeNull();
    expect(requestedPaths).not.toContain("/Users/tester");
    expect(rowNames()).toEqual(["code", "consulting"]);
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/cod" },
    });
    expect(rowNames()).toEqual(["code"]);
  });

  it("a trailing slash descends into the typed subfolder", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/code/" },
    });
    expect(requestedPaths.at(-1)).toBe("/Users/tester/code");
    // Empty folder: only the ".." row remains.
    expect(rowNames()).toEqual([]);
    expect(screen.getByTestId("remote-folder-picker-up-row")).toBeTruthy();
  });

  it("delays the directory skeleton so fast loads do not flash it", () => {
    queryByPath.set(pathKey("/Users/tester/code"), {
      data: undefined,
      isPending: true,
      error: null,
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    act(() => {
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    });
    fireEvent.click(screen.getAllByTestId("remote-folder-picker-row")[0]);

    const loading = screen.getByTestId("remote-folder-picker-loading");
    expect(loading.className).toContain("fade-in-0");
    expect(loading.className).toContain("fill-mode-backwards");
    expect(loading.className).toContain("delay-150");
    expect(loading.className).toContain("motion-reduce:duration-0");
  });

  it("expands ~ against the host home", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), { target: { value: "~/code/" } });
    expect(requestedPaths.at(-1)).toBe("/Users/tester/code");
  });

  it("clicking a row appends its name and a slash to the field", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    expect(pathInput().value).toBe("/Users/tester/code/");
  });

  it("Add resolves with the shown path, trailing slash dropped", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/code"],
    });
    expect(useRemoteFolderPickerStore.getState().open).toBe(false);
    expect(useRemoteFolderPickerStore.getState().client).toBeNull();
  });

  it("cmd+Enter adds the typed path even when it was never listed", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "~/projects/deep" },
    });
    fireEvent.keyDown(pathInput(), { key: "Enter", metaKey: true });
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/projects/deep"],
    });
  });

  it("offers to create and add a missing final directory", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/new-app" },
    });

    expect(
      screen.getByTestId("remote-folder-picker-add").textContent,
    ).toContain("Create & Add");
    expect(screen.queryByText("No subfolders.")).toBeNull();
    fireEvent.keyDown(pathInput(), { key: "Enter" });

    await expect(pick).resolves.toEqual({
      kind: "createAndPrepare",
      path: "/Users/tester/new-app",
    });
  });

  it("does not offer directory creation to a v1.2 host", async () => {
    negotiatedVersion.minor = 2;
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/new-app" },
    });

    const add = screen.getByTestId("remote-folder-picker-add");
    expect(add.textContent).not.toContain("Create & Add");
    expect(add.getAttribute("disabled")).not.toBeNull();
  });

  it("a gated folder lists as a short no-access line and can still be added", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    const rows = await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(rows[2]);
    expect(pathInput().value).toBe("/Users/tester/Documents/");
    expect(screen.getByTestId("remote-folder-picker-error").textContent).toBe(
      "No access to this folder.",
    );
    // Selecting needs no read - Add picks the gated folder.
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/Documents"],
    });
  });

  it("backs out of an unlistable folder via the up button", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const rows = await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(rows[2]);
    expect(screen.getByTestId("remote-folder-picker-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("remote-folder-picker-up"));
    expect(pathInput().value).toBe("/Users/tester/");
    expect(rowNames()).toEqual(["code", "consulting", "Documents"]);
  });

  it("ignores Enter while an IME composition is active", async () => {
    // An IME user's Enter commits the composed segment; opening the selected
    // row instead makes composed folder names untypeable.
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.keyDown(pathInput(), { key: "Enter", isComposing: true });
    expect(pathInput().value).toBe("/Users/tester/");
    // Activate the `..` row, then the same key outside composition opens it.
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/");
  });

  it("uses plain Enter until a row is active, then shows the platform modifier", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    const add = screen.getByTestId("remote-folder-picker-add");
    expect(add.textContent).not.toContain(modLabel());
    expect(add.querySelectorAll('[data-slot="kbd"]')).toHaveLength(1);
    const plainKeyClass = add.querySelector('[data-slot="kbd"]')?.className;
    fireEvent.mouseEnter(screen.getByTestId("remote-folder-picker-up-row"));
    // jsdom is not a Mac, so a hardcoded glyph would fail on platforms where
    // the working shortcut is Ctrl+Enter.
    expect(add.textContent).toContain(modLabel());
    const chord = add.querySelectorAll('[data-slot="kbd"]');
    expect(chord).toHaveLength(2);
    for (const key of chord) {
      expect(key.className).toBe(plainKeyClass);
    }
  });

  it("arrow keys move the active option and Enter opens it", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    // No row starts active. The first arrow activates `..`, the next the first
    // directory.
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-1",
    );
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/code/");
  });

  it("relative input shows a hint, not a loading state", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), { target: { value: "foo" } });
    expect(screen.getByTestId("remote-folder-picker-invalid")).toBeTruthy();
    expect(screen.queryByTestId("remote-folder-picker-loading")).toBeNull();
    // The listbox the combobox references stays mounted even with no rows.
    expect(screen.getByTestId("remote-folder-picker-rows")).toBeTruthy();
    expect(
      screen.getByTestId("remote-folder-picker-add").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("an explicitly cleared field disables Add", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    expect(
      screen.getByTestId("remote-folder-picker-add").hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.change(pathInput(), { target: { value: "" } });
    expect(
      screen.getByTestId("remote-folder-picker-add").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the .. row and offers Retry on a non-consent failure", async () => {
    queryByPath.set(pathKey("/Users/tester/code"), {
      data: undefined,
      isPending: false,
      error: new Error("transport lost"),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    // Transport failure is not a permission problem: generic line + Retry,
    // and the ".." option keeps the combobox's references valid.
    expect(
      screen.getByTestId("remote-folder-picker-error").textContent,
    ).toContain("Couldn't load this folder.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByTestId("remote-folder-picker-up-row")).toBeTruthy();
  });

  it("a failed refetch stops navigation addressing the rows it hid", async () => {
    // TanStack keeps the last successful `data` when a REFETCH fails, and
    // this query is `staleTime: 10_000` - stepping back into a directory
    // serves cache and refetches behind it. The listing hides every entry
    // while the error is up, so navigation must stop counting them too.
    queryByPath.set(pathKey("/Users/tester/code"), {
      data: {
        directoryPath: "/Users/tester/code",
        parentPath: "/Users/tester",
        entries: [
          { path: "/Users/tester/code/api", name: "api", hidden: false },
        ],
      },
      isPending: false,
      error: new Error("Timed out listing this folder"),
      refetch: () => Promise.resolve(),
    });
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    expect(screen.getByTestId("remote-folder-picker-error")).toBeTruthy();
    // The stale "api" row is not rendered, so it must not be addressable:
    // ".." is the only option, and ArrowDown has nowhere past it to go.
    expect(rowNames()).toEqual([]);
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-0",
    );
    // Enter therefore backs out, instead of opening a folder nothing showed.
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/");
  });

  it("navigates up via the up row", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    fireEvent.click(screen.getByTestId("remote-folder-picker-up-row"));
    expect(pathInput().value).toBe("/Users/tester/");
  });

  it("Backspace at the end of an exact directory path walks up", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    const input = pathInput();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.value).toBe("/Users/tester/");
  });

  it("a second requestPick cancels the first", async () => {
    render(<RemoteFolderPickerDialog />);
    const first = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    const second = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await expect(first).resolves.toBeNull();
    fireEvent.click(await screen.findByTestId("remote-folder-picker-add"));
    await expect(second).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester"],
    });
  });

  it("can be cancelled without a keyboard", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    fireEvent.click(
      await screen.findByRole("button", { name: "Close folder picker" }),
    );
    await expect(pick).resolves.toBeNull();
  });

  it("a second requestPick after drilling down starts back at the home", async () => {
    // The body is keyed per request: the path and active query from a
    // cancelled request must not leak into the next one.
    const secondClient = makeClient();
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    expect(pathInput().value).toBe("/Users/tester/code/");
    act(() => {
      void useRemoteFolderPickerStore.getState().requestPick(secondClient);
    });
    expect(pathInput().value).toBe("/Users/tester/");
    expect(lastClient).toBe(secondClient);
  });

  it("offers the host's recent workspaces on the pristine field", async () => {
    recentEntries = [
      { path: "/srv/app", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
      { path: "/srv/api", lastOpenedAt: "2026-07-30T00:00:00.000Z" },
    ];
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const chips = await screen.findAllByTestId("remote-folder-picker-recent");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "/srv/app",
      "/srv/api",
    ]);
    const pathText = chips[0]?.querySelector("span");
    expect(pathText).toBeInstanceOf(HTMLSpanElement);
    expect(pathText?.getAttribute("style")).toContain("direction: rtl");
    expect(pathText?.getAttribute("style")).toContain(
      "text-overflow: ellipsis",
    );
  });

  it("picking a recent fills the field and arms Add with exactly it", async () => {
    recentEntries = [
      { path: "/srv/app", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
    ];
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-recent"))[0],
    );
    // Fills the field rather than adding outright - still editable, and shown
    // in context (its parent, filtered to it).
    expect(pathInput().value).toBe("/srv/app");
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/srv/app"],
    });
  });

  it("keeps focus on the field when a recent is picked by keyboard", async () => {
    // Picking a recent unmounts the whole row, including the button that was
    // just activated. `onMouseDown` covers a pointer, but Enter/Space never
    // fires it - focus would be left on a removed node.
    recentEntries = [
      { path: "/Users/tester/code", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
    ];
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const chip = (
      await screen.findAllByTestId("remote-folder-picker-recent")
    )[0];
    // Tab to the chip first: that is what makes this discriminating. Clicking
    // without focusing leaves the field focused anyway, so the assertion would
    // hold with or without the fix.
    if (!(chip instanceof HTMLElement))
      throw new Error("chip is not an element");
    chip.focus();
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    expect(screen.queryAllByTestId("remote-folder-picker-recent")).toEqual([]);
    expect(document.activeElement).toBe(pathInput());
  });

  it("hides the recents once the field is edited", async () => {
    recentEntries = [
      { path: "/srv/app", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
    ];
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findByTestId("remote-folder-picker-recents");
    fireEvent.change(pathInput(), { target: { value: "/Users/tester/co" } });
    expect(screen.queryByTestId("remote-folder-picker-recents")).toBeNull();
  });

  it("records the added folder as a recent on the host", async () => {
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/code"],
    });
  });

  it("a host that answers neither convenience operation still browses", async () => {
    // Both fail closed on a v1.0 host. That is not an error state for the
    // picker: no shortcut row, and the listing is untouched.
    recentEntries = undefined;
    reportedHomeDir = undefined;
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    expect(await screen.findByTestId("remote-folder-picker-rows")).toBeTruthy();
    expect(screen.queryByTestId("remote-folder-picker-recents")).toBeNull();
    expect(screen.queryByTestId("remote-folder-picker-error")).toBeNull();
    expect(rowNames()).toEqual(["code", "consulting", "Documents"]);
    expect(homeDirEnabledCalls).not.toContain(true);
  });

  it("shows the getHomeDir fallback rather than arming Add over a blank field", async () => {
    // Root listing fails, getHomeDir answers - the supported unlistable-home
    // case. Add falls back to that home, so the field must show it: an enabled
    // Add over an empty field would submit a path never displayed.
    queryByPath.set(pathKey(null), {
      data: undefined,
      isPending: false,
      error: new Error(
        "Access to this folder is denied on the host machine (System Settings > Privacy & Security on the host Mac)",
      ),
      refetch: () => Promise.resolve(),
    });
    reportedHomeDir = "/Users/tester";
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await screen.findByTestId("remote-folder-picker-path");
    expect(homeDirEnabledCalls).toContain(true);
    expect(pathInput().value).toBe("/Users/tester/");
    expect(
      screen.getByTestId("remote-folder-picker-add").hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester"],
    });
  });

  it("expands ~ off getHomeDir when the home listing never answers", async () => {
    // The whole point of reading getHomeDir separately: home is unlistable, so
    // the root browse can never teach the field where `~` points - but Add
    // needs no listing, so picking out of it must still work.
    queryByPath.set(pathKey(null), {
      data: undefined,
      isPending: false,
      error: new Error(
        "Access to this folder is denied on the host machine (System Settings > Privacy & Security on the host Mac)",
      ),
      refetch: () => Promise.resolve(),
    });
    reportedHomeDir = "/Users/tester";
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await screen.findByTestId("remote-folder-picker-path");
    fireEvent.change(pathInput(), { target: { value: "~/code" } });
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/code"],
    });
  });
});
