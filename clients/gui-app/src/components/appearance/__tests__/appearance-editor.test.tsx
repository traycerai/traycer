import { Blob as NodeBlob } from "node:buffer";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceAppearanceRead,
  WorkspaceSetAppearanceResponse,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { useAuthStore } from "@/stores/auth/auth-store";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { captureAppearanceSession } from "@/lib/appearance/appearance-cache";
import type { PreparedAppearanceImage } from "@/lib/appearance/appearance-image-preparation";
import AppearanceEditor from "@/components/appearance/appearance-editor";
import {
  useAppearanceEditor,
  type AppearanceEditorTarget,
  type AppearanceProjectScope,
} from "@/components/appearance/appearance-editor-launcher";

/**
 * Mocks stay at the hook/RPC boundary (`useWorkspaceAppearance`,
 * `useWorkspaceSetAppearance`, `useSaveGlobalAppearance`, `useAppearanceAsset`,
 * `prepareAppearanceImage`) - those already have their own suites, and this
 * one is about the editor's own logic. No jest-dom matchers: this repo
 * doesn't wire up `@testing-library/jest-dom`, so assertions read DOM
 * properties directly (`.textContent`, `.value`, `.disabled`).
 */
// The real `useWorkspaceAppearance().query`'s resolved `data` (and
// `.appearance`) carry an `editable` flag alongside the raw protocol read -
// `ProjectEditor.reload()` gates on `read?.editable === true` before ever
// advancing past a stale/unusable authoritative response.
type MockAppearanceRead = WorkspaceAppearanceRead & {
  readonly editable: boolean;
};

interface WorkspaceAppearanceMockResult {
  readonly query: {
    readonly isSuccess: boolean;
    readonly isError: boolean;
    readonly isFetching: boolean;
    readonly refetch: () => Promise<{
      readonly isSuccess: boolean;
      readonly data: MockAppearanceRead | null | undefined;
    }>;
  };
  readonly appearance: MockAppearanceRead | null;
  readonly scope: null;
  readonly canEdit: boolean;
  readonly readSupport: boolean | null;
  readonly writeSupport: boolean | null;
  readonly isFallback: boolean;
  readonly assetRefreshKey: number;
}

const globalSave = vi.hoisted(() => ({
  mutateAsync:
    vi.fn<
      (input: {
        readonly wallpaper: unknown;
        readonly blob: Blob | null;
        readonly showGreeting: boolean;
        readonly showRecentHistory: boolean;
      }) => Promise<void>
    >(),
}));
vi.mock("@/hooks/appearance/use-appearance-assets", () => ({
  useSaveGlobalAppearance: () => ({
    mutateAsync: globalSave.mutateAsync,
    isPending: false,
  }),
  useAppearanceAsset: () => ({
    url: null,
    status: "empty" as const,
    reason: null,
    reportDecodeFailure: () => {},
  }),
}));

function buildSetAppearanceMock() {
  return {
    mutateAsync:
      vi.fn<
        (input: {
          readonly epicId: string;
          readonly workspacePath: string;
          readonly expectedRevision: string | null;
          readonly patch: unknown;
          readonly uploads: readonly unknown[];
        }) => Promise<WorkspaceSetAppearanceResponse>
      >(),
    isPending: false,
  };
}
const workspace = vi.hoisted(() => {
  const initial: WorkspaceAppearanceMockResult = {
    query: {
      isSuccess: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(() => Promise.resolve({ isSuccess: false, data: null })),
    },
    appearance: null,
    scope: null,
    canEdit: false,
    readSupport: null,
    writeSupport: null,
    isFallback: false,
    assetRefreshKey: 0,
  };
  return { current: initial, setAppearance: buildSetAppearanceMock() };
});
vi.mock("@/hooks/appearance/use-workspace-appearance", () => ({
  useWorkspaceAppearance: () => workspace.current,
  useWorkspaceSetAppearance: () => workspace.setAppearance,
}));

const prepareImage = vi.hoisted(() => ({
  fn: vi.fn<
    (
      input: { readonly blob: Blob; readonly target: "wallpaper" | "icon" },
      signal: AbortSignal,
    ) => Promise<PreparedAppearanceImage>
  >(),
}));
vi.mock("@/lib/appearance/appearance-image-preparation", () => ({
  prepareAppearanceImage: (
    input: { readonly blob: Blob; readonly target: "wallpaper" | "icon" },
    signal: AbortSignal,
  ) => prepareImage.fn(input, signal),
}));

function projectScope(
  overrides: Partial<AppearanceProjectScope>,
): AppearanceProjectScope {
  return {
    kind: "project",
    hostId: "host-a",
    workspacePath: "/repo",
    epicId: "epic-1",
    readOnly: false,
    ...overrides,
  };
}

// `accountId: null` sidesteps the auth-store/session dance the hook suites
// already cover: `appearanceEditorSessionCurrent` treats a null account as
// always current, which is the right stand-in for suites not about session
// validity itself (the real auth store is used separately below, for the
// account-change suite).
function projectTarget(
  overrides: Partial<AppearanceProjectScope>,
): AppearanceEditorTarget {
  return { ...projectScope(overrides), accountId: null, session: 0 };
}

function globalTarget(
  repository: AppearanceProjectScope | null,
): AppearanceEditorTarget {
  return { kind: "global", repository, accountId: null, session: 0 };
}

function appearanceRead(
  overrides: Partial<MockAppearanceRead>,
): MockAppearanceRead {
  return {
    workspacePath: "/repo",
    canonicalSourceRoot: "/repo/root",
    status: "present",
    revision: "rev-1",
    appearance: { version: 1 },
    issues: [],
    editable: true,
    ...overrides,
  };
}

function resolvedAppearance(
  read: MockAppearanceRead | null,
  overrides: Partial<WorkspaceAppearanceMockResult>,
): WorkspaceAppearanceMockResult {
  return {
    query: {
      isSuccess: read !== null,
      isError: false,
      isFetching: false,
      refetch: vi.fn(() =>
        Promise.resolve({ isSuccess: read !== null, data: read }),
      ),
    },
    appearance: read,
    scope: null,
    canEdit: true,
    readSupport: true,
    writeSupport: true,
    isFallback: false,
    assetRefreshKey: 0,
    ...overrides,
  };
}

function pngFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

// `.blob.arrayBuffer()` is called on this by `useEditorImage.select()` -
// jsdom's own `Blob` doesn't implement `arrayBuffer()`, so the global is
// stubbed to the real Node one for the duration of each test (see
// `appearance-cache.test.ts`'s doc comment for the same issue on the
// IndexedDB side), and this constructs a plain `new Blob(...)` under that
// stub rather than casting a `node:buffer` instance to the DOM type.
function preparedImage(path: string): PreparedAppearanceImage {
  return {
    blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    width: 4,
    height: 4,
    hash: path,
    path,
  };
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

function textbox(labelText: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(labelText) as HTMLInputElement;
}

function saveRepositoryButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Save repository",
  }) as HTMLButtonElement;
}

async function openRepositoryScope(): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: "Edit" }));
  fireEvent.click(screen.getByRole("option", { name: "Primary repository" }));
  await screen.findByRole("button", { name: "Save repository" });
}

const noop = () => {};

let createObjectURLCounter = 0;

beforeEach(() => {
  useSettingsStore.setState({
    globalWallpaper: null,
    showGreeting: true,
    showRecentHistory: true,
  });
  globalSave.mutateAsync.mockReset();
  workspace.current = resolvedAppearance(null, {
    canEdit: false,
    readSupport: null,
    writeSupport: null,
  });
  workspace.setAppearance.mutateAsync.mockReset();
  workspace.setAppearance.isPending = false;
  prepareImage.fn.mockReset();
  createObjectURLCounter = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:mock-${createObjectURLCounter++}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.stubGlobal("Blob", NodeBlob);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: "signed-out", contextMetadata: undefined });
});

describe("AppearanceEditor: global scope, Cancel and Save", () => {
  it("Cancel closes without ever calling the save mutation", () => {
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(null)}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(globalSave.mutateAsync).not.toHaveBeenCalled();
  });

  it("Save global calls the mutation with the edited draft and closes on success", async () => {
    globalSave.mutateAsync.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(null)}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    fireEvent.click(checkbox("Show greeting"));
    fireEvent.click(screen.getByRole("button", { name: "Save global" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(globalSave.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ showGreeting: false, showRecentHistory: true }),
    );
  });

  it("a failed save reports the error, keeps the editor open, and preserves the edited draft", async () => {
    globalSave.mutateAsync.mockRejectedValue(new Error("Host unreachable."));
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(null)}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    fireEvent.click(checkbox("Show greeting"));
    fireEvent.click(screen.getByRole("button", { name: "Save global" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Host unreachable.");
    expect(onClose).not.toHaveBeenCalled();
    expect(checkbox("Show greeting").checked).toBe(false);
    // Re-clickable: a prior failure must not have wedged the button disabled.
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save global" })
        .disabled,
    ).toBe(false);
  });

  it("an account change before Save is even attempted refuses editing entirely, via the real auth store", () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "acct-1", username: "acct-1" },
    });
    const target: AppearanceEditorTarget = {
      kind: "global",
      repository: null,
      accountId: "acct-1",
      session: captureAppearanceSession(),
    };
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={target}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );
    fireEvent.click(checkbox("Show greeting"));

    // `fireEvent`/`render` auto-wrap in `act`, but a direct `setState` call
    // does not - without this, `useAuthStore`'s subscribers can flush after
    // the assertion below runs instead of before it.
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "acct-2", username: "acct-2" },
      });
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "Your account changed",
    );
    expect(screen.queryByRole("button", { name: "Save global" })).toBeNull();
    expect(globalSave.mutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("AppearanceEditor: global+repository selector, per-scope dirty tracking", () => {
  it("saving the repository scope while global is still dirty keeps the editor open with both drafts intact; saving global last closes it", async () => {
    const read = appearanceRead({});
    workspace.current = resolvedAppearance(read, {});
    workspace.setAppearance.mutateAsync.mockResolvedValue({
      status: "saved",
      appearance: read,
    } satisfies WorkspaceSetAppearanceResponse);
    globalSave.mutateAsync.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(projectScope({}))}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    // Dirty the global scope first.
    fireEvent.click(checkbox("Show greeting"));

    // Switch to the repository scope and dirty it too.
    await openRepositoryScope();
    fireEvent.change(textbox("Tab color"), { target: { value: "#123456" } });

    // Save the repository scope - the global scope is still dirty, so the
    // editor must stay open with both drafts intact.
    fireEvent.click(saveRepositoryButton());
    await waitFor(() =>
      expect(workspace.setAppearance.mutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(onClose).not.toHaveBeenCalled();

    // Switch back to the global scope - its edit is still there.
    fireEvent.click(screen.getByRole("combobox", { name: "Edit" }));
    fireEvent.click(screen.getByRole("option", { name: "Personal defaults" }));
    expect(checkbox("Show greeting").checked).toBe(false);

    // Saving the remaining dirty (global) scope closes the editor, since
    // neither scope is dirty afterward.
    fireEvent.click(screen.getByRole("button", { name: "Save global" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("saving the global scope first leaves an untouched repository draft alone; saving the repository scope after closes", async () => {
    // The reverse order from the test above - proves a global save cannot
    // alter (or accidentally submit) the repository scope's own state.
    const read = appearanceRead({});
    workspace.current = resolvedAppearance(read, {});
    workspace.setAppearance.mutateAsync.mockResolvedValue({
      status: "saved",
      appearance: read,
    } satisfies WorkspaceSetAppearanceResponse);
    globalSave.mutateAsync.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(projectScope({}))}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    // Visit (but do not edit) the repository scope, then dirty it.
    await openRepositoryScope();
    fireEvent.change(textbox("Tab color"), { target: { value: "#654321" } });

    // Back to global, dirty it too, and save it.
    fireEvent.click(screen.getByRole("combobox", { name: "Edit" }));
    fireEvent.click(screen.getByRole("option", { name: "Personal defaults" }));
    fireEvent.click(checkbox("Show greeting"));
    fireEvent.click(screen.getByRole("button", { name: "Save global" }));

    await waitFor(() =>
      expect(globalSave.mutateAsync).toHaveBeenCalledTimes(1),
    );
    // The repository scope's own mutation must never have been reached by
    // saving global, and the editor must stay open (repository still dirty).
    expect(workspace.setAppearance.mutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The repository draft is exactly as left, untouched by the global save.
    fireEvent.click(screen.getByRole("combobox", { name: "Edit" }));
    fireEvent.click(screen.getByRole("option", { name: "Primary repository" }));
    expect(textbox("Tab color").value).toBe("#654321");

    // Saving the repository scope now clears the last dirty flag and closes.
    fireEvent.click(saveRepositoryButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Cancel discards both drafts even when only the currently-visible scope was ever touched", async () => {
    workspace.current = resolvedAppearance(appearanceRead({}), {});
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={globalTarget(projectScope({}))}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );

    await openRepositoryScope();
    fireEvent.change(textbox("Tab color"), { target: { value: "#654321" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(workspace.setAppearance.mutateAsync).not.toHaveBeenCalled();
    expect(globalSave.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("AppearanceEditor: project scope gating (unknown host / read-only / unsupported)", () => {
  it("explains an unknown host and never mounts a save-capable form", () => {
    render(
      <AppearanceEditor
        target={projectTarget({ hostId: null })}
        onClose={vi.fn()}
        onRestoreFocus={noop}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "This task's device is not known yet.",
    );
    expect(
      screen.queryByRole("button", { name: "Save repository" }),
    ).toBeNull();
  });

  it("explains read-only access and disables Save, while still rendering the (disabled) draft", async () => {
    workspace.current = resolvedAppearance(appearanceRead({}), {});
    render(
      <AppearanceEditor
        target={projectTarget({ readOnly: true })}
        onClose={vi.fn()}
        onRestoreFocus={noop}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("read-only access");
    const button = await screen.findByRole("button", {
      name: "Save repository",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains an unsupported (older) host and disables Save", async () => {
    workspace.current = resolvedAppearance(appearanceRead({}), {
      writeSupport: false,
      canEdit: false,
    });
    render(
      <AppearanceEditor
        target={projectTarget({})}
        onClose={vi.fn()}
        onRestoreFocus={noop}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Update this task's device",
    );
    const button = await screen.findByRole("button", {
      name: "Save repository",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AppearanceEditor: project scope conflict and failure", () => {
  it("a conflict response preserves the draft, explains itself, does not close, and disables Save until Reload", async () => {
    const read = appearanceRead({});
    workspace.current = resolvedAppearance(read, {});
    workspace.setAppearance.mutateAsync.mockResolvedValue({
      status: "conflict",
      appearance: read,
    } satisfies WorkspaceSetAppearanceResponse);
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={projectTarget({})}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );
    await screen.findByRole("button", { name: "Save repository" });

    fireEvent.change(textbox("Tab color"), { target: { value: "#abcdef" } });
    fireEvent.click(saveRepositoryButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your draft is still here");
    expect(onClose).not.toHaveBeenCalled();
    expect(textbox("Tab color").value).toBe("#abcdef");
    expect(saveRepositoryButton().disabled).toBe(true);

    // "Reload saved settings" remounts the form with an explicit new
    // baseline, which is what lifts the post-conflict disabled state.
    fireEvent.click(
      screen.getByRole("button", { name: "Reload saved settings" }),
    );
    await waitFor(() => expect(saveRepositoryButton().disabled).toBe(false));
  });

  it("a reload that comes back authoritative but unusable (editable=false) refuses to advance - conflict, draft, and disabled Save all survive", async () => {
    const read = appearanceRead({});
    workspace.current = resolvedAppearance(read, {});
    workspace.setAppearance.mutateAsync.mockResolvedValue({
      status: "conflict",
      appearance: read,
    } satisfies WorkspaceSetAppearanceResponse);
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={projectTarget({})}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );
    await screen.findByRole("button", { name: "Save repository" });
    fireEvent.change(textbox("Tab color"), { target: { value: "#abcdef" } });
    fireEvent.click(saveRepositoryButton());
    await screen.findByRole("alert");
    expect(saveRepositoryButton().disabled).toBe(true);

    // The next refetch (from clicking Reload) comes back authoritative
    // (isSuccess) but NOT usable - e.g. the device just went unreachable.
    vi.mocked(workspace.current.query.refetch).mockResolvedValueOnce({
      isSuccess: true,
      data: appearanceRead({ status: "unavailable", editable: false }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reload saved settings" }),
    );

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) =>
          alert.textContent.includes("could not be reloaded"),
        ),
      ).toBe(true);
    });
    // Still conflicted, still disabled, still the edited (not reset) draft.
    expect(saveRepositoryButton().disabled).toBe(true);
    expect(textbox("Tab color").value).toBe("#abcdef");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a rejected save reports the failure, preserves the draft, and stays re-clickable", async () => {
    workspace.current = resolvedAppearance(appearanceRead({}), {});
    workspace.setAppearance.mutateAsync.mockRejectedValue(
      new Error("The device disconnected."),
    );
    const onClose = vi.fn();
    render(
      <AppearanceEditor
        target={projectTarget({})}
        onClose={onClose}
        onRestoreFocus={noop}
      />,
    );
    await screen.findByRole("button", { name: "Save repository" });

    fireEvent.change(textbox("Tab color"), { target: { value: "#111111" } });
    fireEvent.click(saveRepositoryButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The device disconnected.");
    expect(onClose).not.toHaveBeenCalled();
    expect(textbox("Tab color").value).toBe("#111111");
    expect(saveRepositoryButton().disabled).toBe(false);
  });
});

describe("AppearanceEditor: background image upload error and supersession", () => {
  it("a failed image preparation surfaces an inline alert", async () => {
    prepareImage.fn.mockRejectedValue(
      new Error("Choose a PNG, JPEG, or WebP image."),
    );
    render(
      <AppearanceEditor
        target={globalTarget(null)}
        onClose={vi.fn()}
        onRestoreFocus={noop}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Background" }));
    fireEvent.click(screen.getByRole("option", { name: "Image" }));
    fireEvent.change(textbox(/Background image/), {
      target: { files: [pngFile("wallpaper.png")] },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Choose a PNG, JPEG, or WebP image.");
  });

  it("a superseded selection's late rejection never surfaces once a newer selection has already succeeded", async () => {
    let rejectFirst!: (reason: unknown) => void;
    const first = new Promise<PreparedAppearanceImage>((_resolve, reject) => {
      rejectFirst = reject;
    });
    prepareImage.fn.mockImplementationOnce(() => first);
    prepareImage.fn.mockImplementationOnce(() =>
      Promise.resolve(preparedImage("appearance/second.webp")),
    );
    render(
      <AppearanceEditor
        target={globalTarget(null)}
        onClose={vi.fn()}
        onRestoreFocus={noop}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Background" }));
    fireEvent.click(screen.getByRole("option", { name: "Image" }));
    const input = textbox(/Background image/);

    fireEvent.change(input, { target: { files: [pngFile("a.png")] } });
    fireEvent.change(input, { target: { files: [pngFile("b.png")] } });

    // The newer (second) selection succeeds - proven by the treatment
    // controls that only render once a valid image is set.
    await screen.findByRole("combobox", { name: "Treatment" });

    // The superseded (first) selection now rejects, late. A real macrotask
    // tick, not just a couple of microtask hops, so this would actually
    // catch a late `setError` if the abort check were missing.
    rejectFirst(new Error("stale failure from the superseded selection"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Treatment" }),
    ).not.toBeNull();
  });
});

function LauncherHarness() {
  const { openEditor, editor } = useAppearanceEditor();
  return (
    <div>
      <button
        type="button"
        onClick={(event) =>
          openEditor({ kind: "global", repository: null }, event.currentTarget)
        }
      >
        Open
      </button>
      {editor}
    </div>
  );
}

describe("AppearanceEditor + launcher: a stale deferred Save never closes a reopened editor or clobbers its draft", () => {
  it("resolves the OLD Save (from a cancelled editor) only after a NEW editor already has its own draft - the new one survives untouched", async () => {
    let resolveOldSave!: () => void;
    globalSave.mutateAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOldSave = resolve;
        }),
    );
    globalSave.mutateAsync.mockResolvedValue(undefined);

    render(<LauncherHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("checkbox", { name: "Show greeting" });

    // Draft A: dirty it and fire a Save that never resolves yet.
    fireEvent.click(checkbox("Show greeting"));
    fireEvent.click(screen.getByRole("button", { name: "Save global" }));
    await waitFor(() =>
      expect(globalSave.mutateAsync).toHaveBeenCalledTimes(1),
    );

    // Cancel while the old Save is still in flight - the RPC itself is not
    // cancelled, only the UI closes.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("checkbox", { name: "Show greeting" }),
    ).toBeNull();

    // Reopen: a genuinely new editor instance/session. Start a NEW draft
    // (B), distinct from A's edit.
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("checkbox", { name: "Show greeting" });
    expect(checkbox("Show greeting").checked).toBe(true); // fresh, unaffected by A
    fireEvent.click(checkbox("Show recent history"));

    // The OLD Save now resolves, late.
    await act(async () => {
      resolveOldSave();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The NEW editor is still open, with draft B intact - untouched by A's
    // late resolution (which must not have closed it or reset its baseline).
    expect(checkbox("Show greeting").checked).toBe(true);
    expect(checkbox("Show recent history").checked).toBe(false);
  });
});

describe("AppearanceEditor: pane concealment preserves dirty values and a prepared upload through Save", () => {
  it("hides the dialog while concealed and, once revealed, saves with the draft and prepared upload intact", async () => {
    const read = appearanceRead({});
    workspace.current = resolvedAppearance(read, {});
    workspace.setAppearance.mutateAsync.mockResolvedValue({
      status: "saved",
      appearance: read,
    } satisfies WorkspaceSetAppearanceResponse);
    prepareImage.fn.mockResolvedValueOnce(
      preparedImage("appearance/concealed.webp"),
    );
    const onClose = vi.fn();
    const { rerender } = render(
      <PortalConcealmentProvider value={false}>
        <AppearanceEditor
          target={projectTarget({})}
          onClose={onClose}
          onRestoreFocus={noop}
        />
      </PortalConcealmentProvider>,
    );
    await screen.findByRole("button", { name: "Save repository" });

    // Dirty a field and start (and finish) an image upload.
    fireEvent.change(textbox("Tab color"), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Background" }));
    fireEvent.click(screen.getByRole("option", { name: "Project image" }));
    fireEvent.change(textbox(/Background image/), {
      target: { files: [pngFile("wallpaper.png")] },
    });
    await screen.findByRole("combobox", { name: "Treatment" });

    // Conceal the pane the dialog's portal lives in - the portal un-presents.
    rerender(
      <PortalConcealmentProvider value>
        <AppearanceEditor
          target={projectTarget({})}
          onClose={onClose}
          onRestoreFocus={noop}
        />
      </PortalConcealmentProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Save repository" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Tab color")).toBeNull();

    // Reveal it again - the same owning component never unmounted, so its
    // staged draft and prepared upload must still be there.
    rerender(
      <PortalConcealmentProvider value={false}>
        <AppearanceEditor
          target={projectTarget({})}
          onClose={onClose}
          onRestoreFocus={noop}
        />
      </PortalConcealmentProvider>,
    );
    expect(textbox("Tab color").value).toBe("#00ff00");
    expect(
      screen.queryByRole("combobox", { name: "Treatment" }),
    ).not.toBeNull();

    fireEvent.click(saveRepositoryButton());

    await waitFor(() =>
      expect(workspace.setAppearance.mutateAsync).toHaveBeenCalledTimes(1),
    );
    const call = workspace.setAppearance.mutateAsync.mock.calls.at(0);
    if (call === undefined) throw new Error("expected a save call");
    const [input] = call;
    expect(input.patch).toMatchObject({ color: "#00ff00" });
    expect(input.uploads).toHaveLength(1);
    expect(input.uploads[0]).toMatchObject({ target: "wallpaper" });
  });
});
