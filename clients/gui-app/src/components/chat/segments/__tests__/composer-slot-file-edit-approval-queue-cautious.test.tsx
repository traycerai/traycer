import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatFileEditApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFileEditApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotFileEditApprovalQueue } from "@/components/chat/segments/composer-slot-file-edit-approval-queue";

/**
 * A `cautious` file-edit card (`chat.subscribe@1.17`) - an edit a user's ask
 * rule forced to a person - is treated as a cautious command card is: never
 * approved by "Approve all", which says how many it left, and marked on its
 * own row. Its rule line shows as the command card's facts do.
 */

afterEach(() => {
  cleanup();
});

const RULE_LINE = {
  label: "Rule",
  value: "An ask rule in project settings requires a person to approve this",
};

function fileEdit(
  overrides: Partial<ChatFileEditApprovalState>,
): ChatFileEditApprovalState {
  return chatFileEditApprovalStateSchema.parse({
    approvalId: "edit-1",
    toolName: "Edit",
    description: "Claude wants to use Edit",
    paths: ["/tmp/project/src/app.ts"],
    operation: "edit",
    input: null,
    requestedAt: 1,
    ...overrides,
  });
}

function renderQueue(
  approvals: ChatFileEditApprovalState[],
  onDecision: (approvalId: string, approved: boolean) => void,
): void {
  render(
    <ComposerSlotFileEditApprovalQueue
      approvals={approvals}
      canAct
      onDecision={onDecision}
      highlightedApprovalId={null}
    />,
  );
}

function rowFor(approvalId: string): HTMLElement {
  const row = screen
    .getByTestId("file-edit-approval-prompt")
    .querySelector<HTMLElement>(`[data-approval-id="${approvalId}"]`);
  if (row === null) throw new Error(`no file-edit row ${approvalId}`);
  return row;
}

function threeRows(): ChatFileEditApprovalState[] {
  return [
    fileEdit({ approvalId: "a" }),
    fileEdit({ approvalId: "b", cautious: true, displayFacts: [RULE_LINE] }),
    fileEdit({ approvalId: "c" }),
  ];
}

describe("a cautious file-edit card in the queue", () => {
  it("Approve all approves only the non-cautious rows and says how many it left; Deny all takes every row", () => {
    const onDecision = vi.fn();
    renderQueue(threeRows(), onDecision);
    expect(
      screen.getByTestId("file-edit-approval-individual-count").textContent,
    ).toBe("1 needs individual approval");

    screen.getByRole("button", { name: /Approve all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", true],
      ["c", true],
    ]);

    onDecision.mockClear();
    screen.getByRole("button", { name: /Deny all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
    ]);
  });

  it("marks only the cautious row, which keeps its own Approve", () => {
    const onDecision = vi.fn();
    renderQueue(threeRows(), onDecision);
    expect(
      within(rowFor("a")).queryByTestId("file-edit-approval-individual-marker"),
    ).toBeNull();
    expect(
      within(rowFor("b")).getByTestId("file-edit-approval-individual-marker")
        .textContent,
    ).toBe("Needs individual approval");
    expect(
      within(rowFor("c")).queryByTestId("file-edit-approval-individual-marker"),
    ).toBeNull();

    within(rowFor("b")).getByRole("button", { name: "Approve" }).click();
    expect(onDecision).toHaveBeenCalledWith("b", true);
  });

  it("says '2 need individual approval' in the plural", () => {
    renderQueue(
      [
        fileEdit({ approvalId: "a" }),
        fileEdit({ approvalId: "b", cautious: true }),
        fileEdit({ approvalId: "c", cautious: true }),
      ],
      vi.fn(),
    );
    expect(
      screen.getByTestId("file-edit-approval-individual-count").textContent,
    ).toBe("2 need individual approval");
  });

  it("disables Approve all when every row is cautious, and Deny all still works", () => {
    const onDecision = vi.fn();
    renderQueue(
      [
        fileEdit({ approvalId: "a", cautious: true }),
        fileEdit({ approvalId: "b", cautious: true }),
      ],
      onDecision,
    );
    expect(
      screen.getByRole("button", { name: /Approve all/ }),
    ).toHaveProperty("disabled", true);
    screen.getByRole("button", { name: /Deny all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("shows the rule line on the row, as the command card shows its facts", () => {
    renderQueue(threeRows(), vi.fn());
    const facts = within(rowFor("b")).getByTestId("approval-display-facts");
    expect(
      within(facts)
        .getAllByTestId("approval-display-fact")
        .map((fact) => fact.textContent),
    ).toEqual([`${RULE_LINE.label}${RULE_LINE.value}`]);
    expect(
      within(rowFor("a")).queryByTestId("approval-display-facts"),
    ).toBeNull();
  });

  it("control: no cautious row - no count line, no marker, Approve all takes every row", () => {
    const onDecision = vi.fn();
    renderQueue(
      [fileEdit({ approvalId: "a" }), fileEdit({ approvalId: "b" })],
      onDecision,
    );
    expect(
      screen.queryByTestId("file-edit-approval-individual-count"),
    ).toBeNull();
    expect(
      screen.queryByTestId("file-edit-approval-individual-marker"),
    ).toBeNull();
    screen.getByRole("button", { name: /Approve all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  it("a lone cautious card shows no bulk bar and no marker, and its own Approve works", () => {
    const onDecision = vi.fn();
    renderQueue([fileEdit({ approvalId: "solo", cautious: true })], onDecision);
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(
      screen.queryByTestId("file-edit-approval-individual-marker"),
    ).toBeNull();
    within(rowFor("solo")).getByRole("button", { name: "Approve" }).click();
    expect(onDecision).toHaveBeenCalledWith("solo", true);
  });
});
