import {
  act,
  cleanup,
  render as renderBase,
  screen,
  fireEvent,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  WorkspaceBrowseFoldersResponseV11,
  WorkspacePrepareFoldersResponseV12,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { modLabel } from "@/lib/keybindings/platform";
import { RemoteFolderPickerDialog } from "@/components/remote-folder-picker-dialog";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

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
function prepareFoldersResponse(
  fields: Partial<WorkspacePrepareFoldersResponseV12>,
): WorkspacePrepareFoldersResponseV12 {
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
  useWorkspaceGetHomeDir: () => ({
    data:
      reportedHomeDir === undefined
        ? undefined
        : prepareFoldersResponse({
            operation: "getHomeDir",
            homeDir: reportedHomeDir,
          }),
  }),
}));

const negotiatedVersion: { current: NegotiatedMethodVersion } = vi.hoisted(
  () => ({
    current: { major: 1, minor: 4 },
  }),
);

vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => negotiatedVersion.current,
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
    { path: "/Users/tester/consulting", name: "consulting", hidden: false },
    { path: "/Users/tester/Documents", name: "Documents", hidden: false },
  ],
};

const CODE_RESPONSE: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "/Users/tester/code",
  parentPath: "/Users/tester",
  entries: [],
};

/** The always-visible path combobox. */
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

function render(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderBase(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
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
    negotiatedVersion.current = { major: 1, minor: 4 };
    useRemoteFolderPickerStore.setState({
      open: false,
      client: null,
      resolvePick: null,
      showHiddenFolders: false,
    });
  });
  afterEach(cleanup);

  it("stays unmounted until a pick is requested", () => {
    render(<RemoteFolderPickerDialog />);
    expect(screen.queryByTestId("remote-folder-picker-dialog")).toBeNull();
  });

  it("keeps a stable height and single-row footer across directory levels", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const dialog = await screen.findByTestId("remote-folder-picker-dialog");
    const dialogClasses = dialog.className.split(" ");
    expect(dialogClasses).toContain("top-[18svh]");
    expect(dialogClasses).toContain("translate-y-0");
    expect(dialogClasses).toContain(
      "h-[min(80dvh,36rem,calc(100dvh-18svh-var(--safe-area-inset-bottom)))]",
    );
    expect(dialogClasses).not.toContain("max-h-[min(80dvh,36rem)]");
    expect(dialogClasses).toContain(
      "max-w-[min(90vw,40rem,var(--safe-area-width))]",
    );
    expect(dialogClasses).toContain(
      "sm:max-w-[min(90vw,40rem,var(--safe-area-width))]",
    );
    expect(dialogClasses).not.toContain("top-safe-center-y");
    expect(dialogClasses).not.toContain("-translate-y-1/2");
    expect(dialogClasses).not.toContain("sm:max-w-sm");
    const addButton = screen.getByTestId("remote-folder-picker-add");
    expect(addButton.dataset.variant).toBe("outline");
    const addKeycaps = [...addButton.querySelectorAll('[data-slot="kbd"]')];
    expect(addKeycaps).toHaveLength(2);
    for (const keycap of addKeycaps) {
      expect(keycap.className).toContain("bg-foreground/8");
      expect(keycap.className).toContain("text-muted-foreground");
      expect(keycap.className.split(" ")).not.toContain("text-current");
    }
    expect(screen.getByRole("button", { name: "Up one folder" })).toBeTruthy();
    expect(pathInput().parentElement?.className).not.toContain(
      "bg-foreground/8",
    );
    expect(pathInput().parentElement?.parentElement?.className).toContain(
      "flex-1",
    );
    expect(pathInput().className).not.toMatch(/border|ring/);
    expect(screen.getByText("Directories")).toBeTruthy();

    const footer = screen
      .getByRole("button", { name: "Folder picker settings" })
      .closest(".border-t");
    expect(footer).not.toBeNull();
    expect(footer?.querySelector(".flex-wrap")).toBeNull();
  });

  it("keeps the editable path visible through navigation and creation", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const field = await screen.findByRole("combobox", { name: "Folder path" });
    expect(field).toBeInstanceOf(HTMLInputElement);
    expect(
      screen.queryByRole("combobox", { name: "Search folders" }),
    ).toBeNull();
    expect(pathInput().value).toBe("/Users/tester/");

    Object.defineProperty(pathInput(), "scrollWidth", {
      configurable: true,
      value: 400,
    });
    pathInput().scrollLeft = 0;
    pathInput().setSelectionRange(0, 0);
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-row"))[0],
    );
    expect(pathInput().value).toBe("/Users/tester/code/");
    expect(pathInput().selectionStart).toBe(pathInput().value.length);
    expect(pathInput().scrollLeft).toBe(400);
    pathInput().scrollLeft = 100;
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/code/new-folder" },
    });
    expect(pathInput().scrollLeft).toBe(100);
    expect(
      screen.getByTestId("remote-folder-picker-add").textContent,
    ).toContain("Create & Add");
  });

  it("keeps a selected fuzzy match visible on hover", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/cod" },
    });
    const row = screen.getByTestId("remote-folder-picker-row");
    expect(row.className.split(" ")).toEqual(
      expect.arrayContaining(["bg-foreground/8", "hover:bg-foreground/8"]),
    );
    expect(
      row.querySelector("[data-testid='folder-picker-name-hit']")?.className,
    ).toContain("group-aria-selected/button:text-foreground");
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

  it("shows hidden folders on demand and remembers the preference locally", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(
      screen.getByRole("button", { name: "Folder picker settings" }),
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(rowNames()).toContain(".config");
    expect(useRemoteFolderPickerStore.getState().showHiddenFolders).toBe(true);
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
    // Retry disappears when it succeeds, so the keyboard returns to the
    // combobox that owns path editing and row navigation.
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
    // Empty folder: only the ".." row remains.
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

  it("backs out of an unlistable folder via the .. row", async () => {
    // The `..` row is the ONLY up affordance - there is no back arrow - so
    // backing out of a folder that cannot be listed has to work from it.
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    const rows = await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.click(rows[2]);
    expect(screen.getByTestId("remote-folder-picker-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("remote-folder-picker-up-row"));
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
    // The same key OUTSIDE composition still opens the selected row. The
    // resting selection is the first real FOLDER, not `..`, so it descends.
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/code/");
  });

  it("advertises the platform modifier on Add, not a fixed glyph", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    // jsdom is not a Mac, so a hardcoded ⌘ would fail this on the very
    // platforms whose working shortcut is Ctrl+Enter.
    expect(
      screen.getByTestId("remote-folder-picker-add").textContent,
    ).toContain(modLabel());
  });

  it("arrow keys move the active option and Enter opens it", async () => {
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    // `..` occupies option 0, so the first real folder is option 1 - and it
    // is where the selection RESTS before any key is pressed. "Go up" is a
    // poor default for Enter, and on touch the resting fill is all the
    // highlight communicates.
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-1",
    );
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(pathInput(), { key: "ArrowDown" });
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-2",
    );
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/consulting/");
  });

  it("keeps the parent row active while repeatedly ascending with Enter", async () => {
    queryByPath.set(
      pathKey("/Users"),
      readyLevel({
        directoryPath: "/Users",
        parentPath: "/",
        entries: [{ path: "/Users/tester", name: "tester", hidden: false }],
      }),
    );
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");

    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/code/");
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-0",
    );
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/tester/");
    expect(pathInput().getAttribute("aria-activedescendant")).toBe(
      "remote-folder-picker-option-0",
    );
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(pathInput().value).toBe("/Users/");
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

  it.each([
    ["v1.2", { major: 1, minor: 2 }],
    ["unsupported", false],
    ["unknown", null],
  ] as const)(
    "keeps Add disabled for a missing folder on a %s host",
    async (_label, version) => {
      negotiatedVersion.current = version;
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/new-folder" },
      });
      const add = screen.getByTestId("remote-folder-picker-add");
      expect(add.hasAttribute("disabled")).toBe(true);
      expect(add.textContent).toContain("Add");
      expect(add.textContent).not.toContain("Create & Add");
    },
  );

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
    // Recents share a base, so it is stated ONCE in the heading and each row
    // carries only what distinguishes it.
    expect(chips.map((chip) => chip.textContent)).toEqual(["app", "api"]);
    expect(
      screen.getByTestId("remote-folder-picker-group-header").textContent,
    ).toContain("/srv");
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

  it("treats a backslash as an ordinary character in a POSIX folder name", async () => {
    // A POSIX host may legitimately have a folder named `foo\bar`; splitting
    // at the backslash would browse `/Users/tester/foo` instead.
    queryByPath.set(
      pathKey("/Users/tester"),
      readyLevel({
        directoryPath: "/Users/tester",
        parentPath: "/Users",
        entries: [
          {
            path: "/Users/tester/foo\\bar",
            name: "foo\\bar",
            hidden: false,
          },
          { path: "/Users/tester/code", name: "code", hidden: false },
        ],
      }),
    );
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), {
      target: { value: "/Users/tester/foo\\bar" },
    });
    // Browsed /Users/tester filtered by "foo\bar" - never /Users/tester/foo.
    expect(requestedPaths).toContain("/Users/tester");
    expect(requestedPaths).not.toContain("/Users/tester/foo");
    expect(rowNames()).toEqual(["foo\\bar"]);
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/Users/tester/foo\\bar"],
    });
  });

  it("preserves trailing whitespace in a directory name through Add", async () => {
    // `/srv/project ` and `/srv/project` are distinct POSIX siblings, so
    // trimming before submit would silently pick the one the field never
    // showed. Reachable by typing too, but a recent is how it arrives verbatim.
    recentEntries = [
      { path: "/srv/project ", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
    ];
    render(<RemoteFolderPickerDialog />);
    const pick = useRemoteFolderPickerStore
      .getState()
      .requestPick(makeClient());
    fireEvent.click(
      (await screen.findAllByTestId("remote-folder-picker-recent"))[0],
    );
    expect(pathInput().value).toBe("/srv/project ");
    fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
    await expect(pick).resolves.toEqual({
      kind: "prepare",
      folderPaths: ["/srv/project "],
    });
  });

  it("whitespace-only input is still no path at all", async () => {
    // Trailing whitespace being significant must not promote a field holding
    // ONLY whitespace into a filter or an addable path.
    render(<RemoteFolderPickerDialog />);
    void useRemoteFolderPickerStore.getState().requestPick(makeClient());
    await screen.findAllByTestId("remote-folder-picker-row");
    fireEvent.change(pathInput(), { target: { value: "   " } });
    expect(screen.queryByTestId("remote-folder-picker-invalid")).toBeNull();
    expect(rowNames()).toEqual(["code", "consulting", "Documents"]);
    expect(
      screen.getByTestId("remote-folder-picker-add").hasAttribute("disabled"),
    ).toBe(true);
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
  /**
   * Paths are HOST-native: `workspace.browseFolders` runs on the host, so a
   * Windows host answers `C:\Users\tester` and the picker has to browse,
   * filter, walk up and Add with those - no POSIX rewriting anywhere.
   */
  describe("against a Windows host", () => {
    const WINDOWS_HOME: WorkspaceBrowseFoldersResponseV11 = {
      directoryPath: "C:\\Users\\tester",
      parentPath: "C:\\Users",
      entries: [
        {
          path: "C:\\Users\\tester\\code",
          name: "code",
          hidden: false,
        },
        {
          path: "C:\\Users\\tester\\Documents",
          name: "Documents",
          hidden: false,
        },
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
          entries: [
            { path: "C:\\Users\\tester", name: "tester", hidden: false },
          ],
        }),
      );
      queryByPath.set(
        pathKey("C:\\"),
        readyLevel({
          directoryPath: "C:\\",
          parentPath: null,
          entries: [{ path: "C:\\Users", name: "Users", hidden: false }],
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
      await expect(pick).resolves.toEqual({
        kind: "prepare",
        folderPaths: ["C:\\Users\\tester"],
      });
    });

    it("keeps the drive root itself addable", async () => {
      render(<RemoteFolderPickerDialog />);
      const pick = useRemoteFolderPickerStore
        .getState()
        .requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "C:\\" } });
      fireEvent.click(screen.getByTestId("remote-folder-picker-add"));
      await expect(pick).resolves.toEqual({
        kind: "prepare",
        folderPaths: ["C:\\"],
      });
    });

    it("keeps the drive root's separator in the field", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "C:\\" } });
      expect(pathInput().value).toBe("C:\\");
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
          entries: [
            {
              path: "\\\\build\\shared\\web",
              name: "web",
              hidden: false,
            },
          ],
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

    it("browses a UNC share root typed WITHOUT a trailing separator", async () => {
      // The form a user types first. Unlike `/` and `C:\`, a share root does
      // not end in a separator, so deriving the filter from the last one would
      // filter the share by its own name ("shared") and hide every row.
      queryByPath.set(
        pathKey("\\\\build\\shared"),
        readyLevel({
          directoryPath: "\\\\build\\shared",
          parentPath: null,
          entries: [
            {
              path: "\\\\build\\shared\\web",
              name: "web",
              hidden: false,
            },
          ],
        }),
      );
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "\\\\build\\shared" } });
      expect(rowNames()).toEqual(["web"]);
    });

    it("recognizes a UNC root typed with forward slashes", async () => {
      // Windows resolves `//build/shared` as UNC just like the backslash
      // form. Falling through to POSIX handling would browse `//build`
      // filtered by "shared" and never list the share itself.
      queryByPath.set(
        pathKey("//build/shared"),
        readyLevel({
          directoryPath: "//build/shared",
          parentPath: null,
          entries: [{ path: "//build/shared/web", name: "web", hidden: false }],
        }),
      );
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), { target: { value: "//build/shared" } });
      expect(requestedPaths).toContain("//build/shared");
      expect(requestedPaths).not.toContain("//build");
      expect(rowNames()).toEqual(["web"]);
      // The share root is the walking-up fixpoint in this spelling too.
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
  describe("path filtering", () => {
    it("filters the current folder from the final path segment", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/co" },
      });
      expect(rowNames()).toEqual(["code", "consulting"]);
      expect(requestedPaths.at(-1)).toBe("/Users/tester");
      expect(pathInput().value).toBe("/Users/tester/co");
    });

    it("ranks by match strength, not by listing order", async () => {
      const level = readyLevel({
        directoryPath: "/Users/tester",
        parentPath: "/Users",
        entries: [
          {
            path: "/Users/tester/my-prototype",
            name: "my-prototype",
            hidden: false,
          },
          {
            path: "/Users/tester/mp-tools",
            name: "mp-tools",
            hidden: false,
          },
          {
            path: "/Users/tester/old-mpt-runner",
            name: "old-mpt-runner",
            hidden: false,
          },
          { path: "/Users/tester/mpt", name: "mpt", hidden: false },
        ],
      });
      queryByPath.set(pathKey(null), level);
      queryByPath.set(pathKey("/Users/tester"), level);
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/mpt" },
      });
      // Prefix, then substring, then scattered subsequence - and within the
      // subsequence tier the tighter run first ("mp-tools" spans 4
      // characters, "my-prototype" spans 7). Listing order does not survive.
      expect(rowNames()).toEqual([
        "mpt",
        "old-mpt-runner",
        "mp-tools",
        "my-prototype",
      ]);
    });

    it("hides the .. row while a search is running", async () => {
      // `..` is navigation, not an answer to the query. The accepted cost is
      // that going up means clearing the search first - there is no back
      // arrow to fall back on.
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      expect(screen.getByTestId("remote-folder-picker-up-row")).toBeTruthy();
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/co" },
      });
      expect(screen.queryByTestId("remote-folder-picker-up-row")).toBeNull();
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/" },
      });
      expect(screen.getByTestId("remote-folder-picker-up-row")).toBeTruthy();
    });

    it("says nothing matches, rather than that the folder is empty", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/zzz" },
      });
      expect(screen.getByText("Nothing here matches.")).toBeTruthy();
    });

    it("marks the matched characters inside each name", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/cod" },
      });
      const [row] = screen.getAllByTestId("remote-folder-picker-row");
      // The hit is marked in place; the rest of the name still renders.
      expect(row.textContent).toBe("code");
      expect(
        row.querySelector("[data-testid='folder-picker-name-hit']")
          ?.textContent,
      ).toBe("cod");
    });

    it("opening a filtered row appends it to the field", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      fireEvent.change(pathInput(), {
        target: { value: "/Users/tester/code" },
      });
      fireEvent.click(screen.getAllByTestId("remote-folder-picker-row")[0]);
      expect(pathInput().value).toBe("/Users/tester/code/");
    });

    it("shows the editable absolute path without a disclosure step", async () => {
      render(<RemoteFolderPickerDialog />);
      void useRemoteFolderPickerStore.getState().requestPick(makeClient());
      await screen.findAllByTestId("remote-folder-picker-row");
      expect(screen.getByRole("combobox", { name: "Folder path" })).toBe(
        pathInput(),
      );
      expect(pathInput().value).toBe("/Users/tester/");
    });

    it("long-pressing a row reveals its full path verbatim", async () => {
      vi.useFakeTimers();
      try {
        render(<RemoteFolderPickerDialog />);
        void useRemoteFolderPickerStore.getState().requestPick(makeClient());
        await vi.advanceTimersByTimeAsync(0);
        const [row] = screen.getAllByTestId("remote-folder-picker-row");
        // The recognizer is touch-only: a mouse already has a right-click,
        // and a long left-click there is an interrupted drag, not an intent.
        fireEvent.pointerDown(row, {
          clientX: 10,
          clientY: 10,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
        });
        act(() => {
          vi.advanceTimersByTime(500);
        });
        // The escape hatch for every abbreviation elsewhere: the absolute
        // path, uncollapsed and untruncated.
        expect(screen.getByText("/Users/tester/code")).toBeTruthy();
        // And the press must not ALSO pick the row it was inspecting.
        fireEvent.click(row);
        expect(pathInput().value).toBe("/Users/tester/");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a press that becomes a scroll is not a long press", async () => {
      vi.useFakeTimers();
      try {
        render(<RemoteFolderPickerDialog />);
        void useRemoteFolderPickerStore.getState().requestPick(makeClient());
        await vi.advanceTimersByTimeAsync(0);
        const [row] = screen.getAllByTestId("remote-folder-picker-row");
        fireEvent.pointerDown(row, {
          clientX: 10,
          clientY: 10,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
        });
        fireEvent.pointerMove(row, {
          clientX: 10,
          clientY: 60,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
        });
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(screen.queryByText("/Users/tester/code")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
