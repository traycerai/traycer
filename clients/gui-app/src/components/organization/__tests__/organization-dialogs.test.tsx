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
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import type {
  LabelDefinition,
  TaskLabel,
} from "@traycer/protocol/host/organization/schemas";
import type { OrganizationDialog } from "@/components/organization/organization-dialogs";
import { OrganizationDialogHost } from "@/components/organization/organization-dialogs";
import { captureOrganizationDialogOpener } from "@/components/organization/organization-dialog-focus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const state = vi.hoisted(() => {
  const view: OrganizationView = {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [{ taskId: "task-1", version: "0", color: null, icon: null }],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  const command = vi.fn<(action: OrganizationAction) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const openDialog = vi.fn<(dialog: OrganizationDialog) => void>();
  const organization = {
    supported: true,
    userId: "user-1",
    view,
    register: vi.fn((_key: string, _taskIds: readonly string[]) => () => {
      return undefined;
    }),
    openDialog,
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

vi.mock("@/components/layout/tabs/tab-appearance-menu", () => ({
  TabColorPicker: (props: {
    readonly color: string | null;
    readonly onChange: (color: string | null) => void;
    readonly onDefault?: () => void;
  }) => (
    <>
      {props.onDefault ? (
        <button type="button" aria-label="Default" onClick={props.onDefault}>
          Default
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Choose color"
        data-color={props.color ?? "default"}
        onClick={() => props.onChange("#445566")}
      >
        Choose color
      </button>
    </>
  ),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({}),
}));

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  useEpicCollaboratorsQuery: () => ({
    data: { flatRows: state.collaboratorRows },
  }),
}));

function resetOrganization(): void {
  state.command.mockReset();
  state.command.mockImplementation(() => Promise.resolve());
  state.organization.openDialog.mockReset();
  state.organization.view.catalog = [];
  state.organization.view.groups = {
    version: "0",
    groups: [],
    memberships: [],
  };
  state.organization.view.appearances = [
    { taskId: "task-1", version: "0", color: null, icon: null },
  ];
  state.organization.view.taskLabels = {};
  state.collaboratorRows.length = 0;
}

function renderDialog(dialog: OrganizationDialog) {
  return render(<OrganizationDialogHost dialog={dialog} onClose={vi.fn()} />);
}

function FocusHarness(props: { readonly initialDialog: OrganizationDialog }) {
  const [dialog, setDialog] = useState<OrganizationDialog | null>(null);
  const [showOpener, setShowOpener] = useState(true);
  state.organization.openDialog.mockImplementation((next) => setDialog(next));

  return (
    <>
      {showOpener ? (
        <button type="button" onClick={() => setDialog(props.initialDialog)}>
          Open organization
        </button>
      ) : null}
      <button type="button" onClick={() => setShowOpener(false)}>
        Remove opener
      </button>
      <OrganizationDialogHost dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function DropdownFocusHarness() {
  const [dialog, setDialog] = useState<OrganizationDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button">Open menu</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onSelect={() => {
            setReturnFocusTo(captureOrganizationDialogOpener());
            setDialog({ kind: "labels", taskId: "task-1", canEdit: false });
          }}
        >
          Open organization
        </DropdownMenuItem>
      </DropdownMenuContent>
      <OrganizationDialogHost
        dialog={dialog}
        returnFocusTo={returnFocusTo}
        onClose={() => setDialog(null)}
      />
    </DropdownMenu>
  );
}

function ContextFocusHarness() {
  const [dialog, setDialog] = useState<OrganizationDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="context-row">
          <button type="button">Row control</button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            setReturnFocusTo(captureOrganizationDialogOpener());
            setDialog({ kind: "labels", taskId: "task-1", canEdit: false });
          }}
        >
          Labels
        </ContextMenuItem>
      </ContextMenuContent>
      <OrganizationDialogHost
        dialog={dialog}
        returnFocusTo={returnFocusTo}
        onClose={() => setDialog(null)}
      />
    </ContextMenu>
  );
}

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

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetOrganization();
});

describe("organization dialogs", () => {
  it("restores focus to a persistent dropdown trigger after its item opens a dialog", async () => {
    const user = userEvent.setup();
    render(<DropdownFocusHarness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    await user.click(trigger);
    await user.click(
      screen.getByRole("menuitem", { name: "Open organization" }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores focus to a row control after a context-menu item opens a dialog", async () => {
    render(<ContextFocusHarness />);
    const row = screen.getByTestId("context-row");
    const rowControl = screen.getByRole("button", { name: "Row control" });
    rowControl.focus();
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Labels" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(rowControl));
  });

  it("returns focus to an external opener after Escape", async () => {
    render(
      <FocusHarness
        initialDialog={{ kind: "labels", taskId: "task-1", canEdit: false }}
      />,
    );
    const opener = screen.getByRole("button", { name: "Open organization" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the opener after a new-group cancellation", async () => {
    render(
      <FocusHarness initialDialog={{ kind: "new-group", taskId: "task-1" }} />,
    );
    const opener = screen.getByRole("button", { name: "Open organization" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("preserves the opener through label management and its editor", async () => {
    state.organization.view.taskLabels = {
      "task-1": { labels: [], removed: [] },
    };
    render(<FocusHarness initialDialog={{ kind: "manage-labels" }} />);
    const opener = screen.getByRole("button", { name: "Open organization" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Manage Labels" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Create label" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Manage Labels" }),
      ).toBeTruthy(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("does not restore focus to an opener removed while the dialog is open", async () => {
    render(
      <FocusHarness
        initialDialog={{ kind: "labels", taskId: "task-1", canEdit: false }}
      />,
    );
    const opener = screen.getByRole("button", { name: "Open organization" });
    const removeOpener = screen.getByRole("button", { name: "Remove opener" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(removeOpener);
    expect(opener.isConnected).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it("leaves no command when creating a group is cancelled", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OrganizationDialogHost
        dialog={{ kind: "new-group", taskId: "task-1" }}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(state.command).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates and assigns a new group in one ordered action", async () => {
    const user = userEvent.setup();
    renderDialog({ kind: "new-group", taskId: "task-1" });

    await user.type(screen.getByLabelText("Name"), "Backend work");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    const action = state.command.mock.calls[0][0];
    if (action.kind !== "groups") {
      throw new Error("Expected a groups organization action");
    }
    expect(action.operations).toHaveLength(2);
    const createOperation = action.operations.at(0);
    const moveOperation = action.operations.at(1);
    if (
      createOperation === undefined ||
      moveOperation === undefined ||
      createOperation.operation !== "create" ||
      moveOperation.operation !== "moveTask"
    ) {
      throw new Error("Expected create followed by moveTask");
    }
    expect(createOperation.name).toBe("Backend work");
    expect(createOperation.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(createOperation.position).toBe(0);
    expect(moveOperation.taskId).toBe("task-1");
    expect(moveOperation.position).toBe(0);
    expect(moveOperation.groupId).toBe(createOperation.groupId);
  });

  it("lets a viewer inspect and copy a foreign label without editing assignments", async () => {
    const user = userEvent.setup();
    const foreign = label({
      ownerId: "owner-2",
      labelId: "label-2",
      name: "Shared",
    });
    state.organization.view.taskLabels = {
      "task-1": { labels: [appliedLabel(foreign)], removed: [] },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: false });

    expect(screen.queryByLabelText("Remove Shared from task")).toBeNull();
    expect(screen.getByPlaceholderText("Search labels…")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Copy Shared to my labels" }),
    );
    await user.click(screen.getByRole("button", { name: "Copy label" }));

    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    expect(state.command.mock.calls[0]?.[0]).toMatchObject({
      kind: "catalog",
      command: {
        operation: "copy",
        taskId: "task-1",
        sourceOwnerId: "owner-2",
        sourceLabelId: "label-2",
        choice: { kind: "create", name: "Shared" },
      },
    });
  });

  it("requires an explicit reuse choice when copying collides with an owned label", async () => {
    const user = userEvent.setup();
    const foreign = label({
      ownerId: "owner-2",
      labelId: "label-2",
      name: "Shared",
    });
    state.organization.view.catalog = [
      label({ ownerId: "user-1", labelId: "label-1", name: "Shared" }),
    ];
    state.organization.view.taskLabels = {
      "task-1": { labels: [appliedLabel(foreign)], removed: [] },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: false });

    await user.click(
      screen.getByRole("button", { name: "Copy Shared to my labels" }),
    );
    const copyButton = screen.getByRole("button", { name: "Copy label" });
    expect(copyButton.hasAttribute("disabled")).toBe(true);
    expect(state.command).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Use existing label" }),
    );
    await waitFor(() => expect(state.command).toHaveBeenCalledOnce());
    expect(state.command.mock.calls[0]?.[0]).toMatchObject({
      kind: "catalog",
      command: {
        operation: "copy",
        choice: { kind: "reuse", labelId: "label-1" },
      },
    });
  });

  it("does not treat an optimistic create-and-apply catalog entry as a duplicate", async () => {
    const user = userEvent.setup();
    state.organization.view.taskLabels = {
      "task-1": { labels: [], removed: [] },
    };
    let resolveAttach: (() => void) | undefined;
    state.command.mockImplementation((action) => {
      if (action.kind === "catalog" && action.command.operation === "create") {
        state.organization.view.catalog = [
          ...state.organization.view.catalog,
          label({
            ownerId: "user-1",
            labelId: action.command.labelId,
            name: action.command.name,
          }),
        ];
        return Promise.resolve();
      }
      if (action.kind === "labels") {
        return new Promise<void>((resolve) => {
          resolveAttach = resolve;
        });
      }
      return Promise.resolve();
    });
    const onClose = vi.fn();
    const dialog = { kind: "labels" as const, taskId: "task-1", canEdit: true };
    const rendered = render(
      <OrganizationDialogHost dialog={dialog} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: "Create label" }));
    await user.type(screen.getByLabelText("Name"), "Fresh label");
    await user.click(screen.getByRole("button", { name: "Create and apply" }));
    await waitFor(() => expect(resolveAttach).toBeDefined());
    const createAndApply = screen.getByRole("button", {
      name: "Create and apply",
    });
    if (!(createAndApply instanceof HTMLButtonElement))
      throw new Error("Expected Create and apply to be a native button");
    expect(createAndApply.disabled).toBe(true);
    await user.click(createAndApply);
    expect(state.command).toHaveBeenCalledTimes(2);

    rendered.rerender(
      withQueryClient(
        <OrganizationDialogHost dialog={dialog} onClose={onClose} />,
      ),
    );
    expect(screen.queryByText(/You already have a label named/)).toBeNull();

    const resolve = resolveAttach;
    if (resolve === undefined) {
      throw new Error("Expected the attach command to remain pending");
    }
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    expect(screen.getByRole("button", { name: "Create label" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks a case-insensitive duplicate when creating a label", async () => {
    const user = userEvent.setup();
    state.organization.view.catalog = [
      label({ ownerId: "user-1", labelId: "existing", name: "Existing" }),
    ];
    state.organization.view.taskLabels = {
      "task-1": { labels: [], removed: [] },
    };
    renderDialog({ kind: "labels", taskId: "task-1", canEdit: true });

    await user.click(screen.getByRole("button", { name: "Create label" }));
    await user.type(screen.getByLabelText("Name"), " existing ");

    expect(screen.getByText(/You already have a label named/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Create and apply" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(state.command).not.toHaveBeenCalled();
  });

  it("shows complete read-only group and label ownership details to a viewer", () => {
    const first = label({
      ownerId: "owner-a",
      labelId: "label-a",
      name: "QA Beta 0923 — Long label for overflow verification",
    });
    const second = label({
      ownerId: "owner-b",
      labelId: "label-b",
      name: "QA Beta 0923 — Long label for overflow verification",
    });
    state.organization.view.groups = {
      version: "0",
      groups: [
        {
          groupId: "group-long",
          name: "A group name that remains complete",
          color: "#445566",
          position: 0,
        },
      ],
      memberships: [{ taskId: "task-1", groupId: "group-long", position: 0 }],
    };
    state.organization.view.taskLabels = {
      "task-1": {
        labels: [appliedLabel(first), appliedLabel(second)],
        removed: [],
      },
    };
    state.collaboratorRows.push(
      { userId: "owner-a", displayName: "Alice Long Collaborator Name" },
      { userId: "owner-b", displayName: "Bob Long Collaborator Name" },
    );

    renderDialog({ kind: "labels", taskId: "task-1", canEdit: false });

    expect(
      screen.getByRole("heading", { name: "Task organization" }),
    ).toBeTruthy();
    const groupSection = screen.getByLabelText("Group");
    expect(groupSection.textContent).toContain(
      "A group name that remains complete",
    );
    const labelsSection = screen.getByLabelText("Labels");
    expect(labelsSection.textContent).toContain("Alice Long Collaborator Name");
    expect(labelsSection.textContent).toContain("Bob Long Collaborator Name");
    expect(
      screen.getAllByText(
        "QA Beta 0923 — Long label for overflow verification",
      ),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", {
        name: "Copy QA Beta 0923 — Long label for overflow verification to my labels",
      }),
    ).toHaveLength(2);
    expect(screen.getByPlaceholderText("Search labels…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create label" })).toBeNull();
    expect(screen.queryByLabelText(/Remove/)).toBeNull();
    expect(state.command).not.toHaveBeenCalled();
  });
});
