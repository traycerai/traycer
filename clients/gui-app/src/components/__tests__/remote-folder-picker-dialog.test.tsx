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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  WorkspaceBrowseFoldersResponse,
  WorkspacePrepareFoldersResponseV11,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { RemoteFolderPickerDialog } from "@/components/remote-folder-picker-dialog";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

interface FakeQueryState {
  readonly data: WorkspaceBrowseFoldersResponse | undefined;
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
 * `workspace.prepareFolders` v1.1 conveniences, faked at the same seam as the
 * browse query. `undefined` data stands in for the fail-closed
 * `DOWNGRADE_UNSUPPORTED` a v1.0 host answers these with - the picker must
 * treat that as "absent", never as an error.
 */
let recentEntries: readonly WorkspaceRecentEntry[] | undefined;
let reportedHomeDir: string | null | undefined;
const recordedRecents: string[] = [];

function prepareFoldersResponse(
  fields: Partial<WorkspacePrepareFoldersResponseV11>,
): WorkspacePrepareFoldersResponseV11 {
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

vi.mock("@/hooks/workspace/use-workspace-recent-workspaces-query", () => ({
  useWorkspaceRecentWorkspaces: () => ({
    data:
      recentEntries === undefined
        ? undefined
        : prepareFoldersResponse({
            operation: "listRecentWorkspaces",
            recentWorkspaces: [...recentEntries],
          }),
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-home-dir-query", () => ({
  useWorkspaceHomeDir: () => ({
    data:
      reportedHomeDir === undefined
        ? undefined
        : prepareFoldersResponse({
            operation: "getHomeDir",
            homeDir: reportedHomeDir,
          }),
  }),
}));

vi.mock(
  "@/hooks/workspace/use-workspace-record-recent-workspace-mutation",
  () => ({
    useWorkspaceRecordRecentWorkspace: () => ({
      mutate: (path: string) => {
        recordedRecents.push(path);
      },
    }),
  }),
);

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

function readyLevel(response: WorkspaceBrowseFoldersResponse): FakeQueryState {
  return {
    data: response,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve(),
  };
}

const HOME_RESPONSE: WorkspaceBrowseFoldersResponse = {
  directoryPath: "/Users/tester",
  parentPath: "/Users",
  entries: [
    { path: "/Users/tester/.config", name: ".config" },
    { path: "/Users/tester/code", name: "code" },
    { path: "/Users/tester/consulting", name: "consulting" },
    { path: "/Users/tester/Documents", name: "Documents" },
  ],
};

const CODE_RESPONSE: WorkspaceBrowseFoldersResponse = {
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
    recordedRecents.length = 0;
    useRemoteFolderPickerStore.setState({
      open: false,
      client: null,
      resolvePick: null,
    });
  });
  afterEach(cleanup);

  it("stays unmounted until a pick is requested", () => {
    render(<RemoteFolderPickerDialog />);
    expect(screen.queryByTestId("remote-folder-picker-dialog")).toBeNull();
  });

  it("seeds the field with the host home; hidden folders stay hidden unfiltered", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    expect(
      await screen.findByTestId("remote-folder-picker-dialog"),
    ).toBeTruthy();
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
    fireEvent.change(pathInput(), { target: { value: "/Users/tester/.co" } });
    expect(rowNames()).toEqual([".config"]);
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
    expect(requestedPaths.at(-1)).toBe("/Users/tester");
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
    // Empty folder: only the ".." row remains (matching T3's layout).
    expect(rowNames()).toEqual([]);
    expect(screen.getByTestId("remote-folder-picker-up-row")).toBeTruthy();
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
    await expect(pick).resolves.toBe("/Users/tester/code");
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
    await expect(pick).resolves.toBe("/Users/tester/projects/deep");
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
    await expect(pick).resolves.toBe("/Users/tester/Documents");
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

  it("arrow keys move the active option and Enter opens it", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    // Home has a ".." row at index 0 now, so the first entry is option 1.
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
        entries: [{ path: "/Users/tester/code/api", name: "api" }],
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
    await expect(second).resolves.toBe("/Users/tester");
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
    await expect(pick).resolves.toBe("/srv/app");
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
    await expect(pick).resolves.toBe("/Users/tester/code");
    expect(recordedRecents).toEqual(["/Users/tester/code"]);
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
    await expect(pick).resolves.toBe("/Users/tester/code");
  });
  /**
   * Paths are HOST-native: `workspace.browseFolders` runs on the host, so a
   * Windows host answers `C:\Users\tester` and the picker has to browse,
   * filter, walk up and Add with those - no POSIX rewriting anywhere.
   */
  describe("against a Windows host", () => {
    const WINDOWS_HOME: WorkspaceBrowseFoldersResponse = {
      directoryPath: "C:\\Users\\tester",
      parentPath: "C:\\Users",
      entries: [
        { path: "C:\\Users\\tester\\code", name: "code" },
        { path: "C:\\Users\\tester\\Documents", name: "Documents" },
      ],
    };

    beforeEach(() => {
      queryByPath.clear();
      queryByPath.set(pathKey(null), readyLevel(WINDOWS_HOME));
      queryByPath.set(pathKey("C:\\Users\\tester"), readyLevel(WINDOWS_HOME));
      queryByPath.set(
        pathKey("C:\\Users"),
        readyLevel({
          directoryPath: "C:\\Users",
          parentPath: "C:\\",
          entries: [{ path: "C:\\Users\\tester", name: "tester" }],
        }),
      );
      queryByPath.set(
        pathKey("C:\\"),
        readyLevel({
          directoryPath: "C:\\",
          parentPath: null,
          entries: [{ path: "C:\\Users", name: "Users" }],
        }),
      );
      queryByPath.set(
        pathKey("C:\\Users\\tester\\code"),
        readyLevel({
          directoryPath: "C:\\Users\\tester\\code",
          parentPath: "C:\\Users\\tester",
          entries: [],
        }),
      );
    });

    it("seeds the field with the host home and descends with backslashes", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      expect(
        await screen.findByTestId("remote-folder-picker-dialog"),
      ).toBeTruthy();
      expect(pathInput().value).toBe("C:\\Users\\tester\\");
      expect(rowNames()).toEqual(["code", "Documents"]);
      fireEvent.click(screen.getAllByTestId("remote-folder-picker-row")[0]);
      expect(pathInput().value).toBe("C:\\Users\\tester\\code\\");
    });

    it("live-filters the segment after the last backslash", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "C:\\Users\\tester\\co" },
      });
      expect(rowNames()).toEqual(["code"]);
    });

    it("walking up stops at the drive root", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.click(screen.getByTestId("remote-folder-picker-up-row"));
      expect(pathInput().value).toBe("C:\\Users\\");
      fireEvent.click(screen.getByTestId("remote-folder-picker-up-row"));
      // `C:\` is the fixpoint - never `C:`, which is drive-RELATIVE and would
      // resolve against the host's working directory instead of the root.
      expect(pathInput().value).toBe("C:\\");
      expect(screen.queryByTestId("remote-folder-picker-up-row")).toBeNull();
    });

    it("Add returns the host path with the trailing separator dropped", async () => {
      render(<RemoteFolderPickerDialog />);
      const pick = useRemoteFolderPickerStore
        .getState()
        .requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
      await expect(pick).resolves.toBe("C:\\Users\\tester");
      expect(recordedRecents).toEqual(["C:\\Users\\tester"]);
    });

    it("keeps the drive root itself addable", async () => {
      render(<RemoteFolderPickerDialog />);
      const pick = useRemoteFolderPickerStore
        .getState()
        .requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "C:\\" } });
      fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
      await expect(pick).resolves.toBe("C:\\");
    });

    it("expands ~ against the Windows home", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "~\\co" } });
      expect(rowNames()).toEqual(["code"]);
    });

    it("accepts forward slashes too, because the host does", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      // Windows resolves `/` as a separator, so the picker must not reject
      // what the user can legitimately type.
      fireEvent.change(pathInput(), { target: { value: "~/co" } });
      expect(screen.queryByTestId("remote-folder-picker-invalid")).toBeNull();
      expect(rowNames()).toEqual(["code"]);
    });

    it("browses a UNC share and stops walking up at it", async () => {
      queryByPath.set(
        pathKey("\\\\build\\shared"),
        readyLevel({
          directoryPath: "\\\\build\\shared",
          parentPath: null,
          entries: [{ path: "\\\\build\\shared\\web", name: "web" }],
        }),
      );
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "\\\\build\\shared\\" },
      });
      expect(rowNames()).toEqual(["web"]);
      expect(screen.queryByTestId("remote-folder-picker-up-row")).toBeNull();
    });

    it("still rejects a drive-relative path", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "Users\\tester" } });
      expect(screen.getByTestId("remote-folder-picker-invalid")).toBeTruthy();
    });
  });
});
