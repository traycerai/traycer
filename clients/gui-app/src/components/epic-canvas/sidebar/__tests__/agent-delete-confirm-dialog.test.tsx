import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    deleteSubtree: vi.fn((_nodeId: string) => Promise.resolve()),
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
  useEpicDeleteAgentSubtree: () => ({
    deleteSubtree: dialogRuntime.deleteSubtree,
    isPending: false,
  }),
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
  beforeEach(() => {
    dialogRuntime.state.chatRecordListAuthoritative = true;
    dialogRuntime.state.tuiAgentRecordListAuthoritative = true;
    dialogRuntime.deleteSubtree.mockReset();
    dialogRuntime.deleteSubtree.mockResolvedValue(undefined);
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

  it("uses the subtree mutation only when the checkbox is checked", async () => {
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
    expect(dialogRuntime.deleteSubtree).toHaveBeenCalledWith("agent-root");
    expect(props.onConfirm).not.toHaveBeenCalled();
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
});
