import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import type {
  LabelDefinition,
  TaskLabel,
} from "@traycer/protocol/host/organization/schemas";
import { TaskAppearancePicker } from "@/components/organization/task-appearance-picker";
import {
  TaskOrganizationDropdown,
  TaskOrganizationMenu,
} from "@/components/organization/task-organization-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  OrganizationDialogHost,
  type OrganizationDialog,
} from "@/components/organization/organization-dialogs";
import { OrganizationSyncNote } from "@/components/organization/organization-metadata";

const state = vi.hoisted(() => {
  const view: OrganizationView = {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [
      { taskId: "task-1", version: "0", color: "#445566", icon: "API" },
    ],
    taskLabels: { "task-1": { labels: [], removed: [] } },
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  const command = vi.fn<(action: OrganizationAction) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const organization = {
    supported: true,
    userId: "user-1",
    view,
    register: vi.fn(
      (_key: string, _taskIds: readonly string[]) => () => undefined,
    ),
    openDialog: vi.fn(),
    command,
  };
  const collaboratorRows: Array<{
    readonly userId: string;
    readonly displayName: string;
  }> = [];
  return { command, collaboratorRows, organization };
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function withQueryClient(ui: ReactNode): ReactNode {
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

function render(ui: ReactNode) {
  return renderUi(withQueryClient(ui));
}

vi.mock("@/hooks/organization/organization-context", async (load) => {
  const actual =
    await load<typeof import("@/hooks/organization/organization-context")>();
  return {
    ...actual,
    useOrganization: () => state.organization,
    useOrganizationTasks: () => state.organization,
  };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({}),
}));

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  useEpicCollaboratorsQuery: () => ({
    data: { flatRows: state.collaboratorRows },
  }),
}));

vi.mock("@/components/layout/tabs/tab-appearance-menu", () => ({
  TabColorPicker: (props: {
    readonly onChange: (color: string | null) => void;
    readonly onDefault?: () => void;
  }) => (
    <div>
      <button type="button" aria-label="Default" onClick={props.onDefault}>
        Default
      </button>
      <button
        type="button"
        aria-label="Choose color"
        onClick={() => props.onChange("#445566")}
      >
        Choose color
      </button>
    </div>
  ),
}));

function label(input: {
  readonly ownerId: string;
  readonly labelId: string;
  readonly name: string;
  readonly kind?: "custom" | "system";
}): LabelDefinition {
  return {
    ownerId: input.ownerId,
    labelId: input.labelId,
    kind: input.kind ?? "custom",
    systemKey: input.kind === "system" ? "imported" : null,
    name: input.name,
    color: "#112233",
    version: "0",
  };
}

function appliedLabel(definition: LabelDefinition): TaskLabel {
  return { ...definition, assignmentId: `${definition.labelId}-assignment` };
}

function renderDialog(dialog: OrganizationDialog) {
  return render(<OrganizationDialogHost dialog={dialog} onClose={vi.fn()} />);
}

function resetOrganization(): void {
  state.command.mockReset();
  state.command.mockImplementation(() => Promise.resolve());
  state.organization.view.catalog = [];
  state.organization.view.groups = {
    version: "0",
    groups: [],
    memberships: [],
  };
  state.organization.view.appearances = [
    { taskId: "task-1", version: "0", color: "#445566", icon: "API" },
  ];
  state.organization.view.taskLabels = {
    "task-1": { labels: [], removed: [] },
  };
  state.organization.view.pending = [];
  state.organization.view.authenticationRequired = false;
  state.collaboratorRows.length = 0;
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetOrganization();
});

describe("organization Revision 2", () => {
  it("saves the icon on blur and patches Default color independently", async () => {
    const user = userEvent.setup();
    render(<TaskAppearancePicker taskId="task-1" />);

    const icon = screen.getByLabelText("Icon");
    await user.clear(icon);
    await user.type(icon, "UI");
    fireEvent.blur(icon);

    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    expect(state.command.mock.calls[0]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      icon: "UI",
    });

    await user.click(screen.getByRole("button", { name: "Default" }));
    await waitFor(() => expect(state.command).toHaveBeenCalledTimes(2));
    expect(state.command.mock.calls[1]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      color: null,
    });
  });

  it("keeps the appearance submenu usable from the real task dropdown", async () => {
    const user = userEvent.setup();
    render(<TaskOrganizationDropdown taskId="task-1" canEdit title="Task" />);

    const launcher = screen.getByRole("button", { name: "Organize Task" });
    await user.click(launcher);
    await user.click(screen.getByRole("menuitem", { name: "Task appearance" }));
    const icon = screen.getByLabelText("Icon");
    expect(icon).toBeTruthy();

    await user.clear(icon);
    expect(icon.isConnected).toBe(true);
    expect(document.activeElement).toBe(icon);
    await user.type(icon, "UI");
    expect(icon.isConnected).toBe(true);
    expect(document.activeElement).toBe(icon);
    expect(screen.getByDisplayValue("UI")).toBe(icon);
    await user.keyboard("{ArrowLeft}");
    expect(icon.isConnected).toBe(true);
    expect(document.activeElement).toBe(icon);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    expect(state.command.mock.calls[0]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      icon: "UI",
    });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("enters the appearance submenu through keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<TaskOrganizationDropdown taskId="task-1" canEdit title="Task" />);

    const launcher = screen.getByRole("button", { name: "Organize Task" });
    launcher.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowRight}");

    const icon = screen.getByLabelText("Icon");
    await waitFor(() => expect(document.activeElement).toBe(icon));
    await user.clear(icon);
    await user.type(icon, "K");
    expect(document.activeElement).toBe(icon);
    expect(screen.getByDisplayValue("K")).toBe(icon);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("keeps a context-menu picker connected and focused after a deferred icon save", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    state.command.mockImplementation((action) => {
      if (action.kind === "appearance" && action.icon !== undefined) {
        return new Promise<void>((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve();
    });
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">Task row</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TaskOrganizationMenu taskId="task-1" canEdit title="Task" />
        </ContextMenuContent>
      </ContextMenu>,
    );

    const taskRow = screen.getByRole("button", { name: "Task row" });
    fireEvent.contextMenu(taskRow);
    await user.click(screen.getByRole("menuitem", { name: "Task appearance" }));
    const icon = screen.getByLabelText("Icon");
    await user.clear(icon);
    await user.type(icon, "UI");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resolveSave).toBeDefined());
    if (icon instanceof HTMLInputElement && icon.disabled) {
      // Browsers dispatch focusout when disabling the focused input; jsdom's
      // disabled blur is a no-op, so model that native transition explicitly.
      icon.disabled = false;
      icon.blur();
      expect(document.activeElement).toBe(document.body);
      icon.disabled = true;
    }
    const resolve = resolveSave;
    if (resolve === undefined) throw new Error("Expected pending icon save");
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    if (!(icon instanceof HTMLInputElement)) {
      throw new Error("Expected icon input");
    }
    await waitFor(() => {
      expect(icon.readOnly).toBe(false);
      expect(icon.disabled).toBe(false);
    });
    expect(icon.isConnected).toBe(true);
    expect(document.activeElement).toBe(icon);
    await user.clear(icon);
    await user.type(icon, "NEXT");
    expect(document.activeElement).toBe(icon);
    expect(screen.getByDisplayValue("NEXT")).toBe(icon);
  });

  it("keeps an applied label checkbox focused across a deferred Space toggle", async () => {
    const user = userEvent.setup();
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    state.organization.view.catalog = [owned];
    state.organization.view.taskLabels = {
      "task-1": { labels: [appliedLabel(owned)], removed: [] },
    };
    const resolves: Array<() => void> = [];
    state.command.mockImplementation((action) => {
      if (action.kind === "labels") {
        return new Promise<void>((resolve) => {
          resolves.push(resolve);
        });
      }
      return Promise.resolve();
    });
    const dialog = { kind: "labels" as const, taskId: "task-1", canEdit: true };
    const rendered = renderDialog(dialog);

    const checkbox = screen.getByRole("checkbox", { name: "Owned" });
    checkbox.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(resolves).toHaveLength(1));
    expect(state.command.mock.calls[0]?.[0]).toMatchObject({
      kind: "labels",
      taskId: "task-1",
      operations: [
        { operation: "remove", ownerId: "user-1", labelId: "owned" },
      ],
    });

    await user.keyboard(" ");
    expect(resolves).toHaveLength(1);

    // Browsers drop focus when disabling the active native button; jsdom's
    // disabled blur is a no-op, so model that transition explicitly.
    if (checkbox instanceof HTMLButtonElement && checkbox.disabled) {
      checkbox.disabled = false;
      checkbox.blur();
      expect(document.activeElement).toBe(document.body);
      checkbox.disabled = true;
    }
    state.organization.view.taskLabels = {
      "task-1": {
        labels: [],
        removed: [
          {
            ownerId: "user-1",
            labelId: "owned",
            assignmentId: "owned-assignment",
          },
        ],
      },
    };
    rendered.rerender(
      withQueryClient(
        <OrganizationDialogHost dialog={dialog} onClose={vi.fn()} />,
      ),
    );
    const resolveFirst = resolves.at(0);
    if (resolveFirst === undefined)
      throw new Error("Expected pending label toggle");
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    expect(checkbox.isConnected).toBe(true);
    expect(document.activeElement).toBe(checkbox);
    await user.keyboard(" ");
    await waitFor(() => expect(resolves).toHaveLength(2));
    expect(state.command.mock.calls[1]?.[0]).toMatchObject({
      kind: "labels",
      taskId: "task-1",
      operations: [{ operation: "attach", labelId: "owned" }],
    });
    const resolveSecond = resolves.at(1);
    if (resolveSecond === undefined)
      throw new Error("Expected second label toggle");
    await act(async () => {
      resolveSecond();
      await Promise.resolve();
    });
  });

  it("does not reclaim focus after an intentional navigation away during a pointer toggle", async () => {
    const user = userEvent.setup();
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    state.organization.view.catalog = [owned];
    state.organization.view.taskLabels = {
      "task-1": { labels: [appliedLabel(owned)], removed: [] },
    };
    let resolveToggle: (() => void) | undefined;
    state.command.mockImplementation((action) => {
      if (action.kind === "labels") {
        return new Promise<void>((resolve) => {
          resolveToggle = resolve;
        });
      }
      return Promise.resolve();
    });
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: true });

    const checkbox = screen.getByRole("checkbox", { name: "Owned" });
    const search = screen.getByRole("searchbox", { name: /labels/i });
    await user.click(checkbox);
    await waitFor(() => expect(resolveToggle).toBeDefined());
    search.focus();
    expect(document.activeElement).toBe(search);

    const resolve = resolveToggle;
    if (resolve === undefined) throw new Error("Expected pending label toggle");
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(search);
  });

  it("resets both personal appearance fields only when an override exists", async () => {
    const user = userEvent.setup();
    render(<TaskAppearancePicker taskId="task-1" />);

    const icon = screen.getByLabelText("Icon");
    await user.clear(icon);
    await user.type(icon, "UI");
    await user.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(state.command).toHaveBeenCalledTimes(2));
    expect(state.command.mock.calls[0]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      icon: "UI",
    });
    expect(state.command.mock.calls[1]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      color: null,
      icon: null,
    });
  });

  it("does not offer Reset when the task has no personal override", () => {
    state.organization.view.appearances = [
      { taskId: "task-1", version: "0", color: null, icon: null },
    ];
    render(<TaskAppearancePicker taskId="task-1" />);

    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("keeps the drafted icon visible and read-only until its save is acknowledged", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    state.command.mockImplementation((action) => {
      if (action.kind === "appearance" && action.icon !== undefined) {
        return new Promise<void>((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve();
    });
    render(<TaskAppearancePicker taskId="task-1" />);

    const icon = screen.getByLabelText("Icon");
    await user.clear(icon);
    await user.type(icon, "UI");
    fireEvent.blur(icon);

    await waitFor(() => expect(resolveSave).toBeDefined());
    expect(screen.getByDisplayValue("UI")).toBeTruthy();
    expect(icon.getAttribute("readonly")).not.toBeNull();
    expect(icon.getAttribute("disabled")).toBeNull();
    await user.type(icon, "X");
    expect(screen.getByDisplayValue("UI")).toBeTruthy();

    const resolve = resolveSave;
    if (resolve === undefined) throw new Error("Expected pending icon save");
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("does not reclaim focus from Default after an icon save started by Enter", async () => {
    const user = userEvent.setup();
    let resolveIconSave: (() => void) | undefined;
    state.command.mockImplementation((action) => {
      if (action.kind === "appearance" && action.icon !== undefined) {
        return new Promise<void>((resolve) => {
          resolveIconSave = resolve;
        });
      }
      return Promise.resolve();
    });
    render(<TaskAppearancePicker taskId="task-1" />);

    const icon = screen.getByLabelText("Icon");
    await user.clear(icon);
    await user.type(icon, "UI");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(resolveIconSave).toBeDefined());

    const defaultButton = screen.getByRole("button", { name: "Default" });
    await user.click(defaultButton);
    expect(state.command.mock.calls[1]?.[0]).toEqual({
      kind: "appearance",
      taskId: "task-1",
      color: null,
    });
    const resolve = resolveIconSave;
    if (resolve === undefined) throw new Error("Expected pending icon save");
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(defaultButton);
  });

  it("keeps picker keyboard input inside the submenu while allowing Escape out", () => {
    const parentKeyDown = vi.fn();
    render(
      <div role="toolbar" tabIndex={-1} onKeyDown={parentKeyDown}>
        <TaskAppearancePicker taskId="task-1" />
      </div>,
    );
    const icon = screen.getByLabelText("Icon");

    fireEvent.keyDown(icon, { key: "ArrowDown" });
    expect(parentKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(icon, { key: "Escape" });
    expect(parentKeyDown).toHaveBeenCalledOnce();
  });

  it("renders one searchable owned catalog with assignment checkboxes", async () => {
    const user = userEvent.setup();
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    const second = label({
      ownerId: "user-1",
      labelId: "second",
      name: "Second",
    });
    const foreign = label({
      ownerId: "owner-2",
      labelId: "foreign",
      name: "Shared",
    });
    state.organization.view.catalog = [owned, second];
    state.organization.view.taskLabels = {
      "task-1": {
        labels: [appliedLabel(owned), appliedLabel(foreign)],
        removed: [],
      },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: true });

    expect(screen.getByRole("searchbox", { name: /labels/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Owned" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Second" })).toBeTruthy();
    expect(screen.getAllByText("Shared")).toHaveLength(1);
    expect(screen.getByLabelText("Labels").textContent).toContain("Shared");
    expect(screen.queryByText("Applied labels")).toBeNull();
    expect(screen.queryByText("Your labels")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage Labels" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Options for Owned" }));
    expect(screen.getByRole("menuitem", { name: "Edit label" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete label" })).toBeTruthy();
    await user.keyboard("{Escape}");

    const ownedCheckbox = screen.getByRole("checkbox", { name: "Owned" });
    expect(ownedCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText("Owned")).toHaveLength(1);
    await user.click(ownedCheckbox);
    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    expect(state.command.mock.calls[0]?.[0]).toMatchObject({
      kind: "labels",
      taskId: "task-1",
      operations: [
        { operation: "remove", ownerId: "user-1", labelId: "owned" },
      ],
    });
    await user.click(screen.getByRole("checkbox", { name: "Second" }));
    await waitFor(() => expect(state.command).toHaveBeenCalledTimes(2));
    expect(state.command.mock.calls[1]?.[0]).toMatchObject({
      kind: "labels",
      taskId: "task-1",
      operations: [{ operation: "attach", labelId: "second" }],
    });
  });

  it("omits self attribution for own-only labels and includes You for mixed owners", () => {
    const own = label({ ownerId: "user-1", labelId: "own", name: "Mine" });
    state.organization.view.taskLabels = {
      "task-1": { labels: [appliedLabel(own)], removed: [] },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: false });
    expect(screen.getByLabelText("Labels").textContent).toContain("Mine");
    expect(screen.getByLabelText("Labels").textContent).not.toContain("You");

    cleanup();
    const foreign = label({
      ownerId: "owner-2",
      labelId: "foreign",
      name: "Shared",
    });
    state.organization.view.taskLabels = {
      "task-1": {
        labels: [appliedLabel(own), appliedLabel(foreign)],
        removed: [],
      },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: false });
    expect(screen.getByLabelText("Labels").textContent).toContain("You");
  });

  it("keeps the owned catalog while child label dialogs open and restores it on cancel", async () => {
    const user = userEvent.setup();
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    state.organization.view.catalog = [owned];
    renderDialog({ kind: "manage-labels" });

    const search = screen.getByRole("searchbox", { name: /labels/i });
    const labelsSection = screen.getByLabelText("Labels");
    const opener = screen.getByRole("button", { name: "Options for Owned" });
    await user.type(search, "own");
    labelsSection.scrollTop = 120;
    await user.click(opener);
    await user.click(screen.getByRole("menuitem", { name: "Edit label" }));
    expect(
      screen.getByRole("heading", { name: "Edit label everywhere" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Cancel label edit" }),
    ).toBeNull();
    expect(labelsSection.isConnected).toBe(true);
    expect(search.isConnected).toBe(true);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("heading", { name: "Manage Labels" })).toBeTruthy();
    expect(screen.getByLabelText("Labels")).toBe(labelsSection);
    expect(screen.getByRole("searchbox", { name: /labels/i })).toBe(search);
    expect(screen.getByDisplayValue("own")).toBe(search);
    expect(labelsSection.scrollTop).toBe(120);
    expect(document.activeElement).toBe(opener);
  });

  it("uses a separate delete confirmation with a child Cancel control", async () => {
    const user = userEvent.setup();
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    state.organization.view.catalog = [owned];
    renderDialog({ kind: "manage-labels" });

    await user.click(screen.getByRole("button", { name: "Options for Owned" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete label" }));
    expect(screen.getByRole("heading", { name: "Delete label" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("heading", { name: "Manage Labels" })).toBeTruthy();
    expect(screen.getByText("Owned")).toBeTruthy();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("reports only task-scoped pending work and uses truthful waiting copy", () => {
    const owned = label({
      ownerId: "user-1",
      labelId: "owned",
      name: "Owned",
    });
    state.organization.view.catalog = [owned];
    state.organization.view.pending = [
      { commandIds: ["command-1"], scope: "labels:task-1", status: "queued" },
      {
        commandIds: ["command-2"],
        scope: "appearance:task-1",
        status: "delivering",
      },
      { commandIds: ["command-3"], scope: "label:owned", status: "retrying" },
      { commandIds: ["command-4"], scope: "groups", status: "delivering" },
    ];
    render(<OrganizationSyncNote taskId="task-1" labels={[owned]} />);
    expect(screen.getByRole("status").textContent).toContain("Waiting to sync");

    cleanup();
    state.organization.view.pending = [
      { commandIds: ["command-5"], scope: "groups", status: "delivering" },
    ];
    render(<OrganizationSyncNote taskId="task-1" labels={[owned]} />);
    expect(screen.queryByRole("status")).toBeNull();

    cleanup();
    state.organization.view.pending = [
      { commandIds: ["command-6"], scope: "label:owned", status: "retrying" },
      { commandIds: ["command-7"], scope: "labels:task-1", status: "queued" },
    ];
    render(<OrganizationSyncNote taskId={null} labels={[owned]} />);
    expect(screen.getByRole("status").textContent).toContain("Waiting to sync");
  });
});
