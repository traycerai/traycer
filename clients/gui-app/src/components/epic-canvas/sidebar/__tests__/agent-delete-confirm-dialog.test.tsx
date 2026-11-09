import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeleteConfirmDialog } from "@/components/epic-canvas/sidebar/agent-delete-confirm-dialog";
import type { ConfirmDestructiveDialogProps } from "@/components/ui/confirm-destructive-dialog";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

const dialogRuntime = vi.hoisted(() => {
  const node = (
    id: string,
    type: "chat" | "terminal-agent",
    parentId: string | null,
  ) => ({
    id,
    parentId,
    title: id,
    type,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  });
  return {
    state: {
      chatRecordListAuthoritative: true,
      tuiAgentRecordListAuthoritative: true,
      tree: {
        rootIds: ["agent-root"],
        childrenByParent: {
          "agent-root": ["nested-chat"],
          "nested-chat": ["nested-terminal"],
        },
        nodeById: {
          "agent-root": node("agent-root", "chat", null),
          "nested-chat": node("nested-chat", "chat", "agent-root"),
          "nested-terminal": node(
            "nested-terminal",
            "terminal-agent",
            "nested-chat",
          ),
        },
      },
    },
    blockedReason: null as string | null,
    errorAfterFailure:
      "Deleted 0 of 3 agents; stopped at “agent-root”: deletion failed.",
    deleteSubtree: vi.fn((_nodeId: string, _confirmedIds: readonly string[]) =>
      Promise.resolve(true),
    ),
  };
});

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: <T,>(
    selector: (
      state: Pick<
        OpenEpicState,
        | "tree"
        | "chatRecordListAuthoritative"
        | "tuiAgentRecordListAuthoritative"
      >,
    ) => T,
  ): T => selector(dialogRuntime.state),
}));

vi.mock("@/hooks/epic/use-epic-delete-agent-subtree", () => ({
  useEpicDeleteAgentSubtree: () => {
    const [error, setError] = useState<string | null>(null);
    return {
      deleteSubtree: async (
        nodeId: string,
        confirmedIds: readonly string[],
      ) => {
        const deleted = await dialogRuntime.deleteSubtree(nodeId, confirmedIds);
        if (!deleted) setError(dialogRuntime.errorAfterFailure);
        return deleted;
      },
      isPending: false,
      error,
      resetError: () => setError(null),
    };
  },
}));

vi.mock("@/hooks/epic/use-agent-subtree-delete-blocker", () => ({
  useAgentSubtreeDeleteBlocker: () =>
    dialogRuntime.blockedReason ??
    (!dialogRuntime.state.chatRecordListAuthoritative ||
    !dialogRuntime.state.tuiAgentRecordListAuthoritative
      ? "Nested agents are still loading."
      : null),
}));

function dialogProps(
  overrides: Partial<ConfirmDestructiveDialogProps> & {
    readonly nodeId?: string;
  },
): ConfirmDestructiveDialogProps & { readonly nodeId: string } {
  return {
    nodeId: "agent-root",
    open: true,
    onOpenChange: vi.fn(),
    title: "Delete agent?",
    description: "This action cannot be undone.",
    cascadeSummary: null,
    actionLabel: "Delete",
    isPending: false,
    blockedReason: null,
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("AgentDeleteConfirmDialog", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    dialogRuntime.state.chatRecordListAuthoritative = true;
    dialogRuntime.state.tuiAgentRecordListAuthoritative = true;
    dialogRuntime.blockedReason = null;
    dialogRuntime.deleteSubtree.mockReset();
    dialogRuntime.deleteSubtree.mockResolvedValue(true);
  });

  it("defaults to the existing single-agent delete and resets the choice after closing", () => {
    const props = dialogProps({});
    const { rerender } = render(<AgentDeleteConfirmDialog {...props} />);
    const checkbox = screen.getByRole("checkbox", {
      name: "Also delete all 2 nested agents",
    });

    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    rerender(<AgentDeleteConfirmDialog {...props} open={false} />);
    rerender(<AgentDeleteConfirmDialog {...props} open />);

    expect(
      screen
        .getByRole("checkbox", { name: "Also delete all 2 nested agents" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(dialogRuntime.deleteSubtree).not.toHaveBeenCalled();
  });

  it("uses the confirmed subtree snapshot only when the checkbox is checked", async () => {
    const props = dialogProps({});
    render(<AgentDeleteConfirmDialog {...props} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete all 2 nested agents" }),
    );

    expect(
      screen.getByText(
        "This will delete 1 agent and 2 nested agents. This action cannot be undone.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete 3 agents" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 agents" }));

    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(dialogRuntime.deleteSubtree).toHaveBeenCalledWith("agent-root", [
      "nested-terminal",
      "nested-chat",
      "agent-root",
    ]);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the mutation error when subtree deletion fails", async () => {
    dialogRuntime.deleteSubtree.mockResolvedValue(false);
    const props = dialogProps({});
    render(<AgentDeleteConfirmDialog {...props} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete all 2 nested agents" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 agents" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      dialogRuntime.errorAfterFailure,
    );
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not claim a descendant count while either record list is still unknown", () => {
    dialogRuntime.state.tuiAgentRecordListAuthoritative = false;
    const props = dialogProps({});
    render(<AgentDeleteConfirmDialog {...props} />);

    expect(
      screen
        .getByRole("checkbox", { name: "Also delete all nested agents" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Nested agents are still loading.")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("disables the subtree option and names the busy descendant while keeping single delete available", () => {
    dialogRuntime.blockedReason =
      "“nested-terminal” is working. You can still delete only the selected agent.";
    const props = dialogProps({});
    render(<AgentDeleteConfirmDialog {...props} />);

    expect(
      screen
        .getByRole("checkbox", { name: "Also delete all 2 nested agents" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("agent-subtree-blocked-reason").textContent).toBe(
      dialogRuntime.blockedReason,
    );
    expect(
      screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
